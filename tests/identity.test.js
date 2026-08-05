"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  IdentityTracker,
  extractProviderConversationId,
  providerFromUrl
} = require("../src/identity.js");

const fixturePath = path.join(__dirname, "fixtures", "routes.json");
const routes = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const CHATGPT_LOCATOR = `loc_${"A".repeat(22)}`;
const CLAUDE_LOCATOR = `loc_${"B".repeat(22)}`;

test("synthetic ChatGPT and Claude routes expose provider conversation IDs only from canonical paths", () => {
  for (const route of routes) {
    assert.equal(providerFromUrl(route.url), route.provider);
    assert.equal(
      extractProviderConversationId(route.provider, route.url),
      route.provider_conversation_id
    );
  }
  assert.equal(
    extractProviderConversationId("chatgpt", "https://chatgpt.com/share/not-a-conversation"),
    null
  );
  assert.equal(
    extractProviderConversationId("claude", "https://example.com/chat/fake-id"),
    null
  );
});

test("new conversation is provisional and binds to exact identity after SPA URL gains ID", async () => {
  const provisionalUuid = "00000000-0000-4000-8000-000000000001";
  const tracker = new IdentityTracker({
    namespace_generation: 1,
    namespace_fingerprint: "fixture-namespace-fingerprint",
    resolveExact: async () => ({
      status: "issued",
      conversation_key: "a".repeat(64),
      locator_handle: CHATGPT_LOCATOR,
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint",
      receipt: { payload: "AA==", signature: "AA==" }
    })
  }, () => provisionalUuid);
  const initial = await tracker.update("chatgpt", "https://chatgpt.com/");
  assert.equal(initial.change, "initial");
  assert.equal(initial.current.identity_status, "provisional");
  assert.equal(initial.current.conversation_key, provisionalUuid);

  const bound = await tracker.update(
    "chatgpt",
    "https://chatgpt.com/c/chat_fixture_123"
  );
  assert.equal(bound.change, "bound");
  assert.equal(bound.previous.conversation_key, provisionalUuid);
  assert.equal(bound.current.identity_status, "exact");
  assert.equal(bound.current.conversation_key, "a".repeat(64));
  assert.equal(bound.current.locator_handle, CHATGPT_LOCATOR);
  assert.equal(Object.hasOwn(bound.current, "provider_conversation_id"), false);
});

test("query and fragment changes preserve the same exact conversation key", async () => {
  const tracker = new IdentityTracker({
    namespace_generation: 1,
    namespace_fingerprint: "fixture-namespace-fingerprint",
    resolveExact: async () => ({
      status: "issued",
      conversation_key: "b".repeat(64),
      locator_handle: CLAUDE_LOCATOR,
      namespace_generation: 1,
      namespace_fingerprint: "fixture-namespace-fingerprint"
    })
  }, () => "unused");
  const first = await tracker.update(
    "claude",
    "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000"
  );
  const second = await tracker.update(
    "claude",
    "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000?mode=test#latest"
  );
  assert.equal(second.change, "url_updated");
  assert.equal(second.current.conversation_key, first.current.conversation_key);
});

test("authority unavailable stays provisional and never derives a scoped key in JS", async () => {
  const provisionalUuid = "00000000-0000-4000-8000-000000000002";
  const tracker = new IdentityTracker({
    resolveExact: async () => ({
      status: "unavailable",
      reason: "bridge_unavailable"
    })
  }, () => provisionalUuid);
  const result = await tracker.update(
    "chatgpt",
    "https://chatgpt.com/c/chat_fixture_123"
  );
  assert.equal(result.current.identity_status, "provisional");
  assert.equal(result.current.conversation_key, provisionalUuid);
  assert.equal(Object.hasOwn(result.current, "provider_conversation_id"), false);
});

test("A to B to A uses only authority-issued keys and restores A", async () => {
  const keys = {
    chat_fixture_A: "a".repeat(64),
    chat_fixture_B: "b".repeat(64)
  };
  const tracker = new IdentityTracker({
    namespace_generation: 2,
    namespace_fingerprint: "fixture-namespace-fingerprint-v2",
    resolveExact: async (request) => ({
      status: "issued",
      conversation_key: keys[request.provider_conversation_id],
      locator_handle: request.provider_conversation_id.endsWith("A")
        ? CHATGPT_LOCATOR
        : CLAUDE_LOCATOR,
      namespace_generation: 2,
      namespace_fingerprint: "fixture-namespace-fingerprint-v2"
    })
  });
  const firstA = await tracker.update(
    "chatgpt",
    "https://chatgpt.com/c/chat_fixture_A"
  );
  const b = await tracker.update(
    "chatgpt",
    "https://chatgpt.com/c/chat_fixture_B"
  );
  const secondA = await tracker.update(
    "chatgpt",
    "https://chatgpt.com/c/chat_fixture_A"
  );
  assert.equal(firstA.current.conversation_key, keys.chat_fixture_A);
  assert.equal(b.change, "switched");
  assert.equal(secondA.change, "switched");
  assert.equal(secondA.current.conversation_key, keys.chat_fixture_A);
});
