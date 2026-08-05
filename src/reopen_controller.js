(function initReopenController(root, factory) {
  const authorityApi = typeof module === "object" && module.exports
    ? require("./authority_client.js")
    : root.AIConversation.AuthorityClient;
  const api = factory(root, authorityApi);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.ReopenController = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function reopenControllerFactory(
  root,
  AuthorityClient
) {
  "use strict";

  const REOPEN_OBSERVATION_TIMEOUT_MS = 4000;
  const TARGET_KEYS = new Set([
    "provider",
    "conversation_key",
    "locator_handle",
    "namespace_generation",
    "namespace_fingerprint"
  ]);
  const CONTEXT_KEYS = new Set([
    "conversation_key",
    "locator_handle",
    "namespace_generation",
    "namespace_fingerprint"
  ]);
  const NOTIFICATION_ID_RE = /^chi27-ai-[0-9a-f-]{36}$/i;
  const SUCCESS_ACTION = "reopened_via_native_actuator";
  const FAILURE_ACTION = "focus_failed";

  function exactKeys(value, expected) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === expected.size &&
      Object.keys(value).every((key) => expected.has(key))
    );
  }

  function canonicalTarget(candidate) {
    if (
      !exactKeys(candidate, TARGET_KEYS) ||
      !["chatgpt", "claude"].includes(candidate.provider) ||
      !AuthorityClient.CONVERSATION_KEY_RE.test(
        candidate.conversation_key || ""
      ) ||
      !AuthorityClient.isValidLocatorHandle(candidate.locator_handle) ||
      !Number.isInteger(candidate.namespace_generation) ||
      candidate.namespace_generation <= 0 ||
      !AuthorityClient.NAMESPACE_FINGERPRINT_RE.test(
        candidate.namespace_fingerprint || ""
      )
    ) {
      throw new Error("invalid_reopen_target");
    }
    return Object.freeze({
      provider: candidate.provider,
      conversation_key: candidate.conversation_key,
      locator_handle: candidate.locator_handle,
      namespace_generation: candidate.namespace_generation,
      namespace_fingerprint: candidate.namespace_fingerprint
    });
  }

  function canonicalObservedContext(candidate) {
    if (
      !exactKeys(candidate, CONTEXT_KEYS) ||
      !AuthorityClient.CONVERSATION_KEY_RE.test(
        candidate.conversation_key || ""
      ) ||
      !AuthorityClient.isValidLocatorHandle(candidate.locator_handle) ||
      !Number.isInteger(candidate.namespace_generation) ||
      candidate.namespace_generation <= 0 ||
      !AuthorityClient.NAMESPACE_FINGERPRINT_RE.test(
        candidate.namespace_fingerprint || ""
      )
    ) {
      return null;
    }
    return Object.freeze({
      conversation_key: candidate.conversation_key,
      locator_handle: candidate.locator_handle,
      namespace_generation: candidate.namespace_generation,
      namespace_fingerprint: candidate.namespace_fingerprint
    });
  }

  function contextMatches(target, observed) {
    return Boolean(
      observed &&
      observed.conversation_key === target.conversation_key &&
      observed.locator_handle === target.locator_handle &&
      observed.namespace_generation === target.namespace_generation &&
      observed.namespace_fingerprint === target.namespace_fingerprint
    );
  }

  function failure(reason) {
    const safeReasons = new Set([
      "authority_not_provisioned",
      "bridge_unavailable",
      "receipt_rejected",
      "namespace_mismatch",
      "identity_mismatch",
      "locator_unavailable",
      "actuator_unavailable",
      "locator_rejected",
      "handle_conflict",
      "capacity_exceeded",
      "provider_not_running",
      "provider_ambiguous",
      "provider_build_rejected",
      "browser_build_rejected",
      "scripting_definition_mismatch",
      "automation_not_authorized",
      "host_action_required",
      "host_command_rejected",
      "unsupported_classic",
      "timeout",
      "attempt_not_found",
      "confirmation_before_actuation",
      "reopen_timeout",
      "reopen_focus_failed",
      "reopen_post_focus_mismatch",
      "reopen_tab_observation_failed",
      "invalid_reopen_target"
    ]);
    return Object.freeze({
      focus_succeeded: false,
      action: FAILURE_ACTION,
      reason: safeReasons.has(reason) ? reason : "authority_unavailable"
    });
  }

  function success() {
    return Object.freeze({
      focus_succeeded: true,
      action: SUCCESS_ACTION,
      reason: "reopen_confirmed"
    });
  }

  class VerifiedReopenController {
    constructor(options) {
      const config = options || {};
      this.authorityClient = config.authorityClient;
      this.listTabs = config.listTabs;
      this.readContext = config.readContext;
      this.providerForTab = config.providerForTab;
      this.focusTab = config.focusTab;
      this.subscribeCandidates = config.subscribeCandidates;
      this.timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : REOPEN_OBSERVATION_TIMEOUT_MS;
      this.setTimer = config.setTimeout || root.setTimeout.bind(root);
      this.clearTimer = config.clearTimeout || root.clearTimeout.bind(root);
      this.inFlight = new Map();
    }

    reopen(notificationId, candidate) {
      if (!NOTIFICATION_ID_RE.test(notificationId || "")) {
        return Promise.resolve(failure("invalid_reopen_target"));
      }
      if (this.inFlight.has(notificationId)) {
        return this.inFlight.get(notificationId);
      }
      let target;
      try {
        target = canonicalTarget(candidate);
      } catch (_error) {
        return Promise.resolve(failure("invalid_reopen_target"));
      }
      const operation = this.run(target).finally(() => {
        if (this.inFlight.get(notificationId) === operation) {
          this.inFlight.delete(notificationId);
        }
      });
      this.inFlight.set(notificationId, operation);
      return operation;
    }

    async run(target) {
      if (
        !this.authorityClient ||
        typeof this.authorityClient.prepareReopenFailClosed !== "function" ||
        typeof this.authorityClient.confirmWebReopenFailClosed !== "function" ||
        typeof this.listTabs !== "function" ||
        typeof this.readContext !== "function" ||
        typeof this.providerForTab !== "function" ||
        typeof this.focusTab !== "function" ||
        typeof this.subscribeCandidates !== "function"
      ) {
        return failure("bridge_unavailable");
      }

      let baselineTabs;
      try {
        baselineTabs = await this.listTabs();
      } catch (_error) {
        return failure("reopen_tab_observation_failed");
      }
      const baselineIds = new Set(
        (Array.isArray(baselineTabs) ? baselineTabs : [])
          .map((tab) => tab && tab.id)
          .filter(Number.isInteger)
      );
      const queued = [];
      let candidateWake = null;
      let preparedAttemptId = null;
      let unsubscribe = () => {};
      try {
        unsubscribe = this.subscribeCandidates((tab) => {
          queued.push({ tab, changedAfterPrepare: true });
          if (candidateWake) {
            const wake = candidateWake;
            candidateWake = null;
            wake();
          }
        });
      } catch (_error) {
        return failure("reopen_tab_observation_failed");
      }

      try {
        const prepared = await this.authorityClient.prepareReopenFailClosed(target);
        if (!prepared || prepared.status !== "attempted") {
          return failure(prepared && prepared.reason);
        }
        preparedAttemptId = prepared.attempt_id;

        let currentTabs;
        try {
          currentTabs = await this.listTabs();
        } catch (_error) {
          return failure("reopen_tab_observation_failed");
        }
        for (const tab of Array.isArray(currentTabs) ? currentTabs : []) {
          queued.push({
            tab,
            changedAfterPrepare: !baselineIds.has(tab && tab.id)
          });
        }

        let deadlineTimer;
        const deadline = new Promise((resolve) => {
          deadlineTimer = this.setTimer(
            () => resolve({ timedOut: true }),
            this.timeoutMs
          );
        });
        const lifecycle = { cancelled: false };
        const observe = this.observeUntilTerminal(
          target,
          prepared,
          queued,
          (wake) => {
            candidateWake = wake;
          },
          lifecycle
        );
        const terminal = await Promise.race([observe, deadline]);
        if (deadlineTimer !== undefined) {
          this.clearTimer(deadlineTimer);
        }
        if (terminal && terminal.timedOut) {
          lifecycle.cancelled = true;
          return failure("reopen_timeout");
        }
        lifecycle.cancelled = true;
        return terminal || failure("authority_unavailable");
      } finally {
        candidateWake = null;
        if (
          preparedAttemptId &&
          typeof this.authorityClient.forgetReopenAttempt === "function"
        ) {
          this.authorityClient.forgetReopenAttempt(preparedAttemptId);
        }
        try {
          unsubscribe();
        } catch (_error) {
          // Listener cleanup is best effort; it never changes a verified result.
        }
      }
    }

    async observeUntilTerminal(
      target,
      prepared,
      queued,
      registerWake,
      lifecycle
    ) {
      while (true) {
        if (lifecycle.cancelled) {
          return failure("reopen_timeout");
        }
        if (!queued.length) {
          await new Promise((resolve) => registerWake(resolve));
          continue;
        }
        const item = queued.shift();
        const tab = item && item.tab;
        if (
          !tab ||
          !Number.isInteger(tab.id) ||
          this.providerForTab(tab) !== target.provider
        ) {
          continue;
        }
        let observed;
        try {
          observed = canonicalObservedContext(await this.readContext(tab.id));
        } catch (_error) {
          observed = null;
        }
        if (lifecycle.cancelled) {
          return failure("reopen_timeout");
        }
        if (!observed) {
          continue;
        }
        const namespaceMatches = (
          observed.namespace_generation === target.namespace_generation &&
          observed.namespace_fingerprint === target.namespace_fingerprint
        );
        const exactMatch = contextMatches(target, observed);
        if (!exactMatch && !item.changedAfterPrepare) {
          continue;
        }

        const confirmed = await this.authorityClient.confirmWebReopenFailClosed({
          provider: target.provider,
          attempt_id: prepared.attempt_id,
          conversation_key: observed.conversation_key,
          locator_handle: observed.locator_handle,
          namespace_generation: observed.namespace_generation,
          namespace_fingerprint: observed.namespace_fingerprint
        });
        if (lifecycle.cancelled) {
          return failure("reopen_timeout");
        }
        if (!namespaceMatches) {
          return failure("namespace_mismatch");
        }
        if (!exactMatch) {
          return failure("identity_mismatch");
        }
        if (!confirmed || confirmed.status !== "confirmed") {
          return failure(confirmed && confirmed.reason);
        }
        if (
          confirmed.attempt_id !== prepared.attempt_id ||
          confirmed.namespace_generation !== target.namespace_generation ||
          confirmed.namespace_fingerprint !== target.namespace_fingerprint
        ) {
          return failure("receipt_rejected");
        }
        try {
          await this.focusTab(tab);
        } catch (_error) {
          return failure("reopen_focus_failed");
        }
        if (lifecycle.cancelled) {
          return failure("reopen_timeout");
        }
        const postFocus = canonicalObservedContext(
          await this.readContext(tab.id).catch(() => null)
        );
        if (!contextMatches(target, postFocus)) {
          return failure("reopen_post_focus_mismatch");
        }
        return success();
      }
    }
  }

  return {
    CONTEXT_KEYS,
    FAILURE_ACTION,
    REOPEN_OBSERVATION_TIMEOUT_MS,
    SUCCESS_ACTION,
    TARGET_KEYS,
    VerifiedReopenController,
    canonicalObservedContext,
    canonicalTarget,
    contextMatches,
    failure,
    success
  };
});
