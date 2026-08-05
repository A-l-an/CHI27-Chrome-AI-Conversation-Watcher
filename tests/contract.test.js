"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildActivityWatchEvent,
  EVENT_TYPES,
  MAX_NOTIFICATION_PREVIEW_CHARS,
  SAFE_METADATA_KEYS,
  sanitizeEphemeralNotificationPreview,
  sanitizePersistedActivityWatchEvent,
  validateActivityWatchEvent
} = require("../src/core.js");

test("ephemeral notification preview collapses controls and truncates by Unicode character", () => {
  assert.equal(
    sanitizeEphemeralNotificationPreview("  第一行\n\u202e第二行\t  "),
    "第一行 第二行"
  );
  const longPreview = sanitizeEphemeralNotificationPreview(
    "🌻".repeat(MAX_NOTIFICATION_PREVIEW_CHARS + 20)
  );
  assert.equal(Array.from(longPreview).length, MAX_NOTIFICATION_PREVIEW_CHARS);
  assert.equal(longPreview.endsWith("…"), true);
  assert.equal(sanitizeEphemeralNotificationPreview(null), "");
});

test("canonical v1 event names include health, lifecycle, turn, return, and engagement", () => {
  assert.deepEqual(Array.from(EVENT_TYPES), [
    "watcher_started",
    "watcher_heartbeat",
    "conversation_foregrounded",
    "conversation_backgrounded",
    "conversation_bound",
    "input_started",
    "prompt_submitted",
    "assistant_response_started",
    "assistant_response_completed",
    "assistant_response_failed",
    "assistant_response_cancelled",
    "tracker_notification_suppressed",
    "tracker_notification_attempted",
    "tracker_notification_created",
    "tracker_notification_failed",
    "tracker_notification_clicked",
    "tracker_notification_auto_cleared",
    "tracker_notification_shown",
    "user_interacted",
    "user_returned",
    "user_engaged",
    "adapter_unhealthy"
  ]);
});

test("suppressed lifecycle accepts only gate plus one fixed reason code", () => {
  const base = {
    provider: "claude",
    event_type: "tracker_notification_suppressed",
    conversation: {
      conversation_key: "b".repeat(64),
      identity_status: "exact",
      provider_conversation_id: "fixture_claude_conversation"
    },
    confidence: "exact",
    source_adapter: "chrome-background-notification-v2"
  };
  for (const reasonCode of [
    "notifications_disabled",
    "study_session_inactive",
    "response_session_not_authorized",
    "response_completed_while_foreground"
  ]) {
    const event = buildActivityWatchEvent(Object.assign({}, base, {
      metadata: { phase: "gate", reason_code: reasonCode }
    }));
    assert.deepEqual(event.data.metadata, {
      phase: "gate",
      reason_code: reasonCode
    });
  }
  assert.throws(
    () => buildActivityWatchEvent(Object.assign({}, base, {
      metadata: {
        phase: "gate",
        reason_code: "SYNTHETIC_SECRET",
        notification_id: "chi27-ai-private"
      }
    })),
    /Invalid tracker_notification_suppressed metadata/
  );
});

test("ActivityWatch outer event and data contract are complete and content-free", () => {
  const event = buildActivityWatchEvent({
    provider: "chatgpt",
    event_type: "prompt_submitted",
    occurred_at: "2026-07-23T00:00:00.000Z",
    observed_at: "2026-07-23T00:00:00.010Z",
    source_event_id: "00000000-0000-4000-8000-000000000001",
    conversation: {
      conversation_key: "a".repeat(64),
      identity_status: "exact",
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint",
      provider_conversation_id: "fixture-provider-id"
    },
    full_url: "https://chatgpt.com/c/fixture-provider-id",
    confidence: "derived",
    source_adapter: "chatgpt-dom-v1",
    metadata: {
      signal: "send_control_clicked",
      prompt_text: "SYNTHETIC_SECRET_MUST_NOT_APPEAR",
      page_title: "SYNTHETIC_TITLE_MUST_NOT_APPEAR"
    }
  });
  assert.equal(event.duration, 0);
  assert.equal(event.timestamp, event.data.occurred_at);
  assert.equal(event.data.schema_version, "1.0");
  assert.equal(event.data.surface, "chrome");
  assert.equal(event.data.privacy_tier, "content_free_local");
  assert.equal(event.data.metadata.signal, "send_control_clicked");
  assert.equal(validateActivityWatchEvent(event), true);
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("SYNTHETIC_SECRET_MUST_NOT_APPEAR"), false);
  assert.equal(serialized.includes("SYNTHETIC_TITLE_MUST_NOT_APPEAR"), false);
  assert.equal(Object.hasOwn(event.data, "provider_conversation_id"), false);
  assert.equal(Object.hasOwn(event.data, "full_url"), false);
});

