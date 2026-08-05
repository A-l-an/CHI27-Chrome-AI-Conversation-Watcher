"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  AuthorityClientError,
  MAX_MESSAGE_BYTES,
  NativeAuthorityClient,
  canonicalReceiptPayload,
  canonicalReopenReceiptPayload,
  decodeAuthorityResponse,
  decodeReopenResponse
} = require("../src/authority_client.js");
const {
  NATIVE_HOST_NAME,
  PROVISIONING,
  validateProvisioning
} = require("../src/authority_provisioning.js");

const EXTENSION_ID = "a".repeat(32);
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const NONCE = `${"A".repeat(43)}=`;
const NAMESPACE = {
  namespace_generation: 7,
  namespace_fingerprint: "fixture-namespace-fingerprint-v7"
};
const KEY_PAIR = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_JWK = KEY_PAIR.publicKey.export({ format: "jwk" });

function base64UrlBytes(value) {
  return Buffer.from(value, "base64url");
}

const PUBLIC_X963 = Buffer.concat([
  Buffer.from([0x04]),
  base64UrlBytes(PUBLIC_JWK.x),
  base64UrlBytes(PUBLIC_JWK.y)
]).toString("base64");
const PROVISIONED = Object.freeze({
  native_host_name: NATIVE_HOST_NAME,
  expected_extension_id: EXTENSION_ID,
  namespace_generation: NAMESPACE.namespace_generation,
  namespace_fingerprint: NAMESPACE.namespace_fingerprint,
  authority_public_key_x963_base64: PUBLIC_X963
});
const RAW_ID_CANARY = "chat_raw_canary_123";
const RAW_URL_CANARY = `https://chatgpt.com/c/${RAW_ID_CANARY}?fixture=1`;
const VALID_LOCATOR = `loc_${"A".repeat(22)}`;
const OTHER_LOCATOR = `loc_${"B".repeat(22)}`;
const ATTEMPT_ID = `rpa_${"R".repeat(22)}`;
const RAW_ID_LOCATOR = `loc_${RAW_ID_CANARY}${"A".repeat(
  22 - RAW_ID_CANARY.length
)}`;

function wireRequest(type = "resolve_web_conversation", overrides = {}) {
  const common = {
    schema_version: "1.0",
    type,
    request_id: REQUEST_ID,
    provider: "chatgpt",
    surface: "chrome",
    client_nonce: NONCE,
    extension_id: EXTENSION_ID,
    namespace_generation: NAMESPACE.namespace_generation,
    namespace_fingerprint: NAMESPACE.namespace_fingerprint
  };
  const operation = type === "resolve_web_conversation"
    ? {
        provider_conversation_id: RAW_ID_CANARY
      }
    : {
        conversation_key: "a".repeat(64),
        locator_handle: VALID_LOCATOR
      };
  return Object.assign(common, operation, overrides);
}

function signPayload(payloadText) {
  return crypto.sign(
    "sha256",
    Buffer.from(payloadText, "utf8"),
    KEY_PAIR.privateKey
  ).toString("base64");
}

function issuedResponse(request, overrides = {}, payloadTextOverride) {
  const response = Object.assign({
    schema_version: "1.0",
    status: "issued",
    request_id: request.request_id,
    conversation_key: request.conversation_key || "a".repeat(64),
    locator_handle:
      request.locator_handle || VALID_LOCATOR,
    namespace_generation: NAMESPACE.namespace_generation,
    namespace_fingerprint: NAMESPACE.namespace_fingerprint
  }, overrides);
  const payloadText = payloadTextOverride === undefined
    ? canonicalReceiptPayload(request, response)
    : payloadTextOverride;
  response.receipt = overrides.receipt || {
    payload: Buffer.from(payloadText, "utf8").toString("base64"),
    signature: signPayload(payloadText)
  };
  return response;
}

function reopenResponse(
  request,
  overrides = {},
  payloadTextOverride,
  targetBinding
) {
  const prepare = request.type === "prepare_reopen";
  const response = Object.assign({
    schema_version: "1.0",
    status: prepare ? "attempted" : "confirmed",
    request_id: request.request_id,
    attempt_id: request.attempt_id || ATTEMPT_ID,
    namespace_generation: request.namespace_generation,
    namespace_fingerprint: request.namespace_fingerprint
  }, overrides);
  const payloadText = payloadTextOverride === undefined
    ? canonicalReopenReceiptPayload(request, response, targetBinding)
    : payloadTextOverride;
  response.receipt = overrides.receipt || {
    payload: Buffer.from(payloadText, "utf8").toString("base64"),
    signature: signPayload(payloadText)
  };
  return response;
}

