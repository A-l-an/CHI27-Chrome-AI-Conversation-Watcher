"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  VerifiedReopenController
} = require("../src/reopen_controller.js");

const NOTIFICATION_A = "chi27-ai-00000000-0000-4000-8000-000000000081";
const NOTIFICATION_B = "chi27-ai-00000000-0000-4000-8000-000000000082";
const ATTEMPT_A = `rpa_${"R".repeat(22)}`;
const ATTEMPT_B = `rpa_${"S".repeat(22)}`;
const ATTEMPT_C = `rpa_${"T".repeat(22)}`;
const LOCATOR_A = `loc_${"A".repeat(22)}`;
const LOCATOR_B = `loc_${"B".repeat(22)}`;
const NAMESPACE = {
  namespace_generation: 1,
  namespace_fingerprint: "fixture-namespace-fingerprint"
};
const TARGET_A = Object.freeze({
  provider: "chatgpt",
  conversation_key: "a".repeat(64),
  locator_handle: LOCATOR_A,
  ...NAMESPACE
});
const TARGET_B = Object.freeze({
  provider: "chatgpt",
  conversation_key: "b".repeat(64),
  locator_handle: LOCATOR_B,
  ...NAMESPACE
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

function createHarness(options = {}) {
  const tabs = new Map(
    (options.tabs || []).map((tab) => [tab.id, clone(tab)])
  );
  const contexts = new Map(
    Object.entries(options.contexts || {}).map(
      ([tabId, context]) => [Number(tabId), clone(context)]
    )
  );
  const subscribers = new Set();
  const prepareCalls = [];
  const confirmCalls = [];
  const focusCalls = [];
  let prepareCount = 0;
  let confirmCount = 0;
  const authorityClient = {
    async prepareReopenFailClosed(target) {
      prepareCount += 1;
      prepareCalls.push(clone(target));
      if (typeof options.prepare === "function") {
        return options.prepare(clone(target), prepareCount);
      }
      return {
        status: "attempted",
        attempt_id: [ATTEMPT_A, ATTEMPT_B, ATTEMPT_C][prepareCount - 1] ||
          `rpa_${"Z".repeat(22)}`,
        ...NAMESPACE
      };
    },
    async confirmWebReopenFailClosed(observed) {
      confirmCount += 1;
      confirmCalls.push(clone(observed));
      if (typeof options.confirm === "function") {
        return options.confirm(clone(observed), confirmCount);
      }
      return {
        status: "confirmed",
        reason: "reopen_confirmed",
        attempt_id: observed.attempt_id,
        namespace_generation: observed.namespace_generation,
        namespace_fingerprint: observed.namespace_fingerprint
      };
    }
  };
  const controller = new VerifiedReopenController({
    authorityClient,
    timeoutMs: options.timeoutMs || 100,
    async listTabs() {
      return Array.from(tabs.values()).map(clone);
    },
    async readContext(tabId) {
      return clone(contexts.get(tabId) || null);
    },
    providerForTab(tab) {
      if (tab.provider) {
        return tab.provider;
      }
      try {
        const host = new URL(tab.url).hostname;
        return host === "chatgpt.com"
          ? "chatgpt"
          : host === "claude.ai" ? "claude" : null;
      } catch (_error) {
        return null;
      }
    },
    async focusTab(tab) {
      focusCalls.push(tab.id);
      if (options.focusError) {
        throw new Error("synthetic focus failure");
      }
    },
    subscribeCandidates(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    }
  });
  return {
    authorityClient,
    confirmCalls,
    controller,
    focusCalls,
    prepareCalls,
    emit(tab, context) {
      tabs.set(tab.id, clone(tab));
      contexts.set(tab.id, clone(context));
      for (const subscriber of subscribers) {
        subscriber(clone(tab));
      }
    }
  };
}

test("missing tab prepares once, confirms exact A, and only then reports focus success", async () => {
  const harness = createHarness();
  const resultPromise = harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  await waitFor(() => harness.prepareCalls.length === 1, "prepare was not sent");
  harness.emit({
    id: 21,
    provider: "chatgpt",
    url: "https://chatgpt.com/c/RAW_URL_CANARY"
  }, {
    conversation_key: TARGET_A.conversation_key,
    locator_handle: TARGET_A.locator_handle,
    ...NAMESPACE
  });
  const result = await resultPromise;
  assert.deepEqual(result, {
    focus_succeeded: true,
    action: "reopened_via_native_actuator",
    reason: "reopen_confirmed"
  });
  assert.equal(harness.confirmCalls.length, 1);
  assert.equal(harness.confirmCalls[0].attempt_id, ATTEMPT_A);
  assert.deepEqual(harness.focusCalls, [21]);
});

test("a changed tab that resolves to B is confirmed as an observation but never succeeds for A", async () => {
  const harness = createHarness({
    confirm: (observed) => ({
      status: "failed",
      reason: "identity_mismatch",
      attempt_id: observed.attempt_id,
      ...NAMESPACE
    })
  });
  const resultPromise = harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  await waitFor(() => harness.prepareCalls.length === 1, "prepare was not sent");
  harness.emit({ id: 22, provider: "chatgpt" }, {
    conversation_key: TARGET_B.conversation_key,
    locator_handle: TARGET_B.locator_handle,
    ...NAMESPACE
  });
  const result = await resultPromise;
  assert.equal(result.focus_succeeded, false);
  assert.equal(result.reason, "identity_mismatch");
  assert.equal(harness.confirmCalls.length, 1);
  assert.equal(harness.focusCalls.length, 0);
});

test("bounded wait times out without polling or a false success", async () => {
  const harness = createHarness({ timeoutMs: 5 });
  const result = await harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  assert.equal(result.focus_succeeded, false);
  assert.equal(result.reason, "reopen_timeout");
  assert.equal(harness.prepareCalls.length, 1);
  assert.equal(harness.confirmCalls.length, 0);
  assert.equal(harness.focusCalls.length, 0);
});

test("a confirm response arriving after the deadline cannot focus or resurrect success", async () => {
  let releaseConfirm;
  const harness = createHarness({
    timeoutMs: 5,
    confirm: (observed) => new Promise((resolve) => {
      releaseConfirm = () => resolve({
        status: "confirmed",
        attempt_id: observed.attempt_id,
        namespace_generation: observed.namespace_generation,
        namespace_fingerprint: observed.namespace_fingerprint
      });
    })
  });
  const resultPromise = harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  await waitFor(() => harness.prepareCalls.length === 1, "prepare was not sent");
  harness.emit({ id: 29, provider: "chatgpt" }, {
    conversation_key: TARGET_A.conversation_key,
    locator_handle: TARGET_A.locator_handle,
    ...NAMESPACE
  });
  await waitFor(() => typeof releaseConfirm === "function", "confirm did not start");
  const result = await resultPromise;
  assert.equal(result.reason, "reopen_timeout");
  releaseConfirm();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(harness.focusCalls.length, 0);
});

test("namespace rotation and invalid receipt are fixed fail-closed outcomes", async () => {
  const rotated = createHarness();
  const rotatedPromise = rotated.controller.reopen(NOTIFICATION_A, TARGET_A);
  await waitFor(() => rotated.prepareCalls.length === 1, "prepare was not sent");
  rotated.emit({ id: 23, provider: "chatgpt" }, {
    conversation_key: TARGET_A.conversation_key,
    locator_handle: TARGET_A.locator_handle,
    namespace_generation: 2,
    namespace_fingerprint: "fixture-namespace-fingerprint-v2"
  });
  assert.equal((await rotatedPromise).reason, "namespace_mismatch");

  const invalidReceipt = createHarness({
    prepare: () => ({ status: "unavailable", reason: "receipt_rejected" })
  });
  const invalid = await invalidReceipt.controller.reopen(
    NOTIFICATION_A,
    TARGET_A
  );
  assert.equal(invalid.focus_succeeded, false);
  assert.equal(invalid.reason, "receipt_rejected");
});

test("bridge unavailable stops before tab observation and actuator acceptance is not success", async () => {
  const unavailable = createHarness({
    prepare: () => ({ status: "unavailable", reason: "bridge_unavailable" })
  });
  const failed = await unavailable.controller.reopen(NOTIFICATION_A, TARGET_A);
  assert.equal(failed.focus_succeeded, false);
  assert.equal(failed.reason, "bridge_unavailable");

  const attemptedOnly = createHarness({ timeoutMs: 5 });
  const attempted = await attemptedOnly.controller.reopen(
    NOTIFICATION_A,
    TARGET_A
  );
  assert.equal(attempted.focus_succeeded, false);
  assert.equal(attempted.reason, "reopen_timeout");
});

test("duplicate clicks share one in-flight attempt; a later A/B/A sequence uses fresh attempts", async () => {
  let releasePrepare;
  const harness = createHarness({
    prepare: (_target, count) => count === 1
      ? new Promise((resolve) => {
          releasePrepare = () => resolve({
            status: "attempted",
            attempt_id: ATTEMPT_A,
            ...NAMESPACE
          });
        })
      : {
          status: "attempted",
          attempt_id: count === 2 ? ATTEMPT_B : ATTEMPT_C,
          ...NAMESPACE
        },
    timeoutMs: 5
  });
  const first = harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  const duplicate = harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  assert.equal(first, duplicate);
  await waitFor(() => typeof releasePrepare === "function", "prepare did not block");
  releasePrepare();
  assert.equal((await first).reason, "reopen_timeout");
  assert.equal(harness.prepareCalls.length, 1);

  const second = harness.controller.reopen(NOTIFICATION_B, TARGET_B);
  await waitFor(() => harness.prepareCalls.length === 2, "fresh B attempt missing");
  assert.equal((await second).reason, "reopen_timeout");
  const third = harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  await waitFor(() => harness.prepareCalls.length === 3, "fresh A attempt missing");
  assert.equal((await third).reason, "reopen_timeout");
  assert.equal(harness.prepareCalls.length, 3);
});

test("bridge-visible and durable test material contains no raw URL or provider ID", async () => {
  const rawId = "raw_provider_id_canary_987";
  const rawUrl = `https://chatgpt.com/c/${rawId}?secret=1`;
  const harness = createHarness({ timeoutMs: 5 });
  await harness.controller.reopen(NOTIFICATION_A, TARGET_A);
  const wireProjection = JSON.stringify({
    prepare: harness.prepareCalls,
    confirm: harness.confirmCalls,
    focus: harness.focusCalls
  });
  assert.doesNotMatch(wireProjection, new RegExp(rawId));
  assert.doesNotMatch(wireProjection, /https?:\/\//);
  assert.equal(rawUrl.includes(rawId), true);
});
