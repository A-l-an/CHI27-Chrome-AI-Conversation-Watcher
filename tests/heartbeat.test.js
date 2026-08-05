"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateActivityWatchEvent } = require("../src/core.js");
const { createHeartbeatEvent } = require("../src/heartbeat.js");

test("background heartbeat factory emits the canonical event", () => {
  const event = createHeartbeatEvent(
    "2026-07-23T00:01:00.000Z",
    "sixty_second_alarm"
  );
  assert.equal(validateActivityWatchEvent(event), true);
  assert.equal(event.data.event_type, "watcher_heartbeat");
  assert.equal(event.data.provider, "watcher");
  assert.equal(event.data.conversation_key, "");
  assert.equal(event.data.source_adapter, "chrome-background-heartbeat-v1");
  assert.equal(event.data.metadata.signal, "sixty_second_alarm");
});

test("background schedules the heartbeat at a sixty-second period", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(
    source,
    /ensurePeriodicAlarm\(HEARTBEAT_ALARM,\s*1\)/
  );
  assert.match(source, /chrome\.alarms\.get\(name/);
  assert.match(
    source,
    /writeHeartbeat\("sixty_second_alarm"\)\.catch/
  );
});
