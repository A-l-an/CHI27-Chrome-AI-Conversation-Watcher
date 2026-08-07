"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ClaudeAdapter } = require("../src/adapters/claude.js");
const {
  ConversationStateMachine
} = require("../src/state_machine.js");

const EXACT_COMPOSER =
  "div[data-testid='chat-input'][role='textbox'].tiptap.ProseMirror";
const STREAMING =
  "[data-is-streaming='true']";
const RESPONSE_TURN = ".font-claude-response";

function elementFor(selectors, textContent = "") {
  return {
    nodeType: 1,
    textContent,
    closest(selector) {
      return selectors.includes(selector) ? this : null;
    }
  };
}

function createClaudeDomFixture() {
  const state = {
    responseTurnCount: 1,
    responseText: "  这是 Claude 的回答片段。\n请继续检查。  ",
    sendVisible: false,
    streaming: false,
    streamingOwner: null,
    responseTurns: []
  };
  function responseTurns() {
    while (state.responseTurns.length < state.responseTurnCount) {
      state.responseTurns.push(elementFor([RESPONSE_TURN]));
    }
    state.responseTurns.length = state.responseTurnCount;
    state.responseTurns.forEach((turn, index) => {
      turn.textContent = index === state.responseTurnCount - 1
        ? state.responseText
        : "较早的回答";
    });
    return state.responseTurns;
  }
  const composer = elementFor([EXACT_COMPOSER], "x");
  state.composer = composer;
  const send = elementFor([
    "button[aria-label='Send message' i], button[data-testid='send-button']"
  ]);
  const streaming = elementFor([STREAMING]);
  streaming.closest = (selector) => {
    if (selector === STREAMING) {
      return streaming;
    }
    if (selector === RESPONSE_TURN) {
      const turns = responseTurns();
      return state.streamingOwner || turns[turns.length - 1] || null;
    }
    return null;
  };
  const document = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === EXACT_COMPOSER) {
        return state.composer;
      }
      if (
        selector ===
        "button[aria-label='Send message' i], button[data-testid='send-button']"
      ) {
        return state.sendVisible ? send : null;
      }
      if (selector === STREAMING) {
        return state.streaming ? streaming : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === STREAMING) {
        return state.streaming ? [streaming] : [];
      }
      if (selector === RESPONSE_TURN) {
        return responseTurns();
      }
      return [];
    }
  };
  return {
    get composer() {
      return state.composer;
    },
    document,
    replaceComposer(textContent = "x") {
      state.composer = elementFor([EXACT_COMPOSER], textContent);
      return state.composer;
    },
    send,
    state
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createManualTimerFixture() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  function scheduleTimeout(callback, delay = 0) {
    const id = nextId;
    nextId += 1;
    timers.set(id, {
      at: now + Math.max(0, Number.isFinite(delay) ? delay : 0),
      callback
    });
    return id;
  }

  function cancelTimeout(id) {
    timers.delete(id);
  }

  function advance(duration) {
    const target = now + duration;
    while (true) {
      let nextTimer = null;
      for (const [id, timer] of timers.entries()) {
        if (timer.at > target) {
          continue;
        }
        if (
          !nextTimer ||
          timer.at < nextTimer.at ||
          (timer.at === nextTimer.at && id < nextTimer.id)
        ) {
          nextTimer = { id, at: timer.at, callback: timer.callback };
        }
      }
      if (!nextTimer) {
        break;
      }
      timers.delete(nextTimer.id);
      now = nextTimer.at;
      nextTimer.callback();
    }
    now = target;
  }

  return {
    now: () => now,
    scheduleTimeout,
    cancelTimeout,
    advance,
    pendingCount: () => timers.size
  };
}

function installMutationObserverFixture() {
  const instances = [];
  class FixtureMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      instances.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }

    trigger(records) {
      this.callback(records, this);
    }
  }
  return { FixtureMutationObserver, instances };
}

test("real-shaped Claude fixture treats idle no-send as healthy and preserves composer priority", () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action));
    assert.equal(adapter.findComposer(), fixture.composer);
    adapter.checkHealth();
    assert.deepEqual(actions, []);
    assert.equal(
      adapter.selectors.composer[0],
      EXACT_COMPOSER
    );
  } finally {
    global.document = originalDocument;
  }
});

