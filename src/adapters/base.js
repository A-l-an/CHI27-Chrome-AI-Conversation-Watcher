(function initBaseAdapter(root, factory) {
  const core = typeof module === "object" && module.exports
    ? require("../core.js")
    : root.AIConversation.Core;
  const api = factory(root, core);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.Adapters = root.AIConversation.Adapters || {};
    root.AIConversation.Adapters.Base = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function baseAdapterFactory(
  root,
  Core
) {
  "use strict";

  function selectorList(selector) {
    if (Array.isArray(selector)) {
      return selector.filter((item) => typeof item === "string" && item);
    }
    return typeof selector === "string" && selector ? [selector] : [];
  }

  function queryFirst(selector) {
    for (const candidate of selectorList(selector)) {
      try {
        const match = document.querySelector(candidate);
        if (match) {
          return match;
        }
      } catch (_error) {
        // Ignore a provider selector that the current browser cannot parse.
      }
    }
    return null;
  }

  function queryCount(selector) {
    let count = 0;
    for (const candidate of selectorList(selector)) {
      try {
        count += document.querySelectorAll(candidate).length;
      } catch (_error) {
        // Ignore a provider selector that the current browser cannot parse.
      }
    }
    return count;
  }

  function queryElements(selector) {
    const elements = [];
    for (const candidate of selectorList(selector)) {
      try {
        for (const match of document.querySelectorAll(candidate)) {
          if (match && !elements.includes(match)) {
            elements.push(match);
          }
        }
      } catch (_error) {
        // Ignore a provider selector that the current browser cannot parse.
      }
      try {
        const first = document.querySelector(candidate);
        if (first && !elements.includes(first)) {
          elements.unshift(first);
        }
      } catch (_error) {
        // Ignore a provider selector that the current browser cannot parse.
      }
    }
    return elements;
  }

  function queryLast(selector) {
    for (const candidate of selectorList(selector)) {
      try {
        const matches = document.querySelectorAll(candidate);
        if (matches.length > 0) {
          return matches[matches.length - 1];
        }
      } catch (_error) {
        // Ignore a provider selector that the current browser cannot parse.
      }
    }
    return null;
  }

  function closestMatch(target, selector) {
    if (!target || target.nodeType !== 1) {
      return null;
    }
    for (const candidate of selectorList(selector)) {
      try {
        const match = target.closest(candidate);
        if (match) {
          return match;
        }
      } catch (_error) {
        // Ignore a provider selector that the current browser cannot parse.
      }
    }
    return null;
  }

  function textContentExcludingMatches(target, selector) {
    const exclusions = selectorList(selector);
    if (
      !target ||
      exclusions.length === 0 ||
      typeof target.cloneNode !== "function"
    ) {
      return null;
    }
    let clone;
    try {
      clone = target.cloneNode(true);
    } catch (_error) {
      return null;
    }
    if (!clone || typeof clone.querySelectorAll !== "function") {
      return null;
    }
    for (const exclusion of exclusions) {
      let matches;
      try {
        matches = clone.querySelectorAll(exclusion);
      } catch (_error) {
        continue;
      }
      for (const match of matches) {
        if (match && typeof match.remove === "function") {
          match.remove();
        }
      }
    }
    return typeof clone.textContent === "string"
      ? clone.textContent
      : null;
  }

  function composerNonEmpty(element) {
    if (!element) {
      return false;
    }
    if (typeof element.value === "string") {
      return element.value.trim().length > 0;
    }
    return (element.textContent || "").trim().length > 0;
  }

  class ProviderDomAdapter {
    constructor(config) {
      this.provider = config.provider;
      this.selectors = config.selectors;
      this.onAction = config.onAction;
      this.now = typeof config.now === "function" ? config.now : Date.now;
      this.healthGraceMs = Number.isFinite(config.healthGraceMs)
        ? config.healthGraceMs
        : 10000;
      this.responseSignalTimeoutMs = Number.isFinite(config.responseSignalTimeoutMs)
        ? config.responseSignalTimeoutMs
        : 15000;
      this.completionSettleMs = Number.isFinite(config.completionSettleMs)
        ? config.completionSettleMs
        : 800;
      this.responseQuietMs = Number.isFinite(config.responseQuietMs)
        ? config.responseQuietMs
        : 1500;
      this.submissionDedupeMs = Number.isFinite(config.submissionDedupeMs)
        ? config.submissionDedupeMs
        : 1000;
      this.observationPollIntervalMs = Number.isFinite(config.observationPollIntervalMs)
        ? config.observationPollIntervalMs
        : 250;
      this.observationPollWindowMs = Number.isFinite(config.observationPollWindowMs)
        ? config.observationPollWindowMs
        : 30000;
      this.mutationObserverOptions = Object.assign(
        { childList: true, subtree: true },
        config.mutationObserverOptions || {}
      );
      this.requireSubmissionForResponseSignals =
        Boolean(config.requireSubmissionForResponseSignals);
      this.requireResponseTurnForCompletion =
        Boolean(config.requireResponseTurnForCompletion);
      this.requireActiveEdgeForCompletion =
        Boolean(config.requireActiveEdgeForCompletion);
      this.responseIdentityAttribute =
        typeof config.responseIdentityAttribute === "string"
          ? config.responseIdentityAttribute
          : "";
      this.started = false;
      this.responseObserved = false;
      this.lastSnapshot = {
        stopVisible: false,
        responseActiveVisible: false,
        responseTurnCount: 0,
        errorVisible: false
      };
      this.submissionResponseTurnCount = 0;
      this.responseObservedTurnCount = 0;
      this.lastSubmissionAt = -Infinity;
      this.submissionPending = false;
      this.observationEpoch = 0;
      this.activeTurnLinkId = "";
      this.activeEdgeObserved = false;
      this.inactiveEdgeObserved = false;
      this.inactiveEdgeSignal = "";
      this.responseTurnConfirmedForObservation = false;
      this.candidateResponseTurnElement = null;
      this.ownedActiveSignal = "";
      this.notificationPreviewCandidate = "";
      this.notificationPreviewIdentity = "";
      this.notificationPreviewSourceLength = 0;
      this.submissionResponseTurnIdentity = "";
      this.submissionResponseTurnElement = null;
      this.completionTimer = null;
      this.responseSignalTimer = null;
      this.healthTimer = null;
      this.mutationTimer = null;
      this.observationPollTimer = null;
      this.observationPollDeadline = 0;
      this.unhealthyReasons = new Set();
      this.boundInput = (event) => this.handleInput(event);
      this.boundKeydown = (event) => this.handleKeydown(event);
      this.boundClick = (event) => this.handleClick(event);
      this.boundScroll = () => this.handleScroll();
      this.boundSubmit = (event) => this.handleSubmit(event);
    }

    emit(action) {
      this.onAction(action);
    }

    start() {
      if (this.started) {
        return;
      }
      this.started = true;
      document.addEventListener("input", this.boundInput, true);
      document.addEventListener("keydown", this.boundKeydown, true);
      document.addEventListener("click", this.boundClick, true);
      document.addEventListener("scroll", this.boundScroll, true);
      document.addEventListener("submit", this.boundSubmit, true);
      this.observer = new MutationObserver(() => this.scheduleSnapshot());
      this.observer.observe(
        document.documentElement,
        this.mutationObserverOptions
      );
      this.lastSnapshot = this.snapshot();
      this.healthTimer = root.setTimeout(() => this.checkHealth(), this.healthGraceMs);
    }

    stop() {
      if (!this.started) {
        return;
      }
      this.started = false;
      document.removeEventListener("input", this.boundInput, true);
      document.removeEventListener("keydown", this.boundKeydown, true);
      document.removeEventListener("click", this.boundClick, true);
      document.removeEventListener("scroll", this.boundScroll, true);
      document.removeEventListener("submit", this.boundSubmit, true);
      if (this.observer) {
        this.observer.disconnect();
      }
      for (const timer of [
        this.completionTimer,
        this.responseSignalTimer,
        this.healthTimer,
        this.mutationTimer,
        this.observationPollTimer
      ]) {
        if (timer) {
          root.clearTimeout(timer);
        }
      }
      this.observationEpoch += 1;
      this.activeTurnLinkId = "";
      this.responseObserved = false;
      this.submissionPending = false;
      this.completionTimer = null;
      this.responseSignalTimer = null;
      this.healthTimer = null;
      this.mutationTimer = null;
      this.observationPollTimer = null;
      this.observationPollDeadline = 0;
      this.candidateResponseTurnElement = null;
      this.ownedActiveSignal = "";
    }

    resetConversation() {
      this.observationEpoch += 1;
      this.activeTurnLinkId = "";
      this.responseObserved = false;
      this.clearCompletionTimer();
      this.clearObservationPolling();
      if (this.responseSignalTimer) {
        root.clearTimeout(this.responseSignalTimer);
        this.responseSignalTimer = null;
      }
      this.lastSnapshot = this.snapshot();
      this.submissionResponseTurnCount = this.lastSnapshot.responseTurnCount;
      this.responseObservedTurnCount = this.lastSnapshot.responseTurnCount;
      this.lastSubmissionAt = -Infinity;
      this.submissionPending = false;
      this.activeEdgeObserved = false;
      this.inactiveEdgeObserved = false;
      this.inactiveEdgeSignal = "";
      this.responseTurnConfirmedForObservation = false;
      this.candidateResponseTurnElement = null;
      this.ownedActiveSignal = "";
      this.notificationPreviewCandidate = "";
      this.notificationPreviewIdentity = "";
      this.notificationPreviewSourceLength = 0;
      this.rememberSubmissionResponseTurn();
    }

    findComposer() {
      return queryFirst(this.selectors.composer);
    }

    currentResponseTurn() {
      return queryLast(this.selectors.responseTurn);
    }

    responseTurnIdentity(responseTurn) {
      if (
        !responseTurn ||
        !this.responseIdentityAttribute ||
        typeof responseTurn.getAttribute !== "function"
      ) {
        return "";
      }
      const identity = responseTurn.getAttribute(this.responseIdentityAttribute);
      return typeof identity === "string" ? identity : "";
    }

    rememberSubmissionResponseTurn() {
      const responseTurn = this.currentResponseTurn();
      this.submissionResponseTurnElement = responseTurn;
      this.submissionResponseTurnIdentity = this.responseTurnIdentity(responseTurn);
    }

    responseTurnConfirmed(snapshot) {
      if (
        snapshot &&
        snapshot.responseTurnCount > this.submissionResponseTurnCount
      ) {
        return true;
      }
      const responseTurn = snapshot && snapshot.responseTurnElement
        ? snapshot.responseTurnElement
        : this.currentResponseTurn();
      if (!responseTurn) {
        return false;
      }
      const identity = this.responseTurnIdentity(responseTurn);
      if (identity && identity !== this.submissionResponseTurnIdentity) {
        return true;
      }
      return false;
    }

    elementBelongsToResponseTurn(element, responseTurn) {
      if (!element || !responseTurn) {
        return false;
      }
      if (element === responseTurn) {
        return true;
      }
      try {
        if (
          typeof responseTurn.contains === "function" &&
          responseTurn.contains(element)
        ) {
          return true;
        }
      } catch (_error) {
        // Treat an unreadable provider node as unverified.
      }
      if (typeof element.closest === "function") {
        for (const selector of selectorList(this.selectors.responseTurn)) {
          try {
            if (element.closest(selector) === responseTurn) {
              return true;
            }
          } catch (_error) {
            // Treat an invalid provider selector as unverified.
          }
        }
      }
      if (typeof element.querySelectorAll === "function") {
        const descendants = [];
        for (const selector of selectorList(this.selectors.responseTurn)) {
          try {
            for (const match of element.querySelectorAll(selector)) {
              if (!descendants.includes(match)) {
                descendants.push(match);
              }
            }
          } catch (_error) {
            // Treat an invalid provider selector as unverified.
          }
        }
        if (descendants.length === 1 && descendants[0] === responseTurn) {
          return true;
        }
      }
      return false;
    }

    activeSignalForTurn(snapshot, responseTurn) {
      for (const element of snapshot.responseActiveElements || []) {
        if (this.elementBelongsToResponseTurn(element, responseTurn)) {
          return "response_active_marker_appeared";
        }
      }
      for (const element of snapshot.stopElements || []) {
        if (this.elementBelongsToResponseTurn(element, responseTurn)) {
          return "stop_control_appeared";
        }
      }
      return "";
    }

    notificationPreviewSourceText(responseTurn) {
      const turn = responseTurn || this.currentResponseTurn();
      if (!turn) {
        return "";
      }
      let target = turn;
      if (this.selectors.responsePreview && typeof turn.querySelector === "function") {
        target = selectorList(this.selectors.responsePreview)
          .map((selector) => turn.querySelector(selector))
          .find(Boolean) || turn;
      }
      const filteredText = textContentExcludingMatches(
        target,
        this.selectors.responsePreviewExclude
      );
      if (filteredText !== null) {
        return filteredText;
      }
      if (target !== turn && typeof target.textContent === "string") {
        return target.textContent;
      }
      if (typeof target.innerText === "string") {
        return target.innerText;
      }
      return typeof target.textContent === "string" ? target.textContent : "";
    }

    notificationPreview(responseTurn) {
      return Core.sanitizeEphemeralNotificationPreview(
        this.notificationPreviewSourceText(responseTurn)
      );
    }

    captureNotificationPreview(snapshot) {
      if (
        !snapshot ||
        !this.responseTurnConfirmed(snapshot)
      ) {
        return this.notificationPreviewCandidate;
      }
      const responseTurn = this.currentResponseTurn();
      const identity = this.responseTurnIdentity(responseTurn);
      const sourceText = this.notificationPreviewSourceText(responseTurn);
      this.notificationPreviewSourceLength = sourceText.length;
      const preview = Core.sanitizeEphemeralNotificationPreview(sourceText);
      if (preview) {
        if (identity && identity !== this.notificationPreviewIdentity) {
          this.notificationPreviewCandidate = preview;
          this.notificationPreviewIdentity = identity;
        } else if (
          Array.from(preview).length >=
            Array.from(this.notificationPreviewCandidate).length
        ) {
          this.notificationPreviewCandidate = preview;
          if (identity) {
            this.notificationPreviewIdentity = identity;
          }
        }
      }
      return this.notificationPreviewCandidate;
    }

    checkHealth() {
      if (!this.findComposer()) {
        this.reportUnhealthy("required_composer_missing");
      }
    }

    reportUnhealthy(reason) {
      if (this.unhealthyReasons.has(reason)) {
        return;
      }
      this.unhealthyReasons.add(reason);
      this.emit({ type: "ADAPTER_UNHEALTHY", reason });
    }

    handleInput(event) {
      const composer = closestMatch(event.target, this.selectors.composer);
      if (!composer) {
        return;
      }
      this.emit({ type: "USER_INTERACTION", signal: "composer_input" });
      this.emit({
        type: "INPUT_CHANGED",
        nonEmpty: composerNonEmpty(composer)
      });
    }

    handleKeydown(event) {
      const composer = closestMatch(event.target, this.selectors.composer);
      if (!composer) {
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        composerNonEmpty(composer)
      ) {
        this.noteSubmission("composer_enter", "heuristic");
      }
    }

    handleClick(event) {
      this.emit({ type: "USER_INTERACTION", signal: "click" });
      if (closestMatch(event.target, this.selectors.stop)) {
        const observationEpoch = this.observationEpoch;
        const turnLinkId = this.activeTurnLinkId;
        this.responseObserved = false;
        this.submissionPending = false;
        this.notificationPreviewCandidate = "";
        this.notificationPreviewIdentity = "";
        this.notificationPreviewSourceLength = 0;
        this.clearCompletionTimer();
        this.clearObservationPolling();
        if (this.responseSignalTimer) {
          root.clearTimeout(this.responseSignalTimer);
          this.responseSignalTimer = null;
        }
        this.emit({
          type: "RESPONSE_CANCELLED",
          signal: "stop_control_clicked",
          confidence: "derived",
          observationEpoch,
          turnLinkId
        });
        this.activeTurnLinkId = "";
        return;
      }
      if (closestMatch(event.target, this.selectors.send)) {
        this.noteSubmission("send_control_clicked", "derived");
      }
    }

    handleScroll() {
      this.emit({ type: "USER_INTERACTION", signal: "scroll" });
    }

    handleSubmit(event) {
      const composer = event.target && event.target.querySelector
        ? selectorList(this.selectors.composer)
          .map((selector) => event.target.querySelector(selector))
          .find(Boolean)
        : null;
      if (composer && composerNonEmpty(composer)) {
        this.noteSubmission("composer_form_submitted", "derived");
      }
    }

    noteSubmission(signal, confidence) {
      const submittedAt = this.now();
      if (submittedAt - this.lastSubmissionAt < this.submissionDedupeMs) {
        return false;
      }
      this.lastSubmissionAt = submittedAt;
      const observationEpoch = this.observationEpoch + 1;
      this.observationEpoch = observationEpoch;
      const turnLinkId = Core.randomUuid();
      this.activeTurnLinkId = turnLinkId;
      this.clearCompletionTimer();
      this.clearObservationPolling();
      if (this.responseSignalTimer) {
        root.clearTimeout(this.responseSignalTimer);
        this.responseSignalTimer = null;
      }
      const baseline = this.snapshot();
      this.lastSnapshot = baseline;
      this.submissionResponseTurnCount = baseline.responseTurnCount;
      this.responseObservedTurnCount = baseline.responseTurnCount;
      this.responseObserved = false;
      this.submissionPending = true;
      this.activeEdgeObserved = false;
      this.inactiveEdgeObserved = false;
      this.inactiveEdgeSignal = "";
      this.responseTurnConfirmedForObservation = false;
      this.candidateResponseTurnElement = null;
      this.ownedActiveSignal = "";
      this.notificationPreviewCandidate = "";
      this.notificationPreviewIdentity = "";
      this.notificationPreviewSourceLength = 0;
      this.rememberSubmissionResponseTurn();
      this.emit({
        type: "PROMPT_SUBMITTED",
        signal,
        confidence,
        observationEpoch,
        turnLinkId
      });
      this.responseSignalTimer = root.setTimeout(() => {
        if (
          observationEpoch === this.observationEpoch &&
          this.submissionPending &&
          !this.responseObserved
        ) {
          this.reportUnhealthy("response_start_signal_timeout");
        }
      }, this.responseSignalTimeoutMs);
      this.startObservationPolling(observationEpoch);
      return true;
    }

    clearObservationPolling() {
      if (this.observationPollTimer) {
        root.clearTimeout(this.observationPollTimer);
        this.observationPollTimer = null;
      }
      this.observationPollDeadline = 0;
    }

    startObservationPolling(observationEpoch) {
      this.clearObservationPolling();
      if (
        !this.started ||
        this.observationPollIntervalMs <= 0 ||
        this.observationPollWindowMs <= 0
      ) {
        return;
      }
      this.observationPollDeadline = this.now() + this.observationPollWindowMs;
      const poll = () => {
        this.observationPollTimer = null;
        if (
          !this.started ||
          observationEpoch !== this.observationEpoch ||
          this.now() > this.observationPollDeadline ||
          (!this.submissionPending && !this.responseObserved)
        ) {
          return;
        }
        this.handleSnapshot(this.snapshot(), observationEpoch);
        if (
          this.started &&
          observationEpoch === this.observationEpoch &&
          this.now() <= this.observationPollDeadline &&
          (this.submissionPending || this.responseObserved)
        ) {
          this.observationPollTimer = root.setTimeout(
            poll,
            this.observationPollIntervalMs
          );
        }
      };
      this.observationPollTimer = root.setTimeout(
        poll,
        this.observationPollIntervalMs
      );
    }

    snapshot() {
      const stopElements = queryElements(this.selectors.stop);
      const responseActiveElements = queryElements(
        this.selectors.responseActive
      );
      return {
        stopVisible: stopElements.length > 0,
        stopElements,
        responseActiveVisible: responseActiveElements.length > 0,
        responseActiveElements,
        responseTurnCount: queryCount(this.selectors.responseTurn),
        responseTurnElement: this.currentResponseTurn(),
        errorVisible: Boolean(
          queryFirst(this.selectors.error)
        )
      };
    }

    scheduleSnapshot() {
      if (this.mutationTimer) {
        return;
      }
      this.mutationTimer = root.setTimeout(() => {
        this.mutationTimer = null;
        this.handleSnapshot(this.snapshot(), this.observationEpoch);
      }, 100);
    }

    markResponseStarted(signal, confidence, snapshot, observationEpoch) {
      if (
        observationEpoch !== this.observationEpoch ||
        this.responseObserved
      ) {
        return;
      }
      this.responseObserved = true;
      const leftCensored = !this.activeTurnLinkId;
      if (!this.activeTurnLinkId) {
        this.activeTurnLinkId = Core.randomUuid();
      }
      this.responseObservedTurnCount = snapshot.responseTurnCount;
      if (this.responseSignalTimer) {
        root.clearTimeout(this.responseSignalTimer);
        this.responseSignalTimer = null;
      }
      this.emit({
        type: "RESPONSE_STARTED",
        signal,
        confidence,
        observationEpoch,
        turnLinkId: this.activeTurnLinkId,
        leftCensored
      });
    }

    scheduleCompletion(signal, confidence, observationEpoch) {
      this.clearCompletionTimer();
      this.completionTimer = root.setTimeout(() => {
        this.completionTimer = null;
        if (observationEpoch !== this.observationEpoch) {
          return;
        }
        const settled = this.snapshot();
        const settledActiveSignal = this.requireActiveEdgeForCompletion
          ? this.activeSignalForTurn(
              settled,
              this.candidateResponseTurnElement
            )
          : (
              settled.stopVisible
                ? "stop_control_appeared"
                : settled.responseActiveVisible
                  ? "response_active_marker_appeared"
                  : ""
            );
        if (
          !settledActiveSignal &&
          !settled.errorVisible &&
          this.responseObserved &&
          (
            !this.requireActiveEdgeForCompletion ||
            this.inactiveEdgeObserved
          ) &&
          (
            !this.requireResponseTurnForCompletion ||
            this.responseTurnConfirmed(settled)
          )
        ) {
          const notificationPreview =
            this.captureNotificationPreview(settled);
          this.responseObserved = false;
          this.submissionPending = false;
          this.clearObservationPolling();
          this.notificationPreviewCandidate = "";
          this.notificationPreviewIdentity = "";
          this.notificationPreviewSourceLength = 0;
          const completedAction = {
            type: "RESPONSE_COMPLETED",
            signal,
            confidence,
            observationEpoch,
            turnLinkId: this.activeTurnLinkId
          };
          if (notificationPreview) {
            completedAction.notification_preview = notificationPreview;
          }
          this.emit(completedAction);
          this.activeTurnLinkId = "";
        }
      }, signal === "assistant_response_structure_quiet"
        ? this.responseQuietMs
        : this.completionSettleMs);
    }

    handleSnapshot(next, observationEpoch) {
      const epoch = Number.isInteger(observationEpoch)
        ? observationEpoch
        : this.observationEpoch;
      if (epoch !== this.observationEpoch) {
        return;
      }
      const previous = this.lastSnapshot;
      this.lastSnapshot = next;
      if (next.errorVisible && this.responseObserved) {
        this.responseObserved = false;
        this.submissionPending = false;
        this.notificationPreviewCandidate = "";
        this.notificationPreviewIdentity = "";
        this.notificationPreviewSourceLength = 0;
        this.clearCompletionTimer();
        this.clearObservationPolling();
        this.emit({
          type: "RESPONSE_FAILED",
          reason: "provider_error_control_visible",
          confidence: "heuristic",
          observationEpoch: epoch,
          turnLinkId: this.activeTurnLinkId
        });
        this.activeTurnLinkId = "";
        return;
      }
      const responseTurnConfirmed = this.responseTurnConfirmed(next);
      const responseTurnBecameConfirmed = (
        this.submissionPending &&
        responseTurnConfirmed &&
        !this.responseTurnConfirmedForObservation
      );
      if (responseTurnConfirmed) {
        this.responseTurnConfirmedForObservation = true;
      }
      if (
        responseTurnBecameConfirmed &&
        next.responseTurnElement &&
        next.responseTurnElement !== this.submissionResponseTurnElement
      ) {
        this.candidateResponseTurnElement = next.responseTurnElement;
      }
      const rawNextActive = next.stopVisible || next.responseActiveVisible;
      const nextActiveSignal = this.requireActiveEdgeForCompletion
        ? this.activeSignalForTurn(next, this.candidateResponseTurnElement)
        : (
            next.stopVisible
              ? "stop_control_appeared"
              : next.responseActiveVisible
                ? "response_active_marker_appeared"
                : ""
          );
      const previousActiveSignal = this.requireActiveEdgeForCompletion
        ? this.ownedActiveSignal
        : (
            previous.stopVisible
              ? "stop_control_appeared"
              : previous.responseActiveVisible
                ? "response_active_marker_appeared"
                : ""
          );
      const nextActive = Boolean(nextActiveSignal);
      const previousActive = Boolean(previousActiveSignal);
      if (
        this.requireActiveEdgeForCompletion &&
        (this.submissionPending || this.responseObserved) &&
        responseTurnConfirmed &&
        rawNextActive &&
        !nextActiveSignal
      ) {
        this.reportUnhealthy("response_active_scope_unverified");
      }
      if (
        nextActive &&
        !previousActive &&
        (!this.requireSubmissionForResponseSignals || this.submissionPending)
      ) {
        this.activeEdgeObserved = true;
        this.inactiveEdgeObserved = false;
        this.inactiveEdgeSignal = "";
        this.markResponseStarted(
          nextActiveSignal,
          nextActiveSignal.startsWith("stop_") ? "derived" : "heuristic",
          next,
          epoch
        );
      }
      if (!this.responseObserved && responseTurnBecameConfirmed) {
        this.markResponseStarted(
          "assistant_response_container_added",
          "heuristic",
          next,
          epoch
        );
      }
      if (next.responseTurnCount > this.responseObservedTurnCount) {
        this.responseObservedTurnCount = next.responseTurnCount;
      }
      let responsePreviewChanged = false;
      if (
        responseTurnConfirmed &&
        (this.responseObserved || this.submissionPending)
      ) {
        const previousPreviewSourceLength =
          this.notificationPreviewSourceLength;
        const previousPreviewIdentity = this.notificationPreviewIdentity;
        this.captureNotificationPreview(next);
        responsePreviewChanged = (
          this.notificationPreviewSourceLength !== previousPreviewSourceLength ||
          this.notificationPreviewIdentity !== previousPreviewIdentity
        );
      }
      if (
        this.activeEdgeObserved &&
        !nextActive &&
        previousActive
      ) {
        this.inactiveEdgeObserved = true;
        this.inactiveEdgeSignal = previousActiveSignal.startsWith("stop_")
          ? "stop_control_disappeared_after_settle"
          : "response_active_marker_disappeared_after_settle";
      }
      if (this.requireActiveEdgeForCompletion) {
        this.ownedActiveSignal = nextActiveSignal;
      }
      if (
        this.responseObserved &&
        !nextActive &&
        previousActive &&
        (
          !this.requireResponseTurnForCompletion ||
          responseTurnConfirmed
        )
      ) {
        this.scheduleCompletion(
          this.inactiveEdgeSignal,
          this.inactiveEdgeSignal.startsWith("stop_")
            ? "derived"
            : "heuristic",
          epoch
        );
      } else if (
        this.requireActiveEdgeForCompletion &&
        this.responseObserved &&
        !nextActive &&
        this.inactiveEdgeObserved &&
        responseTurnBecameConfirmed
      ) {
        this.scheduleCompletion(
          this.inactiveEdgeSignal,
          this.inactiveEdgeSignal.startsWith("stop_") ? "derived" : "heuristic",
          epoch
        );
      } else if (
        !this.requireActiveEdgeForCompletion &&
        this.responseObserved &&
        !nextActive &&
        responseTurnBecameConfirmed
      ) {
        this.scheduleCompletion(
          "assistant_response_structure_quiet",
          "heuristic",
          epoch
        );
      } else if (
        !this.requireActiveEdgeForCompletion &&
        this.responseObserved &&
        !nextActive &&
        responseTurnConfirmed &&
        responsePreviewChanged
      ) {
        this.scheduleCompletion(
          "assistant_response_structure_quiet",
          "heuristic",
          epoch
        );
      }
    }

    clearCompletionTimer() {
      if (this.completionTimer) {
        root.clearTimeout(this.completionTimer);
        this.completionTimer = null;
      }
    }
  }

  return {
    ProviderDomAdapter,
    closestMatch,
    composerNonEmpty,
    queryCount,
    queryElements,
    queryFirst,
    queryLast,
    selectorList
  };
});
