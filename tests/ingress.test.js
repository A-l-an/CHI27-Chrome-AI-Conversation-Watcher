"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ClaudeAdapter } = require("../src/adapters/claude.js");
const {
  buildActivityWatchEvent,
  buildTrackerNotificationRequest
} = require("../src/core.js");
const {
  rebuildContentEvent,
  validateAuthorityRequest,
  validateNotificationRequest
} = require("../src/ingress.js");
const {
  ConversationStateMachine
} = require("../src/state_machine.js");

const EXTENSION_ID = "fixture-extension-id";
const CONVERSATION_ID = "chat_fixture_123";
const FULL_URL = `https://chatgpt.com/c/${CONVERSATION_ID}?fixture=1`;
const CHATGPT_LOCATOR = `loc_${"A".repeat(22)}`;
const SENDER = {
  id: EXTENSION_ID,
  frameId: 0,
  url: FULL_URL,
  tab: { id: 7, windowId: 2, url: FULL_URL }
};
const CLAUDE_CONVERSATION_ID = "claude_fixture_123";
const CLAUDE_FULL_URL =
  `https://claude.ai/chat/${CLAUDE_CONVERSATION_ID}`;
const CLAUDE_SENDER = {
  id: EXTENSION_ID,
  frameId: 0,
  url: CLAUDE_FULL_URL,
  tab: { id: 8, windowId: 2, url: CLAUDE_FULL_URL }
};