test("real-shaped Claude fixture deduplicates Enter/click submit and emits hidden response completion", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: 1 });
    machine.dispatch({ type: "BACKGROUND", at: 2 });
    const events = [];
    const effects = [];
    const actions = [];
    const adapter = new ClaudeAdapter((action) => {
      actions.push(action);
      const result = machine.dispatch(Object.assign({ at: Date.now() }, action));
      events.push(...result.events);
      effects.push(...result.effects);
    }, {
      completionSettleMs: 1,
      responseQuietMs: 1,
      responseSignalTimeoutMs: 100
    });

    adapter.handleKeydown({
      target: fixture.composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    fixture.state.sendVisible = true;
    adapter.handleClick({ target: fixture.send });
    assert.equal(
      events.filter((event) => event.event_type === "prompt_submitted").length,
      1
    );

    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(
      events.filter(
        (event) => event.event_type === "assistant_response_started"
      ).length,
      1
    );
    assert.equal(
      events.filter(
        (event) => event.event_type === "assistant_response_completed"
      ).length,
      1
    );
    assert.deepEqual(effects, [{
      type: "SHOW_TRACKER_NOTIFICATION",
      reason_code: "response_completed_while_hidden"
    }]);
    assert.equal(
      actions.find((action) => action.type === "RESPONSE_COMPLETED")
        .notification_preview,
      "这是 Claude 的回答片段。 请继续检查。"
    );
    assert.doesNotMatch(JSON.stringify(actions), /prompt_text|response_text|title|full_url/);
  } finally {
    global.document = originalDocument;
  }
});

test("Claude observer captures hidden data-is-streaming true-to-false completion exactly once", async () => {
  const fixture = createClaudeDomFixture();
  const observerFixture = installMutationObserverFixture();
  const originalDocument = global.document;
  const originalMutationObserver = global.MutationObserver;
  global.document = fixture.document;
  global.MutationObserver = observerFixture.FixtureMutationObserver;
  try {
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: 1 });
    machine.dispatch({ type: "BACKGROUND", at: 2 });
    const events = [];
    const effects = [];
    const actions = [];
    const adapter = new ClaudeAdapter((action) => {
      actions.push(action);
      const result = machine.dispatch(Object.assign({ at: Date.now() }, action));
      events.push(...result.events);
      effects.push(...result.effects);
    }, {
      completionSettleMs: 1,
      responseQuietMs: 1,
      responseSignalTimeoutMs: 1000
    });

    adapter.start();
    const observer = observerFixture.instances[0];
    assert.deepEqual(observer.options, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-is-streaming"]
    });

    adapter.handleKeydown({
      target: fixture.composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    observer.trigger([{
      type: "attributes",
      attributeName: "class"
    }]);
    await wait(120);
    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED"],
      "an ordinary attribute mutation must not create response lifecycle events"
    );

    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    observer.trigger([{
      type: "attributes",
      attributeName: "data-is-streaming"
    }]);
    await wait(120);

    fixture.state.streaming = false;
    observer.trigger([{
      type: "attributes",
      attributeName: "data-is-streaming"
    }]);
    await wait(120);
    observer.trigger([{
      type: "attributes",
      attributeName: "data-is-streaming"
    }]);
    await wait(120);

    assert.equal(
      actions.filter((action) => action.type === "PROMPT_SUBMITTED").length,
      1
    );
    assert.equal(
      actions.filter((action) => action.type === "RESPONSE_STARTED").length,
      1
    );
    assert.equal(
      actions.filter((action) => action.type === "RESPONSE_COMPLETED").length,
      1
    );
    assert.equal(
      events.filter(
        (event) => event.event_type === "assistant_response_completed"
      ).length,
      1
    );
    assert.deepEqual(effects, [{
      type: "SHOW_TRACKER_NOTIFICATION",
      reason_code: "response_completed_while_hidden"
    }]);
    assert.equal(observer.disconnected, false);
    adapter.stop();
    assert.equal(observer.disconnected, true);
  } finally {
    global.document = originalDocument;
    global.MutationObserver = originalMutationObserver;
  }
});

