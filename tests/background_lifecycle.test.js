"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { buildActivityWatchEvent } = require("../src/core.js");
const {
  canonicalReceiptPayload,
  canonicalReopenReceiptPayload
} = require("../src/authority_client.js");
const { ClaudeAdapter } = require("../src/adapters/claude.js");
const { ConversationStateMachine } = require("../src/state_machine.js");
const PrivateReturnCues = require("../src/private_return_cues.js");
const zlib = require("node:zlib");

const EXTENSION_ROOT = path.join(__dirname, "..");
const FIXTURE_EXTENSION_ID = "a".repeat(32);
const CHATGPT_LOCATOR = `loc_${"A".repeat(22)}`;
const CLAUDE_LOCATOR = `loc_${"B".repeat(22)}`;
const DIFFERENT_LOCATOR = `loc_${"C".repeat(22)}`;
const AUTHORITY_KEY_PAIR = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});
const AUTHORITY_PUBLIC_JWK = AUTHORITY_KEY_PAIR.publicKey.export({
  format: "jwk"
});
const AUTHORITY_PUBLIC_X963 = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(AUTHORITY_PUBLIC_JWK.x, "base64url"),
  Buffer.from(AUTHORITY_PUBLIC_JWK.y, "base64url")
]).toString("base64");
const AUTHORITY_PROVISIONING = Object.freeze({
  native_host_name: "org.chi27.attention.browserbridge",
  expected_extension_id: FIXTURE_EXTENSION_ID,
  namespace_generation: 1,
  namespace_fingerprint: "fixture-namespace-fingerprint",
  authority_public_key_x963_base64: AUTHORITY_PUBLIC_X963
});

function signedNativeAuthorityResponse(request, overrides = {}) {
  const response = Object.assign({
    schema_version: "1.0",
    status: "issued",
    request_id: request.request_id,
    conversation_key: request.conversation_key || "a".repeat(64),
    locator_handle:
      request.locator_handle || CHATGPT_LOCATOR,
    namespace_generation: request.namespace_generation,
    namespace_fingerprint: request.namespace_fingerprint
  }, overrides);
  const payload = canonicalReceiptPayload(request, response);
  response.receipt = {
    payload: Buffer.from(payload, "utf8").toString("base64"),
    signature: crypto.sign(
      "sha256",
      Buffer.from(payload, "utf8"),
      AUTHORITY_KEY_PAIR.privateKey
    ).toString("base64")
  };
  return response;
}

const REOPEN_ATTEMPT_ID = `rpa_${"R".repeat(22)}`;

function signedNativeReopenResponse(
  request,
  targetBinding,
  overrides = {}
) {
  const response = Object.assign({
    schema_version: "1.0",
    status: request.type === "prepare_reopen" ? "attempted" : "confirmed",
    request_id: request.request_id,
    attempt_id: request.attempt_id || REOPEN_ATTEMPT_ID,
    namespace_generation: request.namespace_generation,
    namespace_fingerprint: request.namespace_fingerprint
  }, overrides);
  const payload = canonicalReopenReceiptPayload(
    request,
    response,
    targetBinding || request
  );
  response.receipt = {
    payload: Buffer.from(payload, "utf8").toString("base64"),
    signature: crypto.sign(
      "sha256",
      Buffer.from(payload, "utf8"),
      AUTHORITY_KEY_PAIR.privateKey
    ).toString("base64")
  };
  return response;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function createFakeClock(startMs = Date.parse("2026-07-30T00:00:00.000Z")) {
  let nowMs = startMs;
  let nextTimerId = 1;
  const timers = new Map();
  return {
    Date: class FakeDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [nowMs]));
      }

      static now() {
        return nowMs;
      }
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    async advance(milliseconds) {
      const targetMs = nowMs + milliseconds;
      while (true) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.dueMs <= targetMs)
          .sort((left, right) => left[1].dueMs - right[1].dueMs)[0];
        if (!due) {
          break;
        }
        const [timerId, timer] = due;
        timers.delete(timerId);
        nowMs = timer.dueMs;
        await timer.callback();
        await Promise.resolve();
      }
      nowMs = targetMs;
      await Promise.resolve();
    },
    now() {
      return nowMs;
    },
    setTimeout(callback, delay = 0) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, {
        callback,
        dueMs: nowMs + Math.max(0, Number(delay) || 0)
      });
      return timerId;
    }
  };
}

function createBackgroundHarness(fetchImpl, options = {}) {
  const clock = options.clock || createFakeClock();
  const storage = clone(options.initialStorage || {});
  let participantConfig = Object.hasOwn(options, "participantConfig")
    ? clone(options.participantConfig)
    : { schema_version: "1.0", participant_id: "P99" };
  const fetchCalls = [];
  const alarmsCreated = [];
  const alarmsCleared = [];
  const actionUpdates = [];
  const consoleErrors = [];
  const notificationsCreated = [];
  const notificationsCleared = [];
  const deferredWindowUpdates = [];
  let deferredQueueMigrationRead = null;
  let queueMigrationReadWasDeferred = false;
  const activeNotifications = new Set(options.activeNotifications || []);
  const tabsCreated = [];
  const tabsUpdated = [];
  const windowsCreated = [];
  const windowsUpdated = [];
  const nativeMessages = [];
  const tabs = new Map(
    Object.entries(options.tabs || {}).map(([id, tab]) => [Number(id), clone(tab)])
  );
  const tabContexts = clone(options.tabContexts || {});
  const windows = new Map(
    Object.entries(options.windows || {}).map(
      ([id, window]) => [Number(id), clone(window)]
    )
  );
  const listeners = {
    alarms: [],
    messages: [],
    notificationClicks: [],
    tabCreated: [],
    tabUpdated: []
  };
  let nextTabId = 100;
  let nextWindowId = 100;
  let nativeMessageCount = 0;
  const tabContextReads = new Map();

  function withLastError(message, callback, value) {
    chrome.runtime.lastError = { message };
    callback(value);
    chrome.runtime.lastError = null;
  }

  const chrome = {
    action: {
      setBadgeBackgroundColor(details) {
        actionUpdates.push({ method: "setBadgeBackgroundColor", details: clone(details) });
        return Promise.resolve();
      },
      setBadgeText(details) {
        actionUpdates.push({ method: "setBadgeText", details: clone(details) });
        return Promise.resolve();
      },
      setTitle(details) {
        actionUpdates.push({ method: "setTitle", details: clone(details) });
        return Promise.resolve();
      }
    },
    alarms: {
      clear(name, callback) {
        alarmsCleared.push(name);
        callback(true);
      },
      create(name, details) {
        alarmsCreated.push({ name, details: clone(details) });
        return Promise.resolve();
      },
      get(_name, callback) {
        callback(null);
      },
      onAlarm: {
        addListener(listener) {
          listeners.alarms.push(listener);
        }
      }
    },
    notifications: {
      getPermissionLevel(callback) {
        if (options.notificationPermissionError) {
          withLastError(options.notificationPermissionError, callback);
          return;
        }
        callback(options.notificationPermissionLevel || "granted");
      },
      clear(id, callback) {
        notificationsCleared.push(id);
        if (options.notificationClearError) {
          withLastError(options.notificationClearError, callback);
          return;
        }
        const matched = options.notificationClearMatched === false
          ? false
          : activeNotifications.has(id);
        if (matched) {
          activeNotifications.delete(id);
        }
        callback(matched);
      },
      create(id, payload, callback) {
        if (options.notificationCreateError) {
          withLastError(options.notificationCreateError, callback);
          return;
        }
        notificationsCreated.push({ id, payload: clone(payload) });
        activeNotifications.add(id);
        callback(id);
      },
      onClicked: {
        addListener(listener) {
          listeners.notificationClicks.push(listener);
        }
      }
    },
    runtime: {
      getURL(relativePath) {
        return `chrome-extension://${FIXTURE_EXTENSION_ID}/${relativePath}`;
      },
      id: FIXTURE_EXTENSION_ID,
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          listeners.messages.push(listener);
        }
      },
      onStartup: { addListener() {} },
      sendNativeMessage(_hostName, message, callback) {
        nativeMessageCount += 1;
        nativeMessages.push(clone(message));
        if (
          options.nativeMessageNoCallback ||
          Number.isInteger(options.nativeMessageNoCallbackAfter) &&
            nativeMessageCount > options.nativeMessageNoCallbackAfter
        ) {
          return;
        }
        const response = typeof options.nativeResponseFactory === "function"
          ? options.nativeResponseFactory(clone(message))
          : signedNativeAuthorityResponse(message);
        callback(clone(response));
      }
    },
    storage: {
      local: {
        get(keys, callback) {
          const requested = Array.isArray(keys) ? keys : [keys];
          const result = {};
          for (const key of requested) {
            if (Object.hasOwn(storage, key)) {
              result[key] = clone(storage[key]);
            }
          }
          if (
            options.deferQueueMigrationRead &&
            !queueMigrationReadWasDeferred &&
            requested.includes("legacy_reliable_event_queue_quarantine_v1")
          ) {
            queueMigrationReadWasDeferred = true;
            deferredQueueMigrationRead = () => callback(result);
            return;
          }
          callback(result);
        },
        set(values, callback) {
          Object.assign(storage, clone(values));
          callback();
        }
      }
    },
    tabs: {
      create(details, callback) {
        if (options.tabCreateError) {
          withLastError(options.tabCreateError, callback);
          return;
        }
        const tab = {
          active: details.active !== false,
          id: nextTabId,
          url: details.url,
          windowId: Number.isInteger(details.windowId)
            ? details.windowId
            : 1
        };
        nextTabId += 1;
        tabs.set(tab.id, tab);
        tabsCreated.push(clone(tab));
        callback(clone(tab));
      },
      get(tabId, callback) {
        if (options.tabGetNullWithoutError) {
          callback(null);
          return;
        }
        if (options.tabGetError) {
          withLastError(options.tabGetError, callback);
          return;
        }
        if (!tabs.has(tabId)) {
          withLastError(`No tab with id: ${tabId}.`, callback);
          return;
        }
        callback(clone(tabs.get(tabId)));
      },
      sendMessage(tabId, message, callback) {
        if (message.type === "GET_OPAQUE_CONVERSATION_CONTEXT") {
          const configured = tabContexts[tabId] || null;
          if (Array.isArray(configured)) {
            const index = tabContextReads.get(tabId) || 0;
            tabContextReads.set(tabId, index + 1);
            callback(clone(configured[Math.min(index, configured.length - 1)]));
          } else {
            callback(clone(configured));
          }
          return;
        }
        callback();
      },
      update(tabId, details, callback) {
        if (options.tabUpdateError || !tabs.has(tabId)) {
          withLastError("Unable to update tab", callback);
          return;
        }
        const updated = Object.assign({}, tabs.get(tabId), details);
        tabs.set(tabId, updated);
        tabsUpdated.push({ id: tabId, details: clone(details) });
        callback(clone(updated));
      },
      query(_queryInfo, callback) {
        if (options.tabQueryError) {
          withLastError("Unable to query tabs", callback);
          return;
        }
        callback(Array.from(tabs.values()).map(clone));
      },
      onCreated: {
        addListener(listener) {
          listeners.tabCreated.push(listener);
        }
      },
      onUpdated: {
        addListener(listener) {
          listeners.tabUpdated.push(listener);
        }
      }
    },
    webNavigation: {
      onCommitted: { addListener() {} },
      onHistoryStateUpdated: { addListener() {} },
      onReferenceFragmentUpdated: { addListener() {} }
    },
    windows: {
      create(details, callback) {
        if (options.windowCreateError) {
          withLastError(options.windowCreateError, callback);
          return;
        }
        const window = {
          focused: details.focused !== false,
          id: nextWindowId,
          url: details.url
        };
        nextWindowId += 1;
        windows.set(window.id, window);
        windowsCreated.push(clone(window));
        callback(clone(window));
      },
      get(windowId, callback) {
        if (!windows.has(windowId)) {
          withLastError("No window with id", callback);
          return;
        }
        callback(clone(windows.get(windowId)));
      },
      update(windowId, details, callback) {
        if (options.windowUpdateError || !windows.has(windowId)) {
          withLastError("Unable to update window", callback);
          return;
        }
        const completeUpdate = () => {
          const updated = Object.assign({}, windows.get(windowId), details);
          windows.set(windowId, updated);
          windowsUpdated.push({ id: windowId, details: clone(details) });
          callback(clone(updated));
        };
        if (options.deferWindowUpdate) {
          deferredWindowUpdates.push(completeUpdate);
        } else {
          completeUpdate();
        }
      }
    }
  };

  const context = vm.createContext({
    AbortController,
    Date: clock.Date,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    btoa,
    chrome,
    clearTimeout: clock.clearTimeout,
    console: {
      error(...values) {
        consoleErrors.push(values.map(String).join(" "));
      },
      log() {},
      warn() {}
    },
    crypto: crypto.webcrypto,
    fetch: async (url, options = {}) => {
      const call = {
        body: options.body,
        method: options.method || "GET",
        url: String(url)
      };
      fetchCalls.push(call);
      if (
        call.url ===
          `chrome-extension://${FIXTURE_EXTENSION_ID}/participant_config.json`
      ) {
        if (participantConfig === null) {
          return { ok: false, status: 404 };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return clone(participantConfig);
          }
        };
      }
      return fetchImpl(call);
    },
    setTimeout: clock.setTimeout
  });

  context.importScripts = (...relativePaths) => {
    for (const relativePath of relativePaths) {
      const source = fs.readFileSync(
        path.join(EXTENSION_ROOT, relativePath),
        "utf8"
      );
      vm.runInContext(source, context, { filename: relativePath });
      if (
        relativePath === "src/authority_provisioning.js" &&
        options.authorityProvisioning
      ) {
        context.AIConversation.AuthorityProvisioning.PROVISIONING =
          Object.freeze(clone(options.authorityProvisioning));
      }
    }
  };

  const source = fs.readFileSync(
    path.join(EXTENSION_ROOT, "background.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "background.js" });

  return {
    actionUpdates,
    alarmsCreated,
    alarmsCleared,
    clock,
    consoleErrors,
    deferredWindowUpdates,
    hasDeferredQueueMigrationRead() {
      return typeof deferredQueueMigrationRead === "function";
    },
    releaseQueueMigrationRead() {
      if (!deferredQueueMigrationRead) {
        return false;
      }
      const release = deferredQueueMigrationRead;
      deferredQueueMigrationRead = null;
      release();
      return true;
    },
    fetchCalls,
    listeners,
    nativeMessages,
    notificationsCleared,
    notificationsCreated,
    setParticipantConfig(value) {
      participantConfig = clone(value);
    },
    storage,
    tabsCreated,
    tabsUpdated,
    emitTabCreated(tab, contextValue) {
      tabs.set(tab.id, clone(tab));
      tabContexts[tab.id] = clone(contextValue);
      for (const listener of listeners.tabCreated) {
        listener(clone(tab));
      }
    },
    emitTabUpdated(tab, changeInfo, contextValue) {
      tabs.set(tab.id, clone(tab));
      tabContexts[tab.id] = clone(contextValue);
      for (const listener of listeners.tabUpdated) {
        listener(tab.id, clone(changeInfo), clone(tab));
      }
    },
    setTabContext(tabId, contextValue) {
      tabContexts[tabId] = clone(contextValue);
    },
    windowsCreated,
    windowsUpdated
  };
}

function successfulResponse() {
  return { ok: true, status: 200 };
}

function eventWrites(harness) {
  return harness.fetchCalls.filter(
    (call) => call.method === "POST" && call.url.endsWith("/events")
  );
}

function writtenEvents(harness) {
  return eventWrites(harness).flatMap((call) => JSON.parse(call.body));
}

function sessionEventWrites(harness) {
  return harness.fetchCalls.filter(
    (call) =>
      call.method === "POST" &&
      call.url.endsWith("/api/0/buckets/aw-watcher-study-sessions/events")
  );
}

function writtenSessionEvents(harness) {
  return sessionEventWrites(harness).flatMap((call) => JSON.parse(call.body));
}

async function sendRuntimeMessage(harness, message, sender = {}) {
  assert.equal(harness.listeners.messages.length, 1);
  return new Promise((resolve, reject) => {
    const keepChannelOpen = harness.listeners.messages[0](
      message,
      sender,
      resolve
    );
    if (keepChannelOpen !== true) {
      reject(new Error("background did not keep the response channel open"));
    }
  });
}

function createContentBridgeHarness(backgroundHarness, options = {}) {
  const initialUrl = options.initialUrl || "https://chatgpt.com/";
  const location = { href: initialUrl };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervalCallbacks = [];
  const contentWarnings = [];
  const sentMessages = [];
  let mutationCallback = null;
  let stopVisible = false;
  function responseTurn(text, messageId) {
    return {
      innerText: text,
      textContent: text,
      getAttribute(name) {
        return name === "data-message-id" ? messageId : null;
      },
      contains(candidate) {
        return candidate === this;
      }
    };
  }
  let responseTurns = options.initialResponsePreview
    ? [responseTurn(options.initialResponsePreview, "fixture-message-old")]
    : [];
  const composer = {
    nodeType: 1,
    textContent: "fixture prompt",
    closest(selector) {
      return selector === "#prompt-textarea" ? this : null;
    }
  };
  const sendButton = {
    nodeType: 1,
    closest(selector) {
      return selector === "button[data-testid='send-button']" ? this : null;
    }
  };
  const document = {
    documentElement: {},
    visibilityState: "hidden",
    hasFocus() {
      return false;
    },
    addEventListener(type, listener) {
      const registered = documentListeners.get(type) || [];
      registered.push(listener);
      documentListeners.set(type, registered);
    },
    removeEventListener() {},
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='send-button']") {
        return sendButton;
      }
      if (selector === "button[data-testid='stop-button']") {
        return stopVisible ? {} : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-message-author-role='assistant']"
        ? responseTurns
        : [];
    }
  };
  const contentMessageListeners = [];
  const contentChrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          contentMessageListeners.push(listener);
        }
      },
      sendMessage(message, callback) {
        const plainMessage = clone(message);
        sentMessages.push(plainMessage);
        const tabUrl = location.href;
        const sender = {
          id: FIXTURE_EXTENSION_ID,
          frameId: 0,
          url: options.staleDocumentUrl ? initialUrl : tabUrl,
          tab: { id: 7, url: tabUrl, windowId: 2 }
        };
        const backgroundListener = backgroundHarness.listeners.messages[0];
        backgroundListener(plainMessage, sender, (response) => {
          const completionEnqueue = (
            plainMessage.type === "ENQUEUE_EVENTS" &&
            plainMessage.events.some(
              (event) =>
                event.data.event_type === "assistant_response_completed"
            )
          );
          if (options.disconnectCompletionEnqueue && completionEnqueue) {
            contentChrome.runtime.lastError = {
              message: "The message port closed before a response was received."
            };
            callback();
            contentChrome.runtime.lastError = null;
            return;
          }
          callback(clone(response));
        });
      }
    }
  };
  const context = vm.createContext({
    Date: backgroundHarness.clock.Date,
    MutationObserver: class FixtureMutationObserver {
      constructor(callback) {
        mutationCallback = callback;
      }

      disconnect() {}

      observe() {}
    },
    TextEncoder,
    URL,
    chrome: contentChrome,
    clearTimeout: backgroundHarness.clock.clearTimeout,
    console: {
      error() {},
      log() {},
      warn(...values) {
        contentWarnings.push(values.map(String).join(" "));
      }
    },
    crypto: crypto.webcrypto,
    document,
    history: {
      pushState(_state, _title, nextUrl) {
        location.href = new URL(nextUrl, location.href).href;
      },
      replaceState(_state, _title, nextUrl) {
        location.href = new URL(nextUrl, location.href).href;
      }
    },
    location,
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    setTimeout: backgroundHarness.clock.setTimeout,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    }
  });
  const scripts = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_ROOT, "manifest.json"), "utf8")
  ).content_scripts[0].js;
  for (const script of scripts) {
    vm.runInContext(
      fs.readFileSync(path.join(EXTENSION_ROOT, script), "utf8"),
      context,
      { filename: script }
    );
  }
  return {
    contentWarnings,
    sentMessages,
    async bindCanonicalChatGptRoute() {
      context.history.pushState({}, "", "/c/chat_fixture_123");
      await waitFor(
        () => writtenEvents(backgroundHarness).some(
          (event) => event.data.event_type === "conversation_bound"
        ),
        "content route did not bind provisional ChatGPT identity to exact"
      );
    },
    async completeHiddenResponse(preview = "fixture completed answer preview") {
      for (const listener of documentListeners.get("click") || []) {
        listener({ target: sendButton });
      }
      await waitFor(
        () => writtenEvents(backgroundHarness).some(
          (event) => event.data.event_type === "prompt_submitted"
        ),
        "actual content click did not enqueue prompt_submitted"
      );
      stopVisible = true;
      mutationCallback();
      await backgroundHarness.clock.advance(100);
      await waitFor(
        () => writtenEvents(backgroundHarness).some(
          (event) => event.data.event_type === "assistant_response_started"
        ),
        "actual content mutation did not enqueue response started"
      );
      responseTurns = [responseTurn(preview, "fixture-message-new")];
      stopVisible = false;
      mutationCallback();
      await backgroundHarness.clock.advance(100);
      await backgroundHarness.clock.advance(800);
      await waitFor(
        () => writtenEvents(backgroundHarness).some(
          (event) => event.data.event_type === "assistant_response_completed"
        ),
        "actual content settle did not enqueue response completed"
      );
    }
  };
}