function clientWithResponse(responseFactory, options = {}) {
  const calls = [];
  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      calls.push({ hostName, message: structuredClone(message) });
      callback(responseFactory(message));
    }
  };
  return {
    calls,
    client: new NativeAuthorityClient({
      runtime,
      runtimeExtensionId: EXTENSION_ID,
      provisioning: PROVISIONED,
      crypto: crypto.webcrypto,
      uuidFactory: () => REQUEST_ID,
      nonceFactory: () => NONCE,
      timeoutMs: options.timeoutMs
    })
  };
}

test("typed issued response verifies a pinned P-256 receipt and returns only opaque authority material", async () => {
  const fixture = clientWithResponse((request) => issuedResponse(request));
  const result = await fixture.client.resolve({
    provider: "chatgpt",
    provider_conversation_id: RAW_ID_CANARY
  });
  assert.equal(result.status, "issued");
  assert.equal(result.conversation_key, "a".repeat(64));
  assert.equal(result.locator_handle, VALID_LOCATOR);
  assert.equal(result.namespace_generation, 7);
  assert.equal(result.namespace_fingerprint, "fixture-namespace-fingerprint-v7");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].hostName, NATIVE_HOST_NAME);
  assert.equal(fixture.calls[0].message.extension_id, EXTENSION_ID);
  assert.equal(fixture.calls[0].message.provider_conversation_id, RAW_ID_CANARY);
  assert.equal(Object.hasOwn(fixture.calls[0].message, "full_url"), false);
  assert.doesNotMatch(JSON.stringify(fixture.calls), new RegExp(RAW_URL_CANARY));
  const serializedResult = JSON.stringify(result);
  assert.doesNotMatch(serializedResult, new RegExp(RAW_ID_CANARY));
  assert.doesNotMatch(serializedResult, /https?:\/\//);
});

test("opaque locator validation sends no provider ID or URL and requires an exact signed echo", async () => {
  const fixture = clientWithResponse((request) => issuedResponse(request));
  const result = await fixture.client.validateLocator({
    provider: "chatgpt",
    conversation_key: "a".repeat(64),
    locator_handle: VALID_LOCATOR,
    namespace_generation: 7,
    namespace_fingerprint: "fixture-namespace-fingerprint-v7"
  });
  assert.equal(result.status, "issued");
  assert.equal(fixture.calls[0].message.type, "validate_web_locator");
  assert.equal(
    Object.hasOwn(fixture.calls[0].message, "provider_conversation_id"),
    false
  );
  assert.equal(Object.hasOwn(fixture.calls[0].message, "full_url"), false);
});

test("empty production provisioning, a one-byte key, bridge errors, and timeout fail closed", async () => {
  let called = false;
  const unprovisioned = new NativeAuthorityClient({
    runtime: {
      sendNativeMessage() {
        called = true;
      }
    },
    runtimeExtensionId: EXTENSION_ID,
    provisioning: PROVISIONING
  });
  assert.deepEqual(await unprovisioned.resolveFailClosed({
    provider: "chatgpt",
    provider_conversation_id: RAW_ID_CANARY
  }), {
    status: "unavailable",
    reason: "authority_not_provisioned"
  });
  assert.equal(called, false);
  assert.deepEqual(validateProvisioning(PROVISIONING, EXTENSION_ID), {
    valid: false,
    reason: "authority_not_provisioned"
  });
  assert.equal(validateProvisioning(Object.assign({}, PROVISIONED, {
    authority_public_key_x963_base64: "AA=="
  }), EXTENSION_ID).valid, false);

  const runtime = {
    lastError: null,
    sendNativeMessage(_host, _message, callback) {
      this.lastError = { message: "SYNTHETIC FREE TEXT MUST NOT ESCAPE" };
      callback(undefined);
      this.lastError = null;
    }
  };
  const bridgeDown = new NativeAuthorityClient({
    runtime,
    runtimeExtensionId: EXTENSION_ID,
    provisioning: PROVISIONED,
    crypto: crypto.webcrypto,
    uuidFactory: () => REQUEST_ID,
    nonceFactory: () => NONCE
  });
  assert.deepEqual(await bridgeDown.resolveFailClosed({
    provider: "chatgpt",
    provider_conversation_id: RAW_ID_CANARY
  }), {
    status: "unavailable",
    reason: "bridge_unavailable"
  });

  const timedOut = new NativeAuthorityClient({
    runtime: { sendNativeMessage() {} },
    runtimeExtensionId: EXTENSION_ID,
    provisioning: PROVISIONED,
    crypto: crypto.webcrypto,
    uuidFactory: () => REQUEST_ID,
    nonceFactory: () => NONCE,
    timeoutMs: 5
  });
  assert.deepEqual(await timedOut.resolveFailClosed({
    provider: "chatgpt",
    provider_conversation_id: RAW_ID_CANARY
  }), {
    status: "unavailable",
    reason: "bridge_unavailable"
  });
});

