(function initAuthorityClient(root, factory) {
  const provisioningApi = typeof module === "object" && module.exports
    ? require("./authority_provisioning.js")
    : root.AIConversation.AuthorityProvisioning;
  const core = typeof module === "object" && module.exports
    ? require("./core.js")
    : root.AIConversation.Core;
  const api = factory(root, provisioningApi, core);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.AuthorityClient = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function authorityClientFactory(
  root,
  AuthorityProvisioning,
  Core
) {
  "use strict";

  const MAX_MESSAGE_BYTES = 16 * 1024;
  const NATIVE_TIMEOUT_MS = 1500;
  const RESOLVE_REQUEST_KEYS = new Set([
    "provider",
    "provider_conversation_id"
  ]);
  const LOCATOR_VALIDATION_KEYS = new Set([
    "provider",
    "conversation_key",
    "locator_handle",
    "namespace_generation",
    "namespace_fingerprint"
  ]);
  const REOPEN_TARGET_KEYS = new Set([
    "provider",
    "conversation_key",
    "locator_handle",
    "namespace_generation",
    "namespace_fingerprint"
  ]);
  const REOPEN_CONFIRM_KEYS = new Set([
    "provider",
    "attempt_id",
    "conversation_key",
    "locator_handle",
    "namespace_generation",
    "namespace_fingerprint"
  ]);
  const REOPEN_STATUS_KEYS = new Set([
    "attempt_id",
    "namespace_generation",
    "namespace_fingerprint"
  ]);
  const ISSUED_KEYS = new Set([
    "schema_version",
    "status",
    "request_id",
    "conversation_key",
    "locator_handle",
    "namespace_generation",
    "namespace_fingerprint",
    "receipt"
  ]);
  const UNAVAILABLE_KEYS = new Set([
    "schema_version",
    "status",
    "request_id",
    "reason"
  ]);
  const RECEIPT_KEYS = new Set(["payload", "signature"]);
  const RECEIPT_PAYLOAD_KEYS = new Set([
    "client_nonce",
    "conversation_key",
    "extension_id",
    "locator_handle",
    "namespace_fingerprint",
    "namespace_generation",
    "provider",
    "request_id",
    "schema_version",
    "surface",
    "type"
  ]);
  const REOPEN_RESPONSE_KEYS = new Set([
    "schema_version",
    "status",
    "request_id",
    "attempt_id",
    "namespace_generation",
    "namespace_fingerprint",
    "receipt"
  ]);
  const REOPEN_FAILED_RESPONSE_KEYS = new Set([
    "schema_version",
    "status",
    "request_id",
    "attempt_id",
    "namespace_generation",
    "namespace_fingerprint",
    "reason",
    "receipt"
  ]);
  const REOPEN_RECEIPT_PAYLOAD_KEYS = new Set([
    "attempt_id",
    "client_nonce",
    "conversation_key",
    "extension_id",
    "locator_handle",
    "namespace_fingerprint",
    "namespace_generation",
    "provider",
    "request_id",
    "schema_version",
    "status",
    "surface",
    "type"
  ]);
  const UNAVAILABLE_REASONS = new Set([
    "authority_unavailable",
    "actuator_unavailable",
    "attempt_conflict",
    "attempt_rejected",
    "bridge_unavailable",
    "extension_rejected",
    "locator_unavailable",
    "namespace_mismatch",
    "route_rejected",
    "receipt_rejected"
  ]);
  const REOPEN_FAILURE_REASONS = new Set([
    "authority_unavailable",
    "locator_rejected",
    "namespace_mismatch",
    "identity_mismatch",
    "handle_conflict",
    "capacity_exceeded",
    "actuator_unavailable",
    "provider_not_running",
    "provider_ambiguous",
    "provider_build_rejected",
    "browser_build_rejected",
    "scripting_definition_mismatch",
    "automation_not_authorized",
    "host_action_required",
    "host_command_rejected",
    "unsupported_classic",
    "timeout",
    "attempt_not_found",
    "confirmation_before_actuation"
  ]);
  // These sets mirror the fixed ReopenReason values that the macOS wire
  // handler can emit for each request type. Keeping them request-specific
  // prevents a valid prepare rejection from being mistaken for free text,
  // without accepting reasons that cannot arise in that phase.
  const REOPEN_UNAVAILABLE_REASONS = Object.freeze({
    prepare_reopen: new Set([
      "authority_unavailable",
      "locator_rejected",
      "namespace_mismatch",
      "identity_mismatch",
      "handle_conflict",
      "capacity_exceeded"
    ]),
    confirm_web_reopen: new Set([
      "authority_unavailable",
      "attempt_not_found"
    ]),
    reopen_status: new Set([
      "authority_unavailable",
      "attempt_not_found"
    ])
  });
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CONVERSATION_KEY_RE = /^[0-9a-f]{64}$/;
  const LOCATOR_HANDLE_RE = /^loc_[A-Za-z0-9_-]{22}$/;
  const REOPEN_ATTEMPT_ID_RE = /^rpa_[A-Za-z0-9_-]{22}$/;
  const NAMESPACE_FINGERPRINT_RE = /^[A-Za-z0-9._:-]{16,255}$/;
  const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const CHATGPT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
  const CLAUDE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  class AuthorityClientError extends Error {
    constructor(code) {
      super(code);
      this.name = "AuthorityClientError";
      this.code = code;
    }
  }

  function fail(code) {
    throw new AuthorityClientError(code);
  }

  function hasExactKeys(value, allowed) {
    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === allowed.size &&
      Object.keys(value).every((key) => allowed.has(key))
    );
  }

  function utf8Bytes(value) {
    if (typeof root.TextEncoder === "function") {
      return new root.TextEncoder().encode(value);
    }
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(value);
    }
    if (typeof Buffer === "function") {
      return Uint8Array.from(Buffer.from(value, "utf8"));
    }
    fail("client_encoding_unavailable");
  }

  function decodeUtf8Strict(bytes) {
    const Decoder = root.TextDecoder || (
      typeof TextDecoder === "function" ? TextDecoder : null
    );
    if (!Decoder) {
      fail("receipt_rejected");
    }
    try {
      return new Decoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_error) {
      fail("receipt_rejected");
    }
  }

  function byteLength(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof serialized !== "string") {
      fail("invalid_native_response");
    }
    return utf8Bytes(serialized).length;
  }

  function parseBoundedObject(rawValue) {
    if (byteLength(rawValue) > MAX_MESSAGE_BYTES) {
      fail("native_response_too_large");
    }
    let value = rawValue;
    if (typeof rawValue === "string") {
      try {
        value = JSON.parse(rawValue);
      } catch (_error) {
        fail("native_response_invalid_json");
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("invalid_native_response");
    }
    return value;
  }

  function canonicalRequest(candidate) {
    if (
      !hasExactKeys(candidate, RESOLVE_REQUEST_KEYS) ||
      !["chatgpt", "claude"].includes(candidate.provider) ||
      typeof candidate.provider_conversation_id !== "string"
    ) {
      fail("invalid_authority_request");
    }
    const isChatGPT = candidate.provider === "chatgpt";
    const idPattern = isChatGPT ? CHATGPT_ID_RE : CLAUDE_ID_RE;
    if (!idPattern.test(candidate.provider_conversation_id)) {
      fail("invalid_authority_request");
    }
    return {
      provider: candidate.provider,
      provider_conversation_id: isChatGPT
        ? candidate.provider_conversation_id
        : candidate.provider_conversation_id.toLowerCase()
    };
  }

  function isValidLocatorHandle(value, providerConversationId) {
    if (!LOCATOR_HANDLE_RE.test(value || "")) {
      return false;
    }
    if (
      typeof providerConversationId === "string" &&
      providerConversationId &&
      value.toLowerCase().includes(providerConversationId.toLowerCase())
    ) {
      return false;
    }
    return true;
  }

  function canonicalLocatorValidation(candidate, provisioning) {
    if (
      !hasExactKeys(candidate, LOCATOR_VALIDATION_KEYS) ||
      !["chatgpt", "claude"].includes(candidate.provider) ||
      !CONVERSATION_KEY_RE.test(candidate.conversation_key || "") ||
      !isValidLocatorHandle(candidate.locator_handle) ||
      candidate.namespace_generation !== provisioning.namespace_generation ||
      candidate.namespace_fingerprint !== provisioning.namespace_fingerprint
    ) {
      fail(
        candidate && (
          candidate.namespace_generation !== provisioning.namespace_generation ||
          candidate.namespace_fingerprint !== provisioning.namespace_fingerprint
        ) ? "namespace_mismatch" : "invalid_authority_request"
      );
    }
    return {
      provider: candidate.provider,
      conversation_key: candidate.conversation_key,
      locator_handle: candidate.locator_handle,
      namespace_generation: candidate.namespace_generation,
      namespace_fingerprint: candidate.namespace_fingerprint
    };
  }

  function canonicalReopenTarget(candidate, provisioning) {
    if (
      !hasExactKeys(candidate, REOPEN_TARGET_KEYS) ||
      !["chatgpt", "claude"].includes(candidate.provider) ||
      !CONVERSATION_KEY_RE.test(candidate.conversation_key || "") ||
      !isValidLocatorHandle(candidate.locator_handle) ||
      !Number.isInteger(candidate.namespace_generation) ||
      candidate.namespace_generation <= 0 ||
      !NAMESPACE_FINGERPRINT_RE.test(
        candidate.namespace_fingerprint || ""
      )
    ) {
      fail("invalid_authority_request");
    }
    if (
      candidate.namespace_generation !== provisioning.namespace_generation ||
      candidate.namespace_fingerprint !== provisioning.namespace_fingerprint
    ) {
      fail("namespace_mismatch");
    }
    return {
      provider: candidate.provider,
      conversation_key: candidate.conversation_key,
      locator_handle: candidate.locator_handle,
      namespace_generation: candidate.namespace_generation,
      namespace_fingerprint: candidate.namespace_fingerprint
    };
  }

  function canonicalReopenConfirmation(candidate, provisioning) {
    if (
      !hasExactKeys(candidate, REOPEN_CONFIRM_KEYS) ||
      !["chatgpt", "claude"].includes(candidate.provider) ||
      !REOPEN_ATTEMPT_ID_RE.test(candidate.attempt_id || "") ||
      !CONVERSATION_KEY_RE.test(candidate.conversation_key || "") ||
      !isValidLocatorHandle(candidate.locator_handle) ||
      !Number.isInteger(candidate.namespace_generation) ||
      candidate.namespace_generation <= 0 ||
      !NAMESPACE_FINGERPRINT_RE.test(
        candidate.namespace_fingerprint || ""
      )
    ) {
      fail("invalid_authority_request");
    }
    if (
      candidate.namespace_generation !== provisioning.namespace_generation ||
      candidate.namespace_fingerprint !== provisioning.namespace_fingerprint
    ) {
      fail("namespace_mismatch");
    }
    return {
      provider: candidate.provider,
      attempt_id: candidate.attempt_id,
      conversation_key: candidate.conversation_key,
      locator_handle: candidate.locator_handle,
      namespace_generation: candidate.namespace_generation,
      namespace_fingerprint: candidate.namespace_fingerprint
    };
  }

  function canonicalReopenStatus(candidate, provisioning) {
    if (
      !hasExactKeys(candidate, REOPEN_STATUS_KEYS) ||
      !REOPEN_ATTEMPT_ID_RE.test(candidate.attempt_id || "") ||
      !Number.isInteger(candidate.namespace_generation) ||
      candidate.namespace_generation <= 0 ||
      !NAMESPACE_FINGERPRINT_RE.test(
        candidate.namespace_fingerprint || ""
      )
    ) {
      fail("invalid_authority_request");
    }
    if (
      candidate.namespace_generation !== provisioning.namespace_generation ||
      candidate.namespace_fingerprint !== provisioning.namespace_fingerprint
    ) {
      fail("namespace_mismatch");
    }
    return {
      attempt_id: candidate.attempt_id,
      namespace_generation: candidate.namespace_generation,
      namespace_fingerprint: candidate.namespace_fingerprint
    };
  }

  function decodeCanonicalBase64(value, minimumBytes, maximumBytes, errorCode) {
    if (
      typeof value !== "string" ||
      value.length % 4 !== 0 ||
      !BASE64_RE.test(value) ||
      value.length > Math.ceil(maximumBytes / 3) * 4
    ) {
      fail(errorCode);
    }
    try {
      let bytes;
      let encoded;
      if (typeof root.atob === "function" && typeof root.btoa === "function") {
        const binary = root.atob(value);
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        encoded = root.btoa(binary);
      } else if (typeof Buffer === "function") {
        bytes = Uint8Array.from(Buffer.from(value, "base64"));
        encoded = Buffer.from(bytes).toString("base64");
      } else {
        fail(errorCode);
      }
      if (
        encoded !== value ||
        bytes.length < minimumBytes ||
        bytes.length > maximumBytes
      ) {
        fail(errorCode);
      }
      return bytes;
    } catch (error) {
      if (error instanceof AuthorityClientError) {
        throw error;
      }
      fail(errorCode);
    }
  }

  function readCanonicalDerInteger(bytes, offset) {
    if (bytes[offset] !== 0x02 || offset + 2 > bytes.length) {
      fail("receipt_rejected");
    }
    const length = bytes[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (length < 1 || length > 33 || end > bytes.length) {
      fail("receipt_rejected");
    }
    const integer = bytes.slice(start, end);
    if (
      integer[0] & 0x80 ||
      (length === 33 && (integer[0] !== 0 || !(integer[1] & 0x80))) ||
      (length > 1 && integer[0] === 0 && !(integer[1] & 0x80))
    ) {
      fail("receipt_rejected");
    }
    const magnitude = length === 33 ? integer.slice(1) : integer;
    const result = new Uint8Array(32);
    result.set(magnitude, 32 - magnitude.length);
    return { bytes: result, offset: end };
  }

  function ecdsaDerToRaw(signatureBytes) {
    if (
      signatureBytes.length < 8 ||
      signatureBytes.length > 72 ||
      signatureBytes[0] !== 0x30 ||
      signatureBytes[1] & 0x80 ||
      signatureBytes[1] !== signatureBytes.length - 2
    ) {
      fail("receipt_rejected");
    }
    const r = readCanonicalDerInteger(signatureBytes, 2);
    const s = readCanonicalDerInteger(signatureBytes, r.offset);
    if (s.offset !== signatureBytes.length) {
      fail("receipt_rejected");
    }
    const result = new Uint8Array(64);
    result.set(r.bytes, 0);
    result.set(s.bytes, 32);
    return result;
  }

  function canonicalReceiptPayload(expectedRequest, response) {
    return JSON.stringify({
      client_nonce: expectedRequest.client_nonce,
      conversation_key: response.conversation_key,
      extension_id: expectedRequest.extension_id,
      locator_handle: response.locator_handle,
      namespace_fingerprint: response.namespace_fingerprint,
      namespace_generation: response.namespace_generation,
      provider: expectedRequest.provider,
      request_id: expectedRequest.request_id,
      schema_version: expectedRequest.schema_version,
      surface: expectedRequest.surface,
      type: expectedRequest.type
    });
  }

  function canonicalReopenReceiptPayload(
    expectedRequest,
    response,
    targetBinding
  ) {
    const target = targetBinding || expectedRequest;
    return JSON.stringify({
      attempt_id: response.attempt_id,
      client_nonce: expectedRequest.client_nonce,
      conversation_key: target.conversation_key,
      extension_id: expectedRequest.extension_id,
      locator_handle: target.locator_handle,
      namespace_fingerprint: response.namespace_fingerprint,
      namespace_generation: response.namespace_generation,
      provider: target.provider,
      request_id: expectedRequest.request_id,
      schema_version: expectedRequest.schema_version,
      status: response.status,
      surface: expectedRequest.surface,
      type: expectedRequest.type
    });
  }

  async function verifyCanonicalReceipt(
    receipt,
    expectedPayload,
    payloadKeys,
    provisioning,
    cryptoApi
  ) {
    if (!hasExactKeys(receipt, RECEIPT_KEYS)) {
      fail("receipt_rejected");
    }
    const payloadBytes = decodeCanonicalBase64(
      receipt.payload,
      2,
      4096,
      "receipt_rejected"
    );
    const signatureDer = decodeCanonicalBase64(
      receipt.signature,
      8,
      72,
      "receipt_rejected"
    );
    const signatureRaw = ecdsaDerToRaw(signatureDer);
    const payloadText = decodeUtf8Strict(payloadBytes);
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payloadText);
    } catch (_error) {
      fail("receipt_rejected");
    }
    if (
      !hasExactKeys(parsedPayload, payloadKeys) ||
      payloadText !== expectedPayload
    ) {
      fail("receipt_rejected");
    }
    const publicKeyBytes = decodeCanonicalBase64(
      provisioning.authority_public_key_x963_base64,
      65,
      65,
      "receipt_rejected"
    );
    if (publicKeyBytes[0] !== 0x04 || !cryptoApi || !cryptoApi.subtle) {
      fail("receipt_rejected");
    }
    try {
      const publicKey = await cryptoApi.subtle.importKey(
        "raw",
        publicKeyBytes,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      const verified = await cryptoApi.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signatureRaw,
        payloadBytes
      );
      if (!verified) {
        fail("receipt_rejected");
      }
    } catch (error) {
      if (error instanceof AuthorityClientError) {
        throw error;
      }
      fail("receipt_rejected");
    }
  }

  async function verifyIssuedReceipt(value, expectedRequest, provisioning, cryptoApi) {
    return verifyCanonicalReceipt(
      value.receipt,
      canonicalReceiptPayload(expectedRequest, value),
      RECEIPT_PAYLOAD_KEYS,
      provisioning,
      cryptoApi
    );
  }

  async function decodeAuthorityResponse(
    rawValue,
    expectedRequest,
    provisioning,
    cryptoApi
  ) {
    const value = parseBoundedObject(rawValue);
    if (
      !expectedRequest ||
      value.schema_version !== "1.0" ||
      value.request_id !== expectedRequest.request_id ||
      !UUID_RE.test(value.request_id || "")
    ) {
      fail("invalid_native_response");
    }
    if (value.status === "unavailable") {
      if (
        !hasExactKeys(value, UNAVAILABLE_KEYS) ||
        !UNAVAILABLE_REASONS.has(value.reason)
      ) {
        fail("invalid_native_response");
      }
      return Object.freeze({
        status: "unavailable",
        reason: value.reason
      });
    }
    if (
      value.status !== "issued" ||
      !hasExactKeys(value, ISSUED_KEYS) ||
      !CONVERSATION_KEY_RE.test(value.conversation_key || "") ||
      !hasExactKeys(value.receipt, RECEIPT_KEYS)
    ) {
      fail("invalid_native_response");
    }
    if (!isValidLocatorHandle(
      value.locator_handle,
      expectedRequest.type === "resolve_web_conversation"
        ? expectedRequest.provider_conversation_id
        : null
    )) {
      fail("receipt_rejected");
    }
    if (
      value.namespace_generation !== provisioning.namespace_generation ||
      value.namespace_fingerprint !== provisioning.namespace_fingerprint
    ) {
      fail("namespace_mismatch");
    }
    if (
      expectedRequest.type === "validate_web_locator" &&
      (
        value.conversation_key !== expectedRequest.conversation_key ||
        value.locator_handle !== expectedRequest.locator_handle
      )
    ) {
      fail("receipt_rejected");
    }
    await verifyIssuedReceipt(value, expectedRequest, provisioning, cryptoApi);
    return Object.freeze({
      status: "issued",
      conversation_key: value.conversation_key,
      locator_handle: value.locator_handle,
      namespace_generation: value.namespace_generation,
      namespace_fingerprint: value.namespace_fingerprint,
      receipt: Object.freeze({
        payload: value.receipt.payload,
        signature: value.receipt.signature
      })
    });
  }

  async function decodeReopenResponse(
    rawValue,
    expectedRequest,
    provisioning,
    cryptoApi,
    targetBinding
  ) {
    const value = parseBoundedObject(rawValue);
    if (
      !expectedRequest ||
      !["prepare_reopen", "confirm_web_reopen", "reopen_status"].includes(
        expectedRequest.type
      ) ||
      value.schema_version !== "1.0" ||
      value.request_id !== expectedRequest.request_id ||
      !UUID_RE.test(value.request_id || "")
    ) {
      fail("invalid_native_response");
    }
    if (value.status === "unavailable") {
      const allowedReasons = REOPEN_UNAVAILABLE_REASONS[
        expectedRequest.type
      ];
      if (
        !hasExactKeys(value, UNAVAILABLE_KEYS) ||
        !allowedReasons ||
        !allowedReasons.has(value.reason)
      ) {
        fail("invalid_native_response");
      }
      return Object.freeze({
        status: "unavailable",
        reason: value.reason
      });
    }
    const prepare = expectedRequest.type === "prepare_reopen";
    const statusOnly = expectedRequest.type === "reopen_status";
    const failed = ["failed", "expired"].includes(value.status);
    const expectedKeys = failed
      ? REOPEN_FAILED_RESPONSE_KEYS
      : REOPEN_RESPONSE_KEYS;
    const validStatus = prepare
      ? ["attempted", "failed", "expired"].includes(value.status)
      : statusOnly
        ? ["prepared", "attempted", "confirmed", "failed", "expired"].includes(
            value.status
          )
        : ["confirmed", "failed", "expired"].includes(value.status);
    if (
      !validStatus ||
      !hasExactKeys(value, expectedKeys) ||
      !REOPEN_ATTEMPT_ID_RE.test(value.attempt_id || "") ||
      !hasExactKeys(value.receipt, RECEIPT_KEYS) ||
      value.namespace_generation !== provisioning.namespace_generation ||
      value.namespace_fingerprint !== provisioning.namespace_fingerprint ||
      !prepare && value.attempt_id !== expectedRequest.attempt_id ||
      failed && !REOPEN_FAILURE_REASONS.has(value.reason)
    ) {
      if (
        value.namespace_generation !== provisioning.namespace_generation ||
        value.namespace_fingerprint !== provisioning.namespace_fingerprint
      ) {
        fail("namespace_mismatch");
      }
      fail("invalid_native_response");
    }
    await verifyCanonicalReceipt(
      value.receipt,
      canonicalReopenReceiptPayload(expectedRequest, value, targetBinding),
      REOPEN_RECEIPT_PAYLOAD_KEYS,
      provisioning,
      cryptoApi
    );
    const result = {
      status: value.status,
      attempt_id: value.attempt_id,
      namespace_generation: value.namespace_generation,
      namespace_fingerprint: value.namespace_fingerprint,
      receipt: Object.freeze({
        payload: value.receipt.payload,
        signature: value.receipt.signature
      })
    };
    if (failed) {
      result.reason = value.reason;
    }
    return Object.freeze(result);
  }

  function sendNativeMessage(
    runtime,
    hostName,
    message,
    timeoutMs,
    setTimer,
    clearTimer
  ) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (!settled) {
          settled = true;
          reject(new AuthorityClientError("bridge_unavailable"));
        }
      }, timeoutMs);
      runtime.sendNativeMessage(hostName, message, (response) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer(timer);
        if (runtime.lastError) {
          reject(new AuthorityClientError("bridge_unavailable"));
          return;
        }
        resolve(response);
      });
    });
  }

  class NativeAuthorityClient {
    constructor(options) {
      const config = options || {};
      this.runtime = config.runtime;
      this.crypto = config.crypto || root.crypto;
      this.uuidFactory = config.uuidFactory || Core.randomUuid;
      this.nonceFactory = config.nonceFactory || (() => {
        const bytes = new Uint8Array(32);
        this.crypto.getRandomValues(bytes);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return root.btoa(binary);
      });
      this.timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : NATIVE_TIMEOUT_MS;
      this.setTimer = config.setTimeout || root.setTimeout.bind(root);
      this.clearTimer = config.clearTimeout || root.clearTimeout.bind(root);
      this.provisioning = AuthorityProvisioning.validateProvisioning(
        config.provisioning,
        config.runtimeExtensionId
      );
      this.reopenBindings = new Map();
    }

    context() {
      if (!this.provisioning.valid) {
        return Object.freeze({
          status: "unavailable",
          reason: this.provisioning.reason
        });
      }
      return Object.freeze({
        status: "ready",
        namespace_generation: this.provisioning.value.namespace_generation,
        namespace_fingerprint: this.provisioning.value.namespace_fingerprint
      });
    }

    entropy() {
      const requestId = this.uuidFactory();
      const nonce = this.nonceFactory();
      let nonceBytes;
      try {
        nonceBytes = decodeCanonicalBase64(
          nonce,
          32,
          32,
          "client_entropy_unavailable"
        );
      } catch (_error) {
        throw new AuthorityClientError("client_entropy_unavailable");
      }
      if (!UUID_RE.test(requestId) || nonceBytes.length !== 32) {
        throw new AuthorityClientError("client_entropy_unavailable");
      }
      return { requestId, nonce };
    }

    async sendAndDecode(wireRequest) {
      if (byteLength(wireRequest) > MAX_MESSAGE_BYTES) {
        throw new AuthorityClientError("native_request_too_large");
      }
      const response = await sendNativeMessage(
        this.runtime,
        this.provisioning.value.native_host_name,
        wireRequest,
        this.timeoutMs,
        this.setTimer,
        this.clearTimer
      );
      return decodeAuthorityResponse(
        response,
        wireRequest,
        this.provisioning.value,
        this.crypto
      );
    }

    async sendReopenAndDecode(wireRequest, targetBinding) {
      if (byteLength(wireRequest) > MAX_MESSAGE_BYTES) {
        throw new AuthorityClientError("native_request_too_large");
      }
      const response = await sendNativeMessage(
        this.runtime,
        this.provisioning.value.native_host_name,
        wireRequest,
        this.timeoutMs,
        this.setTimer,
        this.clearTimer
      );
      return decodeReopenResponse(
        response,
        wireRequest,
        this.provisioning.value,
        this.crypto,
        targetBinding
      );
    }

    requireReady() {
      if (!this.provisioning.valid) {
        throw new AuthorityClientError(this.provisioning.reason);
      }
      if (!this.runtime || typeof this.runtime.sendNativeMessage !== "function") {
        throw new AuthorityClientError("bridge_unavailable");
      }
    }

    async resolve(candidate) {
      this.requireReady();
      const request = canonicalRequest(candidate);
      const entropy = this.entropy();
      return this.sendAndDecode({
        schema_version: "1.0",
        type: "resolve_web_conversation",
        request_id: entropy.requestId,
        provider: request.provider,
        surface: "chrome",
        provider_conversation_id: request.provider_conversation_id,
        client_nonce: entropy.nonce,
        extension_id: this.provisioning.value.expected_extension_id,
        namespace_generation: this.provisioning.value.namespace_generation,
        namespace_fingerprint: this.provisioning.value.namespace_fingerprint
      });
    }

    async validateLocator(candidate) {
      this.requireReady();
      const request = canonicalLocatorValidation(
        candidate,
        this.provisioning.value
      );
      const entropy = this.entropy();
      return this.sendAndDecode({
        schema_version: "1.0",
        type: "validate_web_locator",
        request_id: entropy.requestId,
        provider: request.provider,
        surface: "chrome",
        conversation_key: request.conversation_key,
        locator_handle: request.locator_handle,
        client_nonce: entropy.nonce,
        extension_id: this.provisioning.value.expected_extension_id,
        namespace_generation: request.namespace_generation,
        namespace_fingerprint: request.namespace_fingerprint
      });
    }

    async prepareReopen(candidate) {
      this.requireReady();
      const request = canonicalReopenTarget(
        candidate,
        this.provisioning.value
      );
      const entropy = this.entropy();
      const wireRequest = {
        schema_version: "1.0",
        type: "prepare_reopen",
        request_id: entropy.requestId,
        provider: request.provider,
        surface: "chrome",
        client_nonce: entropy.nonce,
        extension_id: this.provisioning.value.expected_extension_id,
        locator_handle: request.locator_handle,
        conversation_key: request.conversation_key,
        namespace_generation: request.namespace_generation,
        namespace_fingerprint: request.namespace_fingerprint
      };
      const result = await this.sendReopenAndDecode(wireRequest, request);
      if (result.status === "attempted") {
        if (this.reopenBindings.has(result.attempt_id)) {
          throw new AuthorityClientError("receipt_rejected");
        }
        if (this.reopenBindings.size >= 128) {
          throw new AuthorityClientError("authority_unavailable");
        }
        this.reopenBindings.set(result.attempt_id, Object.freeze(request));
      }
      return result;
    }

    async confirmWebReopen(candidate) {
      this.requireReady();
      const request = canonicalReopenConfirmation(
        candidate,
        this.provisioning.value
      );
      const targetBinding = this.reopenBindings.get(request.attempt_id);
      if (!targetBinding) {
        throw new AuthorityClientError("attempt_not_found");
      }
      const entropy = this.entropy();
      const result = await this.sendReopenAndDecode({
        schema_version: "1.0",
        type: "confirm_web_reopen",
        request_id: entropy.requestId,
        provider: request.provider,
        surface: "chrome",
        client_nonce: entropy.nonce,
        extension_id: this.provisioning.value.expected_extension_id,
        attempt_id: request.attempt_id,
        conversation_key: request.conversation_key,
        locator_handle: request.locator_handle,
        namespace_generation: request.namespace_generation,
        namespace_fingerprint: request.namespace_fingerprint
      }, targetBinding);
      if (["confirmed", "failed", "expired"].includes(result.status)) {
        this.reopenBindings.delete(request.attempt_id);
      }
      return result;
    }

    async reopenStatus(candidate) {
      this.requireReady();
      const request = canonicalReopenStatus(candidate, this.provisioning.value);
      const targetBinding = this.reopenBindings.get(request.attempt_id);
      if (!targetBinding) {
        throw new AuthorityClientError("attempt_not_found");
      }
      const entropy = this.entropy();
      const result = await this.sendReopenAndDecode({
        schema_version: "1.0",
        type: "reopen_status",
        request_id: entropy.requestId,
        surface: "chrome",
        client_nonce: entropy.nonce,
        extension_id: this.provisioning.value.expected_extension_id,
        attempt_id: request.attempt_id,
        namespace_generation: request.namespace_generation,
        namespace_fingerprint: request.namespace_fingerprint
      }, targetBinding);
      if (["confirmed", "failed", "expired"].includes(result.status)) {
        this.reopenBindings.delete(request.attempt_id);
      }
      return result;
    }

    forgetReopenAttempt(attemptId) {
      if (REOPEN_ATTEMPT_ID_RE.test(attemptId || "")) {
        this.reopenBindings.delete(attemptId);
      }
    }

    async resolveFailClosed(candidate) {
      try {
        return await this.resolve(candidate);
      } catch (error) {
        const allowed = new Set([
          "authority_not_provisioned",
          "bridge_unavailable",
          "namespace_mismatch",
          "receipt_rejected"
        ]);
        return Object.freeze({
          status: "unavailable",
          reason: allowed.has(error && error.code)
            ? error.code
            : "authority_unavailable"
        });
      }
    }

    async validateLocatorFailClosed(candidate) {
      try {
        return await this.validateLocator(candidate);
      } catch (error) {
        const allowed = new Set([
          "authority_not_provisioned",
          "bridge_unavailable",
          "namespace_mismatch",
          "receipt_rejected"
        ]);
        return Object.freeze({
          status: "unavailable",
          reason: allowed.has(error && error.code)
            ? error.code
            : "authority_unavailable"
        });
      }
    }

    async prepareReopenFailClosed(candidate) {
      try {
        return await this.prepareReopen(candidate);
      } catch (error) {
        const allowed = new Set([
          "authority_not_provisioned",
          "bridge_unavailable",
          "namespace_mismatch",
          "receipt_rejected"
        ]);
        return Object.freeze({
          status: "unavailable",
          reason: allowed.has(error && error.code)
            ? error.code
            : "authority_unavailable"
        });
      }
    }

    async reopenStatusFailClosed(candidate) {
      try {
        return await this.reopenStatus(candidate);
      } catch (error) {
        const allowed = new Set([
          "authority_not_provisioned",
          "bridge_unavailable",
          "namespace_mismatch",
          "receipt_rejected",
          "attempt_not_found"
        ]);
        return Object.freeze({
          status: "unavailable",
          reason: allowed.has(error && error.code)
            ? error.code
            : "authority_unavailable"
        });
      }
    }

    async confirmWebReopenFailClosed(candidate) {
      try {
        return await this.confirmWebReopen(candidate);
      } catch (error) {
        const allowed = new Set([
          "authority_not_provisioned",
          "bridge_unavailable",
          "namespace_mismatch",
          "receipt_rejected",
          "attempt_not_found"
        ]);
        return Object.freeze({
          status: "unavailable",
          reason: allowed.has(error && error.code)
            ? error.code
            : "authority_unavailable"
        });
      }
    }
  }

  return {
    AuthorityClientError,
    CONVERSATION_KEY_RE,
    LOCATOR_HANDLE_RE,
    NAMESPACE_FINGERPRINT_RE,
    MAX_MESSAGE_BYTES,
    NATIVE_TIMEOUT_MS,
    NativeAuthorityClient,
    RECEIPT_PAYLOAD_KEYS,
    REOPEN_ATTEMPT_ID_RE,
    REOPEN_FAILURE_REASONS,
    REOPEN_RECEIPT_PAYLOAD_KEYS,
    REOPEN_UNAVAILABLE_REASONS,
    UNAVAILABLE_REASONS,
    canonicalLocatorValidation,
    canonicalReceiptPayload,
    canonicalReopenConfirmation,
    canonicalReopenReceiptPayload,
    canonicalReopenStatus,
    canonicalReopenTarget,
    canonicalRequest,
    decodeAuthorityResponse,
    decodeReopenResponse,
    ecdsaDerToRaw,
    isValidLocatorHandle
  };
});