test("real background lifecycle creates bucket, writes startup/periodic health, and verifies settings", async () => {
  const harness = createBackgroundHarness(() => successfulResponse());

  await waitFor(
    () => eventWrites(harness).length === 1,
    "startup heartbeat was not written"
  );

  assert.deepEqual(
    harness.alarmsCreated.map((alarm) => [alarm.name, alarm.details.periodInMinutes]),
    [
      ["flush-ai-conversation-events", 0.5],
      ["write-ai-conversation-heartbeat", 1]
    ]
  );
  assert.equal(
    harness.fetchCalls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith("/api/0/buckets/aw-watcher-ai-conversations")
    ),
    true
  );

  const startupEvents = JSON.parse(eventWrites(harness)[0].body);
  assert.equal(startupEvents.length, 1);
  assert.equal(startupEvents[0].data.event_type, "watcher_heartbeat");
  assert.equal(startupEvents[0].data.metadata.signal, "worker_initialized");
  assert.equal(
    harness.storage.reliable_event_queue_v1.acknowledged.length,
    1
  );

  harness.listeners.alarms[0]({
    name: "write-ai-conversation-heartbeat"
  });
  await waitFor(
    () => eventWrites(harness).length === 2,
    "periodic heartbeat was not written"
  );
  const periodicEvents = JSON.parse(eventWrites(harness)[1].body);
  assert.equal(periodicEvents[0].data.metadata.signal, "sixty_second_alarm");

  const connection = await sendRuntimeMessage(harness, {
    type: "TEST_CONNECTION"
  });
  assert.deepEqual(
    clone(connection),
    {
      ok: true,
      bucket_id: "aw-watcher-ai-conversations",
      session_bucket_id: "aw-watcher-study-sessions"
    }
  );
  assert.equal(
    harness.fetchCalls.some(
      (call) =>
        call.method === "GET" &&
        call.url.endsWith("/api/0/buckets/aw-watcher-ai-conversations")
    ),
    true
  );
  assert.equal(harness.storage.background_diagnostics_v1, undefined);
});

test("background failure diagnostics contain only a timestamped safe code, retry count, and HTTP status", async () => {
  const harness = createBackgroundHarness((call) => {
    if (
      call.method === "POST" &&
      call.url.endsWith("/api/0/buckets/aw-watcher-ai-conversations")
    ) {
      return { ok: false, status: 503 };
    }
    return successfulResponse();
  });

  await waitFor(
    () =>
      Array.isArray(harness.storage.background_diagnostics_v1) &&
      harness.storage.background_diagnostics_v1.length > 0,
    "startup failure diagnostic was not persisted"
  );

  const diagnostic = harness.storage.background_diagnostics_v1[0];
  assert.deepEqual(
    Object.keys(diagnostic).sort(),
    ["code", "http_status", "retry_count", "timestamp"]
  );
  assert.equal(diagnostic.code, "activitywatch_bucket_create_http");
  assert.equal(diagnostic.retry_count, 1);
  assert.equal(diagnostic.http_status, 503);
  assert.equal(Number.isFinite(Date.parse(diagnostic.timestamp)), true);
  const output = harness.consoleErrors.join("\n");
  assert.doesNotMatch(output, /https?:\/\//);
  assert.doesNotMatch(output, /\/api\//);
  assert.doesNotMatch(output, /"body"/);
  assert.doesNotMatch(output, /source_event_id/);
});

test("identical conversation and session bucket IDs fail closed before init, connection test, or session start writes", async () => {
  const harness = createBackgroundHarness(
    () => successfulResponse(),
    {
      initialStorage: {
        bucket_id: "shared-study-bucket",
        session_bucket_id: "shared-study-bucket"
      }
    }
  );
  await waitFor(
    () => (
      Array.isArray(harness.storage.background_diagnostics_v1) &&
      harness.storage.background_diagnostics_v1.some(
        (diagnostic) =>
          diagnostic.code === "config_bucket_ids_not_distinct"
      )
    ),
    "distinct bucket diagnostic was not written"
  );

  assert.deepEqual(harness.fetchCalls, []);
  assert.equal(
    harness.storage.reliable_event_queue_v1.pending.length,
    1
  );

  const connection = await sendRuntimeMessage(harness, {
    type: "TEST_CONNECTION"
  });
  assert.deepEqual(clone(connection), {
    ok: false,
    error_code: "config_bucket_ids_not_distinct",
    http_status: null
  });

  const started = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    {
      id: FIXTURE_EXTENSION_ID,
      url: `chrome-extension://${FIXTURE_EXTENSION_ID}/popup.html`
    }
  );
  assert.deepEqual(clone(started), {
    ok: false,
    error_code: "config_bucket_ids_not_distinct"
  });
  assert.equal(harness.storage.study_session_state_v1, undefined);
  assert.equal(harness.storage.study_session_event_queue_v1, undefined);
  assert.deepEqual(harness.fetchCalls, []);
});

const TARGET_URL = "https://chatgpt.com/c/chat_fixture_123";
const NOTIFICATION_PREVIEW_CANARY =
  "这是一段只应出现在系统通知中的回答预览。";
const TARGET_SENDER = {
  id: FIXTURE_EXTENSION_ID,
  frameId: 0,
  url: TARGET_URL,
  tab: {
    id: 7,
    url: TARGET_URL,
    windowId: 2
  }
};
const NOTIFICATION_REQUEST = {
  type: "SHOW_TRACKER_NOTIFICATION",
  provider: "chatgpt",
  context: {
    identity: {
      conversation_key: "a".repeat(64),
      identity_status: "exact",
      locator_handle: CHATGPT_LOCATOR,
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    }
  },
  reason_code: "response_completed_while_hidden",
  notification_preview: NOTIFICATION_PREVIEW_CANARY
};
const EXTENSION_PAGE_SENDER = {
  id: FIXTURE_EXTENSION_ID,
  url: `chrome-extension://${FIXTURE_EXTENSION_ID}/popup.html`
};
const OPTIONS_PAGE_SENDER = {
  id: FIXTURE_EXTENSION_ID,
  url: `chrome-extension://${FIXTURE_EXTENSION_ID}/options.html`
};

function rawPromptEvent() {
  return buildActivityWatchEvent({
    provider: "chatgpt",
    event_type: "prompt_submitted",
    turn_link_id: "10000000-0000-4000-8000-000000000001",
    source_event_id: "00000000-0000-4000-8000-000000000001",
    occurred_at: "2026-07-30T00:00:01.000Z",
    observed_at: "2026-07-30T00:00:01.010Z",
    conversation: {
      conversation_key: "a".repeat(64),
      identity_status: "exact",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    },
    confidence: "derived",
    source_adapter: "chatgpt-dom-v1",
    metadata: {
      signal: "send_control_clicked",
      state_transition: "draft_to_submitted"
    }
  });
}

function turnLinkIdForOffset(sourceOffset) {
  return `10000000-0000-4000-8000-${String(sourceOffset).padStart(12, "0")}`;
}

function responseLifecycleEvent(
  request,
  eventType,
  sourceEventId,
  turnLinkId
) {
  const metadataByType = {
    assistant_response_started: {
      signal: "stop_control_appeared",
      state_transition: "submitted_to_responding"
    },
    assistant_response_completed: {
      completion_signal: "stop_control_disappeared",
      state_transition: "responding_to_completed"
    },
    assistant_response_failed: {
      reason_code: "provider_error_control",
      state_transition: "responding_to_failed"
    },
    assistant_response_cancelled: {
      signal: "stop_control_clicked",
      state_transition: "responding_to_cancelled"
    }
  };
  const numericOffset = Number.parseInt(sourceEventId.slice(-12), 10);
  const defaultTurnOffset = Number.isFinite(numericOffset)
    ? numericOffset - (numericOffset % 2)
    : 0;
  return buildActivityWatchEvent({
    provider: request.provider,
    event_type: eventType,
    turn_link_id: turnLinkId || turnLinkIdForOffset(defaultTurnOffset),
    source_event_id: sourceEventId,
    occurred_at: new Date(
      Date.parse("2026-07-30T00:00:02.000Z") +
      Number.parseInt(sourceEventId.slice(-4), 16)
    ).toISOString(),
    observed_at: "2026-07-30T00:00:03.000Z",
    conversation: request.context.identity,
    confidence: "derived",
    source_adapter: `${request.provider}-dom-v1`,
    metadata: metadataByType[eventType]
  });
}

async function sendResponseLifecycle(
  harness,
  request,
  sender,
  eventTypes,
  sourceOffset = 10
) {
  const turnLinkId = turnLinkIdForOffset(sourceOffset);
  const events = eventTypes.map((eventType, index) =>
    responseLifecycleEvent(
      request,
      eventType,
      `00000000-0000-4000-8000-${String(sourceOffset + index).padStart(12, "0")}`,
      turnLinkId
    )
  );
  return sendRuntimeMessage(
    harness,
    { type: "ENQUEUE_EVENTS", events },
    clone(sender)
  );
}

function privateCueForCompletion(event, label = "注意力切换可分为三个阶段") {
  return {
    raw_completion_id: event.data.source_event_id,
    provider: event.data.provider,
    completion_time: event.data.occurred_at,
    label,
    generator: PrivateReturnCues.GENERATOR,
    version: PrivateReturnCues.GENERATOR_VERSION,
    status: "generated"
  };
}

async function sendPrivateResponseLifecycle(
  harness,
  request,
  sender,
  sourceOffset,
  label
) {
  const turnLinkId = turnLinkIdForOffset(sourceOffset);
  const started = responseLifecycleEvent(
    request,
    "assistant_response_started",
    `00000000-0000-4000-8000-${String(sourceOffset).padStart(12, "0")}`,
    turnLinkId
  );
  const completed = responseLifecycleEvent(
    request,
    "assistant_response_completed",
    `00000000-0000-4000-8000-${String(sourceOffset + 1).padStart(12, "0")}`,
    turnLinkId
  );
  const authorization = await sendRuntimeMessage(
    harness,
    { type: "AUTHORIZE_PRIVATE_RETURN_CUE" },
    clone(sender)
  );
  const message = {
    type: "ENQUEUE_EVENTS",
    events: [started, completed]
  };
  if (authorization.authorized) {
    message.private_return_cue = privateCueForCompletion(completed, label);
    message.private_return_cue_authorization =
      authorization.authorization_id;
  }
  return sendRuntimeMessage(harness, message, clone(sender));
}

function conversationBoundEvent(request, previousConversationKey, sourceOffset) {
  return buildActivityWatchEvent({
    provider: request.provider,
    event_type: "conversation_bound",
    source_event_id: (
      `00000000-0000-4000-8000-${String(sourceOffset).padStart(12, "0")}`
    ),
    occurred_at: "2026-07-30T00:00:04.000Z",
    observed_at: "2026-07-30T00:00:04.010Z",
    conversation: request.context.identity,
    previous_conversation_key: previousConversationKey,
    confidence: "exact",
    source_adapter: `${request.provider}-dom-v1`,
    metadata: {
      route_pattern: request.provider === "chatgpt" ? "/c/<id>" : "/chat/<id>",
      state_transition: "provisional_to_exact"
    }
  });
}

async function readyHarness(options = {}, fetchImpl = () => successfulResponse()) {
  const activeSessionState = {
    status: "active",
    session_id: "11111111-1111-4111-8111-111111111111",
    start_utc: "2026-07-30T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    utc_offset_minutes: 480,
    source: "toolbar_popup"
  };
  const responseAuthorizationState = {
    bindings: {},
    authorizations: {
      ["a".repeat(64)]: {
        session_id: activeSessionState.session_id,
        completed_at: "2026-07-30T00:00:00.000Z",
        expires_at: "2026-07-30T00:01:00.000Z"
      }
    }
  };
  const preparedOptions = Object.assign({}, options, {
    authorityProvisioning:
      options.authorityProvisioning || AUTHORITY_PROVISIONING,
    tabContexts: Object.assign({
      7: {
        conversation_key: "a".repeat(64),
        locator_handle: CHATGPT_LOCATOR,
        namespace_generation: 1,
        namespace_fingerprint: "fixture-namespace-fingerprint"
      }
    }, options.tabContexts || {}),
    initialStorage: Object.assign(
      {
        response_session_bindings_v1: responseAuthorizationState,
        study_session_state_v1: activeSessionState
      },
      options.initialStorage || {}
    )
  });
  const harness = createBackgroundHarness(fetchImpl, preparedOptions);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );
  return harness;
}