test("Claude active marker without a new response turn cannot start lifecycle", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 1000
    });
    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(10);

    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED"]
    );
    clearTimeout(adapter.responseSignalTimer);
    adapter.responseSignalTimer = null;
  } finally {
    global.document = originalDocument;
  }
});

test("Claude active marker without a submission does not emit response lifecycle", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      completionSettleMs: 1
    });
    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(10);

    assert.deepEqual(actions, []);
  } finally {
    global.document = originalDocument;
  }
});

test("Claude foreground completion records completion with only a suppressed audit effect", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: 1 });
    const events = [];
    const effects = [];
    const adapter = new ClaudeAdapter((action) => {
      const result = machine.dispatch(Object.assign({ at: Date.now() }, action));
      events.push(...result.events);
      effects.push(...result.effects);
    }, {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 1000
    });
    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(10);

    assert.equal(
      events.filter(
        (event) => event.event_type === "assistant_response_completed"
      ).length,
      1
    );
    assert.deepEqual(effects, [{
      type: "AUDIT_TRACKER_NOTIFICATION_SUPPRESSED",
      reason_code: "response_completed_while_foreground"
    }]);
  } finally {
    global.document = originalDocument;
  }
});

test("Claude response-turn growth starts a response but cannot guess completion from quiet", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      responseQuietMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.responseTurnCount = 2;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED", "RESPONSE_STARTED"]
    );
    assert.equal(actions[1].signal, "assistant_response_container_added");
    assert.equal(actions[1].confidence, "heuristic");
  } finally {
    global.document = originalDocument;
  }
});

test("Claude quiet fallback ignores arbitrary mutations when response structure did not grow", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      responseQuietMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.noteSubmission("composer_enter", "heuristic");
    adapter.handleSnapshot(adapter.snapshot());
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED"]
    );
    clearTimeout(adapter.responseSignalTimer);
    adapter.responseSignalTimer = null;
  } finally {
    global.document = originalDocument;
  }
});

test("Claude delegated composer handling survives an SPA composer replacement", () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      responseSignalTimeoutMs: 1000
    });
    const replacement = fixture.replaceComposer("replacement draft");
    const nestedTarget = {
      nodeType: 1,
      textContent: "",
      closest(selector) {
        return selector === EXACT_COMPOSER ? replacement : null;
      }
    };
    adapter.handleInput({ target: nestedTarget });
    adapter.handleKeydown({
      target: nestedTarget,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    assert.equal(adapter.findComposer(), replacement);
    assert.deepEqual(
      actions.map((action) => action.type),
      ["USER_INTERACTION", "INPUT_CHANGED", "PROMPT_SUBMITTED"]
    );
    clearTimeout(adapter.responseSignalTimer);
    adapter.responseSignalTimer = null;
  } finally {
    global.document = originalDocument;
  }
});

test("Claude ignores an unrelated form submit even when the global composer has a draft", () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action));
    adapter.handleSubmit({
      target: {
        querySelector() {
          return null;
        }
      }
    });
    assert.deepEqual(actions, []);
  } finally {
    global.document = originalDocument;
  }
});

test("Claude adapter-to-machine accepts a fresh link at 1100 ms and recovers", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    let now = 0;
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: now });
    const events = [];
    const adapter = new ClaudeAdapter((action) => {
      events.push(...machine.dispatch(Object.assign({ at: now }, action)).events);
    }, {
      completionSettleMs: 0,
      now: () => now,
      responseSignalTimeoutMs: 1000
    });

    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    now = 100;
    adapter.handleSnapshot(adapter.snapshot());

    now = 1100;
    assert.equal(adapter.noteSubmission("composer_enter", "heuristic"), true);
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.responseTurnCount = 3;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(2);

    const prompts = events.filter(
      (event) => event.event_type === "prompt_submitted"
    );
    assert.equal(prompts.length, 2);
    assert.notEqual(prompts[0].turn_link_id, prompts[1].turn_link_id);
    assert.equal(
      events.filter((event) => event.event_type === "adapter_unhealthy").length,
      1
    );
    assert.equal(
      events.some((event) => (
        event.event_type === "assistant_response_completed" &&
        event.turn_link_id === prompts[1].turn_link_id
      )),
      true
    );
  } finally {
    global.document = originalDocument;
  }
});