test("receipt rejects wrong signatures, one-byte signatures, and namespace mismatch", async () => {
  const request = wireRequest();
  const wrongSignature = issuedResponse(request);
  wrongSignature.receipt.signature = signPayload("different-payload");
  await assert.rejects(
    decodeAuthorityResponse(
      wrongSignature,
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    (error) => error instanceof AuthorityClientError &&
      error.code === "receipt_rejected"
  );
  const oneByte = issuedResponse(request);
  oneByte.receipt.signature = "AQ==";
  await assert.rejects(
    decodeAuthorityResponse(oneByte, request, PROVISIONED, crypto.webcrypto),
    /receipt_rejected/
  );
  await assert.rejects(
    decodeAuthorityResponse(
      issuedResponse(request, { namespace_generation: 8 }),
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    (error) => error instanceof AuthorityClientError &&
      error.code === "namespace_mismatch"
  );
});

test("receipt payload is a canonical closed schema and binds every authority field", async () => {
  const request = wireRequest();
  const base = issuedResponse(request);
  const canonicalText = Buffer.from(base.receipt.payload, "base64").toString("utf8");
  const parsed = JSON.parse(canonicalText);
  const malformedPayloads = [
    ` ${canonicalText}`,
    JSON.stringify(Object.assign({ extra: true }, parsed)),
    canonicalText.replace(
      '"client_nonce":',
      '"client_nonce":"DUPLICATE","client_nonce":'
    ),
    JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()))
  ];
  for (const payloadText of malformedPayloads) {
    await assert.rejects(
      decodeAuthorityResponse(
        issuedResponse(request, {}, payloadText),
        request,
        PROVISIONED,
        crypto.webcrypto
      ),
      /receipt_rejected/
    );
  }

  const mutations = {
    schema_version: "2.0",
    type: "validate_web_locator",
    request_id: "00000000-0000-4000-8000-000000000099",
    client_nonce: `${"B".repeat(43)}=`,
    provider: "claude",
    surface: "other",
    extension_id: "b".repeat(32),
    namespace_generation: 8,
    namespace_fingerprint: "different-namespace-fingerprint",
    conversation_key: "b".repeat(64),
    locator_handle: OTHER_LOCATOR
  };
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = Object.assign({}, parsed, { [field]: value });
    const payloadText = JSON.stringify(mutated);
    await assert.rejects(
      decodeAuthorityResponse(
        issuedResponse(request, {}, payloadText),
        request,
        PROVISIONED,
        crypto.webcrypto
      ),
      /receipt_rejected/
    );
  }
});

test("signed receipts reject raw-ID, wrong-length, padded, and non-base64url locator handles", async () => {
  const request = wireRequest();
  const invalidHandles = [
    RAW_ID_LOCATOR,
    `loc_${"A".repeat(21)}`,
    `loc_${"A".repeat(21)}=`,
    `loc_${"A".repeat(21)}.`
  ];
  for (const locatorHandle of invalidHandles) {
    await assert.rejects(
      decodeAuthorityResponse(
        issuedResponse(request, { locator_handle: locatorHandle }),
        request,
        PROVISIONED,
        crypto.webcrypto
      ),
      (error) => error instanceof AuthorityClientError &&
        error.code === "receipt_rejected"
    );
  }

  const equalRequest = wireRequest("resolve_web_conversation", {
    provider_conversation_id: VALID_LOCATOR
  });
  await assert.rejects(
    decodeAuthorityResponse(
      issuedResponse(equalRequest, { locator_handle: VALID_LOCATOR }),
      equalRequest,
      PROVISIONED,
      crypto.webcrypto
    ),
    /receipt_rejected/
  );

  const fixture = clientWithResponse((nativeRequest) =>
    issuedResponse(nativeRequest, { locator_handle: RAW_ID_LOCATOR })
  );
  assert.deepEqual(await fixture.client.resolveFailClosed({
    provider: "chatgpt",
    provider_conversation_id: RAW_ID_CANARY
  }), {
    status: "unavailable",
    reason: "receipt_rejected"
  });
});