async function readyInactiveHarness(options = {}) {
  const harness = createBackgroundHarness(
    options.fetchImpl || (() => successfulResponse()),
    options
  );
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );
  return harness;
}

async function createTrackedNotification(harness) {
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_created"
    ),
    "notification created event was not written"
  );
  return response;
}

function notificationLifecycle(harness) {
  return writtenEvents(harness).filter(
    (event) => event.data.event_type.startsWith("tracker_notification_")
  );
}

function assertSingleSuppressed(harness, reasonCode) {
  const lifecycle = notificationLifecycle(harness);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].data.event_type, "tracker_notification_suppressed");
  assert.deepEqual(lifecycle[0].data.metadata, {
    phase: "gate",
    reason_code: reasonCode
  });
  assert.equal(
    lifecycle.some(
      (event) => event.data.event_type === "tracker_notification_attempted"
    ),
    false
  );
  assert.equal(lifecycle[0].data.full_url, undefined);
  const diagnosticText = JSON.stringify(
    harness.storage.background_diagnostics_v1 || []
  );
  assert.doesNotMatch(diagnosticText, /https?:\/\//);
  assert.doesNotMatch(diagnosticText, /[ab]{64}/);
}

test("background validates the sender route but sends no full URL to native authority", async () => {
  const harness = await readyHarness();
  const result = await sendRuntimeMessage(
    harness,
    {
      type: "RESOLVE_CONVERSATION",
      provider: "chatgpt",
      provider_conversation_id: "chat_fixture_123"
    },
    clone(TARGET_SENDER)
  );
  assert.equal(result.status, "issued");
  assert.equal(harness.nativeMessages.length, 1);
  assert.equal(
    harness.nativeMessages[0].type,
    "resolve_web_conversation"
  );
  assert.equal(
    Object.hasOwn(harness.nativeMessages[0], "full_url"),
    false
  );
  assert.doesNotMatch(JSON.stringify(harness.nativeMessages), /https?:\/\//);
});

test("legacy scope is retained unused while raw queue and notification records are sanitized in place", async () => {
  const rawIdCanary = "RAW_ID_CANARY_987";
  const rawUrlCanary = `https://chatgpt.com/c/${rawIdCanary}`;
  const rawIdLocator = `loc_${rawIdCanary}${"A".repeat(
    22 - rawIdCanary.length
  )}`;
  const legacyEvent = rawPromptEvent();
  legacyEvent.data.provider_conversation_id = rawIdCanary;
  legacyEvent.data.full_url = rawUrlCanary;
  legacyEvent.data.privacy_tier = "private_raw_url";
  const notificationId = "chi27-ai-00000000-0000-4000-8000-000000000077";
  const harness = createBackgroundHarness(
    () => successfulResponse(),
    {
      initialStorage: {
        profile_scope_id: "legacy-profile-scope-must-remain",
        reliable_event_queue_v1: {
          acknowledged: [
            "00000000-0000-4000-8000-000000000077",
            rawIdCanary,
            rawUrlCanary
          ],
          pending: [{
            event: legacyEvent,
            attempts: 0,
            next_attempt_at: 0
          }]
        },
        notification_targets_v1: {
          [notificationId]: {
            tab_id: 7,
            window_id: 2,
            provider: "chatgpt",
            conversation: {
              conversation_key: "a".repeat(64),
              identity_status: "exact",
              namespace_generation: 1,
              namespace_fingerprint: "fixture-namespace-fingerprint",
              provider_conversation_id: rawIdCanary
            },
            locator_handle: rawIdLocator,
            url: rawUrlCanary,
            reason_code: "response_completed_while_hidden",
            due_at: "2026-07-30T00:00:08.000Z"
          }
        }
      }
    }
  );
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "prompt_submitted"
    ),
    "sanitized legacy event was not preserved"
  );
  assert.equal(
    harness.storage.profile_scope_id,
    "legacy-profile-scope-must-remain"
  );
  assert.equal(
    harness.storage.background_diagnostics_v1.some(
      (item) => item.code === "legacy_scope_present_migration_required"
    ),
    true
  );
  const migratedTarget = harness.storage.notification_targets_v1[notificationId];
  assert.equal(migratedTarget.target_status, "unavailable");
  assert.equal(migratedTarget.locator_handle, null);
  const persistedWithoutLegacyScope = clone(harness.storage);
  delete persistedWithoutLegacyScope.profile_scope_id;
  const persisted = JSON.stringify(persistedWithoutLegacyScope);
  const activityWatchWire = JSON.stringify(harness.fetchCalls);
  assert.doesNotMatch(persisted, new RegExp(rawIdCanary));
  assert.doesNotMatch(persisted, new RegExp(rawUrlCanary));
  assert.doesNotMatch(activityWatchWire, new RegExp(rawIdCanary));
  assert.doesNotMatch(activityWatchWire, new RegExp(rawUrlCanary));
  assert.equal(
    harness.storage.reliable_event_queue_v1.acknowledged.includes(
      "00000000-0000-4000-8000-000000000077"
    ),
    true
  );
  assert.doesNotMatch(
    JSON.stringify(harness.storage.reliable_event_queue_v1.acknowledged),
    new RegExp(rawIdCanary)
  );
  assert.doesNotMatch(
    JSON.stringify(harness.storage.reliable_event_queue_v1.acknowledged),
    /https?:\/\//
  );
  assert.doesNotMatch(
    JSON.stringify(harness.notificationsCreated),
    new RegExp(rawIdCanary)
  );
});

test("schema v1.0 pending queue migration preserves unrecoverable lifecycle records in quarantine", async () => {
  const legacyLifecycle = rawPromptEvent();
  legacyLifecycle.data.schema_version = "1.0";
  delete legacyLifecycle.data.turn_link_id;

  const legacyForeground = buildActivityWatchEvent({
    provider: "chatgpt",
    event_type: "conversation_foregrounded",
    source_event_id: "00000000-0000-4000-8000-000000000091",
    occurred_at: "2026-07-30T00:00:00.500Z",
    observed_at: "2026-07-30T00:00:00.510Z",
    conversation: {
      conversation_key: "a".repeat(64),
      identity_status: "exact",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    },
    confidence: "exact",
    source_adapter: "chatgpt-dom-v1",
    metadata: {
      visibility: "visible",
      state_transition: "initial_foreground"
    }
  });
  legacyForeground.data.schema_version = "1.0";

  const harness = createBackgroundHarness(
    () => successfulResponse(),
    {
      initialStorage: {
        reliable_event_queue_v1: {
          acknowledged: [],
          pending: [legacyLifecycle, legacyForeground].map((event) => ({
            event,
            attempts: 0,
            next_attempt_at: 0
          }))
        }
      }
    }
  );
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written after queue migration"
  );

  const written = writtenEvents(harness);
  const migrated = written.find(
    (event) => event.data.source_event_id === legacyForeground.data.source_event_id
  );
  assert.equal(migrated.data.schema_version, "1.1");
  assert.equal(migrated.data.event_type, "conversation_foregrounded");
  assert.equal(
    written.some(
      (event) => event.data.source_event_id === legacyLifecycle.data.source_event_id
    ),
    false
  );

  const quarantine = harness.storage.legacy_reliable_event_queue_quarantine_v1;
  assert.equal(quarantine.schema_version, "1.0");
  assert.equal(quarantine.records.length, 1);
  assert.equal(
    quarantine.records[0].reason_code,
    "lifecycle_missing_turn_link"
  );
  assert.equal(
    quarantine.records[0].record.event.data.source_event_id,
    legacyLifecycle.data.source_event_id
  );
  assert.equal(
    Object.hasOwn(quarantine.records[0].record.event.data, "turn_link_id"),
    false
  );

  const diagnostics = harness.storage.background_diagnostics_v1 || [];
  for (const code of [
    "legacy_queue_safe_non_lifecycle_migrated",
    "legacy_queue_lifecycle_quarantined_missing_turn_link"
  ]) {
    const diagnostic = diagnostics.find((item) => item.code === code);
    assert.equal(Boolean(diagnostic), true, `${code} diagnostic is required`);
    assert.equal(diagnostic.item_count, 1);
  }
  assert.equal(harness.storage.reliable_event_queue_v1.pending.length, 0);
});

