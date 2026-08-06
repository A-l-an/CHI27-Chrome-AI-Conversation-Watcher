"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ConversationSessionRegistry,
  ConversationStateMachine
} = require("../src/state_machine.js");

function eventTypes(result) {
  return result.events.map((event) => event.event_type);
}

const TURN_A = "00000000-0000-4000-8000-0000000000a1";
const TURN_B = "00000000-0000-4000-8000-0000000000b2";

test("synthetic interaction trace covers input, submit dedupe, hidden completion, return, and engage", () => {
  const trace = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "interaction_trace.json"), "utf8")
  );
  const machine = new ConversationStateMachine();
  const allEvents = [];
  const allEffects = [];
  for (const action of trace) {
    const result = machine.dispatch(action);
    allEvents.push(...result.events);
    allEffects.push(...result.effects);
  }
  const types = allEvents.map((event) => event.event_type);
  assert.deepEqual(types, [
    "watcher_started",
    "conversation_foregrounded",
    "input_started",
    "prompt_submitted",
    "assistant_response_started",
    "conversation_backgrounded",
    "assistant_response_completed",
    "conversation_foregrounded",
    "user_returned",
    "user_interacted",
    "input_started",
    "user_engaged"
  ]);
  assert.deepEqual(allEffects, [{
    type: "SHOW_TRACKER_NOTIFICATION",
    reason_code: "response_completed_while_hidden"
  }]);
});

test("input_started fires only on each empty to non-empty transition", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({ type: "START", visible: true, at: 0 });
  assert.deepEqual(eventTypes(
    machine.dispatch({ type: "INPUT_CHANGED", nonEmpty: true, at: 1 })
  ), ["input_started"]);
  assert.deepEqual(eventTypes(
    machine.dispatch({ type: "INPUT_CHANGED", nonEmpty: true, at: 2 })
  ), []);
  machine.dispatch({ type: "INPUT_CHANGED", nonEmpty: false, at: 3 });
  assert.deepEqual(eventTypes(
    machine.dispatch({ type: "INPUT_CHANGED", nonEmpty: true, at: 4 })
  ), ["input_started"]);
});

test("submit signals inside the dedupe window produce one event", () => {
  const machine = new ConversationStateMachine();
  const first = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    signal: "send_control_clicked",
    at: 1000
  });
  const duplicate = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    signal: "composer_form_submitted",
    at: 1200
  });
  const later = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    signal: "send_control_clicked",
    at: 2600
  });
  assert.deepEqual(eventTypes(first), ["prompt_submitted"]);
  assert.deepEqual(eventTypes(duplicate), []);
  assert.deepEqual(eventTypes(later), [
    "adapter_unhealthy",
    "prompt_submitted"
  ]);
  assert.deepEqual(later.events[0].metadata, {
    adapter_health: "unhealthy",
    generation_state: "response_observation_incomplete_at_new_submission",
    observation_gap: true,
    reason_code: "new_submission_before_previous_terminal"
  });
});

test("one submission lifecycle keeps one link and the next submission gets a fresh link", () => {
  const machine = new ConversationStateMachine();
  const first = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1000
  });
  const started = machine.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1100
  });
  const completed = machine.dispatch({
    type: "RESPONSE_COMPLETED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1200
  });
  const second = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    at: 3000
  });
  assert.deepEqual(
    [...first.events, ...started.events, ...completed.events]
      .map((event) => event.turn_link_id),
    [TURN_A, TURN_A, TURN_A]
  );
  assert.equal(second.events[0].turn_link_id, TURN_B);
  assert.notEqual(TURN_A, TURN_B);
});

test("late terminal from an older observation cannot close a newer submission", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1000
  });
  machine.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1100
  });
  const replacement = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    at: 3000
  });
  assert.deepEqual(eventTypes(replacement), [
    "adapter_unhealthy",
    "prompt_submitted"
  ]);
  assert.deepEqual(eventTypes(machine.dispatch({
    type: "RESPONSE_COMPLETED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 3100
  })), []);
  const currentStarted = machine.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    at: 3200
  });
  const currentCompleted = machine.dispatch({
    type: "RESPONSE_COMPLETED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    at: 3300
  });
  assert.deepEqual(eventTypes(currentStarted), ["assistant_response_started"]);
  assert.deepEqual(eventTypes(currentCompleted), ["assistant_response_completed"]);
  assert.equal(currentCompleted.events[0].turn_link_id, TURN_B);
});

