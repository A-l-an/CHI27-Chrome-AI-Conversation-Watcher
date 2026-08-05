"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SESSION_DATA_KEYS,
  StudySessionController,
  WARNING_AFTER_MS,
  buildStudySessionEvent,
  studySessionEventId,
  validateStudySessionEvent
} = require("../src/session_controller.js");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const START_MS = Date.parse("2026-07-31T01:02:03.000Z");

function memoryStore(initial = { status: "inactive" }) {
  let state = structuredClone(initial);
  return {
    async get() {
      return structuredClone(state);
    },
    async set(next) {
      state = structuredClone(next);
    },
    snapshot() {
      return structuredClone(state);
    }
  };
}

function fixture(options = {}) {
  let nowMs = options.nowMs || START_MS;
  let idIndex = 0;
  const ids = [SESSION_ID, SECOND_SESSION_ID];
  const markers = [];
  const store = options.store || memoryStore();
  const controller = new StudySessionController({
    store,
    emitMarker: async (event) => {
      markers.push(structuredClone(event));
    },
    pendingCount: options.pendingCount || (async () => 0),
    now: () => nowMs,
    randomUuid: () => ids[idIndex++],
    timeZone: () => "Asia/Shanghai",
    offsetMinutes: () => 480
  });
  return {
    advance(milliseconds) {
      nowMs += milliseconds;
    },
    controller,
    markers,
    store
  };
}

test("start and stop persist one paired marker with the original start time", async () => {
  const harness = fixture();
  const started = await harness.controller.start();
  assert.equal(started.changed, true);
  assert.equal(started.active, true);
  assert.equal(started.session_id, SESSION_ID);

  harness.advance(12345);
  const stopped = await harness.controller.stop();
  assert.equal(stopped.changed, true);
  assert.equal(stopped.active, false);
  assert.deepEqual(
    harness.markers.map((event) => event.data.event_type),
    ["study_session_started", "study_session_stopped"]
  );
  assert.equal(
    harness.markers[1].data.start_utc,
    harness.markers[0].data.start_utc
  );
  assert.equal(
    harness.markers[1].data.end_utc,
    "2026-07-31T01:02:15.345Z"
  );
});

test("cancel emits a fixed content-free reason code", async () => {
  const harness = fixture();
  await harness.controller.start();
  await harness.controller.cancel();
  assert.equal(
    harness.markers[1].data.event_type,
    "study_session_cancelled"
  );
  assert.equal(
    harness.markers[1].data.reason_code,
    "participant_cancelled"
  );
});

test("duplicate start and stop clicks are idempotent", async () => {
  const harness = fixture();
  const [first, second] = await Promise.all([
    harness.controller.start(),
    harness.controller.start()
  ]);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.reason, "already_active");
  assert.equal(harness.markers.length, 1);

  const stopped = await harness.controller.stop();
  const duplicateStop = await harness.controller.stop();
  assert.equal(stopped.changed, true);
  assert.equal(duplicateStop.changed, false);
  assert.equal(duplicateStop.reason, "not_active");
  assert.equal(harness.markers.length, 2);
});

test("new controller instance restores active state without duplicating start marker", async () => {
  const first = fixture();
  await first.controller.start();
  const restoredMarkers = [];
  const restored = new StudySessionController({
    store: first.store,
    emitMarker: async (event) => restoredMarkers.push(event),
    now: () => START_MS + 60000,
    randomUuid: () => SECOND_SESSION_ID,
    timeZone: () => "Asia/Shanghai",
    offsetMinutes: () => 480
  });

  const status = await restored.getStatus();
  assert.equal(status.active, true);
  assert.equal(status.session_id, SESSION_ID);
  assert.deepEqual(restoredMarkers, []);
  const duplicateStart = await restored.start();
  assert.equal(duplicateStart.changed, false);
  assert.deepEqual(restoredMarkers, []);
});

test("status exposes pending sync and the 90 minute reminder without ending", async () => {
  let pending = 1;
  const harness = fixture({ pendingCount: async () => pending });
  await harness.controller.start();
  let status = await harness.controller.getStatus();
  assert.equal(status.pending_sync, true);
  assert.equal(status.overdue, false);

  pending = 0;
  harness.advance(WARNING_AFTER_MS);
  status = await harness.controller.getStatus();
  assert.equal(status.active, true);
  assert.equal(status.pending_sync, false);
  assert.equal(status.overdue, true);
});

test("marker contract rejects unknown and sensitive fields", () => {
  const event = buildStudySessionEvent({
    event_type: "study_session_started",
    session_id: SESSION_ID,
    occurred_at: "2026-07-31T01:02:03.000Z",
    start_utc: "2026-07-31T01:02:03.000Z",
    timezone: "Asia/Shanghai",
    utc_offset_minutes: 480,
    source: "toolbar_popup"
  });
  assert.equal(validateStudySessionEvent(event), true);
  assert.deepEqual(
    Object.keys(event.data).sort(),
    Array.from(SESSION_DATA_KEYS)
      .filter((key) => !["end_utc", "reason_code"].includes(key))
      .sort()
  );
  assert.equal(
    studySessionEventId(event),
    `${SESSION_ID}:study_session_started`
  );
  for (const key of [
    "full_url",
    "provider",
    "conversation_key",
    "title",
    "prompt",
    "response",
    "source_event_id"
  ]) {
    const poisoned = structuredClone(event);
    poisoned.data[key] = "sensitive";
    assert.equal(validateStudySessionEvent(poisoned), false, key);
  }
});

test("marker contract rejects non-IANA timezone and non-UTC timestamps", () => {
  assert.throws(() => buildStudySessionEvent({
    event_type: "study_session_started",
    session_id: SESSION_ID,
    occurred_at: "2026-07-31T09:02:03+08:00",
    start_utc: "2026-07-31T09:02:03+08:00",
    timezone: "GMT+8",
    utc_offset_minutes: 480,
    source: "toolbar_popup"
  }), /invalid_study_session_marker/);
});
