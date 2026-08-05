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
    streaming: false
  };
  const composer = elementFor([EXACT_COMPOSER], "x");
  const send = elementFor([
    "button[aria-label='Send message' i], button[data-testid='send-button']"
  ]);
  const streaming = elementFor([STREAMING]);
  const document = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === EXACT_COMPOSER) {
        return composer;
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
      if (selector === RESPONSE_TURN) {
        return Array.from(
          { length: state.responseTurnCount },
          (_value, index) => ({
            textContent: index === state.responseTurnCount - 1
              ? state.responseText
              : "较早的回答"
          })
        );
      }
      return [];
    }
  };
  return { composer, document, send, state };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    fixture.state.responseTurnCount = 2;
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

test("Claude explicit inactive marker requires a newly added response turn", async () => {
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
      ["PROMPT_SUBMITTED", "RESPONSE_STARTED"]
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

test("Claude response-turn growth provides a quiet-period fallback without reading text", async () => {
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
      ["PROMPT_SUBMITTED", "RESPONSE_STARTED", "RESPONSE_COMPLETED"]
    );
    assert.equal(actions[1].signal, "assistant_response_container_added");
    assert.equal(actions[2].signal, "assistant_response_structure_quiet");
    assert.equal(actions[1].confidence, "heuristic");
    assert.equal(actions[2].confidence, "heuristic");
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