function validEvent() {
  return buildActivityWatchEvent({
    provider: "chatgpt",
    event_type: "prompt_submitted",
    source_event_id: "00000000-0000-4000-8000-000000000001",
    occurred_at: "2026-07-23T00:00:00.000Z",
    observed_at: "2026-07-23T00:00:00.010Z",
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

function validClaudeCompletionEvent(completionSignal) {
  return buildActivityWatchEvent({
    provider: "claude",
    event_type: "assistant_response_completed",
    source_event_id: "00000000-0000-4000-8000-000000000002",
    occurred_at: "2026-07-31T00:00:00.000Z",
    observed_at: "2026-07-31T00:00:00.010Z",
    conversation: {
      conversation_key: "b".repeat(64),
      identity_status: "exact",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    },
    confidence: "heuristic",
    source_adapter: "claude-dom-v1",
    metadata: {
      completion_signal: completionSignal,
      state_transition: "responding_to_completed"
    }
  });
}

function createClaudeCompletionFixture() {
  const state = {
    responseTurnCount: 1,
    streaming: false
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
  const streaming = {};
  return {
    composer,
    state,
    document: {
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
        if (selector === ".font-claude-response") {
          return Array.from(
            { length: state.responseTurnCount },
            () => ({})
          );
        }
        return [];
      }
    }
  };
}

test("allowed provider-tab event is strictly rebuilt from the v1 allowlist", () => {
  const rebuilt = rebuildContentEvent(validEvent(), SENDER, EXTENSION_ID);
  assert.equal(rebuilt.data.provider, "chatgpt");
  assert.equal(rebuilt.data.event_type, "prompt_submitted");
  assert.deepEqual(rebuilt.data.metadata, {
    signal: "send_control_clicked",
    state_transition: "draft_to_submitted"
  });
});

test("ingress accepts only the two fixed Claude completion signals", () => {
  for (const completionSignal of [
    "response_active_marker_disappeared_after_settle",
    "assistant_response_structure_quiet"
  ]) {
    const rebuilt = rebuildContentEvent(
      validClaudeCompletionEvent(completionSignal),
      CLAUDE_SENDER,
      EXTENSION_ID
    );
    assert.deepEqual(rebuilt.data.metadata, {
      completion_signal: completionSignal,
      state_transition: "responding_to_completed"
    });
  }

  assert.throws(
    () => rebuildContentEvent(
      validClaudeCompletionEvent("unknown_claude_completion"),
      CLAUDE_SENDER,
      EXTENSION_ID
    ),
    /metadata_value_invalid/
  );
});

test("hidden Claude adapter completion survives state machine and ingress", async () => {
  const fixture = createClaudeCompletionFixture();
  const originalDocument = global.document;
  global.document = fixture.document;
  try {
    const machine = new ConversationStateMachine();
    machine.dispatch({ type: "START", visible: true, at: 1 });
    machine.dispatch({ type: "BACKGROUND", at: 2 });
    const completedDescriptors = [];
    const effects = [];
    const adapter = new ClaudeAdapter((action) => {
      const result = machine.dispatch(Object.assign({
        at: Date.now()
      }, action));
      completedDescriptors.push(...result.events.filter(
        (descriptor) => (
          descriptor.event_type === "assistant_response_completed"
        )
      ));
      effects.push(...result.effects);
    }, {
      completionSettleMs: 1,
      responseSignalTimeoutMs: 1000
    });

    adapter.handleKeydown({
      target: fixture.composer,
      key: "Enter",
      shiftKey: false,
      isComposing: false
    });
    fixture.state.responseTurnCount = 2;
    fixture.state.streaming = true;
    adapter.handleSnapshot(adapter.snapshot());
    fixture.state.streaming = false;
    adapter.handleSnapshot(adapter.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(completedDescriptors.length, 1);
    assert.deepEqual(effects, [{
      type: "SHOW_TRACKER_NOTIFICATION",
      reason_code: "response_completed_while_hidden"
    }]);
    const descriptor = completedDescriptors[0];
    const occurredAt = new Date(descriptor.at).toISOString();
    const candidate = buildActivityWatchEvent({
      provider: "claude",
      event_type: descriptor.event_type,
      source_event_id: "00000000-0000-4000-8000-000000000003",
      occurred_at: occurredAt,
      observed_at: occurredAt,
      conversation: {
        conversation_key: "b".repeat(64),
        identity_status: "exact",
        namespace_generation: 1,
        namespace_fingerprint: "fixture-namespace-fingerprint"
      },
      confidence: descriptor.confidence,
      source_adapter: "claude-dom-v1",
      metadata: descriptor.metadata
    });
    const rebuilt = rebuildContentEvent(
      candidate,
      CLAUDE_SENDER,
      EXTENSION_ID
    );
    assert.equal(
      rebuilt.data.event_type,
      "assistant_response_completed"
    );
    assert.deepEqual(rebuilt.data.metadata, {
      completion_signal:
        "response_active_marker_disappeared_after_settle",
      state_transition: "responding_to_completed"
    });
  } finally {
    global.document = originalDocument;
  }
});

test("ingress rejects body fields, unknown fields, free-text smuggling, and wrong senders", () => {
  const bodyField = structuredClone(validEvent());
  bodyField.data.prompt_text = "SYNTHETIC_BODY_MUST_BE_REJECTED";
  assert.throws(
    () => rebuildContentEvent(bodyField, SENDER, EXTENSION_ID),
    /data_unknown_key/
  );

  const unknownOuter = structuredClone(validEvent());
  unknownOuter.unknown = true;
  assert.throws(
    () => rebuildContentEvent(unknownOuter, SENDER, EXTENSION_ID),
    /outer_shape_invalid/
  );

  const smuggled = structuredClone(validEvent());
  smuggled.data.metadata.signal = "SYNTHETIC_BODY_IN_ALLOWED_KEY";
  assert.throws(
    () => rebuildContentEvent(smuggled, SENDER, EXTENSION_ID),
    /metadata_value_invalid/
  );

  assert.throws(
    () => rebuildContentEvent(
      validEvent(),
      Object.assign({}, SENDER, { id: "wrong-extension" }),
      EXTENSION_ID
    ),
    /sender_not_allowed_provider_tab/
  );
  assert.throws(
    () => rebuildContentEvent(
      validEvent(),
      {
        id: EXTENSION_ID,
        frameId: 0,
        url: "https://example.com/",
        tab: { id: 8, url: "https://example.com/" }
      },
      EXTENSION_ID
    ),
    /sender_host_not_allowed/
  );
});

test("notification request is sender-checked with one canonical ephemeral preview", () => {
  const event = validEvent();
  const request = {
    type: "SHOW_TRACKER_NOTIFICATION",
    provider: "chatgpt",
    context: {
      identity: {
        conversation_key: event.data.conversation_key,
        identity_status: "exact",
        locator_handle: CHATGPT_LOCATOR,
        namespace_generation: 1,
        namespace_fingerprint: "fixture-namespace-fingerprint"
      }
    },
    reason_code: "response_completed_while_hidden",
    notification_preview: "这是一段已经清理并截断的回答预览。"
  };
  const sanitized = validateNotificationRequest(request, SENDER, EXTENSION_ID);
  assert.equal(sanitized.context.identity.locator_handle,
    CHATGPT_LOCATOR);
  assert.equal(
    sanitized.notification_preview,
    "这是一段已经清理并截断的回答预览。"
  );
  const malicious = structuredClone(request);
  malicious.context.prompt = "SYNTHETIC_BODY";
  assert.throws(
    () => validateNotificationRequest(malicious, SENDER, EXTENSION_ID),
    /notification_unknown_key/
  );

  for (const invalidPreview of [
    "  前后有空格  ",
    "包含\n换行",
    "x".repeat(181),
    ""
  ]) {
    const invalid = structuredClone(request);
    invalid.notification_preview = invalidPreview;
    assert.throws(
      () => validateNotificationRequest(invalid, SENDER, EXTENSION_ID),
      /notification_preview_invalid/
    );
  }

  for (const locatorHandle of [
    "RAW_PROVIDER_ID_CANARY",
    "loc_too_short",
    `loc_${"A".repeat(21)}=`,
    `loc_${"A".repeat(21)}.`
  ]) {
    const invalidLocator = structuredClone(request);
    invalidLocator.context.identity.locator_handle = locatorHandle;
    assert.throws(
      () => validateNotificationRequest(
        invalidLocator,
        SENDER,
        EXTENSION_ID
      ),
      /notification_identity_not_exact/
    );
  }
});

test("real identity shape is projected to the closed notification ingress contract", () => {
  const internalIdentity = {
    conversation_key: "c".repeat(64),
    identity_status: "exact",
    provider: "chatgpt",
    locator_handle: CHATGPT_LOCATOR,
    namespace_generation: 1,
    namespace_fingerprint: "browser-local-v1.fixtureNamespace123"
  };
  assert.throws(
    () => validateNotificationRequest({
      type: "SHOW_TRACKER_NOTIFICATION",
      provider: "chatgpt",
      context: { identity: internalIdentity },
      reason_code: "response_completed_while_hidden"
    }, SENDER, EXTENSION_ID),
    /notification_unknown_key/
  );

  const request = buildTrackerNotificationRequest({
    provider: "chatgpt",
    identity: internalIdentity,
    reason_code: "response_completed_while_hidden",
    notification_preview: "  已完成\n并可回访  "
  });
  assert.deepEqual(Object.keys(request.context.identity).sort(), [
    "conversation_key",
    "identity_status",
    "locator_handle",
    "namespace_fingerprint",
    "namespace_generation"
  ]);
  assert.equal(request.context.identity.provider, undefined);
  assert.equal(request.notification_preview, "已完成 并可回访");
  assert.doesNotThrow(
    () => validateNotificationRequest(request, SENDER, EXTENSION_ID)
  );
});

test("authority ingress derives route trust from sender URL and rejects full_url fields", () => {
  const request = {
    type: "RESOLVE_CONVERSATION",
    provider: "chatgpt",
    provider_conversation_id: CONVERSATION_ID
  };
  assert.deepEqual(
    validateAuthorityRequest(request, SENDER, EXTENSION_ID),
    {
      provider: "chatgpt",
      provider_conversation_id: CONVERSATION_ID
    }
  );
  assert.throws(
    () => validateAuthorityRequest(Object.assign({}, request, {
      full_url: FULL_URL
    }), SENDER, EXTENSION_ID),
    /authority_message_invalid/
  );
  assert.throws(
    () => validateAuthorityRequest(Object.assign({}, request, {
      provider_conversation_id: "another_conversation"
    }), SENDER, EXTENSION_ID),
    /authority_route_mismatch/
  );
});

test("authority ingress accepts root sender to matching canonical Chrome tab SPA upgrade", () => {
  const request = {
    type: "RESOLVE_CONVERSATION",
    provider: "chatgpt",
    provider_conversation_id: CONVERSATION_ID
  };
  const spaSender = {
    id: EXTENSION_ID,
    frameId: 0,
    url: "https://chatgpt.com/",
    tab: {
      id: 8,
      url: `https://chatgpt.com/c/${CONVERSATION_ID}`
    }
  };
  assert.deepEqual(
    validateAuthorityRequest(request, spaSender, EXTENSION_ID),
    {
      provider: "chatgpt",
      provider_conversation_id: CONVERSATION_ID
    }
  );
});

test("authority ingress rejects root sender to mismatched canonical Chrome tab", () => {
  const request = {
    type: "RESOLVE_CONVERSATION",
    provider: "chatgpt",
    provider_conversation_id: "another_conversation"
  };
  const spaSender = {
    id: EXTENSION_ID,
    frameId: 0,
    url: "https://chatgpt.com/",
    tab: {
      id: 8,
      url: `https://chatgpt.com/c/${CONVERSATION_ID}`
    }
  };
  assert.throws(
    () => validateAuthorityRequest(request, spaSender, EXTENSION_ID),
    /authority_route_mismatch/
  );
});

test("authority ingress accepts a stale canonical sender after a same-origin SPA switch when the live tab matches", () => {
  const conversationB = "chat_fixture_456";
  const spaSender = {
    id: EXTENSION_ID,
    frameId: 0,
    url: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    tab: {
      id: 8,
      url: `https://chatgpt.com/c/${conversationB}`
    }
  };
  assert.deepEqual(
    validateAuthorityRequest({
      type: "RESOLVE_CONVERSATION",
      provider: "chatgpt",
      provider_conversation_id: conversationB
    }, spaSender, EXTENSION_ID),
    {
      provider: "chatgpt",
      provider_conversation_id: conversationB
    }
  );
  assert.throws(
    () => validateAuthorityRequest({
      type: "RESOLVE_CONVERSATION",
      provider: "chatgpt",
      provider_conversation_id: CONVERSATION_ID
    }, spaSender, EXTENSION_ID),
    /authority_route_mismatch/,
    "the stale document URL must not override the live tab route"
  );
});

test("authority ingress rejects sender and tab provider conflict", () => {
  const conflictingSender = {
    id: EXTENSION_ID,
    frameId: 0,
    url: "https://chatgpt.com/",
    tab: {
      id: 8,
      url: "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000"
    }
  };
  assert.throws(
    () => validateAuthorityRequest({
      type: "RESOLVE_CONVERSATION",
      provider: "chatgpt",
      provider_conversation_id: CONVERSATION_ID
    }, conflictingSender, EXTENSION_ID),
    /authority_route_mismatch/
  );
});

test("content ingress cannot forge background-only notification lifecycle events", () => {
  for (const eventType of [
    "tracker_notification_suppressed",
    "tracker_notification_attempted",
    "tracker_notification_created",
    "tracker_notification_failed",
    "tracker_notification_clicked",
    "tracker_notification_auto_cleared",
    "tracker_notification_shown"
  ]) {
    const forged = structuredClone(validEvent());
    forged.data.event_type = eventType;
    forged.data.metadata = {};
    assert.throws(
      () => rebuildContentEvent(forged, SENDER, EXTENSION_ID),
      /contract_value_invalid/
    );
  }
});
