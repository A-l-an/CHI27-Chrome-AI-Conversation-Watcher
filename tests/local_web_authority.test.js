"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BrowserLocalWebAuthority,
  STORAGE_KEY
} = require("../src/local_web_authority.js");

function inMemoryStorage(initial = {}) {
  const values = JSON.parse(JSON.stringify(initial));
  return {
    values,
    get(key) {
      return Promise.resolve(
        Object.hasOwn(values, key) ? { [key]: values[key] } : {}
      );
    },
    set(update) {
      Object.assign(values, JSON.parse(JSON.stringify(update)));
      return Promise.resolve();
    }
  };
}

test("browser-local authority creates stable opaque web identities without persisting provider IDs", async () => {
  const storage = inMemoryStorage();
  const authority = new BrowserLocalWebAuthority({
    storageGet: storage.get,
    storageSet: storage.set
  });
  const context = await authority.context();
  assert.equal(context.status, "ready");
  assert.equal(context.authority_mode, "browser_local");
  assert.match(context.namespace_fingerprint, /^browser-local-v1\./);

  const chatIdA = "chat_fixture_123";
  const chatIdB = "chat_fixture_456";
  const first = await authority.resolve({
    provider: "chatgpt",
    provider_conversation_id: chatIdA
  });
  const repeated = await authority.resolve({
    provider: "chatgpt",
    provider_conversation_id: chatIdA
  });
  const different = await authority.resolve({
    provider: "chatgpt",
    provider_conversation_id: chatIdB
  });

  assert.equal(first.status, "issued");
  assert.match(first.conversation_key, /^[0-9a-f]{64}$/);
  assert.match(first.locator_handle, /^loc_[A-Za-z0-9_-]{22}$/);
  assert.equal(first.conversation_key, repeated.conversation_key);
  assert.equal(first.locator_handle, repeated.locator_handle);
  assert.notEqual(first.conversation_key, different.conversation_key);
  assert.equal(first.namespace_fingerprint, context.namespace_fingerprint);

  const durable = JSON.stringify(storage.values);
  assert.doesNotMatch(durable, new RegExp(chatIdA));
  assert.doesNotMatch(durable, new RegExp(chatIdB));
  assert.deepEqual(Object.keys(storage.values), [STORAGE_KEY]);
});

test("browser-local authority normalizes Claude UUIDs and fails closed on invalid persisted state", async () => {
  const storage = inMemoryStorage();
  const authority = new BrowserLocalWebAuthority({
    storageGet: storage.get,
    storageSet: storage.set
  });
  const upper = await authority.resolve({
    provider: "claude",
    provider_conversation_id: "123E4567-E89B-12D3-A456-426614174000"
  });
  const lower = await authority.resolve({
    provider: "claude",
    provider_conversation_id: "123e4567-e89b-12d3-a456-426614174000"
  });
  assert.equal(upper.status, "issued");
  assert.equal(upper.conversation_key, lower.conversation_key);

  const corrupt = inMemoryStorage({
    [STORAGE_KEY]: {
      schema_version: "1.0",
      secret_base64url: "invalid",
      namespace_fingerprint: "browser-local-v1.invalid"
    }
  });
  const rejected = new BrowserLocalWebAuthority({
    storageGet: corrupt.get,
    storageSet: corrupt.set
  });
  assert.deepEqual(await rejected.context(), {
    status: "unavailable",
    reason: "authority_unavailable"
  });
  assert.deepEqual(await rejected.resolve({
    provider: "chatgpt",
    provider_conversation_id: "chat_fixture_123"
  }), {
    status: "unavailable",
    reason: "authority_unavailable"
  });
});
