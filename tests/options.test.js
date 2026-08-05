"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement() {
  const listeners = {};
  return {
    checked: false,
    disabled: false,
    listeners,
    style: {},
    textContent: "",
    value: "",
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
}

function createHarness(participantConfig = {
  schema_version: "1.0",
  participant_id: "P99"
}, exportResponse = null) {
  const elements = {
    "#settings": createElement(),
    "#aw-base-url": createElement(),
    "#bucket-id": createElement(),
    "#session-bucket-id": createElement(),
    "#notifications-enabled": createElement(),
    "#status": createElement(),
    "#test-connection": createElement(),
    "#export-private-cues": createElement(),
    "#participant-id": createElement(),
    "#participant-config-note": createElement()
  };
  const storageWrites = [];
  const runtimeMessages = [];
  const downloads = [];
  const objectUrls = [];
  class HarnessURL extends URL {
    static createObjectURL(blob) {
      objectUrls.push({ action: "create", blob });
      return "blob:private-return-cues";
    }

    static revokeObjectURL(url) {
      objectUrls.push({ action: "revoke", url });
    }
  }
  const chrome = {
    downloads: {
      download(options, callback) {
        downloads.push(structuredClone(options));
        callback(7);
      }
    },
    runtime: {
      lastError: null,
      getURL(relative) {
        return `chrome-extension://test/${relative}`;
      },
      sendMessage(message, callback) {
        runtimeMessages.push(structuredClone(message));
        if (message.type === "EXPORT_PRIVATE_RETURN_CUES") {
          callback(exportResponse || {
            ok: true,
            filename: "rta-return-cues-fixture.json",
            sidecar: {
              schema_version: "chi27-rta-private-return-cues/1.0",
              artifact_class: "local_content_derived_private",
              study_session_id: "11111111-1111-4111-8111-111111111111",
              created_at_utc: "2026-07-30T00:00:03.000Z",
              records: []
            }
          });
          return;
        }
        callback({
          ok: true,
          bucket_id: elements["#bucket-id"].value,
          session_bucket_id: elements["#session-bucket-id"].value
        });
      }
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({});
        },
        set(values, callback) {
          storageWrites.push(structuredClone(values));
          callback();
        }
      }
    }
  };
  const context = vm.createContext({
    Blob,
    URL: HarnessURL,
    chrome,
    fetch: async () => participantConfig === null
      ? { ok: false }
      : { ok: true, async json() { return structuredClone(participantConfig); } },
    document: {
      querySelector(selector) {
        return elements[selector];
      }
    }
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "participant_config.js"), "utf8"),
    context,
    { filename: "participant_config.js" }
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8"),
    context,
    { filename: "options.js" }
  );
  return {
    downloads,
    elements,
    objectUrls,
    runtimeMessages,
    storageWrites
  };
}

test("options save and connection test both reject identical bucket IDs without side effects", () => {
  const harness = createHarness();
  harness.elements["#bucket-id"].value = "same-bucket";
  harness.elements["#session-bucket-id"].value = "same-bucket";

  let prevented = false;
  harness.elements["#settings"].listeners.submit({
    preventDefault() {
      prevented = true;
    }
  });
  assert.equal(prevented, true);
  assert.deepEqual(harness.storageWrites, []);
  assert.match(
    harness.elements["#status"].textContent,
    /必须使用不同的 ID/
  );

  harness.elements["#test-connection"].listeners.click();
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.runtimeMessages, []);
  assert.match(
    harness.elements["#status"].textContent,
    /必须使用不同的 ID/
  );
});

test("options retain normal save and connection behavior for distinct default buckets", () => {
  const harness = createHarness();
  harness.elements["#settings"].listeners.submit({
    preventDefault() {}
  });
  assert.equal(harness.storageWrites.length, 1);
  assert.equal(
    harness.storageWrites[0].bucket_id,
    "aw-watcher-ai-conversations"
  );
  assert.equal(
    harness.storageWrites[0].session_bucket_id,
    "aw-watcher-study-sessions"
  );

  harness.elements["#test-connection"].listeners.click();
  assert.equal(harness.storageWrites.length, 2);
  assert.deepEqual(harness.runtimeMessages, [{ type: "TEST_CONNECTION" }]);
  assert.match(harness.elements["#status"].textContent, /连接成功/);
});

test("options show configured ID without writing it to Chrome storage", async () => {
  const harness = createHarness();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.elements["#participant-id"].textContent, "P99");
  assert.match(harness.elements["#participant-config-note"].textContent, /不会写进回溯文件/);
  assert.deepEqual(harness.storageWrites, []);
});

test("options clearly distinguish missing config from capture availability", async () => {
  const harness = createHarness(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.elements["#participant-id"].textContent, "未配置");
  assert.match(harness.elements["#participant-config-note"].textContent, /采集仍可继续/);
});

test("options explicitly downloads the private sidecar with saveAs and revokes its object URL", () => {
  const harness = createHarness();
  harness.elements["#export-private-cues"].listeners.click();
  assert.deepEqual(
    harness.runtimeMessages,
    [{ type: "EXPORT_PRIVATE_RETURN_CUES" }]
  );
  assert.deepEqual(harness.downloads, [{
    url: "blob:private-return-cues",
    filename: "rta-return-cues-fixture.json",
    saveAs: true,
    conflictAction: "uniquify"
  }]);
  assert.equal(harness.objectUrls[0].action, "create");
  assert.deepEqual(harness.objectUrls[1], {
    action: "revoke",
    url: "blob:private-return-cues"
  });
  assert.match(harness.elements["#status"].textContent, /已保存/);
  assert.equal(harness.elements["#export-private-cues"].disabled, false);
});

test("options uses the participant-facing save button contract", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "options.html"),
    "utf8"
  );
  assert.match(html, />保存给回溯工具…（JSON）<\/button>/);
  assert.match(html, /不包含参与者编号/);
  assert.doesNotMatch(html, /选择位置并导出 JSON/);
});

test("options explains active, cancelled, and expired export states without echoing labels", () => {
  const cases = [
    ["private_cue_export_session_active", /仍在进行/],
    ["private_cue_export_session_cancelled", /已取消/],
    ["private_cue_export_expired", /超过保留期限/]
  ];
  for (const [errorCode, expectedText] of cases) {
    const harness = createHarness(undefined, {
      ok: false,
      error_code: errorCode,
      label: "SYNTHETIC_PRIVATE_LABEL_MUST_NOT_APPEAR"
    });
    harness.elements["#export-private-cues"].listeners.click();
    const message = harness.elements["#status"].textContent;
    assert.match(message, expectedText);
    assert.doesNotMatch(message, /SYNTHETIC_PRIVATE_LABEL_MUST_NOT_APPEAR/);
    assert.doesNotMatch(message, /private_cue_export/);
    assert.equal(harness.elements["#export-private-cues"].disabled, false);
  }
});
