"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ChatGptAdapter } = require("../src/adapters/chatgpt.js");
const {
  MAX_NOTIFICATION_PREVIEW_CHARS,
  sanitizeEphemeralNotificationPreview
} = require("../src/core.js");

function elementFor(selector, textContent = "", attributes = {}) {
  return {
    nodeType: 1,
    textContent,
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
    contains(candidate) {
      return candidate === this;
    },
    querySelector() {
      return null;
    },
    closest(candidate) {
      return candidate === selector ? this : null;
    }
  };
}

function installMutationObserverFixture() {
  const instances = [];
  class FixtureMutationObserver {
    constructor(callback) {
      this.callback = callback;
      instances.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {}

    trigger(records) {
      this.callback(records, this);
    }
  }
  return { FixtureMutationObserver, instances };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ChatGPT adapter keeps composer, submit dedupe, and stop lifecycle after shared base changes", async () => {
  const originalDocument = global.document;
  const state = {
    assistantVisible: false,
    sendVisible: false,
    stopVisible: false
  };
  const composer = elementFor("#prompt-textarea", "x");
  const send = elementFor("button[data-testid='send-button']");
  const stop = elementFor("button[data-testid='stop-button']");
  const assistant = elementFor(
    "[data-message-author-role='assistant']",
    "  先检查叶片背面。\n再观察盆土排水。  "
  );
  global.document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='send-button']") {
        return state.sendVisible ? send : null;
      }
      if (selector === "button[data-testid='stop-button']") {
        return state.stopVisible ? stop : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-message-author-role='assistant']") {
        return state.assistantVisible ? [assistant] : [];
      }
      return [];
    }
  };
  try {
    const actions = [];
    const adapter = new ChatGptAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.checkHealth();
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.sendVisible = true;
    adapter.handleClick({ target: send });
    state.assistantVisible = true;
    state.stopVisible = true;
    adapter.handleSnapshot(adapter.snapshot());
    state.stopVisible = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(
      actions
        .filter((action) => [
          "ADAPTER_UNHEALTHY",
          "PROMPT_SUBMITTED",
          "RESPONSE_STARTED",
          "RESPONSE_COMPLETED"
        ].includes(action.type))
        .map((action) => action.type),
      [
        "PROMPT_SUBMITTED",
        "RESPONSE_STARTED",
        "RESPONSE_COMPLETED"
      ]
    );
    assert.equal(
      actions.filter((action) => action.type === "PROMPT_SUBMITTED").length,
      1
    );
    assert.equal(
      actions.find((action) => action.type === "RESPONSE_COMPLETED")
        .notification_preview,
      "先检查叶片背面。 再观察盆土排水。"
    );
    assert.doesNotMatch(
      JSON.stringify(actions),
      /prompt_text|response_text|title|full_url/
    );
  } finally {
    global.document = originalDocument;
  }
});

test("ChatGPT adapter preserves the full 150-character streaming preview across a short final DOM repaint", async () => {
  const originalDocument = global.document;
  const state = { assistantVisible: false, stopVisible: false };
  const composer = elementFor("#prompt-textarea", "x");
  const stop = elementFor("button[data-testid='stop-button']");
  const longStreamingText = "甲乙丙丁".repeat(60);
  const assistant = elementFor(
    "[data-message-author-role='assistant']",
    longStreamingText
  );
  global.document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='stop-button']") {
        return state.stopVisible ? stop : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-message-author-role='assistant']") {
        return state.assistantVisible ? [assistant] : [];
      }
      return [];
    }
  };
  try {
    const actions = [];
    const adapter = new ChatGptAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.assistantVisible = true;
    state.stopVisible = true;
    adapter.handleSnapshot(adapter.snapshot());
    assistant.textContent = "短片段";
    state.stopVisible = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = actions.find(
      (action) => action.type === "RESPONSE_COMPLETED"
    );
    assert.equal(
      completed.notification_preview,
      sanitizeEphemeralNotificationPreview(longStreamingText)
    );
    assert.equal(
      Array.from(completed.notification_preview).length,
      MAX_NOTIFICATION_PREVIEW_CHARS
    );
  } finally {
    global.document = originalDocument;
  }
});

