"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateActivityWatchEvent } = require("../src/core.js");
const { rebuildContentEvent } = require("../src/ingress.js");

const fixtureDir = path.join(__dirname, "fixtures");
const events = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "ledger_v1_events.json"), "utf8")
);
const expected = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "ledger_v1_expected.json"), "utf8")
);

test("ledger contract fixture is valid 08 output with three visits and two turns", () => {
  assert.equal(events.length, expected.source_event_count);
  assert.equal(events.every(validateActivityWatchEvent), true);
  assert.equal(
    events.filter((event) => event.data.event_type === "conversation_foregrounded").length,
    expected.visit_count
  );
  assert.equal(
    events.filter((event) => event.data.event_type === "assistant_response_completed").length,
    expected.turn_count
  );
  assert.equal(
    events.filter((event) => event.data.event_type === "user_returned").length,
    expected.returned_count
  );
  assert.equal(
    events.filter((event) => event.data.event_type === "user_interacted").length,
    expected.interacted_count
  );
  assert.equal(
    events.filter((event) => event.data.event_type === "user_engaged").length,
    expected.engaged_count
  );
  const visitCounts = {};
  for (const event of events) {
    if (event.data.event_type === "conversation_foregrounded") {
      visitCounts[event.data.conversation_key] =
        (visitCounts[event.data.conversation_key] || 0) + 1;
    }
  }
  assert.deepEqual(visitCounts, expected.conversation_visit_counts);
});

test("every provider-tab fixture event survives strict background reconstruction", () => {
  const extensionId = "fixture-extension";
  for (const event of events.filter((item) => item.data.provider === "chatgpt")) {
    const sender = {
      id: extensionId,
      frameId: 0,
      url: "https://chatgpt.com/",
      tab: { id: 9, url: "https://chatgpt.com/" }
    };
    const rebuilt = rebuildContentEvent(event, sender, extensionId);
    assert.deepEqual(rebuilt, event);
  }
});

test("ledger fixture contains no prompt or response body fields", () => {
  const serialized = JSON.stringify(events);
  for (const forbidden of [
    "prompt_text",
    "response_text",
    "page_title",
    "cookie",
    "token",
    "clipboard"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.doesNotMatch(serialized, /provider_conversation_id/);
  assert.doesNotMatch(serialized, /full_url/);
  assert.doesNotMatch(serialized, /https?:\/\//);
});
