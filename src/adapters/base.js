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
      this.healthGraceMs = config.healthGraceMs || 10000;
      this.responseSignalTimeoutMs = config.responseSignalTimeoutMs || 15000;
      this.completionSettleMs = config.completionSettleMs || 800;
      this.responseQuietMs = config.responseQuietMs || 1500;
      this.submissionDedupeMs = config.submissionDedupeMs || 1000;
      this.mutationObserverOptions = Object.assign(
        { childList: true, subtree: true },
        config.mutationObserverOptions || {}
      );
      this.requireSubmissionForResponseSignals =
        Boolean(config.requireSubmissionForResponseSignals);
      this.requireResponseTurnForCompletion =
        Boolean(config.requireResponseTurnForCompletion);
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
      this.notificationPreviewCandidate = "";
      this.notificationPreviewIdentity = "";
      this.notificationPreviewSourceLength = 0;
      this.submissionResponseTurnIdentity = "";
      this.completionTimer = null;
      this.responseSignalTimer = null;
      this.healthTimer = null;
      this.mutationTimer = null;
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
        this.mutationTimer
      ]) {
        if (timer) {
          root.clearTimeout(timer);
        }
      }
    }

    resetConversation() {
      this.responseObserved = false;
      this.clearCompletionTimer();
      if (this.responseSignalTimer) {
        root.clearTimeout(this.responseSignalTimer);
        this.responseSignalTimer = null;
      }
      this.lastSnapshot = this.snapshot();
      this.submissionResponseTurnCount = this.lastSnapshot.responseTurnCount;
      this.responseObservedTurnCount = this.lastSnapshot.responseTurnCount;
      this.lastSubmissionAt = -Infinity;
      this.submissionPending = false;
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
      this.submissionResponseTurnIdentity = this.responseTurnIdentity(responseTurn);
    }

    responseTurnConfirmed(snapshot) {
      if (
        snapshot &&
        snapshot.responseTurnCount > this.submissionResponseTurnCount
      ) {
        return true;
      }
      const responseTurn = this.currentResponseTurn();
      if (!responseTurn) {
        return false;
      }
      const identity = this.responseTurnIdentity(responseTurn);
      if (identity && identity !== this.submissionResponseTurnIdentity) {
        return true;
      }
      return false;
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
      if (!closestMatch(event.target, this.selectors.composer)) {
        return;
      }
      this.emit({ type: "USER_INTERACTION", signal: "composer_input" });
      this.emit({
        type: "INPUT_CHANGED",
        nonEmpty: composerNonEmpty(event.target)
      });
    }

    handleKeydown(event) {
      if (!closestMatch(event.target, this.selectors.composer)) {
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        composerNonEmpty(event.target)
      ) {
        this.noteSubmission("composer_enter", "heuristic");
      }
    }

    handleClick(event) {
      this.emit({ type: "USER_INTERACTION", signal: "click" });
      if (closestMatch(event.target, this.selectors.stop)) {
        this.responseObserved = false;
        this.submissionPending = false;
        this.notificationPreviewCandidate = "";
        this.notificationPreviewIdentity = "";
        this.notificationPreviewSourceLength = 0;
        this.clearCompletionTimer();
        this.emit({
          type: "RESPONSE_CANCELLED",
          signal: "stop_control_clicked",
          confidence: "derived"
        });
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
      const submittedAt = Date.now();
      if (submittedAt - this.lastSubmissionAt < this.submissionDedupeMs) {
        return false;
      }
      this.lastSubmissionAt = submittedAt;
      const baseline = this.snapshot();
      this.submissionResponseTurnCount = baseline.responseTurnCount;
      this.responseObservedTurnCount = baseline.responseTurnCount;
      this.responseObserved = false;
      this.submissionPending = true;
      this.notificationPreviewCandidate = "";
      this.notificationPreviewIdentity = "";
      this.notificationPreviewSourceLength = 0;
      this.rememberSubmissionResponseTurn();
      this.clearCompletionTimer();
      this.emit({ type: "PROMPT_SUBMITTED", signal, confidence });
      if (this.responseSignalTimer) {
        root.clearTimeout(this.responseSignalTimer);
      }
      this.responseSignalTimer = root.setTimeout(() => {
        if (!this.responseObserved) {
          this.reportUnhealthy("response_start_signal_timeout");
        }
      }, this.responseSignalTimeoutMs);
      return true;
    }

    snapshot() {
      return {
        stopVisible: Boolean(queryFirst(this.selectors.stop)),
        responseActiveVisible: Boolean(queryFirst(this.selectors.responseActive)),
        responseTurnCount: queryCount(this.selectors.responseTurn),
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
        this.handleSnapshot(this.snapshot());
      }, 100);
    }

    markResponseStarted(signal, confidence, snapshot) {
      if (this.responseObserved) {
        return;
      }
      this.responseObserved = true;
      this.responseObservedTurnCount = snapshot.responseTurnCount;
      if (this.responseSignalTimer) {
        root.clearTimeout(this.responseSignalTimer);
        this.responseSignalTimer = null;
      }
      this.emit({
        type: "RESPONSE_STARTED",
        signal,
        confidence
      });
    }

    scheduleCompletion(signal, confidence) {
      this.clearCompletionTimer();
      this.completionTimer = root.setTimeout(() => {
        this.completionTimer = null;
        const settled = this.snapshot();
        if (
          !settled.stopVisible &&
          !settled.responseActiveVisible &&
          !settled.errorVisible &&
          this.responseObserved &&
          (
            !this.requireResponseTurnForCompletion ||
            this.responseTurnConfirmed(settled)
          )
        ) {
          const notificationPreview =
            this.captureNotificationPreview(settled);
          this.responseObserved = false;
          this.submissionPending = false;
          this.notificationPreviewCandidate = "";
          this.notificationPreviewIdentity = "";
          this.notificationPreviewSourceLength = 0;
          const completedAction = {
            type: "RESPONSE_COMPLETED",
            signal,
            confidence
          };
          if (notificationPreview) {
            completedAction.notification_preview = notificationPreview;
          }
          this.emit(completedAction);
        }
      }, signal === "assistant_response_structure_quiet"
        ? this.responseQuietMs
        : this.completionSettleMs);
    }

    handleSnapshot(next) {
      const previous = this.lastSnapshot;
      this.lastSnapshot = next;
      if (next.errorVisible && this.responseObserved) {
        this.responseObserved = false;
        this.submissionPending = false;
        this.notificationPreviewCandidate = "";
        this.notificationPreviewIdentity = "";
        this.notificationPreviewSourceLength = 0;
        this.clearCompletionTimer();
        this.emit({
          type: "RESPONSE_FAILED",
          reason: "provider_error_control_visible",
          confidence: "heuristic"
        });
        return;
      }
      const nextActive = next.stopVisible || next.responseActiveVisible;
      const previousActive = previous.stopVisible || previous.responseActiveVisible;
      if (
        nextActive &&
        !previousActive &&
        (!this.requireSubmissionForResponseSignals || this.submissionPending)
      ) {
        this.markResponseStarted(
          next.stopVisible
            ? "stop_control_appeared"
            : "response_active_marker_appeared",
          next.stopVisible ? "derived" : "heuristic",
          next
        );
      }
      const responseTurnConfirmed = this.responseTurnConfirmed(next);
      const responseTurnAdded = (
        this.submissionPending && responseTurnConfirmed
      );
      if (!this.responseObserved && responseTurnAdded) {
        this.markResponseStarted(
          "assistant_response_container_added",
          "heuristic",
          next
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
        this.responseObserved &&
        !nextActive &&
        previousActive &&
        (
          !this.requireResponseTurnForCompletion ||
          responseTurnConfirmed
        )
      ) {
        this.scheduleCompletion(
          previous.stopVisible
            ? "stop_control_disappeared_after_settle"
            : "response_active_marker_disappeared_after_settle",
          previous.stopVisible ? "derived" : "heuristic"
        );
      } else if (this.responseObserved && !nextActive && responseTurnAdded) {
        this.scheduleCompletion(
          "assistant_response_structure_quiet",
          "heuristic"
        );
      } else if (
        this.responseObserved &&
        !nextActive &&
        responseTurnConfirmed &&
        responsePreviewChanged
      ) {
        this.scheduleCompletion(
          "assistant_response_structure_quiet",
          "heuristic"
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
    queryFirst,
    queryLast,
    selectorList
  };
});
