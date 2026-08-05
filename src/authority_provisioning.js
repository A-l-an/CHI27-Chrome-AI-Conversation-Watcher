(function initAuthorityProvisioning(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.AuthorityProvisioning = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function authorityProvisioningFactory(root) {
  "use strict";

  const NATIVE_HOST_NAME = "org.chi27.attention.browserbridge";
  const ALLOWED_KEYS = new Set([
    "native_host_name",
    "expected_extension_id",
    "namespace_generation",
    "namespace_fingerprint",
    "authority_public_key_x963_base64"
  ]);
  const EXTENSION_ID_RE = /^[a-p]{32}$/;
  const FINGERPRINT_RE = /^[A-Za-z0-9._:-]{16,255}$/;
  const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  // Deployment must replace these empty values from the signed release
  // envelope. Keeping them empty is intentional: an unpacked checkout must
  // never silently become an identity authority or mint a new namespace.
  const PROVISIONING = Object.freeze({
    native_host_name: NATIVE_HOST_NAME,
    expected_extension_id: "",
    namespace_generation: 0,
    namespace_fingerprint: "",
    authority_public_key_x963_base64: ""
  });

  function decodeCanonicalBase64(value) {
    if (
      typeof value !== "string" ||
      !value ||
      value.length % 4 !== 0 ||
      !BASE64_RE.test(value)
    ) {
      return null;
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
        return null;
      }
      return encoded === value ? bytes : null;
    } catch (_error) {
      return null;
    }
  }

  function validP256X963PublicKey(value) {
    const bytes = decodeCanonicalBase64(value);
    return Boolean(bytes && bytes.length === 65 && bytes[0] === 0x04);
  }

  function validateProvisioning(candidate, runtimeExtensionId) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => !ALLOWED_KEYS.has(key)) ||
      candidate.native_host_name !== NATIVE_HOST_NAME ||
      !EXTENSION_ID_RE.test(candidate.expected_extension_id || "") ||
      runtimeExtensionId !== candidate.expected_extension_id ||
      !Number.isInteger(candidate.namespace_generation) ||
      candidate.namespace_generation <= 0 ||
      !FINGERPRINT_RE.test(candidate.namespace_fingerprint || "") ||
      !validP256X963PublicKey(candidate.authority_public_key_x963_base64)
    ) {
      return Object.freeze({
        valid: false,
        reason: "authority_not_provisioned"
      });
    }
    return Object.freeze({
      valid: true,
      value: Object.freeze({
        native_host_name: NATIVE_HOST_NAME,
        expected_extension_id: candidate.expected_extension_id,
        namespace_generation: candidate.namespace_generation,
        namespace_fingerprint: candidate.namespace_fingerprint,
        authority_public_key_x963_base64:
          candidate.authority_public_key_x963_base64
      })
    });
  }

  return {
    EXTENSION_ID_RE,
    FINGERPRINT_RE,
    NATIVE_HOST_NAME,
    PROVISIONING,
    validP256X963PublicKey,
    validateProvisioning
  };
});