test("a different valid link is a new submit even inside the legacy time window", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1000
  });
  const second = machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    at: 1100
  });
  assert.deepEqual(eventTypes(second), [
    "adapter_unhealthy",
    "prompt_submitted"
  ]);
  assert.equal(second.events[1].turn_link_id, TURN_B);
});

test("ordinary start without submit is rejected; explicit left-censored start is linked", () => {
  const machine = new ConversationStateMachine();
  assert.deepEqual(eventTypes(machine.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 0
  })), []);
  const started = machine.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    leftCensored: true,
    at: 1
  });
  const completed = machine.dispatch({
    type: "RESPONSE_COMPLETED",
    observationEpoch: 2,
    turnLinkId: TURN_B,
    at: 2
  });
  assert.equal(started.events[0].turn_link_id, TURN_B);
  assert.equal(completed.events[0].turn_link_id, TURN_B);
});

test("cancel before the start mutation arrives still terminates the submitted link", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 0
  });
  const cancelled = machine.dispatch({
    type: "RESPONSE_CANCELLED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1
  });
  assert.deepEqual(eventTypes(cancelled), ["assistant_response_cancelled"]);
  assert.equal(cancelled.events[0].turn_link_id, TURN_A);
});

test("response failed and cancelled are terminal and do not also complete", () => {
  const failed = new ConversationStateMachine();
  failed.dispatch({
    type: "PROMPT_SUBMITTED",
    turnLinkId: TURN_A,
    at: -2000
  });
  failed.dispatch({ type: "RESPONSE_STARTED", turnLinkId: TURN_A, at: 0 });
  assert.deepEqual(eventTypes(
    failed.dispatch({ type: "RESPONSE_FAILED", turnLinkId: TURN_A, at: 1 })
  ), ["assistant_response_failed"]);
  assert.deepEqual(eventTypes(
    failed.dispatch({ type: "RESPONSE_COMPLETED", turnLinkId: TURN_A, at: 2 })
  ), []);

  const cancelled = new ConversationStateMachine();
  cancelled.dispatch({
    type: "PROMPT_SUBMITTED",
    turnLinkId: TURN_A,
    at: -2000
  });
  cancelled.dispatch({ type: "RESPONSE_STARTED", turnLinkId: TURN_A, at: 0 });
  assert.deepEqual(eventTypes(
    cancelled.dispatch({
      type: "RESPONSE_CANCELLED",
      turnLinkId: TURN_A,
      at: 1
    })
  ), ["assistant_response_cancelled"]);
});

test("untagged terminal cannot close an active tagged lifecycle", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 0
  });
  machine.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1
  });
  assert.deepEqual(eventTypes(machine.dispatch({
    type: "RESPONSE_COMPLETED",
    at: 2
  })), []);
  assert.deepEqual(eventTypes(machine.dispatch({
    type: "RESPONSE_COMPLETED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 3
  })), ["assistant_response_completed"]);
});

test("foreground-observed completion produces only an explicit suppressed audit effect", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({ type: "START", visible: true, at: 0 });
  machine.dispatch({
    type: "PROMPT_SUBMITTED",
    turnLinkId: TURN_A,
    at: 1
  });
  machine.dispatch({ type: "RESPONSE_STARTED", turnLinkId: TURN_A, at: 2 });
  const completed = machine.dispatch({
    type: "RESPONSE_COMPLETED",
    turnLinkId: TURN_A,
    at: 3
  });
  assert.deepEqual(eventTypes(completed), ["assistant_response_completed"]);
  assert.deepEqual(completed.effects, [{
    type: "AUDIT_TRACKER_NOTIFICATION_SUPPRESSED",
    reason_code: "response_completed_while_foreground"
  }]);
});

test("a click after return is interaction but engagement waits for input_started or submit", () => {
  const machine = new ConversationStateMachine();
  machine.dispatch({ type: "START", visible: true, at: 0 });
  machine.dispatch({ type: "BACKGROUND", at: 1 });
  machine.dispatch({ type: "FOREGROUND", at: 2 });
  assert.deepEqual(eventTypes(
    machine.dispatch({ type: "USER_INTERACTION", signal: "click", at: 3 })
  ), ["user_interacted"]);
  assert.deepEqual(eventTypes(
    machine.dispatch({ type: "USER_INTERACTION", signal: "scroll", at: 4 })
  ), []);
  assert.deepEqual(eventTypes(
    machine.dispatch({ type: "INPUT_CHANGED", nonEmpty: true, at: 5 })
  ), ["input_started", "user_engaged"]);
});