test("enqueue waits for a delayed queue migration and preserves both legacy and new events", async () => {
  const legacyForeground = buildActivityWatchEvent({
    provider: "chatgpt",
    event_type: "conversation_foregrounded",
    source_event_id: "00000000-0000-4000-8000-000000000092",
    occurred_at: "2026-07-30T00:00:00.500Z",
    observed_at: "2026-07-30T00:00:00.510Z",
    conversation: {
      conversation_key: "a".repeat(64),
      identity_status: "exact",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    },
    confidence: "exact",
    source_adapter: "chatgpt-dom-v1",
    metadata: {
      visibility: "visible",
      state_transition: "initial_foreground"
    }
  });
  legacyForeground.data.schema_version = "1.0";
  const newPrompt = rawPromptEvent();
  const harness = createBackgroundHarness(
    () => successfulResponse(),
    {
      deferQueueMigrationRead: true,
      initialStorage: {
        reliable_event_queue_v1: {
          acknowledged: [],
          pending: [{
            event: legacyForeground,
            attempts: 0,
            next_attempt_at: 0
          }]
        }
      }
    }
  );
  await waitFor(
    () => harness.hasDeferredQueueMigrationRead(),
    "queue migration read was not delayed"
  );
  harness.listeners.alarms[0]({ name: "flush-ai-conversation-events" });

  let enqueueSettled = false;
  const enqueue = sendRuntimeMessage(
    harness,
    { type: "ENQUEUE_EVENTS", events: [newPrompt] },
    clone(TARGET_SENDER)
  ).finally(() => {
    enqueueSettled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(enqueueSettled, false);
  assert.equal(eventWrites(harness).length, 0);

  assert.equal(harness.releaseQueueMigrationRead(), true);
  const response = await enqueue;
  assert.equal(response.added, 1);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written after delayed migration"
  );
  const writtenIds = new Set(
    writtenEvents(harness).map((event) => event.data.source_event_id)
  );
  assert.equal(writtenIds.has(legacyForeground.data.source_event_id), true);
  assert.equal(writtenIds.has(newPrompt.data.source_event_id), true);
});

test("unsafe schema v1.0 queue payload blocks migration without copying or deleting it", async () => {
  const contentCanary = "UNSAFE_LEGACY_PROMPT_TEXT_CANARY";
  const unsafeLegacy = rawPromptEvent();
  unsafeLegacy.data.schema_version = "1.0";
  delete unsafeLegacy.data.turn_link_id;
  unsafeLegacy.data.metadata.prompt_text = contentCanary;
  const originalQueue = {
    acknowledged: [],
    pending: [{
      event: unsafeLegacy,
      attempts: 0,
      next_attempt_at: 0,
      prompt_text: contentCanary
    }]
  };
  const harness = createBackgroundHarness(
    () => successfulResponse(),
    { initialStorage: { reliable_event_queue_v1: originalQueue } }
  );
  await waitFor(
    () => (harness.storage.background_diagnostics_v1 || []).some(
      (item) => item.code === "legacy_queue_unsafe_payload_blocked"
    ),
    "unsafe legacy queue payload did not emit a blocking diagnostic"
  );

  assert.deepEqual(
    harness.storage.reliable_event_queue_v1,
    originalQueue
  );
  assert.equal(
    harness.storage.legacy_reliable_event_queue_quarantine_v1,
    undefined
  );
  assert.equal(eventWrites(harness).length, 0);
  assert.doesNotMatch(
    JSON.stringify(harness.storage.background_diagnostics_v1),
    new RegExp(contentCanary)
  );

  const response = await sendRuntimeMessage(
    harness,
    { type: "ENQUEUE_EVENTS", events: [rawPromptEvent()] },
    clone(TARGET_SENDER)
  );
  assert.equal(response.error, "legacy_queue_unsafe_payload_blocked");
  assert.deepEqual(
    harness.storage.reliable_event_queue_v1,
    originalQueue
  );
  assert.equal(eventWrites(harness).length, 0);
});

test("popup session commands are idempotent and write paired start, stop, and cancel markers", async () => {
  const harness = createBackgroundHarness(() => successfulResponse());
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );

  const started = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(started.ok, true);
  assert.equal(started.status.active, true);
  assert.equal(started.status.changed, true);
  assert.equal(started.status.pending_sync, false);
  assert.match(
    started.status.session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  const duplicate = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(duplicate.status.changed, false);
  assert.equal(duplicate.status.reason, "already_active");
  assert.equal(
    writtenSessionEvents(harness).filter(
      (event) => event.data.event_type === "study_session_started"
    ).length,
    1
  );

  await harness.clock.advance(1000);
  const stopped = await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(stopped.status.active, false);
  assert.equal(stopped.status.changed, true);
  const duplicateStop = await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(duplicateStop.status.changed, false);

  const restarted = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const cancelled = await sendRuntimeMessage(
    harness,
    { type: "CANCEL_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(restarted.status.active, true);
  assert.equal(cancelled.status.active, false);
  assert.deepEqual(
    writtenSessionEvents(harness).map((event) => event.data.event_type),
    [
      "study_session_started",
      "study_session_stopped",
      "study_session_started",
      "study_session_cancelled"
    ]
  );
});

test("worker restart restores an active session without creating a duplicate marker", async () => {
  const first = createBackgroundHarness(() => successfulResponse());
  await waitFor(
    () => writtenEvents(first).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "first worker heartbeat was not written"
  );
  const started = await sendRuntimeMessage(
    first,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(started.status.active, true);
  assert.equal(writtenSessionEvents(first).length, 1);

  const restarted = createBackgroundHarness(
    () => successfulResponse(),
    { initialStorage: first.storage }
  );
  await waitFor(
    () => writtenEvents(restarted).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "restarted worker heartbeat was not written"
  );
  const status = await sendRuntimeMessage(
    restarted,
    { type: "GET_STUDY_SESSION_STATUS" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(status.status.active, true);
  assert.equal(status.status.session_id, started.status.session_id);
  assert.deepEqual(writtenSessionEvents(restarted), []);
});

test("offline session marker stays pending while the independent content-free conversation queue still writes", async () => {
  let sessionOffline = true;
  const harness = createBackgroundHarness((call) => {
    if (
      sessionOffline &&
      call.url.endsWith("/api/0/buckets/aw-watcher-study-sessions/events")
    ) {
      return { ok: false, status: 503 };
    }
    return successfulResponse();
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );

  const started = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(started.status.active, true);
  assert.equal(started.status.pending_sync, true);
  assert.equal(harness.storage.study_session_event_queue_v1.pending.length, 1);
  const originalOccurredAt = (
    harness.storage.study_session_event_queue_v1.pending[0].event.data.occurred_at
  );

  const rawResult = await sendRuntimeMessage(
    harness,
    { type: "ENQUEUE_EVENTS", events: [rawPromptEvent()] },
    clone(TARGET_SENDER)
  );
  assert.equal(rawResult.added, 1);
  assert.equal(
    writtenEvents(harness).some(
      (event) => event.data.event_type === "prompt_submitted"
    ),
    true
  );

  sessionOffline = false;
  await harness.clock.advance(1000);
  harness.listeners.alarms[0]({ name: "flush-ai-conversation-events" });
  await waitFor(
    () => harness.storage.study_session_event_queue_v1.pending.length === 0,
    "session marker was not retried"
  );
  const delivered = writtenSessionEvents(harness).find(
    (event) => event.data.event_type === "study_session_started"
  );
  assert.equal(delivered.data.occurred_at, originalOccurredAt);
});

test("notifications-disabled gate emits one suppressed audit and never attempted", async () => {
  const harness = await readyHarness({
    initialStorage: { notifications_enabled: false }
  });
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    reason: "disabled"
  });
  assert.equal(harness.notificationsCreated.length, 0);
  assertSingleSuppressed(harness, "notifications_disabled");
});

test("rejected notification ingress writes only one safe background diagnostic", async () => {
  const harness = await readyHarness();
  const invalid = clone(NOTIFICATION_REQUEST);
  invalid.context.identity.provider = "chatgpt";
  invalid.notification_preview =
    "https://chatgpt.com/c/raw-preview-and-route-canary";
  const response = await sendRuntimeMessage(
    harness,
    invalid,
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    error_code: "notification_request_rejected",
    rejected: true
  });
  const diagnostics = harness.storage.background_diagnostics_v1 || [];
  const rejected = diagnostics.filter(
    (diagnostic) => diagnostic.code === "notification_request_rejected"
  );
  assert.equal(rejected.length, 1);
  assert.deepEqual(Object.keys(rejected[0]).sort(), [
    "code",
    "http_status",
    "retry_count",
    "timestamp"
  ]);
  const durable = JSON.stringify({
    diagnostics,
    consoleErrors: harness.consoleErrors,
    storage: harness.storage
  });
  assert.doesNotMatch(durable, /raw-preview-and-route-canary/);
  assert.doesNotMatch(durable, /https?:\/\//);
  assert.equal(harness.notificationsCreated.length, 0);
});

test("foreground-observed completion is explicitly suppressed without creating a notification", async () => {
  const harness = await readyHarness();
  const request = clone(NOTIFICATION_REQUEST);
  request.reason_code = "response_completed_while_foreground";
  const response = await sendRuntimeMessage(
    harness,
    request,
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    reason: "response_completed_while_foreground"
  });
  assert.equal(harness.notificationsCreated.length, 0);
  assertSingleSuppressed(harness, "response_completed_while_foreground");
  assert.equal(
    Object.hasOwn(
      harness.storage.response_session_bindings_v1.authorizations,
      "a".repeat(64)
    ),
    false
  );
});

test("actual content bridge binds a new ChatGPT route and creates a hidden-completion notification", async () => {
  const harness = await readyHarness();
  const previousPreview = "prior response must not be reused";
  const currentPreview = "fixture completed answer preview";
  const content = createContentBridgeHarness(harness, {
    initialResponsePreview: previousPreview,
    initialUrl: "https://chatgpt.com/",
    staleDocumentUrl: true
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_started"
    ),
    "actual content script did not finish boot"
  );
  await content.bindCanonicalChatGptRoute();
  await content.completeHiddenResponse(currentPreview);
  await waitFor(
    () => harness.notificationsCreated.length === 1,
    "actual content request did not create a tracker notification"
  );
  const request = content.sentMessages.find(
    (message) => message.type === "SHOW_TRACKER_NOTIFICATION"
  );
  assert.ok(request);
  assert.equal(request.provider, "chatgpt");
  assert.equal(request.context.identity.identity_status, "exact");
  assert.equal(request.context.identity.provider, undefined);
  assert.equal(request.notification_preview, currentPreview);
  assert.deepEqual(Object.keys(request.context.identity).sort(), [
    "conversation_key",
    "identity_status",
    "locator_handle",
    "namespace_fingerprint",
    "namespace_generation"
  ]);
  assert.deepEqual(
    notificationLifecycle(harness).map((event) => event.data.event_type),
    ["tracker_notification_attempted", "tracker_notification_created"]
  );
  assert.equal(harness.notificationsCreated[0].payload.message, currentPreview);
  assert.doesNotMatch(
    JSON.stringify({
      storage: harness.storage,
      writtenEvents: writtenEvents(harness)
    }),
    /prior response must not be reused|fixture completed answer preview/
  );
});

test("actual content bridge still sends SHOW when completion ENQUEUE response disconnects", async () => {
  const harness = await readyHarness();
  const content = createContentBridgeHarness(harness, {
    disconnectCompletionEnqueue: true,
    initialUrl: "https://chatgpt.com/",
    staleDocumentUrl: true
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_started"
    ),
    "actual content script did not finish boot"
  );
  await content.bindCanonicalChatGptRoute();
  await content.completeHiddenResponse();
  await waitFor(
    () => harness.notificationsCreated.length === 1,
    "lost completion callback incorrectly blocked SHOW"
  );
  assert.equal(
    content.sentMessages.some(
      (message) => message.type === "SHOW_TRACKER_NOTIFICATION"
    ),
    true
  );
  assert.equal(
    content.contentWarnings.includes(
      "CHI27_AI_WATCHER_CONTENT content_event_enqueue_failed"
    ),
    true
  );
  assert.deepEqual(
    notificationLifecycle(harness).map((event) => event.data.event_type),
    ["tracker_notification_attempted", "tracker_notification_created"]
  );
});

test("real Claude hidden-completion adapter path reaches inactive suppressed audit across ingress and background", async () => {
  const claudeUrl = "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000";
  const claudeSender = {
    id: FIXTURE_EXTENSION_ID,
    frameId: 0,
    url: claudeUrl,
    tab: { id: 8, url: claudeUrl, windowId: 2 }
  };
  const claudeRequest = {
    type: "SHOW_TRACKER_NOTIFICATION",
    provider: "claude",
    context: {
      identity: {
        conversation_key: "b".repeat(64),
        identity_status: "exact",
        locator_handle: CLAUDE_LOCATOR,
        namespace_generation: 1,
        namespace_fingerprint: "fixture-namespace-fingerprint"
      }
    },
    reason_code: "response_completed_while_hidden"
  };
  const state = {
    responseTurnCount: 1,
    streaming: false,
    responseTurns: []
  };
  function responseTurns() {
    while (state.responseTurns.length < state.responseTurnCount) {
      state.responseTurns.push({});
    }
    state.responseTurns.length = state.responseTurnCount;
    return state.responseTurns;
  }
  const streaming = {
    closest(selector) {
      const turns = responseTurns();
      return selector === ".font-claude-response"
        ? turns[turns.length - 1]
        : null;
    }
  };
  const composerSelector =
    "div[data-testid='chat-input'][role='textbox'].tiptap.ProseMirror";
  const composer = {
    nodeType: 1,
    textContent: "x",
    closest(selector) {
      return selector === composerSelector ? this : null;
    }
  };
  const fixtureDocument = {
    querySelector(selector) {
      if (selector === composerSelector) {
        return composer;
      }
      if (selector === "[data-is-streaming='true']") {
        return state.streaming ? streaming : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-is-streaming='true']") {
        return state.streaming ? [streaming] : [];
      }
      return selector === ".font-claude-response"
        ? responseTurns()
        : [];
    }
  };
  const machine = new ConversationStateMachine();
  machine.dispatch({ type: "START", visible: true, at: 1 });
  machine.dispatch({ type: "BACKGROUND", at: 2 });
  const descriptors = [];
  const effects = [];
  const originalDocument = global.document;
  global.document = fixtureDocument;
  try {
    const adapter = new ClaudeAdapter((action) => {
      const result = machine.dispatch(Object.assign({ at: Date.now() }, action));
      descriptors.push(...result.events);
      effects.push(...result.effects);
    }, {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 1000
    });
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.responseTurnCount = 2;
    state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    global.document = originalDocument;
  }
  const completed = descriptors.find(
    (descriptor) => descriptor.event_type === "assistant_response_completed"
  );
  assert.ok(completed);
  assert.deepEqual(effects, [{
    type: "SHOW_TRACKER_NOTIFICATION",
    reason_code: "response_completed_while_hidden"
  }]);

  const harness = await readyInactiveHarness();
  const occurredAt = new Date(completed.at).toISOString();
  const event = buildActivityWatchEvent({
    provider: "claude",
    event_type: completed.event_type,
    turn_link_id: completed.turn_link_id,
    source_event_id: "00000000-0000-4000-8000-000000000321",
    occurred_at: occurredAt,
    observed_at: occurredAt,
    conversation: claudeRequest.context.identity,
    confidence: completed.confidence,
    source_adapter: "claude-dom-v1",
    metadata: completed.metadata
  });
  const written = await sendRuntimeMessage(
    harness,
    { type: "ENQUEUE_EVENTS", events: [event] },
    claudeSender
  );
  assert.equal(written.added, 1);
  const response = await sendRuntimeMessage(
    harness,
    claudeRequest,
    claudeSender
  );
  assert.deepEqual(clone(response), {
    created: false,
    reason: "study_session_inactive"
  });
  assert.equal(
    writtenEvents(harness).some(
      (item) => item.data.event_type === "assistant_response_completed"
    ),
    true
  );
  assertSingleSuppressed(harness, "study_session_inactive");
});

test("inactive suppresses notification creation with an audit while content-free writes continue; active allows both providers and stop suppresses again", async () => {
  const harness = createBackgroundHarness(() => successfulResponse());
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );
  const rawResult = await sendRuntimeMessage(
    harness,
    { type: "ENQUEUE_EVENTS", events: [rawPromptEvent()] },
    clone(TARGET_SENDER)
  );
  assert.equal(rawResult.added, 1);

  const inactive = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(inactive), {
    created: false,
    reason: "study_session_inactive"
  });
  assert.equal(harness.notificationsCreated.length, 0);
  assertSingleSuppressed(harness, "study_session_inactive");

  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started", "assistant_response_completed"],
    20
  );
  const chatgpt = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(chatgpt.created, true);

  const claudeUrl = "https://claude.ai/chat/claude_fixture_123";
  const claudeRequest = clone(NOTIFICATION_REQUEST);
  claudeRequest.provider = "claude";
  claudeRequest.context.identity.conversation_key = "b".repeat(64);
  claudeRequest.context.identity.locator_handle =
    CLAUDE_LOCATOR;
  const claudeSender = clone(TARGET_SENDER);
  claudeSender.url = claudeUrl;
  claudeSender.tab.url = claudeUrl;
  await sendResponseLifecycle(
    harness,
    claudeRequest,
    claudeSender,
    ["assistant_response_started", "assistant_response_completed"],
    30
  );
  const claude = await sendRuntimeMessage(
    harness,
    claudeRequest,
    claudeSender
  );
  assert.equal(claude.created, true);

  await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const afterStop = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(afterStop), {
    created: false,
    reason: "study_session_inactive"
  });
  assert.equal(harness.notificationsCreated.length, 2);
  const suppressed = notificationLifecycle(harness).filter(
    (event) => event.data.event_type === "tracker_notification_suppressed"
  );
  assert.equal(suppressed.length, 2);
  assert.deepEqual(
    suppressed.map((event) => event.data.metadata),
    [
      { phase: "gate", reason_code: "study_session_inactive" },
      { phase: "gate", reason_code: "study_session_inactive" }
    ]
  );
  assert.equal(
    writtenEvents(harness).filter(
      (event) => event.data.event_type === "prompt_submitted"
    ).length,
    1
  );
});

