(function initLocalWebAuthority(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.LocalWebAuthority = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function localWebAuthorityFactory(root) {
  "use strict";

  const STORAGE_KEY = "browser_local_identity_authority_v1";
  const SCHEMA_VERSION = "1.0";
  const NAMESPACE_GENERATION = 1;
  const NAMESPACE_PREFIX = "browser-local-v1.";
  const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
  const NAMESPACE_RE = /^browser-local-v1\.[A-Za-z0-9_-]{22}$/;
  const PROVIDER_IDS = Object.freeze({
    chatgpt: /^[A-Za-z0-9_-]{8,128}$/,
    claude: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  });

  function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return root.btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function decodeBase64Url(value) {
    if (!SECRET_RE.test(value || "")) {
      return null;
    }
    try {
      const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
      const binary = root.atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return bytes.length === 32 ? bytes : null;
    } catch (_error) {
      return null;
    }
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    return bytes;
  }

  function canonicalProviderId(provider, value) {
    if (!Object.hasOwn(PROVIDER_IDS, provider) || typeof value !== "string") {
      return null;
    }
    const candidate = provider === "claude" ? value.toLowerCase() : value;
    return PROVIDER_IDS[provider].test(candidate) ? candidate : null;
  }

  function sanitizeState(candidate) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== 3 ||
      candidate.schema_version !== SCHEMA_VERSION ||
      !SECRET_RE.test(candidate.secret_base64url || "") ||
      !decodeBase64Url(candidate.secret_base64url) ||
      !NAMESPACE_RE.test(candidate.namespace_fingerprint || "")
    ) {
      return null;
    }
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      secret_base64url: candidate.secret_base64url,
      namespace_fingerprint: candidate.namespace_fingerprint
    });
  }

  function createState() {
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      secret_base64url: base64Url(randomBytes(32)),
      namespace_fingerprint: `${NAMESPACE_PREFIX}${base64Url(randomBytes(16))}`
    });
  }

  async function hmac(secretBytes, label, provider, providerId) {
    const key = await root.crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const payload = new TextEncoder().encode(
      `chi27-browser-local-v1\u0000${label}\u0000${provider}\u0000${providerId}`
    );
    return new Uint8Array(await root.crypto.subtle.sign("HMAC", key, payload));
  }

  function hex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  class BrowserLocalWebAuthority {
    constructor(options) {
      const config = options || {};
      if (
        typeof config.storageGet !== "function" ||
        typeof config.storageSet !== "function"
      ) {
        throw new Error("browser_local_authority_storage_required");
      }
      this.storageGet = config.storageGet;
      this.storageSet = config.storageSet;
      this.statePromise = null;
    }

    async state() {
      if (!this.statePromise) {
        this.statePromise = (async () => {
          const stored = await this.storageGet(STORAGE_KEY);
          if (Object.hasOwn(stored, STORAGE_KEY)) {
            const existing = sanitizeState(stored[STORAGE_KEY]);
            if (!existing) {
              throw new Error("browser_local_authority_state_invalid");
            }
            return existing;
          }
          const created = createState();
          await this.storageSet({ [STORAGE_KEY]: created });
          return created;
        })();
        this.statePromise.catch(() => {
          this.statePromise = null;
        });
      }
      return this.statePromise;
    }

    async context() {
      try {
        const state = await this.state();
        return Object.freeze({
          status: "ready",
          authority_mode: "browser_local",
          namespace_generation: NAMESPACE_GENERATION,
          namespace_fingerprint: state.namespace_fingerprint
        });
      } catch (_error) {
        return Object.freeze({
          status: "unavailable",
          reason: "authority_unavailable"
        });
      }
    }

    async resolve(request) {
      const provider = request && request.provider;
      const providerId = canonicalProviderId(
        provider,
        request && request.provider_conversation_id
      );
      if (!providerId) {
        return Object.freeze({
          status: "unavailable",
          reason: "authority_unavailable"
        });
      }
      try {
        const state = await this.state();
        const secret = decodeBase64Url(state.secret_base64url);
        const conversationDigest = await hmac(
          secret,
          "conversation-key",
          provider,
          providerId
        );
        const locatorDigest = await hmac(
          secret,
          "locator-handle",
          provider,
          providerId
        );
        return Object.freeze({
          status: "issued",
          authority_mode: "browser_local",
          conversation_key: hex(conversationDigest),
          locator_handle: `loc_${base64Url(locatorDigest.slice(0, 16))}`,
          namespace_generation: NAMESPACE_GENERATION,
          namespace_fingerprint: state.namespace_fingerprint
        });
      } catch (_error) {
        return Object.freeze({
          status: "unavailable",
          reason: "authority_unavailable"
        });
      }
    }
  }

  function isBrowserLocalNamespace(value) {
    return NAMESPACE_RE.test(value || "");
  }

  return {
    BrowserLocalWebAuthority,
    NAMESPACE_GENERATION,
    NAMESPACE_PREFIX,
    STORAGE_KEY,
    canonicalProviderId,
    isBrowserLocalNamespace,
    sanitizeState
  };
});
