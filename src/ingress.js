(function initIngress(root, factory) {
  const core = typeof module === "object" && module.exports
    ? require("./core.js")
    : root.AIConversation.Core;
  const authorityClient = typeof module === "object" && module.exports
    ? require("./authority_client.js")
    : root.AIConversation.AuthorityClient;
  const api = factory(core, authorityClient);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.Ingress = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function ingressFactory(
  Core,
  AuthorityClient
) {
  "use strict";

  const CONTENT_EVENT_TYPES = new Set(
    Array.from(Core.EVENT_TYPES).filter(
      (eventType) => (
        eventType !== "watcher_heartbeat" &&
        !eventType.startsWith("tracker_notification_")
      )
    )
  );
  const OUTER_KEYS = new Set(["timestamp", "duration", "data"]);
  const DATA_KEYS = new Set([
    "schema_version",
    "source_event_id",
    "occurred_at",
    "observed_at",
    "provider",
    "surface",
    "event_type",
    "turn_link_id",
    "conversation_key",
    "identity_status",
    "namespace_generation",
    "namespace_fingerprint",
    "confidence",
    "source_adapter",
    "adapter_version",
    "privacy_tier",
    "previous_conversation_key",
    "metadata"
  ]);
  const PROVIDER_HOSTS = Object.freeze({
    chatgpt: new Set(["chatgpt.com", "www.chatgpt.com"]),
    claude: new Set(["claude.ai", "www.claude.ai"])
  });
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const EXACT_KEY_RE = /^[0-9a-f]{64}$/;
  const LOCATOR_HANDLE_RE = AuthorityClient.LOCATOR_HANDLE_RE;
  const NAMESPACE_FINGERPRINT_RE = /^[A-Za-z0-9._:-]{16,255}$/;
  const SOURCE_ID_RE = UUID_V4_RE;
  const CONTENT_METADATA_VALUES = Object.freeze({
    adapter_health: new Set(["starting", "unhealthy"]),
    completion_signal: new Set([
      "assistant_response_structure_quiet",
      "response_active_marker_disappeared_after_settle",
      "stop_control_disappeared",
      "stop_control_disappeared_after_settle"
    ]),
    generation_state: new Set([
      "response_in_progress_at_navigation",
      "response_observation_incomplete_at_new_submission"
    ]),
    reason_code: new Set([
      "identity_bound_to_existing_conversation",
      "new_submission_before_previous_terminal",
      "navigation_while_response_in_progress",
      "provider_error_control",
      "provider_error_control_visible",
      "required_composer_missing",
      "required_composer_or_send_control_missing",
      "response_active_scope_unverified",
      "response_start_signal_timeout",
      "route_identity_resolution_failed",
      "unknown"
    ]),
    route_pattern: new Set(["/c/<id>", "/chat/<id>"]),
    signal: new Set([
      "click",
      "click_scroll_or_input",
      "assistant_response_container_added",
      "assistant_response_structure_quiet",
      "composer_empty_to_nonempty",
      "composer_enter",
      "composer_form_submitted",
      "composer_input",
      "conversation_switch",
      "document_visibility",
      "document_visible",
      "input_started",
      "pointer_or_keyboard",
      "prompt_submitted",
      "response_active_marker_appeared",
      "response_active_marker_disappeared_after_settle",
      "scroll",
      "send_control_clicked",
      "spa_identity_binding",
      "spa_route_change",
      "stop_control_appeared",
      "stop_control_clicked",
      "stop_control_disappeared",
      "stop_control_disappeared_after_settle",
      "submit_control",
      "window_focus"
    ]),
    state_transition: new Set([
      "background_to_foreground",
      "background_to_returned",
      "draft_to_submitted",
      "empty_to_nonempty",
      "foreground_to_background",
      "initial_foreground",
      "provisional_to_exact",
      "responding_to_cancelled",
      "responding_to_completed",
      "responding_to_failed",
      "returned_to_engaged",
      "returned_to_interacted",
      "submitted_to_responding"
    ]),
    visibility: new Set(["hidden", "visible"])
  });

  function reject(message) {
    throw new Error(`rejected_content_event:${message}`);
  }

  function hasOnlyKeys(object, allowed) {
    return (
      object &&
      typeof object === "object" &&
      !Array.isArray(object) &&
      Object.keys(object).every((key) => allowed.has(key))
    );
  }

  function parseProviderUrl(rawUrl, expectedProvider) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_error) {
      reject("invalid_url");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !PROVIDER_HOSTS[expectedProvider] ||
      !PROVIDER_HOSTS[expectedProvider].has(parsed.hostname.toLowerCase())
    ) {
      reject("provider_url_mismatch");
    }
    return parsed;
  }

  function providerFromSender(sender, expectedExtensionId) {
    if (
      !sender ||
      sender.id !== expectedExtensionId ||
      !sender.tab ||
      !Number.isInteger(sender.tab.id) ||
      sender.frameId !== 0
    ) {
      reject("sender_not_allowed_provider_tab");
    }
    const senderUrl = sender.url || sender.tab.url;
    let parsed;
    try {
      parsed = new URL(senderUrl);
    } catch (_error) {
      reject("sender_url_invalid");
    }
    if (parsed.protocol !== "https:") {
      reject("sender_scheme_invalid");
    }
    for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) {
      if (hosts.has(parsed.hostname.toLowerCase())) {
        return provider;
      }
    }
    reject("sender_host_not_allowed");
  }

  function validateNamespace(data, required) {
    const generationPresent = Object.hasOwn(data, "namespace_generation");
    const fingerprintPresent = Object.hasOwn(data, "namespace_fingerprint");
    if (generationPresent !== fingerprintPresent) {
      reject("namespace_pair_invalid");
    }
    if (
      required && !generationPresent ||
      generationPresent && (
        !Number.isInteger(data.namespace_generation) ||
        data.namespace_generation <= 0 ||
        !NAMESPACE_FINGERPRINT_RE.test(data.namespace_fingerprint || "")
      )
    ) {
      reject("namespace_invalid");
    }
  }

  function validateConversationIdentity(data) {
    if (!["exact", "provisional", "unknown"].includes(data.identity_status)) {
      reject("identity_status_invalid");
    }
    if (data.identity_status === "exact") {
      if (!EXACT_KEY_RE.test(data.conversation_key || "")) {
        reject("exact_key_invalid");
      }
      validateNamespace(data, true);
    } else if (data.identity_status === "provisional") {
      if (!UUID_RE.test(data.conversation_key || "")) {
        reject("provisional_identity_invalid");
      }
      validateNamespace(data, false);
    } else if (
      typeof data.conversation_key !== "string" ||
      data.conversation_key.length < 8
    ) {
      reject("unknown_identity_invalid");
    } else {
      validateNamespace(data, false);
    }
    if (
      data.previous_conversation_key &&
      !UUID_RE.test(data.previous_conversation_key) &&
      !EXACT_KEY_RE.test(data.previous_conversation_key)
    ) {
      reject("previous_conversation_key_invalid");
    }
  }

  function validateMetadata(metadata) {
    if (!hasOnlyKeys(metadata, new Set([
      ...Object.keys(CONTENT_METADATA_VALUES),
      "observation_gap"
    ]))) {
      reject("metadata_unknown_key");
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "observation_gap") {
        if (value !== true) {
          reject("metadata_value_invalid");
        }
      } else if (!CONTENT_METADATA_VALUES[key].has(value)) {
        reject("metadata_value_invalid");
      }
    }
  }

  function rebuildContentEvent(candidate, sender, expectedExtensionId) {
    if (!hasOnlyKeys(candidate, OUTER_KEYS) || candidate.duration !== 0) {
      reject("outer_shape_invalid");
    }
    const data = candidate.data;
    if (!hasOnlyKeys(data, DATA_KEYS)) {
      reject("data_unknown_key");
    }
    const provider = providerFromSender(sender, expectedExtensionId);
    if (
      data.schema_version !== Core.SCHEMA_VERSION ||
      data.provider !== provider ||
      data.surface !== "chrome" ||
      !CONTENT_EVENT_TYPES.has(data.event_type) ||
      !SOURCE_ID_RE.test(data.source_event_id || "") ||
      !["exact", "derived", "heuristic"].includes(data.confidence) ||
      data.source_adapter !== `${provider}-dom-v1` ||
      data.adapter_version !== Core.ADAPTER_VERSION ||
      data.privacy_tier !== Core.PRIVACY_TIER ||
      !Number.isFinite(Date.parse(data.occurred_at)) ||
      !Number.isFinite(Date.parse(data.observed_at)) ||
      candidate.timestamp !== data.occurred_at
    ) {
      reject("contract_value_invalid");
    }
    validateConversationIdentity(data);
    const turnLinkPresent = Object.hasOwn(data, "turn_link_id");
    if (
      turnLinkPresent !== Core.TURN_LINK_EVENT_TYPES.has(data.event_type) ||
      turnLinkPresent && !SOURCE_ID_RE.test(data.turn_link_id || "")
    ) {
      reject("turn_link_id_invalid");
    }
    validateMetadata(data.metadata);
    if (!Core.validMetadataForEvent(data.event_type, data.metadata, true)) {
      reject("metadata_value_invalid");
    }
    if (
      provider === "claude" &&
      data.event_type === "assistant_response_completed" &&
      data.metadata.completion_signal === "assistant_response_structure_quiet"
    ) {
      reject("metadata_value_invalid");
    }
    return Core.buildActivityWatchEvent({
      provider,
      event_type: data.event_type,
      turn_link_id: data.turn_link_id,
      source_event_id: data.source_event_id,
      occurred_at: data.occurred_at,
      observed_at: data.observed_at,
      conversation: {
        conversation_key: data.conversation_key,
        identity_status: data.identity_status,
        namespace_generation: data.namespace_generation,
        namespace_fingerprint: data.namespace_fingerprint
      },
      confidence: data.confidence,
      source_adapter: `${provider}-dom-v1`,
      previous_conversation_key: data.previous_conversation_key,
      metadata: data.metadata
    });
  }

  function validateNotificationRequest(message, sender, expectedExtensionId) {
    const allowedMessageKeys = new Set([
      "type",
      "provider",
      "context",
      "reason_code",
      "notification_preview"
    ]);
    const allowedContextKeys = new Set(["identity"]);
    const allowedIdentityKeys = new Set([
      "conversation_key",
      "identity_status",
      "locator_handle",
      "namespace_generation",
      "namespace_fingerprint"
    ]);
    if (
      !hasOnlyKeys(message, allowedMessageKeys) ||
      !hasOnlyKeys(message.context, allowedContextKeys) ||
      !hasOnlyKeys(message.context.identity, allowedIdentityKeys)
    ) {
      reject("notification_unknown_key");
    }
    const provider = providerFromSender(sender, expectedExtensionId);
    if (
      message.provider !== provider ||
      ![
        "response_completed_while_hidden",
        "response_completed_while_foreground"
      ].includes(message.reason_code)
    ) {
      reject("notification_value_invalid");
    }
    const previewPresent = Object.hasOwn(message, "notification_preview");
    const notificationPreview = previewPresent
      ? Core.sanitizeEphemeralNotificationPreview(message.notification_preview)
      : "";
    if (
      previewPresent &&
      (
        !notificationPreview ||
        notificationPreview !== message.notification_preview
      )
    ) {
      reject("notification_preview_invalid");
    }
    const data = message.context.identity;
    validateConversationIdentity(data);
    if (
      data.identity_status === "exact" &&
      !AuthorityClient.isValidLocatorHandle(data.locator_handle)
    ) {
      reject("notification_identity_not_exact");
    }
    const result = {
      provider,
      context: {
        identity: {
          conversation_key: data.conversation_key,
          identity_status: data.identity_status,
          locator_handle: data.locator_handle,
          namespace_generation: data.namespace_generation,
          namespace_fingerprint: data.namespace_fingerprint
        }
      },
      reason_code: message.reason_code
    };
    if (notificationPreview) {
      result.notification_preview = notificationPreview;
    }
    return result;
  }

  function validateAuthorityRequest(message, sender, expectedExtensionId) {
    const allowedKeys = new Set([
      "type",
      "provider",
      "provider_conversation_id"
    ]);
    let serialized;
    try {
      serialized = JSON.stringify(message);
    } catch (_error) {
      reject("authority_message_invalid");
    }
    if (
      !hasOnlyKeys(message, allowedKeys) ||
      Object.keys(message).length !== allowedKeys.size ||
      new TextEncoder().encode(serialized).length > 16 * 1024 ||
      message.type !== "RESOLVE_CONVERSATION"
    ) {
      reject("authority_message_invalid");
    }
    const provider = providerFromSender(sender, expectedExtensionId);
    if (
      message.provider !== provider ||
      typeof message.provider_conversation_id !== "string"
    ) {
      reject("authority_value_invalid");
    }
    const route = provider === "chatgpt"
      ? /^\/c\/([A-Za-z0-9_-]{8,128})\/?$/
      : /^\/chat\/([0-9a-fA-F-]{36})\/?$/;
    const providerId = provider === "claude"
      ? message.provider_conversation_id.toLowerCase()
      : message.provider_conversation_id;
    let senderParsed;
    let tabParsed;
    try {
      senderParsed = parseProviderUrl(sender.url, provider);
      tabParsed = parseProviderUrl(sender.tab.url, provider);
    } catch (_error) {
      reject("authority_route_mismatch");
    }
    const senderMatch = senderParsed.pathname.match(route);
    const tabMatch = tabParsed.pathname.match(route);
    const tabProviderId = tabMatch ? tabMatch[1].toLowerCase() : null;
    const requestedProviderId = providerId.toLowerCase();
    const senderIsExplicitRoot = senderParsed.pathname === "/";
    // MessageSender.url is the document URL captured when the content script
    // loaded. It can remain on conversation A after a same-origin SPA switch
    // makes sender.tab.url conversation B. The live tab route is authoritative:
    // it must exactly match the requested provider ID. The stale document URL
    // is accepted only when it is still a canonical route or the explicit root
    // for the same allowlisted provider.
    const senderAttestationCompatible = Boolean(senderMatch) ||
      senderIsExplicitRoot;
    if (
      !tabMatch ||
      tabProviderId !== requestedProviderId ||
      !senderAttestationCompatible ||
      provider === "claude" &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(providerId)
    ) {
      reject("authority_route_mismatch");
    }
    return {
      provider,
      provider_conversation_id: providerId
    };
  }

  return {
    CONTENT_EVENT_TYPES,
    LOCATOR_HANDLE_RE,
    NAMESPACE_FINGERPRINT_RE,
    providerFromSender,
    rebuildContentEvent,
    validateAuthorityRequest,
    validateNotificationRequest
  };
});