test("response started in session A cannot create a notification after A stops and session B starts", async () => {
  const harness = await readyInactiveHarness();
  const sessionA = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    100
  );
  await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(
    harness.storage.response_session_bindings_v1.bindings[
      "a".repeat(64)
    ].session_id,
    sessionA.status.session_id
  );
  const sessionB = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.notEqual(sessionA.status.session_id, sessionB.status.session_id);

  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_completed"],
    101
  );
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    reason: "response_session_not_authorized"
  });
  assert.equal(harness.notificationsCreated.length, 0);
  assertSingleSuppressed(harness, "response_session_not_authorized");
  assert.deepEqual(
    clone(harness.storage.response_session_bindings_v1),
    { bindings: {}, authorizations: {} }
  );
});

test("response started outside a session remains unauthorized when it completes inside a later session", async () => {
  const harness = await readyInactiveHarness();
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    110
  );
  const storedBinding = harness.storage.response_session_bindings_v1.bindings[
    "a".repeat(64)
  ];
  assert.equal(storedBinding.session_id, null);

  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_completed"],
    111
  );
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, false);
  assert.equal(response.reason, "response_session_not_authorized");
  assert.equal(harness.notificationsCreated.length, 0);
});

test("response-session binding survives a worker restart and authorizes completion in the same session", async () => {
  const first = await readyInactiveHarness();
  const started = await sendRuntimeMessage(
    first,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    first,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    120
  );
  assert.equal(
    first.storage.response_session_bindings_v1.bindings["a".repeat(64)].session_id,
    started.status.session_id
  );

  const restarted = createBackgroundHarness(
    () => successfulResponse(),
    { initialStorage: first.storage }
  );
  await waitFor(
    () => writtenEvents(restarted).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "restarted worker heartbeat was not written"
  );
  await sendResponseLifecycle(
    restarted,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_completed"],
    121
  );
  const response = await sendRuntimeMessage(
    restarted,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, true);
  assert.equal(restarted.notificationsCreated.length, 1);
});

test("failed and cancelled responses clear bindings without notification authorization", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  for (const [index, terminalType] of [
    "assistant_response_failed",
    "assistant_response_cancelled"
  ].entries()) {
    await sendResponseLifecycle(
      harness,
      NOTIFICATION_REQUEST,
      TARGET_SENDER,
      ["assistant_response_started", terminalType],
      130 + (index * 10)
    );
    assert.deepEqual(
      clone(harness.storage.response_session_bindings_v1),
      { bindings: {}, authorizations: {} }
    );
  }
});

test("a new response turn overwrites an older session binding for the same conversation", async () => {
  const harness = await readyInactiveHarness();
  const sessionA = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    150
  );
  await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const sessionB = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    151
  );
  const replacement = harness.storage.response_session_bindings_v1.bindings[
    "a".repeat(64)
  ];
  assert.equal(replacement.session_id, sessionB.status.session_id);
  assert.notEqual(replacement.session_id, sessionA.status.session_id);

  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_completed"],
    152
  );
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, true);
});

test("provisional response binding follows conversation_bound to the exact key", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const provisionalKey = "00000000-0000-4000-8000-000000000199";
  const provisionalUrl = "https://chatgpt.com/";
  const provisionalRequest = clone(NOTIFICATION_REQUEST);
  provisionalRequest.context = {
    identity: {
      conversation_key: provisionalKey,
      identity_status: "provisional",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    }
  };
  const provisionalSender = clone(TARGET_SENDER);
  provisionalSender.url = provisionalUrl;
  provisionalSender.tab.url = provisionalUrl;
  await sendResponseLifecycle(
    harness,
    provisionalRequest,
    provisionalSender,
    ["assistant_response_started"],
    160
  );

  await sendRuntimeMessage(
    harness,
    {
      type: "ENQUEUE_EVENTS",
      events: [
        conversationBoundEvent(NOTIFICATION_REQUEST, provisionalKey, 161)
      ]
    },
    clone(TARGET_SENDER)
  );
  assert.equal(
    harness.storage.response_session_bindings_v1.bindings[provisionalKey],
    undefined
  );
  assert.ok(
    harness.storage.response_session_bindings_v1.bindings["a".repeat(64)]
  );

  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_completed"],
    162
  );
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, true);
});

test("expired or malformed persisted response bindings fail closed without diagnostic key leakage", async () => {
  const conversationKey = "a".repeat(64);
  const harness = await readyHarness({
    initialStorage: {
      response_session_bindings_v1: {
        bindings: {
          [conversationKey]: {
            session_id: "11111111-1111-4111-8111-111111111111",
            bound_at: "2026-07-29T00:00:00.000Z",
            expires_at: "2026-07-29T01:00:00.000Z",
            full_url: TARGET_URL
          }
        },
        authorizations: {}
      }
    }
  });
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, false);
  assert.equal(response.reason, "response_session_not_authorized");
  assert.equal(harness.notificationsCreated.length, 0);
  assert.deepEqual(
    clone(harness.storage.response_session_bindings_v1),
    { bindings: {}, authorizations: {} }
  );
  const diagnostics = JSON.stringify(
    harness.storage.background_diagnostics_v1 || []
  );
  assert.doesNotMatch(diagnostics, new RegExp(conversationKey));
  assert.doesNotMatch(diagnostics, /https?:\/\//);
});

test("90 minute alarm changes badge and title without ending the session", async () => {
  const harness = createBackgroundHarness(() => successfulResponse());
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(
    harness.actionUpdates.some(
      (update) =>
        update.method === "setBadgeText" &&
        update.details.text === "ON"
    ),
    true
  );

  await harness.clock.advance(90 * 60 * 1000);
  harness.listeners.alarms[0]({ name: "study-session-duration-warning" });
  await waitFor(
    () => harness.actionUpdates.some(
      (update) =>
        update.method === "setBadgeText" &&
        update.details.text === "90+"
    ),
    "90 minute badge was not shown"
  );
  const status = await sendRuntimeMessage(
    harness,
    { type: "GET_STUDY_SESSION_STATUS" },
    EXTENSION_PAGE_SENDER
  );
  assert.equal(status.status.active, true);
  assert.equal(status.status.overdue, true);
  assert.equal(
    writtenSessionEvents(harness).some(
      (event) => [
        "study_session_stopped",
        "study_session_cancelled"
      ].includes(event.data.event_type)
    ),
    false
  );
});

test("notification creation shows an ephemeral answer preview without persisting it", async () => {
  const harness = await readyHarness();
  const response = await createTrackedNotification(harness);

  assert.equal(response.created, true);
  assert.equal(harness.notificationsCreated.length, 1);
  const created = harness.notificationsCreated[0];
  assert.match(created.payload.iconUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(
    created.payload.iconUrl.slice("data:image/png;base64,".length),
    "base64"
  );
  assert.deepEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 128);
  assert.equal(png.readUInt32BE(20), 128);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const idatChunks = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const chunkLength = png.readUInt32BE(offset);
    const chunkType = png.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkEnd = offset + 12 + chunkLength;
    assert.ok(chunkEnd <= png.length);
    if (chunkType === "IDAT") {
      idatChunks.push(png.subarray(offset + 8, offset + 8 + chunkLength));
    }
    offset = chunkEnd;
  }
  assert.ok(idatChunks.length > 0);
  const scanlines = zlib.inflateSync(Buffer.concat(idatChunks));
  assert.equal(scanlines.length, (128 * 4 + 1) * 128);
  assert.equal(
    scanlines.every((byte) => byte === 0),
    true,
    "every RGBA pixel must be fully transparent"
  );
  assert.equal(created.payload.title, "CHI27 · ChatGPT 回答已完成");
  assert.equal(created.payload.message, NOTIFICATION_PREVIEW_CANARY);
  assert.equal(created.payload.contextMessage, undefined);
  assert.equal(created.payload.imageUrl, undefined);
  assert.equal(created.payload.appIconMaskUrl, undefined);
  assert.equal(created.payload.requireInteraction, false);
  const storedTarget = harness.storage.notification_targets_v1[
    response.notification_id
  ];
  assert.equal(
    Object.hasOwn(storedTarget, "notification_preview"),
    false
  );
  assert.equal(
    Date.parse(storedTarget.due_at) - harness.clock.now(),
    20000
  );

  const lifecycle = writtenEvents(harness)
    .filter((event) => event.data.event_type.startsWith("tracker_notification_"))
    .map((event) => event.data.event_type);
  assert.deepEqual(lifecycle, [
    "tracker_notification_attempted",
    "tracker_notification_created"
  ]);
  assert.equal(lifecycle.includes("tracker_notification_shown"), false);

  const diagnostics = JSON.stringify(harness.storage.background_diagnostics_v1);
  assert.doesNotMatch(diagnostics, /chat_fixture_123/);
  assert.doesNotMatch(diagnostics, /chi27-ai-[0-9a-f-]+/);
  assert.doesNotMatch(diagnostics, /https?:\/\//);
  const durableSurfaces = JSON.stringify({
    storage: harness.storage,
    activityWatchWrites: harness.fetchCalls,
    nativeMessages: harness.nativeMessages,
    diagnostics: harness.consoleErrors
  });
  assert.doesNotMatch(
    durableSurfaces,
    new RegExp(NOTIFICATION_PREVIEW_CANARY)
  );
});

test("notification remains before twenty seconds, then auto-clears and audits exactly once", async () => {
  const harness = await readyHarness();
  const response = await createTrackedNotification(harness);

  await harness.clock.advance(19999);
  assert.deepEqual(harness.notificationsCleared, []);
  assert.equal(
    writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_auto_cleared"
    ),
    false
  );

  await harness.clock.advance(1);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_auto_cleared"
    ),
    "notification auto-clear event was not written"
  );
  const autoCleared = writtenEvents(harness).filter(
    (event) => event.data.event_type === "tracker_notification_auto_cleared"
  );
  assert.equal(autoCleared.length, 1);
  assert.deepEqual(clone(autoCleared[0].data.metadata), {
    phase: "clear",
    reason_code: "notification_timeout",
    timeout_seconds: 20
  });
  assert.equal(Object.hasOwn(autoCleared[0].data, "full_url"), false);
  assert.doesNotMatch(JSON.stringify(autoCleared[0]), /https?:\/\//);
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});

  await harness.clock.advance(16000);
  assert.equal(
    writtenEvents(harness).filter(
      (event) => event.data.event_type === "tracker_notification_auto_cleared"
    ).length,
    1
  );
});

test("notification click wins the timeout race and produces only the clicked terminal event", async () => {
  const harness = await readyHarness({
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    }
  });
  const response = await createTrackedNotification(harness);
  harness.listeners.notificationClicks[0](response.notification_id);
  await harness.clock.advance(20000);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_clicked"
    ),
    "notification clicked event was not written"
  );
  assert.equal(
    writtenEvents(harness).filter(
      (event) => [
        "tracker_notification_clicked",
        "tracker_notification_auto_cleared"
      ].includes(event.data.event_type)
    ).length,
    1
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
});

test("periodic sweep does not steal a current-worker click claim", async () => {
  const harness = await readyHarness({
    deferWindowUpdate: true,
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    }
  });
  const response = await createTrackedNotification(harness);
  harness.storage.notification_targets_v1[response.notification_id].due_at =
    new Date(harness.clock.now() - 1).toISOString();
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () =>
      harness.storage.notification_targets_v1[response.notification_id]
        .terminal_state === "clicked" &&
      harness.deferredWindowUpdates.length === 1,
    "click claim did not remain active during deferred focus"
  );

  harness.listeners.alarms[0]({ name: "flush-ai-conversation-events" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(harness.notificationsCleared, []);
  assert.equal(
    harness.storage.notification_targets_v1[response.notification_id]
      .terminal_state,
    "clicked"
  );

  harness.deferredWindowUpdates.shift()();
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_clicked"
    ),
    "deferred click did not finish"
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});
});

test("initialization clears an overdue persisted notification after a worker restart", async () => {
  const notificationId = "chi27-ai-00000000-0000-4000-8000-000000000099";
  const clock = createFakeClock();
  const harness = await readyHarness({
    activeNotifications: [notificationId],
    clock,
    initialStorage: {
      notification_targets_v1: {
        [notificationId]: {
          tab_id: 7,
          window_id: 2,
          provider: "chatgpt",
          conversation: clone(NOTIFICATION_REQUEST.context.identity),
          reason_code: "response_completed_while_hidden",
          url: TARGET_URL,
          due_at: new Date(clock.now() - 1).toISOString()
        }
      }
    }
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_auto_cleared"
    ),
    "restart sweep did not audit the overdue notification"
  );
  assert.deepEqual(harness.notificationsCleared, [notificationId]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});
});

for (const terminalState of ["clicked", "timeout"]) {
  test(`worker restart recovers an overdue persisted ${terminalState} claim`, async () => {
    const notificationId =
      `chi27-ai-00000000-0000-4000-8000-0000000000${terminalState === "clicked" ? "97" : "98"}`;
    const clock = createFakeClock();
    const harness = await readyHarness({
      activeNotifications: [notificationId],
      clock,
      initialStorage: {
        notification_targets_v1: {
          [notificationId]: {
            tab_id: 7,
            window_id: 2,
            provider: "chatgpt",
            conversation: clone(NOTIFICATION_REQUEST.context.identity),
            reason_code: "response_completed_while_hidden",
            url: TARGET_URL,
            due_at: new Date(clock.now() - 1).toISOString(),
            terminal_state: terminalState
          }
        }
      }
    });
    await waitFor(
      () => writtenEvents(harness).some(
        (event) =>
          event.data.event_type === "tracker_notification_auto_cleared"
      ),
      `restart did not clear the stale ${terminalState} claim`
    );
    assert.deepEqual(harness.notificationsCleared, [notificationId]);
    assert.deepEqual(clone(harness.storage.notification_targets_v1), {});
  });
}

test("worker restart releases an unexpired claim and reschedules its original deadline", async () => {
  const notificationId = "chi27-ai-00000000-0000-4000-8000-000000000096";
  const clock = createFakeClock();
  const dueAt = new Date(clock.now() + 8000).toISOString();
  const harness = await readyHarness({
    activeNotifications: [notificationId],
    clock,
    initialStorage: {
      notification_targets_v1: {
        [notificationId]: {
          tab_id: 7,
          window_id: 2,
          provider: "chatgpt",
          conversation: clone(NOTIFICATION_REQUEST.context.identity),
          reason_code: "response_completed_while_hidden",
          url: TARGET_URL,
          due_at: dueAt,
          terminal_state: "clicked"
        }
      }
    }
  });
  assert.equal(
    harness.storage.notification_targets_v1[notificationId].terminal_state,
    undefined
  );
  await harness.clock.advance(7999);
  assert.deepEqual(harness.notificationsCleared, []);
  assert.equal(
    Object.hasOwn(harness.storage.notification_targets_v1, notificationId),
    true
  );

  await harness.clock.advance(1);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_auto_cleared"
    ),
    "restart did not clear the recovered claim at its original deadline"
  );
  assert.deepEqual(harness.notificationsCleared, [notificationId]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});
});

test("retry alarm scan clears a target that became overdue while the worker timer was unavailable", async () => {
  const harness = await readyHarness();
  const response = await createTrackedNotification(harness);
  harness.storage.notification_targets_v1[response.notification_id].due_at =
    new Date(harness.clock.now() - 1).toISOString();
  harness.listeners.alarms[0]({ name: "flush-ai-conversation-events" });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_auto_cleared"
    ),
    "periodic sweep did not clear the overdue notification"
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
});