test("ChatGPT notification preview removes webpage citation pills without mutating the live answer", () => {
  const citationCanary = "ADA+2ADA+2nhs.uk+1nhs.uk+2";
  const answerText = "最适合 真正的回答建议从这里开始，并应当出现在通知预览中。";
  let cloneCitationRemoved = false;
  const clonedCitation = {
    remove() {
      cloneCitationRemoved = true;
    }
  };
  const clonedPreview = {
    querySelectorAll(selector) {
      return selector === "[data-testid='webpage-citation-pill']"
        ? [clonedCitation]
        : [];
    },
    get textContent() {
      return cloneCitationRemoved
        ? answerText
        : `最适合 ${citationCanary} 真正的回答建议从这里开始。`;
    }
  };
  const livePreview = {
    textContent: `最适合 ${citationCanary} 真正的回答建议从这里开始。`,
    cloneNode(deep) {
      assert.equal(deep, true);
      return clonedPreview;
    }
  };
  const assistant = elementFor(
    "[data-message-author-role='assistant']",
    "包装层",
    { "data-message-id": "assistant-citations" }
  );
  assistant.querySelector = (selector) => selector === ".markdown"
    ? livePreview
    : null;

  const adapter = new ChatGptAdapter(() => {});
  assert.equal(adapter.notificationPreview(assistant), answerText);
  assert.equal(cloneCitationRemoved, true);
  assert.match(livePreview.textContent, /ADA\+2/);
});

test("ChatGPT observer follows in-place streaming text until quiet and previews the answer body", async () => {
  const originalDocument = global.document;
  const originalMutationObserver = global.MutationObserver;
  const observerFixture = installMutationObserverFixture();
  const composer = elementFor("#prompt-textarea", "x");
  const baseline = elementFor(
    "[data-message-author-role='assistant']",
    "上一轮回答",
    { "data-message-id": "assistant-old" }
  );
  const previewNode = elementFor(".markdown", "这是同");
  const current = elementFor(
    "[data-message-author-role='assistant']",
    "包装层的短文本不应成为通知正文",
    { "data-message-id": "assistant-new" }
  );
  current.innerText = "这是同";
  current.querySelector = (selector) => selector === ".markdown"
    ? previewNode
    : null;
  const state = { responseTurns: [baseline] };
  global.document = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return selector === "#prompt-textarea" ? composer : null;
    },
    querySelectorAll(selector) {
      return selector === "[data-message-author-role='assistant']"
        ? state.responseTurns
        : [];
    }
  };
  global.MutationObserver = observerFixture.FixtureMutationObserver;
  let adapter = null;
  try {
    const actions = [];
    adapter = new ChatGptAdapter((action) => actions.push(action), {
      responseQuietMs: 180,
      responseSignalTimeoutMs: 1000
    });
    adapter.start();
    const observer = observerFixture.instances[0];
    assert.equal(observer.options.characterData, true);

    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.responseTurns = [baseline, current];
    observer.trigger([{ type: "childList" }]);
    await wait(120);

    previewNode.textContent = "这是同一轮逐步增长的回答内容。".repeat(4);
    observer.trigger([{ type: "characterData" }]);
    await wait(120);

    const finalText = "这是最终完整回答，应当持续更新通知预览候选。".repeat(12);
    previewNode.textContent = finalText;
    observer.trigger([{ type: "characterData" }]);
    await wait(120);
    assert.equal(
      actions.some((action) => action.type === "RESPONSE_COMPLETED"),
      false,
      "later streaming text must extend the quiet window"
    );
    await wait(200);

    const completed = actions.find(
      (action) => action.type === "RESPONSE_COMPLETED"
    );
    assert.equal(
      completed.notification_preview,
      sanitizeEphemeralNotificationPreview(finalText)
    );
    assert.equal(
      Array.from(completed.notification_preview).length,
      MAX_NOTIFICATION_PREVIEW_CHARS
    );
    assert.doesNotMatch(completed.notification_preview, /包装层/);
  } finally {
    if (adapter) {
      adapter.stop();
    }
    global.document = originalDocument;
    global.MutationObserver = originalMutationObserver;
  }
});

test("ChatGPT adapter captures the new message when virtualization keeps the assistant count unchanged", async () => {
  const originalDocument = global.document;
  const state = {
    assistant: elementFor(
      "[data-message-author-role='assistant']",
      "上一轮回答不应出现在本轮通知。",
      { "data-message-id": "assistant-old" }
    ),
    stopVisible: false
  };
  const composer = elementFor("#prompt-textarea", "x");
  const stop = elementFor("button[data-testid='stop-button']");
  global.document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='stop-button']") {
        return state.stopVisible ? stop : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-message-author-role='assistant']"
        ? [state.assistant]
        : [];
    }
  };
  try {
    const actions = [];
    const adapter = new ChatGptAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.assistant = elementFor(
      "[data-message-author-role='assistant']",
      "这是本轮新回答的摘要内容。",
      { "data-message-id": "assistant-new" }
    );
    state.stopVisible = true;
    adapter.handleSnapshot(adapter.snapshot());
    state.stopVisible = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = actions.find(
      (action) => action.type === "RESPONSE_COMPLETED"
    );
    assert.equal(
      completed.notification_preview,
      "这是本轮新回答的摘要内容。"
    );
    assert.doesNotMatch(JSON.stringify(completed), /上一轮回答/);
  } finally {
    global.document = originalDocument;
  }
});

