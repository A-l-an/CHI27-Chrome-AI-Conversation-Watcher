"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement() {
  const listeners = {};
  return {
    className: "",
    disabled: false,
    listeners,
    textContent: "",
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPopupHarness(initialStatus, participantConfig = {
  schema_version: "1.0",
  participant_id: "P99"
}) {
  const elements = Object.fromEntries([
    "#session-status",
    "#start-time",
    "#elapsed-time",
    "#sync-status",
    "#error",
    "#start-session",
    "#stop-session",
    "#cancel-session",
    "#participant-id",
    "#participant-config-note"
  ].map((selector) => [selector, createElement()]));
  const runtimeMessages = [];
  const intervals = [];
  const clearedIntervals = [];
  const windowListeners = {};
  let status = structuredClone(initialStatus);
  let deferRefresh = false;
  const deferredCallbacks = [];
  const chrome = {
    runtime: {
      lastError: null,
      getURL(relative) {
        return `chrome-extension://test/${relative}`;
      },
      sendMessage(message, callback) {
        runtimeMessages.push(structuredClone(message));
        if (
          deferRefresh &&
          message.type === "GET_STUDY_SESSION_STATUS" &&
          runtimeMessages.length > 1
        ) {
          deferredCallbacks.push(callback);
          return;
        }
        callback({ ok: true, status: structuredClone(status) });
      }
    }
  };
  const context = vm.createContext({
    Date,
    chrome,
    fetch: async () => participantConfig === null
      ? { ok: false }
      : { ok: true, async json() { return structuredClone(participantConfig); } },
    clearInterval(timerId) {
      clearedIntervals.push(timerId);
    },
    document: {
      querySelector(selector) {
        return elements[selector];
      }
    },
    setInterval(callback, milliseconds) {
      intervals.push({ callback, milliseconds });
      return intervals.length;
    },
    window: {
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      }
    }
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "participant_config.js"), "utf8"),
    context,
    { filename: "participant_config.js" }
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8"),
    context,
    { filename: "popup.js" }
  );
  return {
    clearedIntervals,
    deferredCallbacks,
    elements,
    intervals,
    runtimeMessages,
    setDeferRefresh(value) {
      deferRefresh = value;
    },
    setStatus(next) {
      status = structuredClone(next);
    },
    windowListeners
  };
}

test("open popup refreshes pending sync status every three seconds and stops on close", async () => {
  const harness = createPopupHarness({
    active: true,
    elapsed_seconds: 10,
    overdue: false,
    pending_count: 1,
    pending_sync: true,
    session_id: "11111111-1111-4111-8111-111111111111",
    start_utc: new Date(Date.now() - 10000).toISOString(),
    timezone: "Asia/Shanghai"
  });
  await flushMicrotasks();
  assert.match(harness.elements["#sync-status"].textContent, /等待 ActivityWatch/);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].milliseconds, 3000);

  harness.setStatus({
    active: true,
    elapsed_seconds: 13,
    overdue: false,
    pending_count: 0,
    pending_sync: false,
    session_id: "11111111-1111-4111-8111-111111111111",
    start_utc: new Date(Date.now() - 13000).toISOString(),
    timezone: "Asia/Shanghai"
  });
  await harness.intervals[0].callback();
  await flushMicrotasks();
  assert.equal(harness.elements["#sync-status"].textContent, "已同步");
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.type === "GET_STUDY_SESSION_STATUS"
    ).length,
    2
  );

  harness.windowListeners.unload();
  assert.deepEqual(harness.clearedIntervals, [1]);
});

test("popup periodic status refresh never overlaps an in-flight request", async () => {
  const harness = createPopupHarness({
    active: false,
    pending_count: 1,
    pending_sync: true
  });
  await flushMicrotasks();
  harness.setDeferRefresh(true);
  const firstTick = harness.intervals[0].callback();
  const secondTick = harness.intervals[0].callback();
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.type === "GET_STUDY_SESSION_STATUS"
    ).length,
    2
  );
  assert.equal(harness.deferredCallbacks.length, 1);
  harness.deferredCallbacks[0]({
    ok: true,
    status: {
      active: false,
      pending_count: 0,
      pending_sync: false
    }
  });
  await firstTick;
  await secondTick;
  await flushMicrotasks();
  assert.equal(harness.elements["#sync-status"].textContent, "已同步");
});

test("popup shows preconfigured participant ID", async () => {
  const harness = createPopupHarness({ active: false, pending_count: 0, pending_sync: false });
  await flushMicrotasks();
  assert.equal(harness.elements["#participant-id"].textContent, "P99");
  assert.match(harness.elements["#participant-config-note"].textContent, /自动使用/);
});

test("popup allows capture but warns that export will stop when unconfigured", async () => {
  const harness = createPopupHarness(
    { active: false, pending_count: 0, pending_sync: false },
    null
  );
  await flushMicrotasks();
  assert.equal(harness.elements["#participant-id"].textContent, "未配置");
  assert.match(harness.elements["#participant-config-note"].textContent, /采集可继续/);
  assert.equal(harness.elements["#start-session"].disabled, false);
});