test("Claude records five continuous submissions as five independently linked lifecycles", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: 0 });
    const events = [];
    const adapter = new ClaudeAdapter((action) => {
      const at = Number.isInteger(action.observationEpoch)
        ? action.observationEpoch * 2000
        : Date.now();
      events.push(...machine.dispatch(Object.assign({ at }, action)).events);
    }, {
      completionSettleMs: 0,
      submissionDedupeMs: 0,
      responseSignalTimeoutMs: 1000
    });

    for (let round = 0; round < 5; round += 1) {
      assert.equal(adapter.noteSubmission("composer_enter", "heuristic"), true);
      fixture.state.responseTurnCount += 1;
      fixture.state.streaming = true;
      adapter.handleSnapshot(adapter.snapshot());
      fixture.state.streaming = false;
      adapter.handleSnapshot(adapter.snapshot());
      await wait(2);
    }

    const lifecycle = events.filter((event) => (
      event.event_type === "prompt_submitted" ||
      event.event_type.startsWith("assistant_response_")
    ));
    assert.equal(
      lifecycle.filter((event) => event.event_type === "prompt_submitted").length,
      5
    );
    assert.equal(
      lifecycle.filter((event) => event.event_type === "assistant_response_started").length,
      5
    );
    assert.equal(
      lifecycle.filter((event) => event.event_type === "assistant_response_completed").length,
      5
    );
    const links = new Set(lifecycle.map((event) => event.turn_link_id));
    assert.equal(links.size, 5);
    for (const link of links) {
      assert.equal(
        lifecycle.filter((event) => event.turn_link_id === link).length,
        3
      );
    }
  } finally {
    global.document = originalDocument;
  }
});

test("Claude abandons one stuck observation and lets the next submission recover", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: 0 });
    const events = [];
    const adapter = new ClaudeAdapter((action) => {
      const at = Number.isInteger(action.observationEpoch)
        ? action.observationEpoch * 2000
        : Date.now();
      events.push(...machine.dispatch(Object.assign({ at }, action)).events);
    }, {
      completionSettleMs: 0,
      submissionDedupeMs: 0,
      responseSignalTimeoutMs: 1000
    });

    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    const firstLink = events.find(
      (event) => event.event_type === "prompt_submitted"
    ).turn_link_id;

    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.responseTurnCount = 3;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(2);

    const prompts = events.filter(
      (event) => event.event_type === "prompt_submitted"
    );
    assert.equal(prompts.length, 2);
    assert.notEqual(prompts[0].turn_link_id, prompts[1].turn_link_id);
    assert.equal(
      events.filter((event) => event.event_type === "adapter_unhealthy").length,
      1
    );
    assert.equal(
      events.some((event) => (
        event.event_type === "assistant_response_completed" &&
        event.turn_link_id === firstLink
      )),
      false
    );
    assert.equal(
      events.some((event) => (
        event.event_type === "assistant_response_completed" &&
        event.turn_link_id === prompts[1].turn_link_id
      )),
      true
    );
  } finally {
    global.document = originalDocument;
  }
});

test("Claude residual active DOM at submit cannot close until a fresh active edge falls", async () => {
  const fixture = createClaudeDomFixture();
  fixture.state.streaming = true;
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      completionSettleMs: 0,
      responseSignalTimeoutMs: 1000
    });
    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(2);
    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED"]
    );

    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(2);
    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED", "RESPONSE_STARTED", "RESPONSE_COMPLETED"]
    );
    assert.equal(
      new Set(actions.map((action) => action.turnLinkId)).size,
      1
    );
  } finally {
    global.document = originalDocument;
  }
});