test("auto-cleared lifecycle keeps only timeout metadata and rejects sensitive additions", () => {
  const event = buildActivityWatchEvent({
    provider: "claude",
    event_type: "tracker_notification_auto_cleared",
    conversation: {
      conversation_key: "b".repeat(64),
      identity_status: "exact",
      provider_conversation_id: "fixture_claude_conversation"
    },
    confidence: "exact",
    source_adapter: "chrome-background-notification-v2",
    metadata: {
      phase: "clear",
      reason_code: "notification_timeout",
      timeout_seconds: 20,
      prompt_text: "SYNTHETIC_PROMPT_MUST_NOT_APPEAR",
      response_text: "SYNTHETIC_RESPONSE_MUST_NOT_APPEAR",
      full_url: "https://claude.ai/chat/private-fixture"
    }
  });
  assert.deepEqual(event.data.metadata, {
    phase: "clear",
    reason_code: "notification_timeout",
    timeout_seconds: 20
  });
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /SYNTHETIC_/);
  assert.doesNotMatch(serialized, /https?:\/\//);
});

test("persisted-event sanitizer rejects raw URL or provider-ID canaries in every metadata key", () => {
  const safe = buildActivityWatchEvent({
    provider: "chatgpt",
    event_type: "prompt_submitted",
    source_event_id: "00000000-0000-4000-8000-000000000088",
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
  assert.ok(sanitizePersistedActivityWatchEvent(safe));
  for (const key of SAFE_METADATA_KEYS) {
    for (const canary of [
      "https://chatgpt.com/c/raw-provider-id-canary",
      "raw-provider-id-canary"
    ]) {
      const poisoned = structuredClone(safe);
      poisoned.data.metadata[key] = canary;
      assert.equal(
        sanitizePersistedActivityWatchEvent(poisoned),
        null,
        `${key} accepted ${canary}`
      );
    }
  }
  const unknownKey = structuredClone(safe);
  unknownKey.data.metadata.raw_route =
    "https://chatgpt.com/c/raw-provider-id-canary";
  assert.equal(sanitizePersistedActivityWatchEvent(unknownKey), null);
});

test("manifest declares only the expected local ActivityWatch and provider hosts", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
  );
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:5600/*",
    "http://localhost:5600/*",
    "https://chatgpt.com/*",
    "https://claude.ai/*"
  ]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.permissions.includes("history"), false);
  assert.equal(manifest.permissions.includes("clipboardRead"), false);
  assert.equal(manifest.permissions.includes("nativeMessaging"), true);
  assert.deepEqual(manifest.icons, {
    "16": "extension-assets/icon-16.png",
    "32": "extension-assets/icon-32.png",
    "48": "extension-assets/icon-48.png",
    "128": "extension-assets/icon-128.png"
  });
  assert.deepEqual(manifest.action.default_icon, {
    "16": "extension-assets/icon-16.png",
    "32": "extension-assets/icon-32.png"
  });
  assert.equal(
    fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8")
      .includes('getURL("icon.svg")'),
    false
  );
});

test("declared PNG icons have the PNG signature and exact IHDR dimensions", () => {
  for (const size of [16, 32, 48, 128]) {
    const bytes = fs.readFileSync(
      path.join(__dirname, "..", "extension-assets", `icon-${size}.png`)
    );
    assert.deepEqual(
      Array.from(bytes.subarray(0, 8)),
      [137, 80, 78, 71, 13, 10, 26, 10]
    );
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});
