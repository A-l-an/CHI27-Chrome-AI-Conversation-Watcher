"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MemoryQueueStore,
  ReliableEventQueue
} = require("../src/reliable_queue.js");

function fixtureEvent(sourceId) {
  return {
    timestamp: "2026-07-23T00:00:00.000Z",
    duration: 0,
    data: { source_event_id: sourceId }
  };
}

test("queue retries failed writes and acknowledges a successful retry", async () => {
  const store = new MemoryQueueStore();
  let clock = 0;
  let calls = 0;
  const delivered = [];
  const queue = new ReliableEventQueue({
    store,
    now: () => clock,
    baseRetryMs: 100,
    transport: async (events) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("synthetic outage");
      }
      delivered.push(...events);
    }
  });

  assert.equal(await queue.enqueue([fixtureEvent("evt-1")]), 1);
  const first = await queue.process();
  assert.equal(first.status, "retry_scheduled");
  assert.equal((await store.get()).pending[0].next_attempt_at, 100);
  assert.equal((await queue.process()).status, "idle");

  clock = 100;
  const second = await queue.process();
  assert.equal(second.status, "sent");
  assert.equal(delivered.length, 1);
  assert.deepEqual((await store.get()).acknowledged, ["evt-1"]);
});

test("queue deduplicates source_event_id while pending and after acknowledgement", async () => {
  const store = new MemoryQueueStore();
  const queue = new ReliableEventQueue({
    store,
    transport: async () => {}
  });
  assert.equal(await queue.enqueue([
    fixtureEvent("same-id"),
    fixtureEvent("same-id")
  ]), 1);
  assert.equal(await queue.enqueue([fixtureEvent("same-id")]), 0);
  assert.equal((await queue.process()).status, "sent");
  assert.equal(await queue.enqueue([fixtureEvent("same-id")]), 0);
});

test("concurrent enqueues are serialized without dropping either event", async () => {
  const store = new MemoryQueueStore();
  const queue = new ReliableEventQueue({
    store,
    transport: async () => {}
  });
  const results = await Promise.all([
    queue.enqueue([fixtureEvent("concurrent-1")]),
    queue.enqueue([fixtureEvent("concurrent-2")])
  ]);
  assert.deepEqual(results, [1, 1]);
  const state = await store.get();
  assert.deepEqual(
    state.pending.map((item) => item.event.data.source_event_id).sort(),
    ["concurrent-1", "concurrent-2"]
  );
});