test("Claude cannot join an old turn marker edge to a new response container", async () => {
  const fixture = createClaudeDomFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const actions = [];
    const adapter = new ClaudeAdapter((action) => actions.push(action), {
      completionSettleMs: 0,
      responseSignalTimeoutMs: 1000
    });
    adapter.noteSubmission("composer_enter", "heuristic");
    const oldTurn = fixture.state.responseTurns[0];

    fixture.state.responseTurnCount = 2;
    fixture.state.streamingOwner = oldTurn;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(2);

    assert.equal(
      actions.filter((action) => action.type === "RESPONSE_COMPLETED").length,
      0
    );
    assert.equal(
      actions.some((action) => (
        action.type === "ADAPTER_UNHEALTHY" &&
        action.reason === "response_active_scope_unverified"
      )),
      true
    );

    fixture.state.streamingOwner = fixture.state.responseTurns[1];
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await wait(2);
    assert.equal(
      actions.filter((action) => action.type === "RESPONSE_COMPLETED").length,
      1
    );
  } finally {
    global.document = originalDocument;
  }
});

test("Claude bounded polling recovers a missed observer callback", () => {
  const fixture = createClaudeDomFixture();
  const observerFixture = installMutationObserverFixture();
  const timerFixture = createManualTimerFixture();
  const originalDocument = global.document;
  const originalMutationObserver = global.MutationObserver;
  global.document = fixture.document;
  global.MutationObserver = observerFixture.FixtureMutationObserver;
  let adapter;
  try {
    const actions = [];
    adapter = new ClaudeAdapter((action) => actions.push(action), {
      completionSettleMs: 0,
      healthGraceMs: 1000,
      observationPollIntervalMs: 2,
      observationPollWindowMs: 100,
      responseSignalTimeoutMs: 100,
      now: timerFixture.now,
      scheduleTimeout: timerFixture.scheduleTimeout,
      cancelTimeout: timerFixture.cancelTimeout
    });
    adapter.start();
    const observer = observerFixture.instances[0];
    assert.ok(observer);
    let observerCallbackCount = 0;
    const observerCallback = observer.callback;
    observer.callback = (...args) => {
      observerCallbackCount += 1;
      return observerCallback(...args);
    };
    adapter.noteSubmission("composer_enter", "heuristic");
    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    timerFixture.advance(2);
    fixture.state.streaming = false;
    timerFixture.advance(2);
    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED", "RESPONSE_STARTED", "RESPONSE_COMPLETED"]
    );
    assert.equal(observerCallbackCount, 0);
    const [submitted, started, completed] = actions;
    assert.equal(typeof submitted.turnLinkId, "string");
    assert.notEqual(submitted.turnLinkId, "");
    assert.equal(typeof started.turnLinkId, "string");
    assert.notEqual(started.turnLinkId, "");
    assert.equal(typeof completed.turnLinkId, "string");
    assert.notEqual(completed.turnLinkId, "");
    assert.equal(started.turnLinkId, submitted.turnLinkId);
    assert.equal(completed.turnLinkId, submitted.turnLinkId);
    adapter.stop();
    adapter = null;
    assert.equal(timerFixture.pendingCount(), 0);
  } finally {
    if (adapter) {
      adapter.stop();
    }
    global.document = originalDocument;
    global.MutationObserver = originalMutationObserver;
  }
});

test("Claude no-signal observation reports unhealthy without inventing a completion", async () => {
  const fixture = createClaudeDomFixture();
  const observerFixture = installMutationObserverFixture();
  const originalDocument = global.document;
  const originalMutationObserver = global.MutationObserver;
  global.document = fixture.document;
  global.MutationObserver = observerFixture.FixtureMutationObserver;
  let adapter;
  try {
    const actions = [];
    adapter = new ClaudeAdapter((action) => actions.push(action), {
      healthGraceMs: 1000,
      observationPollIntervalMs: 2,
      observationPollWindowMs: 10,
      responseSignalTimeoutMs: 10
    });
    adapter.start();
    adapter.noteSubmission("composer_enter", "heuristic");
    await wait(25);
    assert.deepEqual(
      actions.map((action) => action.type),
      ["PROMPT_SUBMITTED", "ADAPTER_UNHEALTHY"]
    );
    assert.equal(
      actions.some((action) => action.type === "RESPONSE_COMPLETED"),
      false
    );
  } finally {
    if (adapter) {
      adapter.stop();
    }
    global.document = originalDocument;
    global.MutationObserver = originalMutationObserver;
  }
});