test("clear matched=false never fabricates an auto-cleared lifecycle event", async () => {
  const harness = await readyHarness({ notificationClearMatched: false });
  const response = await createTrackedNotification(harness);
  await harness.clock.advance(20000);
  await waitFor(
    () => !Object.hasOwn(
      harness.storage.notification_targets_v1,
      response.notification_id
    ),
    "unmatched notification target was not cleaned up"
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.equal(
    writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_auto_cleared"
    ),
    false
  );
});

test("notification permission denied fails before target storage or Chrome create", async () => {
  const harness = await readyHarness({
    notificationPermissionLevel: "denied"
  });
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    error_code: "notification_permission_denied"
  });
  assert.equal(harness.notificationsCreated.length, 0);
  assert.equal(harness.storage.notification_targets_v1, undefined);
  const failed = writtenEvents(harness).find(
    (event) => event.data.event_type === "tracker_notification_failed"
  );
  assert.deepEqual(clone(failed.data.metadata), {
    error_code: "notification_permission_denied",
    phase: "permission"
  });
});

test("notification permission preflight error fails closed without persisting raw error", async () => {
  const harness = await readyHarness({
    notificationPermissionError: "SYNTHETIC_PRIVATE_PERMISSION_ERROR"
  });
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    error_code: "notification_permission_check_failed"
  });
  assert.equal(harness.notificationsCreated.length, 0);
  assert.doesNotMatch(
    JSON.stringify(harness.storage),
    /SYNTHETIC_PRIVATE_PERMISSION_ERROR/
  );
});

test("notification create failure is reduced to an allowlisted failed event and safe diagnostic", async () => {
  const harness = await readyHarness({
    notificationCreateError: "Unable to download all specified images."
  });
  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.deepEqual(clone(response), {
    created: false,
    error_code: "notification_icon_load_failed"
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_failed"
    ),
    "notification failed event was not written"
  );
  const failed = writtenEvents(harness).find(
    (event) => event.data.event_type === "tracker_notification_failed"
  );
  assert.deepEqual(clone(failed.data.metadata), {
    error_code: "notification_icon_load_failed",
    phase: "create"
  });
  assert.deepEqual(
    clone(harness.storage.notification_targets_v1),
    {}
  );
  const diagnostics = JSON.stringify(harness.storage.background_diagnostics_v1);
  assert.doesNotMatch(diagnostics, /Unable to download/);
  assert.doesNotMatch(diagnostics, /https?:\/\//);
});

test("provisional conversation fails closed without creating or storing a root-URL target", async () => {
  const harness = await readyHarness();
  const provisionalUrl = "https://chatgpt.com/";
  const provisionalRequest = clone(NOTIFICATION_REQUEST);
  provisionalRequest.context = {
    identity: {
      conversation_key: "00000000-0000-4000-8000-000000000099",
      identity_status: "provisional",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    }
  };
  const provisionalSender = {
    id: FIXTURE_EXTENSION_ID,
    frameId: 0,
    url: provisionalUrl,
    tab: {
      id: 9,
      url: provisionalUrl,
      windowId: 3
    }
  };
  await sendResponseLifecycle(
    harness,
    provisionalRequest,
    provisionalSender,
    ["assistant_response_started", "assistant_response_completed"],
    40
  );
  const response = await sendRuntimeMessage(
    harness,
    provisionalRequest,
    provisionalSender
  );
  assert.deepEqual(clone(response), {
    created: false,
    error_code: "identity_not_exact"
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_failed" &&
        event.data.metadata.error_code === "identity_not_exact"
    ),
    "provisional notification failure was not audited"
  );
  assert.equal(harness.notificationsCreated.length, 0);
  assert.equal(harness.storage.notification_targets_v1, undefined);
  const failed = writtenEvents(harness).find(
    (event) => event.data.event_type === "tracker_notification_failed"
  );
  assert.deepEqual(clone(failed.data.metadata), {
    error_code: "identity_not_exact",
    phase: "validate_context"
  });
  assert.equal(Object.hasOwn(failed.data, "full_url"), false);
  assert.doesNotMatch(JSON.stringify(failed), /https?:\/\//);
  assert.doesNotMatch(
    JSON.stringify(harness.storage.background_diagnostics_v1),
    /https?:\/\//
  );
});

test("unprovisioned checkout uses browser-local exact identity for notification and verified existing-tab focus", async () => {
  const emptyProvisioning = {
    native_host_name: "org.chi27.attention.browserbridge",
    expected_extension_id: "",
    namespace_generation: 0,
    namespace_fingerprint: "",
    authority_public_key_x963_base64: ""
  };
  const harness = await readyHarness({
    authorityProvisioning: emptyProvisioning,
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    }
  });
  const authorityContext = await sendRuntimeMessage(
    harness,
    { type: "GET_AUTHORITY_CONTEXT" },
    clone(TARGET_SENDER)
  );
  assert.equal(authorityContext.status, "ready");
  assert.equal(authorityContext.authority_mode, "browser_local");

  const identity = await sendRuntimeMessage(
    harness,
    {
      type: "RESOLVE_CONVERSATION",
      provider: "chatgpt",
      provider_conversation_id: "chat_fixture_123"
    },
    clone(TARGET_SENDER)
  );
  assert.equal(identity.status, "issued");
  assert.equal(identity.authority_mode, "browser_local");
  assert.match(identity.conversation_key, /^[0-9a-f]{64}$/);
  assert.match(identity.locator_handle, /^loc_[A-Za-z0-9_-]{22}$/);
  assert.match(identity.namespace_fingerprint, /^browser-local-v1\./);

  const request = clone(NOTIFICATION_REQUEST);
  request.context.identity = {
    conversation_key: identity.conversation_key,
    identity_status: "exact",
    locator_handle: identity.locator_handle,
    namespace_generation: identity.namespace_generation,
    namespace_fingerprint: identity.namespace_fingerprint
  };
  harness.setTabContext(7, {
    conversation_key: identity.conversation_key,
    locator_handle: identity.locator_handle,
    namespace_generation: identity.namespace_generation,
    namespace_fingerprint: identity.namespace_fingerprint
  });
  await sendResponseLifecycle(
    harness,
    request,
    TARGET_SENDER,
    ["assistant_response_started", "assistant_response_completed"],
    210
  );
  const response = await sendRuntimeMessage(
    harness,
    request,
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, true);
  assert.equal(harness.notificationsCreated.length, 1);
  assert.equal(harness.nativeMessages.length, 0);

  const notificationId = harness.notificationsCreated[0].id;
  await harness.listeners.notificationClicks[0](notificationId);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_clicked" &&
        event.data.metadata.focus_succeeded === true
    ),
    "browser-local notification click was not verified and audited"
  );
  assert.equal(harness.nativeMessages.length, 0);
  const durable = JSON.stringify(harness.storage);
  assert.doesNotMatch(durable, /chat_fixture_123/);
  assert.doesNotMatch(durable, /https:\/\//);
});

test("same-origin SPA switch resolves exact identity and creates the custom notification", async () => {
  const emptyProvisioning = {
    native_host_name: "org.chi27.attention.browserbridge",
    expected_extension_id: "",
    namespace_generation: 0,
    namespace_fingerprint: "",
    authority_public_key_x963_base64: ""
  };
  const conversationB = "chat_fixture_456";
  const liveUrl = `https://chatgpt.com/c/${conversationB}`;
  const harness = await readyHarness({
    authorityProvisioning: emptyProvisioning,
    tabs: {
      7: { id: 7, url: liveUrl, windowId: 2 }
    }
  });
  const staleSender = clone(TARGET_SENDER);
  staleSender.tab.url = liveUrl;

  const identity = await sendRuntimeMessage(
    harness,
    {
      type: "RESOLVE_CONVERSATION",
      provider: "chatgpt",
      provider_conversation_id: conversationB
    },
    staleSender
  );

  assert.equal(identity.status, "issued");
  assert.equal(identity.authority_mode, "browser_local");
  assert.match(identity.conversation_key, /^[0-9a-f]{64}$/);
  assert.match(identity.locator_handle, /^loc_[A-Za-z0-9_-]{22}$/);

  const request = clone(NOTIFICATION_REQUEST);
  request.context.identity = {
    conversation_key: identity.conversation_key,
    identity_status: "exact",
    locator_handle: identity.locator_handle,
    namespace_generation: identity.namespace_generation,
    namespace_fingerprint: identity.namespace_fingerprint
  };
  await sendResponseLifecycle(
    harness,
    request,
    staleSender,
    ["assistant_response_started", "assistant_response_completed"],
    230
  );
  const response = await sendRuntimeMessage(
    harness,
    request,
    staleSender
  );

  assert.equal(response.created, true);
  assert.equal(harness.notificationsCreated.length, 1);
  assert.equal(
    harness.notificationsCreated[0].payload.title,
    "CHI27 · ChatGPT 回答已完成"
  );
  assert.deepEqual(
    notificationLifecycle(harness).map((event) => event.data.event_type),
    ["tracker_notification_attempted", "tracker_notification_created"]
  );
  assert.equal(harness.nativeMessages.length, 0);
  assert.doesNotMatch(
    JSON.stringify({
      storage: harness.storage,
      writtenEvents: writtenEvents(harness)
    }),
    /chat_fixture_456|https?:\/\//
  );
});

test("ActivityWatch outage retains attempted and created notification events in the reliable queue", async () => {
  let activityWatchAvailable = true;
  const harness = await readyHarness({}, () => (
    activityWatchAvailable
      ? successfulResponse()
      : { ok: false, status: 503 }
  ));
  activityWatchAvailable = false;

  const response = await sendRuntimeMessage(
    harness,
    clone(NOTIFICATION_REQUEST),
    clone(TARGET_SENDER)
  );
  assert.equal(response.created, true);
  const pending = harness.storage.reliable_event_queue_v1.pending;
  assert.deepEqual(
    pending.map((item) => item.event.data.event_type),
    [
      "tracker_notification_attempted",
      "tracker_notification_created"
    ]
  );
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[1].attempts, 1);
});

const CLICK_CASES = [
  {
    name: "target tab still shows the conversation",
    options: {
      tabs: {
        7: { id: 7, url: TARGET_URL, windowId: 2 }
      },
      windows: {
        2: { id: 2, focused: false }
      }
    },
    expectedAction: "activated_existing_tab",
    expectedFocus: true,
    verify(harness) {
      assert.deepEqual(harness.tabsUpdated, [
        { id: 7, details: { active: true } }
      ]);
      assert.equal(harness.nativeMessages.length, 2);
      assert.equal(
        harness.nativeMessages.every(
          (message) =>
            message.type === "validate_web_locator" &&
            !Object.hasOwn(message, "provider_conversation_id") &&
            !Object.hasOwn(message, "full_url")
        ),
        true
      );
      assert.equal(harness.tabsCreated.length, 0);
      assert.equal(harness.windowsCreated.length, 0);
    }
  },
  {
    name: "original tab switched to another conversation",
    options: {
      tabs: {
        7: {
          id: 7,
          url: "https://chatgpt.com/c/another_conversation",
          windowId: 2
        }
      },
      windows: {
        2: { id: 2, focused: false }
      },
      tabContexts: {
        7: {
          conversation_key: "b".repeat(64),
          locator_handle: DIFFERENT_LOCATOR,
          namespace_generation: 1,
          namespace_fingerprint: "fixture-namespace-fingerprint"
        }
      }
    },
    expectedAction: "focus_failed",
    expectedFocus: false,
    verify(harness) {
      assert.equal(harness.tabsUpdated.length, 0);
      assert.equal(harness.tabsCreated.length, 0);
      assert.equal(harness.windowsCreated.length, 0);
    }
  },
  {
    name: "original tab was closed",
    options: {
      windows: {
        2: { id: 2, focused: false }
      }
    },
    expectedAction: "focus_failed",
    expectedFocus: false,
    verify(harness) {
      assert.equal(harness.tabsCreated.length, 0);
      assert.equal(harness.windowsCreated.length, 0);
    }
  },
  {
    name: "original window was closed",
    options: {},
    expectedAction: "focus_failed",
    expectedFocus: false,
    verify(harness) {
      assert.equal(harness.tabsCreated.length, 0);
      assert.equal(harness.windowsCreated.length, 0);
    }
  }
];

for (const clickCase of CLICK_CASES) {
  test(`notification click safely returns when ${clickCase.name}`, async () => {
    const harness = await readyHarness(clickCase.options);
    const response = await createTrackedNotification(harness);
    assert.equal(harness.listeners.notificationClicks.length, 1);
    harness.listeners.notificationClicks[0](response.notification_id);
    await waitFor(
      () => writtenEvents(harness).some(
        (event) => event.data.event_type === "tracker_notification_clicked"
      ),
      "notification clicked event was not written"
    );

    const clicked = writtenEvents(harness).find(
      (event) => event.data.event_type === "tracker_notification_clicked"
    );
    assert.deepEqual(clone(clicked.data.metadata), {
      action: clickCase.expectedAction,
      focus_succeeded: clickCase.expectedFocus,
      phase: "focus"
    });
    clickCase.verify(harness);
    if (clickCase.expectedFocus) {
      assert.deepEqual(
        clone(harness.storage.notification_targets_v1),
        {}
      );
      assert.deepEqual(
        harness.notificationsCleared,
        [response.notification_id]
      );
    } else {
      assert.equal(
        Object.hasOwn(
          harness.storage.notification_targets_v1,
          response.notification_id
        ),
        true
      );
      assert.deepEqual(harness.notificationsCleared, []);
    }
    const diagnostic = harness.storage.background_diagnostics_v1.at(-1);
    assert.equal(diagnostic.event_type, "tracker_notification_clicked");
    assert.equal(diagnostic.action, clickCase.expectedAction);
    assert.equal(diagnostic.focus_succeeded, clickCase.expectedFocus);
    assert.equal(Object.hasOwn(diagnostic, "notification_id"), false);
    assert.equal(Object.hasOwn(diagnostic, "url"), false);
  });
}

test("successful notification focus keeps clear API failure as a safe clear diagnostic", async () => {
  const clearErrorCanary =
    "RAW_CLEAR_ERROR_CANARY https://chatgpt.com/c/private-route";
  const harness = await readyHarness({
    notificationClearError: clearErrorCanary,
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    }
  });
  const response = await createTrackedNotification(harness);
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => (harness.storage.background_diagnostics_v1 || []).some(
      (diagnostic) => diagnostic.code === "notification_clear_failed"
    ),
    "notification clear API failure was not diagnosed"
  );

  const clicked = writtenEvents(harness).find(
    (event) => event.data.event_type === "tracker_notification_clicked"
  );
  assert.deepEqual(clone(clicked.data.metadata), {
    action: "activated_existing_tab",
    focus_succeeded: true,
    phase: "focus"
  });
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});

  const diagnostics = harness.storage.background_diagnostics_v1 || [];
  const clearDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "notification_clear_failed"
  );
  assert.equal(clearDiagnostics.length, 1);
  assert.deepEqual(Object.keys(clearDiagnostics[0]).sort(), [
    "code",
    "http_status",
    "retry_count",
    "timestamp"
  ]);
  assert.equal(
    diagnostics.some(
      (diagnostic) => diagnostic.code === "notification_focus_failed"
    ),
    false
  );
  assert.doesNotMatch(
    JSON.stringify({
      consoleErrors: harness.consoleErrors,
      diagnostics
    }),
    /RAW_CLEAR_ERROR_CANARY|private-route|https?:\/\//
  );
});