test("resolve request rejects any caller-supplied full_url before native messaging", async () => {
  const fixture = clientWithResponse((request) => issuedResponse(request));
  await assert.rejects(
    fixture.client.resolve({
      provider: "chatgpt",
      provider_conversation_id: RAW_ID_CANARY,
      full_url: RAW_URL_CANARY
    }),
    /invalid_authority_request/
  );
  assert.equal(fixture.calls.length, 0);
});

test("unknown fields, echoed raw values, free-text reasons, partial JSON, and oversize responses are rejected", async () => {
  const request = wireRequest();
  await assert.rejects(
    decodeAuthorityResponse(
      Object.assign(issuedResponse(request), { future: true }),
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    /invalid_native_response/
  );
  await assert.rejects(
    decodeAuthorityResponse(Object.assign(issuedResponse(request), {
      provider_conversation_id: RAW_ID_CANARY,
      full_url: RAW_URL_CANARY
    }), request, PROVISIONED, crypto.webcrypto),
    /invalid_native_response/
  );
  await assert.rejects(
    decodeAuthorityResponse({
      schema_version: "1.0",
      status: "unavailable",
      request_id: REQUEST_ID,
      reason: "Native host said: private route failed"
    }, request, PROVISIONED, crypto.webcrypto),
    /invalid_native_response/
  );
  await assert.rejects(
    decodeAuthorityResponse(
      '{"schema_version":"1.0","status":',
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    /native_response_invalid_json/
  );
  await assert.rejects(
    decodeAuthorityResponse(
      JSON.stringify({ padding: "x".repeat(MAX_MESSAGE_BYTES) }),
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    /native_response_too_large/
  );
});

test("prepare and confirm reopen require signed, content-free, namespace-bound receipts", async () => {
  const fixture = clientWithResponse((request) => reopenResponse(request));
  const target = {
    provider: "chatgpt",
    conversation_key: "a".repeat(64),
    locator_handle: VALID_LOCATOR,
    namespace_generation: NAMESPACE.namespace_generation,
    namespace_fingerprint: NAMESPACE.namespace_fingerprint
  };
  const prepared = await fixture.client.prepareReopen(target);
  assert.equal(prepared.status, "attempted");
  assert.equal(prepared.attempt_id, ATTEMPT_ID);
  const confirmed = await fixture.client.confirmWebReopen(Object.assign({}, target, {
    attempt_id: prepared.attempt_id
  }));
  assert.equal(confirmed.status, "confirmed");
  assert.equal(Object.hasOwn(confirmed, "reason"), false);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(
    fixture.calls.map((call) => call.message.type),
    ["prepare_reopen", "confirm_web_reopen"]
  );
  for (const call of fixture.calls) {
    assert.equal(call.message.extension_id, EXTENSION_ID);
    assert.equal(call.message.client_nonce, NONCE);
    assert.equal(Object.hasOwn(call.message, "provider_conversation_id"), false);
    assert.equal(Object.hasOwn(call.message, "full_url"), false);
  }
  const serialized = JSON.stringify({ calls: fixture.calls, prepared, confirmed });
  assert.doesNotMatch(serialized, new RegExp(RAW_ID_CANARY));
  assert.doesNotMatch(serialized, /https?:\/\//);
});

test("prepare unavailable accepts exactly the macOS coordinator fixed rejection reasons", async () => {
  const request = wireRequest("prepare_reopen");
  const prepareReasons = [
    "authority_unavailable",
    "locator_rejected",
    "namespace_mismatch",
    "identity_mismatch",
    "handle_conflict",
    "capacity_exceeded"
  ];
  for (const reason of prepareReasons) {
    const result = await decodeReopenResponse({
      schema_version: "1.0",
      status: "unavailable",
      request_id: request.request_id,
      reason
    }, request, PROVISIONED, crypto.webcrypto);
    assert.deepEqual(result, { status: "unavailable", reason });
  }

  for (const reason of [
    "attempt_not_found",
    "host_action_required",
    "Native host said private locator failed"
  ]) {
    await assert.rejects(
      decodeReopenResponse({
        schema_version: "1.0",
        status: "unavailable",
        request_id: request.request_id,
        reason
      }, request, PROVISIONED, crypto.webcrypto),
      /invalid_native_response/
    );
  }

  const confirmRequest = wireRequest("confirm_web_reopen", {
    attempt_id: ATTEMPT_ID
  });
  assert.deepEqual(await decodeReopenResponse({
    schema_version: "1.0",
    status: "unavailable",
    request_id: confirmRequest.request_id,
    reason: "attempt_not_found"
  }, confirmRequest, PROVISIONED, crypto.webcrypto), {
    status: "unavailable",
    reason: "attempt_not_found"
  });
});

test("reopen receipt rejects extra, duplicate, wrong-bound, wrong-signature, and one-byte material", async () => {
  const request = {
    schema_version: "1.0",
    type: "prepare_reopen",
    request_id: REQUEST_ID,
    provider: "chatgpt",
    surface: "chrome",
    client_nonce: NONCE,
    extension_id: EXTENSION_ID,
    locator_handle: VALID_LOCATOR,
    conversation_key: "a".repeat(64),
    namespace_generation: NAMESPACE.namespace_generation,
    namespace_fingerprint: NAMESPACE.namespace_fingerprint
  };
  await assert.rejects(
    decodeReopenResponse(
      Object.assign(reopenResponse(request), { future: true }),
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    /invalid_native_response/
  );
  await assert.rejects(
    decodeReopenResponse(
      reopenResponse(request, {
        status: "failed",
        reason: "private native free text"
      }),
      request,
      PROVISIONED,
      crypto.webcrypto,
      request
    ),
    /invalid_native_response/
  );

  const canonical = canonicalReopenReceiptPayload(
    request,
    reopenResponse(request)
  );
  const duplicatePayload = canonical.replace(
    "{",
    `{"attempt_id":"${ATTEMPT_ID}",`
  );
  await assert.rejects(
    decodeReopenResponse(
      reopenResponse(request, {}, duplicatePayload),
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    /receipt_rejected/
  );

  const wrongBound = reopenResponse(request);
  wrongBound.attempt_id = `rpa_${"S".repeat(22)}`;
  await assert.rejects(
    decodeReopenResponse(wrongBound, request, PROVISIONED, crypto.webcrypto),
    /receipt_rejected/
  );

  const wrongSignature = reopenResponse(request);
  wrongSignature.receipt.signature = signPayload("different");
  await assert.rejects(
    decodeReopenResponse(
      wrongSignature,
      request,
      PROVISIONED,
      crypto.webcrypto
    ),
    /receipt_rejected/
  );

  const oneByte = reopenResponse(request);
  oneByte.receipt.signature = "AQ==";
  await assert.rejects(
    decodeReopenResponse(oneByte, request, PROVISIONED, crypto.webcrypto),
    /receipt_rejected/
  );
});

test("reopen fails closed on bridge errors, namespace rotation, and signed failed confirmation", async () => {
  const target = {
    provider: "claude",
    conversation_key: "b".repeat(64),
    locator_handle: OTHER_LOCATOR,
    namespace_generation: NAMESPACE.namespace_generation,
    namespace_fingerprint: NAMESPACE.namespace_fingerprint
  };
  const bridgeDown = new NativeAuthorityClient({
    runtime: {
      lastError: null,
      sendNativeMessage(_host, _message, callback) {
        this.lastError = { message: "private native diagnostic" };
        callback(undefined);
        this.lastError = null;
      }
    },
    runtimeExtensionId: EXTENSION_ID,
    provisioning: PROVISIONED,
    crypto: crypto.webcrypto,
    uuidFactory: () => REQUEST_ID,
    nonceFactory: () => NONCE
  });
  assert.deepEqual(await bridgeDown.prepareReopenFailClosed(target), {
    status: "unavailable",
    reason: "bridge_unavailable"
  });
  assert.deepEqual(await bridgeDown.prepareReopenFailClosed(Object.assign({}, target, {
    namespace_generation: 8
  })), {
    status: "unavailable",
    reason: "namespace_mismatch"
  });

  const failed = clientWithResponse((request) => request.type === "prepare_reopen"
    ? reopenResponse(request)
    : reopenResponse(request, {
        status: "failed",
        reason: "identity_mismatch"
      }, undefined, target));
  const prepared = await failed.client.prepareReopen(target);
  const result = await failed.client.confirmWebReopen(Object.assign({}, target, {
    attempt_id: prepared.attempt_id
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "identity_mismatch");
});

test("confirm receipt stays bound to the prepare target when the observed identity is B", async () => {
  let preparedTarget;
  const fixture = clientWithResponse((request) => {
    if (request.type === "prepare_reopen") {
      preparedTarget = structuredClone(request);
      return reopenResponse(request);
    }
    return reopenResponse(
      request,
      { status: "failed", reason: "identity_mismatch" },
      undefined,
      preparedTarget
    );
  });
  const targetA = {
    provider: "chatgpt",
    conversation_key: "a".repeat(64),
    locator_handle: VALID_LOCATOR,
    ...NAMESPACE
  };
  const prepared = await fixture.client.prepareReopen(targetA);
  const result = await fixture.client.confirmWebReopen({
    provider: "chatgpt",
    attempt_id: prepared.attempt_id,
    conversation_key: "b".repeat(64),
    locator_handle: OTHER_LOCATOR,
    ...NAMESPACE
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "identity_mismatch");
  const confirmWire = fixture.calls.at(-1).message;
  assert.equal(confirmWire.conversation_key, "b".repeat(64));
  const receiptPayload = Buffer.from(
    reopenResponse(
      confirmWire,
      { status: "failed", reason: "identity_mismatch" },
      undefined,
      preparedTarget
    ).receipt.payload,
    "base64"
  ).toString("utf8");
  assert.equal(JSON.parse(receiptPayload).conversation_key, "a".repeat(64));
});

test("reopen_status is content-free, signed against the saved target, and never polled implicitly", async () => {
  let targetBinding;
  const fixture = clientWithResponse((request) => {
    if (request.type === "prepare_reopen") {
      targetBinding = structuredClone(request);
      return reopenResponse(request);
    }
    return reopenResponse(
      request,
      { status: "attempted" },
      undefined,
      targetBinding
    );
  });
  const target = {
    provider: "claude",
    conversation_key: "c".repeat(64),
    locator_handle: OTHER_LOCATOR,
    ...NAMESPACE
  };
  const prepared = await fixture.client.prepareReopen(target);
  assert.equal(fixture.calls.length, 1);
  const status = await fixture.client.reopenStatus({
    attempt_id: prepared.attempt_id,
    ...NAMESPACE
  });
  assert.equal(status.status, "attempted");
  assert.equal(fixture.calls.length, 2);
  const wire = fixture.calls[1].message;
  assert.deepEqual(Object.keys(wire).sort(), [
    "attempt_id",
    "client_nonce",
    "extension_id",
    "namespace_fingerprint",
    "namespace_generation",
    "request_id",
    "schema_version",
    "surface",
    "type"
  ]);
  assert.equal(wire.type, "reopen_status");
  assert.equal(Object.hasOwn(wire, "provider"), false);
  assert.equal(Object.hasOwn(wire, "conversation_key"), false);
  assert.equal(Object.hasOwn(wire, "locator_handle"), false);
});

test("a native attempt ID can bind only one prepare target at a time", async () => {
  const fixture = clientWithResponse((request) => reopenResponse(request));
  const targetA = {
    provider: "chatgpt",
    conversation_key: "a".repeat(64),
    locator_handle: VALID_LOCATOR,
    ...NAMESPACE
  };
  const targetB = {
    provider: "chatgpt",
    conversation_key: "b".repeat(64),
    locator_handle: OTHER_LOCATOR,
    ...NAMESPACE
  };
  assert.equal((await fixture.client.prepareReopen(targetA)).status, "attempted");
  assert.deepEqual(await fixture.client.prepareReopenFailClosed(targetB), {
    status: "unavailable",
    reason: "receipt_rejected"
  });
});