test("ChatGPT adapter replaces a longer stale candidate when the response message identity changes", async () => {
  const originalDocument = global.document;
  const baseline = elementFor(
    "[data-message-author-role='assistant']",
    "baseline",
    { "data-message-id": "assistant-baseline" }
  );
  const staleCandidate = elementFor(
    "[data-message-author-role='assistant']",
    "OLD_RESPONSE_CANARY_".repeat(20),
    { "data-message-id": "assistant-stale" }
  );
  const newAnswer = elementFor(
    "[data-message-author-role='assistant']",
    "NEW SHORT",
    { "data-message-id": "assistant-new-short" }
  );
  const state = { responseTurns: [baseline], stopVisible: false };
  const composer = elementFor("#prompt-textarea", "x");
  const stop = elementFor("button[data-testid='stop-button']");
  global.document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='stop-button']") {
        return state.stopVisible ? stop : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-message-author-role='assistant']"
        ? state.responseTurns
        : [];
    }
  };
  try {
    const actions = [];
    const adapter = new ChatGptAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.responseTurns = [baseline, staleCandidate];
    state.stopVisible = true;
    adapter.handleSnapshot(adapter.snapshot());
    state.responseTurns = [newAnswer];
    adapter.handleSnapshot(adapter.snapshot());
    state.stopVisible = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = actions.find(
      (action) => action.type === "RESPONSE_COMPLETED"
    );
    assert.equal(completed.notification_preview, "NEW SHORT");
    assert.doesNotMatch(JSON.stringify(completed), /OLD_RESPONSE_CANARY/);
  } finally {
    global.document = originalDocument;
  }
});

test("ChatGPT adapter does not trust a same-ID mutation as proof of a new answer", async () => {
  const originalDocument = global.document;
  const state = { stopVisible: false };
  const composer = elementFor("#prompt-textarea", "x");
  const stop = elementFor("button[data-testid='stop-button']");
  const assistant = elementFor(
    "[data-message-author-role='assistant']",
    "上一轮回答",
    { "data-message-id": "assistant-reused" }
  );
  global.document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='stop-button']") {
        return state.stopVisible ? stop : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-message-author-role='assistant']"
        ? [assistant]
        : [];
    }
  };
  try {
    const actions = [];
    const adapter = new ChatGptAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.stopVisible = true;
    adapter.handleSnapshot(adapter.snapshot());
    assistant.textContent = "同一容器内生成的本轮新回答。";
    adapter.handleSnapshot(adapter.snapshot());
    state.stopVisible = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = actions.find(
      (action) => action.type === "RESPONSE_COMPLETED"
    );
    assert.equal(completed.notification_preview, undefined);
  } finally {
    global.document = originalDocument;
  }
});

test("ChatGPT adapter never reuses an unchanged prior answer as the new notification preview", async () => {
  const originalDocument = global.document;
  const state = { stopVisible: false };
  const composer = elementFor("#prompt-textarea", "x");
  const stop = elementFor("button[data-testid='stop-button']");
  const assistant = elementFor(
    "[data-message-author-role='assistant']",
    "OLD_RESPONSE_CANARY",
    { "data-message-id": "assistant-unchanged" }
  );
  global.document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === "button[data-testid='stop-button']") {
        return state.stopVisible ? stop : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-message-author-role='assistant']"
        ? [assistant]
        : [];
    }
  };
  try {
    const actions = [];
    const adapter = new ChatGptAdapter((action) => actions.push(action), {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 100
    });
    adapter.handleKeydown({
      target: composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    state.stopVisible = true;
    adapter.handleSnapshot(adapter.snapshot());
    state.stopVisible = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = actions.find(
      (action) => action.type === "RESPONSE_COMPLETED"
    );
    assert.equal(completed.notification_preview, undefined);
    assert.doesNotMatch(JSON.stringify(completed), /OLD_RESPONSE_CANARY/);
  } finally {
    global.document = originalDocument;
  }
});