const TAB_LOOKUP_FAILURE_CASES = [
  {
    name: "a null callback without runtime.lastError",
    options: { tabGetNullWithoutError: true }
  },
  {
    name: "an invalid-tab API error",
    options: { tabGetError: "Invalid tab ID: 7." }
  },
  {
    name: "an unknown transient API error",
    options: { tabGetError: "Synthetic transient tabs API failure" }
  },
  {
    name: "a permission error",
    options: { tabGetError: "Cannot access tab 7 due to permissions." }
  },
  {
    name: "a near-match with appended free text",
    options: { tabGetError: "No tab with id: 7. Permission denied" }
  },
  {
    name: "a not-found message with leading whitespace",
    options: { tabGetError: " No tab with id: 7." }
  },
  {
    name: "a not-found message with trailing whitespace",
    options: { tabGetError: "No tab with id: 7. " }
  }
];

for (const lookupCase of TAB_LOOKUP_FAILURE_CASES) {
  test(`tab lookup fails closed without native reopen for ${lookupCase.name}`, async () => {
    const harness = await readyHarness(lookupCase.options);
    const response = await createTrackedNotification(harness);
    harness.listeners.notificationClicks[0](response.notification_id);
    await waitFor(
      () => writtenEvents(harness).some(
        (event) => event.data.event_type === "tracker_notification_clicked"
      ),
      "tab lookup failure was not audited"
    );

    assert.equal(harness.nativeMessages.length, 0);
    assert.equal(harness.tabsCreated.length, 0);
    assert.equal(harness.windowsCreated.length, 0);
    const clicked = writtenEvents(harness).find(
      (event) => event.data.event_type === "tracker_notification_clicked"
    );
    assert.deepEqual(clone(clicked.data.metadata), {
      action: "focus_failed",
      focus_succeeded: false,
      phase: "focus"
    });
    const diagnostic = harness.storage.background_diagnostics_v1.at(-1);
    assert.equal(diagnostic.code, "notification_tab_lookup_failed");
    assert.doesNotMatch(
      JSON.stringify(harness.storage.background_diagnostics_v1),
      /Synthetic transient|Invalid tab|Cannot access|Permission denied/
    );
  });
}

const INVALID_PERSISTED_TAB_CASES = [
  { name: "null", value: null, suffix: "101" },
  { name: "string", value: "7", suffix: "102" },
  { name: "negative integer", value: -1, suffix: "103" }
];

for (const tabCase of INVALID_PERSISTED_TAB_CASES) {
  test(`persisted ${tabCase.name} tab_id is unavailable and cannot prepare reopen`, async () => {
    const notificationId = (
      `chi27-ai-00000000-0000-4000-8000-000000000${tabCase.suffix}`
    );
    const clock = createFakeClock();
    const harness = await readyHarness({
      activeNotifications: [notificationId],
      clock,
      initialStorage: {
        notification_targets_v1: {
          [notificationId]: {
            tab_id: tabCase.value,
            window_id: 2,
            provider: "chatgpt",
            conversation: {
              conversation_key: "a".repeat(64),
              identity_status: "exact",
              namespace_generation: 1,
              namespace_fingerprint: "fixture-namespace-fingerprint"
            },
            locator_handle: CHATGPT_LOCATOR,
            reason_code: "response_completed_while_hidden",
            due_at: new Date(clock.now() + 8000).toISOString()
          }
        }
      }
    });

    const sanitized = harness.storage.notification_targets_v1[notificationId];
    assert.equal(sanitized.tab_id, null);
    assert.equal(sanitized.target_status, "unavailable");
    harness.listeners.notificationClicks[0](notificationId);
    await waitFor(
      () => !Object.hasOwn(
        harness.storage.notification_targets_v1,
        notificationId
      ),
      "invalid persisted target was not rejected"
    );
    assert.equal(harness.nativeMessages.length, 0);
    assert.equal(harness.tabsCreated.length, 0);
    assert.equal(harness.windowsCreated.length, 0);
    assert.equal(
      harness.storage.background_diagnostics_v1.some(
        (item) => item.code === "notification_target_missing_or_invalid"
      ),
      true
    );
  });
}

test("missing original tab uses prepare plus exact confirm and never opens a raw URL from Chrome", async () => {
  let targetBinding;
  const rawIdCanary = "raw_reopen_provider_id_canary";
  const harness = await readyHarness({
    windows: {
      9: { id: 9, focused: false }
    },
    nativeResponseFactory(request) {
      if (request.type === "prepare_reopen") {
        targetBinding = clone(request);
        return signedNativeReopenResponse(request, targetBinding);
      }
      if (request.type === "confirm_web_reopen") {
        return signedNativeReopenResponse(request, targetBinding);
      }
      return signedNativeAuthorityResponse(request);
    }
  });
  const response = await createTrackedNotification(harness);
  assert.equal(harness.nativeMessages.length, 0);
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => harness.nativeMessages.some(
      (message) => message.type === "prepare_reopen"
    ),
    "explicit click did not prepare native reopen"
  );
  harness.emitTabCreated({
    id: 31,
    windowId: 9,
    url: `https://chatgpt.com/c/${rawIdCanary}`
  }, {
    conversation_key: "a".repeat(64),
    locator_handle: CHATGPT_LOCATOR,
    namespace_generation: 1,
    namespace_fingerprint: "fixture-namespace-fingerprint"
  });
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_clicked" &&
        event.data.metadata.focus_succeeded === true
    ),
    "exact reopen confirmation did not become focus success"
  );

  assert.deepEqual(
    harness.nativeMessages.map((message) => message.type),
    ["prepare_reopen", "confirm_web_reopen"]
  );
  assert.equal(harness.nativeMessages[0].attempt_id, undefined);
  assert.equal(harness.nativeMessages[1].attempt_id, REOPEN_ATTEMPT_ID);
  assert.equal(harness.nativeMessages[1].conversation_key, "a".repeat(64));
  assert.equal(harness.tabsCreated.length, 0);
  assert.equal(harness.windowsCreated.length, 0);
  assert.deepEqual(harness.tabsUpdated, [
    { id: 31, details: { active: true } }
  ]);
  assert.deepEqual(harness.windowsUpdated, [
    { id: 9, details: { focused: true } }
  ]);
  const clicked = writtenEvents(harness).find(
    (event) => event.data.event_type === "tracker_notification_clicked"
  );
  assert.deepEqual(clone(clicked.data.metadata), {
    action: "reopened_via_native_actuator",
    focus_succeeded: true,
    phase: "focus"
  });
  const durableAndWire = JSON.stringify({
    nativeMessages: harness.nativeMessages,
    storage: harness.storage,
    events: writtenEvents(harness),
    diagnostics: harness.consoleErrors
  });
  assert.doesNotMatch(durableAndWire, new RegExp(rawIdCanary));
  assert.doesNotMatch(durableAndWire, /https?:\/\/(?:chatgpt\.com|claude\.ai)/);
});

test("duplicate notification clicks share one background prepare attempt and one terminal audit", async () => {
  const harness = await readyHarness({ nativeMessageNoCallback: true });
  const response = await createTrackedNotification(harness);
  harness.listeners.notificationClicks[0](response.notification_id);
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => harness.nativeMessages.length === 1,
    "duplicate click did not reach the shared prepare"
  );
  assert.equal(harness.nativeMessages[0].type, "prepare_reopen");
  await harness.clock.advance(1500);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_clicked"
    ),
    "shared prepare did not settle"
  );
  assert.equal(harness.nativeMessages.length, 1);
  assert.equal(
    writtenEvents(harness).filter(
      (event) => event.data.event_type === "tracker_notification_clicked"
    ).length,
    1
  );
});

const POST_FOCUS_FAILURE_CASES = [
  {
    name: "the tab navigates from conversation A to B during focus",
    options: {
      tabContexts: {
        7: [
          {
            conversation_key: "a".repeat(64),
            locator_handle: CHATGPT_LOCATOR,
            namespace_generation: 1,
            namespace_fingerprint: "fixture-namespace-fingerprint"
          },
          {
            conversation_key: "b".repeat(64),
            locator_handle: DIFFERENT_LOCATOR,
            namespace_generation: 1,
            namespace_fingerprint: "fixture-namespace-fingerprint"
          }
        ]
      }
    }
  },
  {
    name: "the live namespace changes during focus",
    options: {
      tabContexts: {
        7: [
          {
            conversation_key: "a".repeat(64),
            locator_handle: CHATGPT_LOCATOR,
            namespace_generation: 1,
            namespace_fingerprint: "fixture-namespace-fingerprint"
          },
          {
            conversation_key: "a".repeat(64),
            locator_handle: CHATGPT_LOCATOR,
            namespace_generation: 2,
            namespace_fingerprint: "fixture-namespace-fingerprint-v2"
          }
        ]
      }
    }
  },
  {
    name: "the native authority returns a different opaque locator",
    options: {
      nativeResponseFactory: (() => {
        let calls = 0;
        return (request) => {
          calls += 1;
          return signedNativeAuthorityResponse(
            request,
            calls === 1 ? {} : {
              locator_handle: DIFFERENT_LOCATOR
            }
          );
        };
      })()
    }
  }
];

for (const failureCase of POST_FOCUS_FAILURE_CASES) {
  test(`notification click is attempted but not successful when ${failureCase.name}`, async () => {
    const harness = await readyHarness(Object.assign({
      tabs: {
        7: { id: 7, url: TARGET_URL, windowId: 2 }
      },
      windows: {
        2: { id: 2, focused: false }
      }
    }, failureCase.options));
    const response = await createTrackedNotification(harness);
    harness.listeners.notificationClicks[0](response.notification_id);
    await waitFor(
      () => writtenEvents(harness).some(
        (event) =>
          event.data.event_type === "tracker_notification_clicked" &&
          event.data.metadata.focus_succeeded === false
      ),
      "post-focus mismatch was not audited as failure"
    );
    const clicked = writtenEvents(harness).find(
      (event) => event.data.event_type === "tracker_notification_clicked"
    );
    assert.deepEqual(clone(clicked.data.metadata), {
      action: "activated_existing_tab",
      focus_succeeded: false,
      phase: "focus"
    });
    assert.equal(harness.tabsUpdated.length, 1, "focus attempt must be visible");
    assert.equal(harness.notificationsCleared.length, 0);
    assert.equal(
      Object.hasOwn(
        harness.storage.notification_targets_v1,
        response.notification_id
      ),
      true
    );
  });
}

test("native authority timeout after focus is audited as failure, never success", async () => {
  const harness = await readyHarness({
    nativeMessageNoCallbackAfter: 1,
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    }
  });
  const response = await createTrackedNotification(harness);
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => harness.tabsUpdated.length === 1,
    "focus attempt did not reach native postcondition"
  );
  await harness.clock.advance(1500);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_clicked" &&
        event.data.metadata.focus_succeeded === false
    ),
    "native timeout was not audited as failure"
  );
  assert.equal(harness.notificationsCleared.length, 0);
  assert.equal(
    Object.hasOwn(
      harness.storage.notification_targets_v1,
      response.notification_id
    ),
    true
  );
});

test("clicking a malformed persisted target deletes it instead of leaking a claim", async () => {
  const notificationId = "chi27-ai-00000000-0000-4000-8000-000000000095";
  const clock = createFakeClock();
  const harness = await readyHarness({
    activeNotifications: [notificationId],
    clock,
    initialStorage: {
      notification_targets_v1: {
        [notificationId]: {
          tab_id: 7,
          window_id: 2,
          provider: "chatgpt",
          conversation: {
            conversation_key: "a".repeat(64),
            identity_status: "exact"
          },
          reason_code: "response_completed_while_hidden",
          url: "https://chatgpt.com/",
          due_at: new Date(clock.now() + 8000).toISOString()
        }
      }
    }
  });
  harness.listeners.notificationClicks[0](notificationId);
  await waitFor(
    () => !Object.hasOwn(
      harness.storage.notification_targets_v1,
      notificationId
    ),
    "malformed clicked target was not deleted"
  );
  await harness.clock.advance(8000);
  assert.deepEqual(harness.notificationsCleared, []);
  assert.equal(
    writtenEvents(harness).some(
      (event) => event.data.event_type === "tracker_notification_clicked"
    ),
    false
  );
});

test("failed notification focus retains the target only until its original deadline", async () => {
  const harness = await readyHarness({
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    },
    windowUpdateError: true
  });
  const response = await createTrackedNotification(harness);
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_clicked" &&
        event.data.metadata.focus_succeeded === false
    ),
    "failed focus was not audited"
  );
  const clicked = writtenEvents(harness).find(
    (event) => event.data.event_type === "tracker_notification_clicked"
  );
  assert.deepEqual(clone(clicked.data.metadata), {
    action: "activated_existing_tab",
    focus_succeeded: false,
    phase: "focus"
  });
  await waitFor(
    () => {
      const target = harness.storage.notification_targets_v1[
        response.notification_id
      ];
      return target && !target.terminal_state;
    },
    "failed focus claim was not released"
  );
  assert.equal(
    Object.hasOwn(
      harness.storage.notification_targets_v1,
      response.notification_id
    ),
    true
  );
  assert.equal(harness.notificationsCleared.length, 0);
  await harness.clock.advance(19999);
  assert.equal(
    Object.hasOwn(
      harness.storage.notification_targets_v1,
      response.notification_id
    ),
    true
  );
  assert.equal(harness.notificationsCleared.length, 0);

  await harness.clock.advance(1);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_auto_cleared"
    ),
    "failed-focus notification was not auto-cleared at its deadline"
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});
  assert.equal(
    writtenEvents(harness).filter(
      (event) => event.data.event_type === "tracker_notification_clicked"
    ).length,
    1
  );
  assert.equal(
    writtenEvents(harness).filter(
      (event) =>
        event.data.event_type === "tracker_notification_auto_cleared"
    ).length,
    1
  );
});

test("failed focus with clear matched=false drops the expired target without fabricating auto-cleared", async () => {
  const harness = await readyHarness({
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    },
    notificationClearMatched: false,
    windowUpdateError: true
  });
  const response = await createTrackedNotification(harness);
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => {
      const target = harness.storage.notification_targets_v1[
        response.notification_id
      ];
      return (
        writtenEvents(harness).some(
          (event) =>
            event.data.event_type === "tracker_notification_clicked" &&
            event.data.metadata.focus_succeeded === false
        ) &&
        target &&
        !target.terminal_state
      );
    },
    "failed focus was not audited and released"
  );

  await harness.clock.advance(20000);
  await waitFor(
    () => !Object.hasOwn(
      harness.storage.notification_targets_v1,
      response.notification_id
    ),
    "expired unmatched failed-focus target was not removed"
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.equal(
    writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_auto_cleared"
    ),
    false
  );
});