test("A to B to A retains per-conversation state and creates three visits", () => {
  const registry = new ConversationSessionRegistry();
  const transitions = [];
  transitions.push(...registry.start("conversation-A", { visible: true, at: 0 }));
  transitions.push(...registry.switchTo("conversation-B", { visible: true, at: 1 }));
  transitions.push(...registry.switchTo("conversation-A", { visible: true, at: 2 }));
  const flattened = transitions.flatMap((transition) =>
    transition.result.events.map((event) => ({
      conversation_key: transition.conversation_key,
      event_type: event.event_type
    }))
  );
  assert.equal(
    flattened.filter((event) => event.event_type === "conversation_foregrounded").length,
    3
  );
  assert.deepEqual(
    flattened.filter((event) => event.event_type === "conversation_foregrounded")
      .map((event) => event.conversation_key),
    ["conversation-A", "conversation-B", "conversation-A"]
  );
  assert.equal(
    flattened.some((event) =>
      event.conversation_key === "conversation-A" && event.event_type === "user_returned"
    ),
    true
  );
  assert.deepEqual(
    eventTypes(registry.dispatch({
      type: "USER_INTERACTION",
      signal: "click",
      at: 3
    }).result),
    ["user_interacted"]
  );
  assert.deepEqual(
    eventTypes(registry.dispatch({
      type: "INPUT_CHANGED",
      nonEmpty: true,
      at: 4
    }).result),
    ["input_started", "user_engaged"]
  );
});

test("navigating away during generation records an observation gap, never a guessed completion", () => {
  const registry = new ConversationSessionRegistry();
  registry.start("conversation-A", { visible: true, at: 0 });
  registry.dispatch({
    type: "PROMPT_SUBMITTED",
    turnLinkId: TURN_A,
    at: 1
  });
  registry.dispatch({ type: "RESPONSE_STARTED", turnLinkId: TURN_A, at: 2 });
  const transitions = registry.switchTo("conversation-B", { visible: true, at: 3 });
  const events = transitions.flatMap((transition) => transition.result.events);
  const gap = events.find((event) => event.event_type === "adapter_unhealthy");
  assert.ok(gap);
  assert.equal(gap.metadata.observation_gap, true);
  assert.equal(gap.metadata.generation_state, "response_in_progress_at_navigation");
  assert.equal(
    events.some((event) => event.event_type === "assistant_response_completed"),
    false
  );
});

test("navigating away after submit but before start also records an observation gap", () => {
  const registry = new ConversationSessionRegistry();
  registry.start("conversation-A", { visible: true, at: 0 });
  registry.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1
  });
  const transitions = registry.switchTo("conversation-B", {
    visible: true,
    at: 2
  });
  const events = transitions.flatMap((transition) => transition.result.events);
  const gap = events.find((event) => event.event_type === "adapter_unhealthy");
  assert.ok(gap);
  assert.equal(gap.metadata.observation_gap, true);
  assert.equal(gap.metadata.generation_state, "response_in_progress_at_navigation");
  assert.equal(
    events.some((event) => event.event_type === "assistant_response_completed"),
    false
  );
});

test("provisional to exact binding preserves the active turn link", () => {
  const registry = new ConversationSessionRegistry();
  const provisional = "00000000-0000-4000-8000-000000000099";
  const exact = "e".repeat(64);
  registry.start(provisional, { visible: true, at: 0 });
  const submitted = registry.dispatch({
    type: "PROMPT_SUBMITTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 1
  });
  assert.equal(submitted.result.events[0].turn_link_id, TURN_A);
  const binding = registry.bindCurrent(exact, { visible: true, at: 2 });
  assert.equal(binding.reused_existing, false);
  assert.equal(registry.currentKey, exact);
  const started = registry.dispatch({
    type: "RESPONSE_STARTED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 3
  });
  const completed = registry.dispatch({
    type: "RESPONSE_COMPLETED",
    observationEpoch: 1,
    turnLinkId: TURN_A,
    at: 4
  });
  assert.equal(started.result.events[0].turn_link_id, TURN_A);
  assert.equal(completed.result.events[0].turn_link_id, TURN_A);
});