test("failed focus immediately clears when the persisted due_at is already past", async () => {
  const harness = await readyHarness({
    tabs: {
      7: { id: 7, url: TARGET_URL, windowId: 2 }
    },
    windows: {
      2: { id: 2, focused: false }
    },
    windowUpdateError: true
  });
  const response = await createTrackedNotification(harness);
  harness.storage.notification_targets_v1[response.notification_id].due_at =
    new Date(harness.clock.now() - 1).toISOString();
  harness.listeners.notificationClicks[0](response.notification_id);
  await waitFor(
    () => {
      const target = harness.storage.notification_targets_v1[
        response.notification_id
      ];
      return target && !target.terminal_state;
    },
    "past-due failed focus did not release its claim"
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await harness.clock.advance(0);
  await waitFor(
    () => writtenEvents(harness).some(
      (event) =>
        event.data.event_type === "tracker_notification_auto_cleared"
    ),
    "past-due failed focus was not cleared immediately"
  );
  assert.deepEqual(harness.notificationsCleared, [response.notification_id]);
  assert.deepEqual(clone(harness.storage.notification_targets_v1), {});
});
test("private Return cue is stored only for an active bound response and exports only after stop", async () => {
  const harness = await readyInactiveHarness();
  const started = await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const privateLabel = "注意力切换可分为三个阶段";
  await sendPrivateResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    500,
    privateLabel
  );

  const state = harness.storage.rta_private_return_cues_v1;
  assert.equal(state.schema_version, "1.0");
  assert.equal(state.records.length, 1);
  const record = state.records[0];
  assert.equal(record.study_session_id, started.status.session_id);
  assert.equal(record.label, privateLabel);
  assert.match(record.event_link_id, /^evt_[0-9a-f]{20}$/);
  const rawCompletionId = "00000000-0000-4000-8000-000000000501";
  const rawTurnLinkId = turnLinkIdForOffset(500);
  assert.equal(
    record.event_link_id,
    `evt_${crypto.createHash("sha256").update(rawCompletionId).digest("hex").slice(0, 20)}`
  );
  const durablePrivate = JSON.stringify(state);
  assert.doesNotMatch(durablePrivate, new RegExp(rawCompletionId));
  assert.doesNotMatch(durablePrivate, new RegExp(rawTurnLinkId));
  for (const forbiddenKey of [
    "raw_completion_id",
    "turn_link_id",
    "response_preview",
    "notification_preview",
    "prompt",
    "embedding",
    "hash"
  ]) {
    assert.equal(Object.hasOwn(record, forbiddenKey), false);
  }
  assert.doesNotMatch(JSON.stringify(writtenEvents(harness)), new RegExp(privateLabel));
  assert.doesNotMatch(harness.consoleErrors.join("\n"), new RegExp(privateLabel));

  const activeExport = await sendRuntimeMessage(
    harness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.deepEqual(clone(activeExport), {
    ok: false,
    error_code: "private_cue_export_session_active"
  });

  await harness.clock.advance(5000);
  await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const exported = await sendRuntimeMessage(
    harness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.equal(exported.ok, true);
  assert.equal(exported.sidecar.schema_version, "chi27-rta-private-return-cues/1.0");
  assert.equal(exported.sidecar.study_session_id, started.status.session_id);
  assert.deepEqual(Object.keys(exported.sidecar.records[0]).sort(), [
    "completion_time",
    "event_link_id",
    "expires_at_utc",
    "generator",
    "label",
    "provider",
    "status",
    "version"
  ]);
  assert.equal(exported.sidecar.records[0].label, privateLabel);
  assert.doesNotMatch(JSON.stringify(exported.sidecar), new RegExp(rawCompletionId));
  assert.doesNotMatch(JSON.stringify(exported.sidecar), /https?:\/\//i);
  assert.equal(Object.hasOwn(exported.sidecar, "participant_id"), false);
  assert.doesNotMatch(JSON.stringify(exported.sidecar), /participant/i);
  assert.doesNotMatch(JSON.stringify(exported.sidecar), /P99/);
  assert.doesNotMatch(JSON.stringify(harness.storage), /P99/);
  assert.doesNotMatch(harness.consoleErrors.join("\n"), /P99/);
});

test("private Return cue export requires the existing local participant config", async () => {
  const missingHarness = await readyInactiveHarness({ participantConfig: null });
  await sendRuntimeMessage(
    missingHarness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendRuntimeMessage(
    missingHarness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const missing = await sendRuntimeMessage(
    missingHarness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.deepEqual(clone(missing), {
    ok: false,
    error_code: "participant_config_missing"
  });

  const invalidHarness = await readyInactiveHarness({
    participantConfig: {
      schema_version: "1.0",
      participant_id: "INVALID"
    }
  });
  await sendRuntimeMessage(
    invalidHarness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendRuntimeMessage(
    invalidHarness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const invalid = await sendRuntimeMessage(
    invalidHarness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.deepEqual(clone(invalid), {
    ok: false,
    error_code: "participant_config_invalid"
  });
  assert.doesNotMatch(invalidHarness.consoleErrors.join("\n"), /INVALID/);
  assert.doesNotMatch(JSON.stringify(invalidHarness.storage), /INVALID/);
});

test("private Return cue export rejects a changed participant authority without disclosing either ID", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const first = await sendRuntimeMessage(
    harness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.equal(first.ok, true);
  harness.setParticipantConfig({
    schema_version: "1.0",
    participant_id: "P100"
  });
  const conflict = await sendRuntimeMessage(
    harness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.deepEqual(clone(conflict), {
    ok: false,
    error_code: "participant_config_conflict"
  });
  const durableOutput = JSON.stringify({
    conflict,
    consoleErrors: harness.consoleErrors,
    storage: harness.storage
  });
  assert.doesNotMatch(durableOutput, /P99|P100/);
});

test("cancel immediately clears private Return cues and cancelled sessions cannot export", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendPrivateResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    520,
    "回看这个回答的具体步骤"
  );
  assert.equal(harness.storage.rta_private_return_cues_v1.records.length, 1);

  await sendRuntimeMessage(
    harness,
    { type: "CANCEL_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  assert.deepEqual(harness.storage.rta_private_return_cues_v1.records, []);
  const exported = await sendRuntimeMessage(
    harness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.deepEqual(clone(exported), {
    ok: false,
    error_code: "private_cue_export_session_cancelled"
  });
});

test("expired private Return cues fail closed with a fixed export code", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendPrivateResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    540,
    "这条回溯线索将超过保留期限"
  );
  await sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await harness.clock.advance(PrivateReturnCues.RECORD_TTL_MS + 5000);
  const exported = await sendRuntimeMessage(
    harness,
    { type: "EXPORT_PRIVATE_RETURN_CUES" },
    OPTIONS_PAGE_SENDER
  );
  assert.deepEqual(clone(exported), {
    ok: false,
    error_code: "private_cue_export_expired"
  });
});

test("stop wins a true late-completion race and old authorization cannot write afterward", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    600
  );
  const authorization = await sendRuntimeMessage(
    harness,
    { type: "AUTHORIZE_PRIVATE_RETURN_CUE" },
    TARGET_SENDER
  );
  assert.equal(authorization.authorized, true);
  const completed = responseLifecycleEvent(
    NOTIFICATION_REQUEST,
    "assistant_response_completed",
    "00000000-0000-4000-8000-000000000601"
  );
  const completionMessage = {
    type: "ENQUEUE_EVENTS",
    events: [completed],
    private_return_cue: privateCueForCompletion(
      completed,
      "停止之后不得回写这个标签"
    ),
    private_return_cue_authorization: authorization.authorization_id
  };

  const stopPromise = sendRuntimeMessage(
    harness,
    { type: "STOP_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const completionPromise = sendRuntimeMessage(
    harness,
    completionMessage,
    TARGET_SENDER
  );
  await Promise.all([stopPromise, completionPromise]);
  assert.deepEqual(harness.storage.rta_private_return_cues_v1.records, []);
  assert.equal(
    writtenEvents(harness).some(
      (event) => event.data.source_event_id === completed.data.source_event_id
    ),
    true
  );
});

test("cancel queued behind an in-flight completion leaves no private cue", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    620
  );
  const authorization = await sendRuntimeMessage(
    harness,
    { type: "AUTHORIZE_PRIVATE_RETURN_CUE" },
    TARGET_SENDER
  );
  const completed = responseLifecycleEvent(
    NOTIFICATION_REQUEST,
    "assistant_response_completed",
    "00000000-0000-4000-8000-000000000621"
  );
  const completionPromise = sendRuntimeMessage(
    harness,
    {
      type: "ENQUEUE_EVENTS",
      events: [completed],
      private_return_cue: privateCueForCompletion(
        completed,
        "取消必须清除这个并发标签"
      ),
      private_return_cue_authorization: authorization.authorization_id
    },
    TARGET_SENDER
  );
  const cancelPromise = sendRuntimeMessage(
    harness,
    { type: "CANCEL_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await Promise.all([completionPromise, cancelPromise]);
  assert.deepEqual(harness.storage.rta_private_return_cues_v1.records, []);
});

test("private cue authorization is active-only and one-message use", async () => {
  const harness = await readyInactiveHarness();
  const inactive = await sendRuntimeMessage(
    harness,
    { type: "AUTHORIZE_PRIVATE_RETURN_CUE" },
    TARGET_SENDER
  );
  assert.deepEqual(clone(inactive), {
    authorized: false,
    reason: "study_session_inactive"
  });

  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    640
  );
  const authorization = await sendRuntimeMessage(
    harness,
    { type: "AUTHORIZE_PRIVATE_RETURN_CUE" },
    TARGET_SENDER
  );
  const first = responseLifecycleEvent(
    NOTIFICATION_REQUEST,
    "assistant_response_completed",
    "00000000-0000-4000-8000-000000000641"
  );
  await sendRuntimeMessage(
    harness,
    {
      type: "ENQUEUE_EVENTS",
      events: [first],
      private_return_cue: privateCueForCompletion(first, "第一次授权使用"),
      private_return_cue_authorization: authorization.authorization_id
    },
    TARGET_SENDER
  );
  assert.equal(harness.storage.rta_private_return_cues_v1.records.length, 1);

  await sendResponseLifecycle(
    harness,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    ["assistant_response_started"],
    642
  );
  const second = responseLifecycleEvent(
    NOTIFICATION_REQUEST,
    "assistant_response_completed",
    "00000000-0000-4000-8000-000000000643"
  );
  await sendRuntimeMessage(
    harness,
    {
      type: "ENQUEUE_EVENTS",
      events: [second],
      private_return_cue: privateCueForCompletion(second, "不得跨消息复用"),
      private_return_cue_authorization: authorization.authorization_id
    },
    TARGET_SENDER
  );
  assert.equal(harness.storage.rta_private_return_cues_v1.records.length, 1);
});

test("inactive, mismatched, and non-unique completion cues never enter private storage", async () => {
  const inactive = await readyInactiveHarness();
  await sendPrivateResponseLifecycle(
    inactive,
    NOTIFICATION_REQUEST,
    TARGET_SENDER,
    540,
    "不会保存的短标签"
  );
  assert.deepEqual(inactive.storage.rta_private_return_cues_v1.records, []);

  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const first = responseLifecycleEvent(
    NOTIFICATION_REQUEST,
    "assistant_response_completed",
    "00000000-0000-4000-8000-000000000551"
  );
  const second = responseLifecycleEvent(
    NOTIFICATION_REQUEST,
    "assistant_response_completed",
    "00000000-0000-4000-8000-000000000552"
  );
  const authorization = await sendRuntimeMessage(
    harness,
    { type: "AUTHORIZE_PRIVATE_RETURN_CUE" },
    TARGET_SENDER
  );
  const duplicateCompletion = await sendRuntimeMessage(
    harness,
    {
      type: "ENQUEUE_EVENTS",
      events: [first, second],
      private_return_cue: privateCueForCompletion(first),
      private_return_cue_authorization: authorization.authorization_id
    },
    TARGET_SENDER
  );
  assert.deepEqual(clone(duplicateCompletion), {
    error: "rejected_content_event",
    rejected: true
  });

  const mismatched = privateCueForCompletion(first);
  mismatched.raw_completion_id = "00000000-0000-4000-8000-000000000559";
  const mismatchResult = await sendRuntimeMessage(
    harness,
    {
      type: "ENQUEUE_EVENTS",
      events: [first],
      private_return_cue: mismatched,
      private_return_cue_authorization: authorization.authorization_id
    },
    TARGET_SENDER
  );
  assert.deepEqual(clone(mismatchResult), {
    error: "rejected_content_event",
    rejected: true
  });
  assert.deepEqual(harness.storage.rta_private_return_cues_v1.records, []);
});

test("private cue mutation chain preserves concurrent completions from two providers", async () => {
  const harness = await readyInactiveHarness();
  await sendRuntimeMessage(
    harness,
    { type: "START_STUDY_SESSION" },
    EXTENSION_PAGE_SENDER
  );
  const claudeUrl = "https://claude.ai/chat/claude_fixture_123";
  const claudeRequest = clone(NOTIFICATION_REQUEST);
  claudeRequest.provider = "claude";
  claudeRequest.context.identity.conversation_key = "b".repeat(64);
  claudeRequest.context.identity.locator_handle = CLAUDE_LOCATOR;
  const claudeSender = clone(TARGET_SENDER);
  claudeSender.url = claudeUrl;
  claudeSender.tab.url = claudeUrl;

  await Promise.all([
    sendPrivateResponseLifecycle(
      harness,
      NOTIFICATION_REQUEST,
      TARGET_SENDER,
      570,
      "ChatGPT 回答的切换成本"
    ),
    sendPrivateResponseLifecycle(
      harness,
      claudeRequest,
      claudeSender,
      580,
      "Claude 回答的任务边界"
    )
  ]);
  const records = harness.storage.rta_private_return_cues_v1.records;
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.provider).sort(),
    ["chatgpt", "claude"]
  );
  assert.equal(new Set(records.map((record) => record.event_link_id)).size, 2);
});

test("worker startup and retry alarm purge expired private cues", async () => {
  const completionTime = "2026-07-30T00:00:02.000Z";
  const state = {
    schema_version: "1.0",
    records: [{
      study_session_id: "11111111-1111-4111-8111-111111111111",
      event_link_id: "evt_4a66f48c4bb0def380ea",
      provider: "chatgpt",
      completion_time: completionTime,
      label: "注意力切换可分为三个阶段",
      generator: "deterministic_response_preview_v1",
      version: "1.0",
      status: "generated",
      expires_at_utc: new Date(
        Date.parse(completionTime) + PrivateReturnCues.RECORD_TTL_MS
      ).toISOString()
    }]
  };
  const harness = createBackgroundHarness(
    () => successfulResponse(),
    { initialStorage: { rta_private_return_cues_v1: state } }
  );
  await waitFor(
    () => writtenEvents(harness).some(
      (event) => event.data.event_type === "watcher_heartbeat"
    ),
    "startup heartbeat was not written"
  );
  assert.equal(harness.storage.rta_private_return_cues_v1.records.length, 1);
  await harness.clock.advance(8 * 24 * 60 * 60 * 1000);
  harness.listeners.alarms[0]({ name: "flush-ai-conversation-events" });
  await waitFor(
    () => harness.storage.rta_private_return_cues_v1.records.length === 0,
    "retry alarm did not purge expired private cues"
  );
});
