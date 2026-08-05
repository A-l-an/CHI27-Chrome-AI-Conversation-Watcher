(function initCore(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.Core = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function coreFactory(root) {
  "use strict";

  const SCHEMA_VERSION = "1.0";
  const ADAPTER_VERSION = "0.1.0";
  const SURFACE = "chrome";
  const PRIVACY_TIER = "content_free_local";
  const MAX_NOTIFICATION_PREVIEW_CHARS = 150;
  const EVENT_DATA_KEYS = new Set([
    "schema_version",
    "source_event_id",
    "occurred_at",
    "observed_at",
    "provider",
    "surface",
    "event_type",
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
  const EVENT_TYPES = new Set([
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
  const SAFE_METADATA_KEYS = new Set([
    "adapter_health",
    "action",
    "completion_signal",
    "error_code",
    "focus_succeeded",
    "observation_gap",
    "phase",
    "reason_code",
    "route_pattern",
    "signal",
    "state_transition",
    "timeout_seconds",
    "generation_state",
    "visibility"
  ]);
  const NOTIFICATION_SUPPRESSION_REASON_CODES = new Set([
    "notifications_disabled",
    "study_session_inactive",
    "response_session_not_authorized",
    "response_completed_while_foreground"
  ]);
  const SOURCE_EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const EXACT_CONVERSATION_KEY_RE = /^[0-9a-f]{64}$/;
  const NAMESPACE_FINGERPRINT_RE = /^[A-Za-z0-9._:-]{16,255}$/;
  const METADATA_CONTRACTS = Object.freeze({
    watcher_started: Object.freeze({
      adapter_health: new Set(["starting"])
    }),
    watcher_heartbeat: Object.freeze({
      adapter_health: new Set(["healthy"]),
      signal: new Set(["worker_initialized", "sixty_second_alarm"])
    }),
    conversation_foregrounded: Object.freeze({
      visibility: new Set(["visible"]),
      state_transition: new Set([
        "initial_foreground",
        "background_to_foreground"
      ])
    }),
    conversation_backgrounded: Object.freeze({
      visibility: new Set(["hidden"]),
      state_transition: new Set(["foreground_to_background"])
    }),
    conversation_bound: Object.freeze({
      route_pattern: new Set(["/c/<id>", "/chat/<id>"]),
      state_transition: new Set(["provisional_to_exact"])
    }),
    input_started: Object.freeze({
      signal: new Set(["composer_empty_to_nonempty"]),
      state_transition: new Set(["empty_to_nonempty"])
    }),
    prompt_submitted: Object.freeze({
      signal: new Set([
        "composer_enter",
        "composer_form_submitted",
        "send_control_clicked",
        "submit_control"
      ]),
      state_transition: new Set(["draft_to_submitted"])
    }),
    assistant_response_started: Object.freeze({
      signal: new Set([
        "assistant_response_container_added",
        "response_active_marker_appeared",
        "stop_control_appeared"
      ]),
      state_transition: new Set(["submitted_to_responding"])
    }),
    assistant_response_completed: Object.freeze({
      completion_signal: new Set([
        "assistant_response_structure_quiet",
        "response_active_marker_disappeared_after_settle",
        "stop_control_disappeared",
        "stop_control_disappeared_after_settle"
      ]),
      state_transition: new Set(["responding_to_completed"])
    }),
    assistant_response_failed: Object.freeze({
      reason_code: new Set([
        "provider_error_control",
        "provider_error_control_visible"
      ]),
      state_transition: new Set(["responding_to_failed"])
    }),
    assistant_response_cancelled: Object.freeze({
      signal: new Set(["stop_control_clicked"]),
      state_transition: new Set(["responding_to_cancelled"])
    }),
    tracker_notification_suppressed: Object.freeze({
      phase: new Set(["gate"]),
      reason_code: NOTIFICATION_SUPPRESSION_REASON_CODES
    }),
    tracker_notification_attempted: Object.freeze({
      phase: new Set(["create"]),
      reason_code: new Set(["response_completed_while_hidden"])
    }),
    tracker_notification_created: Object.freeze({
      phase: new Set(["create"]),
      reason_code: new Set(["response_completed_while_hidden"])
    }),
    tracker_notification_failed: Object.freeze({
      phase: new Set(["validate_context", "permission", "store_target", "create"]),
      error_code: new Set([
        "identity_not_exact",
        "notification_create_failed",
        "notification_icon_load_failed",
        "notification_permission_check_failed",
        "notification_permission_denied",
        "notification_target_storage_failed"
      ])
    }),
    tracker_notification_clicked: Object.freeze({
      phase: new Set(["focus"]),
      action: new Set([
        "activated_existing_tab",
        "reopened_via_native_actuator",
        "focus_failed"
      ]),
      focus_succeeded: "boolean"
    }),
    tracker_notification_auto_cleared: Object.freeze({
      phase: new Set(["clear"]),
      reason_code: new Set(["notification_timeout"]),
      timeout_seconds: new Set([20])
    }),
    tracker_notification_shown: Object.freeze({
      phase: new Set(["create"]),
      reason_code: new Set(["response_completed_while_hidden"])
    }),
    user_interacted: Object.freeze({
      signal: new Set([
        "click",
        "click_scroll_or_input",
        "composer_input",
        "pointer_or_keyboard",
        "scroll"
      ]),
      state_transition: new Set(["returned_to_interacted"])
    }),
    user_returned: Object.freeze({
      signal: new Set([
        "conversation_switch",
        "document_visible",
        "document_visibility",
        "identity_bound_to_existing_conversation",
        "spa_route_change",
        "window_focus"
      ]),
      state_transition: new Set(["background_to_returned"])
    }),
    user_engaged: Object.freeze({
      signal: new Set(["input_started", "prompt_submitted"]),
      state_transition: new Set(["returned_to_engaged"])
    }),
    adapter_unhealthy: Object.freeze({
      adapter_health: new Set(["unhealthy"]),
      generation_state: new Set(["response_in_progress_at_navigation"]),
      observation_gap: new Set([true]),
      reason_code: new Set([
        "identity_bound_to_existing_conversation",
        "navigation_while_response_in_progress",
        "required_composer_missing",
        "required_composer_or_send_control_missing",
        "response_start_signal_timeout",
        "route_identity_resolution_failed",
        "unknown"
      ])
    })
  });

  function randomUuid() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return root.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (root.crypto && typeof root.crypto.getRandomValues === "function") {
      root.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function sanitizeEphemeralNotificationPreview(value) {
    if (typeof value !== "string") {
      return "";
    }
    const collapsed = value
      .replace(
        /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu,
        " "
      )
      .replace(/\s+/gu, " ")
      .trim();
    if (!collapsed) {
      return "";
    }
    const characters = Array.from(collapsed);
    if (characters.length <= MAX_NOTIFICATION_PREVIEW_CHARS) {
      return collapsed;
    }
    return `${characters
      .slice(0, MAX_NOTIFICATION_PREVIEW_CHARS - 1)
      .join("")}…`;
  }

  function buildTrackerNotificationRequest(options) {
    const config = options || {};
    const identity = config.identity || {};
    const projectedIdentity = {};
    for (const key of [
      "conversation_key",
      "identity_status",
      "locator_handle",
      "namespace_generation",
      "namespace_fingerprint"
    ]) {
      if (Object.hasOwn(identity, key)) {
        projectedIdentity[key] = identity[key];
      }
    }
    const request = {
      type: "SHOW_TRACKER_NOTIFICATION",
      provider: config.provider,
      context: { identity: projectedIdentity },
      reason_code: config.reason_code
    };
    const notificationPreview = sanitizeEphemeralNotificationPreview(
      config.notification_preview
    );
    if (notificationPreview) {
      request.notification_preview = notificationPreview;
    }
    return request;
  }

  function metadataValueAllowed(rule, value) {
    return rule === "boolean"
      ? typeof value === "boolean"
      : rule instanceof Set && rule.has(value);
  }

  function cleanMetadata(eventType, metadata) {
    const result = {};
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return result;
    }
    const contract = METADATA_CONTRACTS[eventType];
    if (!contract) {
      return result;
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (
        !Object.hasOwn(contract, key) ||
        !metadataValueAllowed(contract[key], value)
      ) {
        continue;
      }
      result[key] = value;
    }
    return result;
  }

  function validMetadataForEvent(eventType, metadata, requireComplete) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return false;
    }
    const contract = METADATA_CONTRACTS[eventType];
    if (!contract) {
      return false;
    }
    const keys = Object.keys(metadata);
    if (
      keys.some(
        (key) => !Object.hasOwn(contract, key) ||
          !metadataValueAllowed(contract[key], metadata[key])
      )
    ) {
      return false;
    }
    if (!requireComplete) {
      return true;
    }
    if (eventType === "adapter_unhealthy") {
      const ordinary = ["adapter_health", "reason_code"];
      const observationGap = [
        "adapter_health",
        "generation_state",
        "observation_gap",
        "reason_code"
      ];
      const sorted = keys.slice().sort();
      return (
        JSON.stringify(sorted) === JSON.stringify(ordinary.slice().sort()) ||
        JSON.stringify(sorted) === JSON.stringify(observationGap.slice().sort())
      );
    }
    return (
      keys.length === Object.keys(contract).length &&
      Object.keys(contract).every((key) => Object.hasOwn(metadata, key))
    );
  }

  function validNamespacePair(data, required) {
    const generationPresent = Object.hasOwn(data, "namespace_generation");
    const fingerprintPresent = Object.hasOwn(data, "namespace_fingerprint");
    if (generationPresent !== fingerprintPresent || required && !generationPresent) {
      return false;
    }
    return !generationPresent || (
      Number.isInteger(data.namespace_generation) &&
      data.namespace_generation > 0 &&
      NAMESPACE_FINGERPRINT_RE.test(data.namespace_fingerprint || "")
    );
  }

  function validClosedEventData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return false;
    }
    const heartbeat = data.event_type === "watcher_heartbeat";
    const notification = data.event_type.startsWith("tracker_notification_");
    if (
      (heartbeat ? data.provider !== "watcher" : !["chatgpt", "claude"].includes(data.provider)) ||
      data.adapter_version !== ADAPTER_VERSION ||
      (
        heartbeat
          ? data.source_adapter !== "chrome-background-heartbeat-v1"
          : notification
            ? data.source_adapter !== "chrome-background-notification-v2"
            : data.source_adapter !== `${data.provider}-dom-v1`
      )
    ) {
      return false;
    }
    if (data.identity_status === "exact") {
      if (
        !EXACT_CONVERSATION_KEY_RE.test(data.conversation_key || "") ||
        !validNamespacePair(data, true)
      ) {
        return false;
      }
    } else if (data.identity_status === "provisional") {
      if (
        !UUID_RE.test(data.conversation_key || "") ||
        !validNamespacePair(data, false)
      ) {
        return false;
      }
    } else if (
      data.identity_status !== "unknown" ||
      !heartbeat ||
      data.conversation_key !== "" ||
      !validNamespacePair(data, false)
    ) {
      return false;
    }
    if (Object.hasOwn(data, "previous_conversation_key")) {
      if (
        data.event_type !== "conversation_bound" ||
        !UUID_RE.test(data.previous_conversation_key || "") &&
          !EXACT_CONVERSATION_KEY_RE.test(data.previous_conversation_key || "")
      ) {
        return false;
      }
    }
    return true;
  }

  function buildActivityWatchEvent(input) {
    if (!input || !EVENT_TYPES.has(input.event_type)) {
      throw new Error(`Unsupported event_type: ${input && input.event_type}`);
    }
    const sourceLevelWithoutConversation = input.event_type === "watcher_heartbeat";
    if (
      !input.provider ||
      !input.conversation ||
      (!input.conversation.conversation_key && !sourceLevelWithoutConversation)
    ) {
      throw new Error("provider and conversation identity are required");
    }
    const occurredAt = input.occurred_at || isoNow();
    const observedAt = input.observed_at || isoNow();
    let metadata = cleanMetadata(input.event_type, input.metadata);
    if (input.event_type === "tracker_notification_suppressed") {
      const rawMetadata = input.metadata;
      const rawKeys = (
        rawMetadata &&
        typeof rawMetadata === "object" &&
        !Array.isArray(rawMetadata)
      ) ? Object.keys(rawMetadata).sort() : [];
      if (
        rawKeys.length !== 2 ||
        rawKeys[0] !== "phase" ||
        rawKeys[1] !== "reason_code" ||
        metadata.phase !== "gate" ||
        !NOTIFICATION_SUPPRESSION_REASON_CODES.has(metadata.reason_code)
      ) {
        throw new Error("Invalid tracker_notification_suppressed metadata");
      }
      metadata = {
        phase: "gate",
        reason_code: metadata.reason_code
      };
    }
    const data = {
      schema_version: SCHEMA_VERSION,
      source_event_id: input.source_event_id || randomUuid(),
      occurred_at: occurredAt,
      observed_at: observedAt,
      provider: input.provider,
      surface: SURFACE,
      event_type: input.event_type,
      conversation_key: input.conversation.conversation_key || "",
      identity_status: input.conversation.identity_status || "unknown",
      confidence: input.confidence || "heuristic",
      source_adapter: input.source_adapter,
      adapter_version: input.adapter_version || ADAPTER_VERSION,
      privacy_tier: PRIVACY_TIER,
      metadata
    };
    if (
      Number.isInteger(input.conversation.namespace_generation) &&
      input.conversation.namespace_generation > 0 &&
      typeof input.conversation.namespace_fingerprint === "string" &&
      input.conversation.namespace_fingerprint
    ) {
      data.namespace_generation = input.conversation.namespace_generation;
      data.namespace_fingerprint = input.conversation.namespace_fingerprint;
    }
    if (input.previous_conversation_key) {
      data.previous_conversation_key = input.previous_conversation_key;
    }
    return {
      timestamp: occurredAt,
      duration: 0,
      data
    };
  }

  function validateActivityWatchEvent(event) {
    if (!event || event.duration !== 0 || !event.data) {
      return false;
    }
    const data = event.data;
    return (
      Object.keys(event).length === 3 &&
      Object.keys(event).every((key) => ["timestamp", "duration", "data"].includes(key)) &&
      Object.keys(data).every((key) => EVENT_DATA_KEYS.has(key)) &&
      data.schema_version === SCHEMA_VERSION &&
      SOURCE_EVENT_ID_RE.test(data.source_event_id || "") &&
      typeof data.occurred_at === "string" &&
      typeof data.observed_at === "string" &&
      typeof data.provider === "string" &&
      data.surface === SURFACE &&
      EVENT_TYPES.has(data.event_type) &&
      typeof data.conversation_key === "string" &&
      (data.conversation_key.length > 0 || data.event_type === "watcher_heartbeat") &&
      ["exact", "provisional", "unknown"].includes(data.identity_status) &&
      ["exact", "derived", "heuristic"].includes(data.confidence) &&
      typeof data.source_adapter === "string" &&
      data.privacy_tier === PRIVACY_TIER &&
      validClosedEventData(data) &&
      validMetadataForEvent(data.event_type, data.metadata, false) &&
      !Object.hasOwn(data, "provider_conversation_id") &&
      !Object.hasOwn(data, "full_url") &&
      !Object.hasOwn(data, "locator_handle") &&
      !Object.hasOwn(data, "receipt")
    );
  }

  function sanitizePersistedActivityWatchEvent(candidate) {
    if (
      !candidate ||
      candidate.duration !== 0 ||
      !candidate.data ||
      candidate.timestamp !== candidate.data.occurred_at
    ) {
      return null;
    }
    const data = candidate.data;
    if (
      data.schema_version !== SCHEMA_VERSION ||
      !EVENT_TYPES.has(data.event_type) ||
      !SOURCE_EVENT_ID_RE.test(data.source_event_id || "") ||
      typeof data.provider !== "string" ||
      typeof data.conversation_key !== "string" ||
      !["exact", "provisional", "unknown"].includes(data.identity_status) ||
      !["exact", "derived", "heuristic"].includes(data.confidence) ||
      typeof data.source_adapter !== "string" ||
      !data.source_adapter ||
      !Number.isFinite(Date.parse(data.occurred_at)) ||
      !Number.isFinite(Date.parse(data.observed_at))
    ) {
      return null;
    }
    if (!validClosedEventData(data)) {
      return null;
    }
    if (!validMetadataForEvent(data.event_type, data.metadata, true)) {
      return null;
    }
    try {
      const rebuilt = buildActivityWatchEvent({
        provider: data.provider,
        event_type: data.event_type,
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
        source_adapter: data.source_adapter,
        adapter_version: data.adapter_version || ADAPTER_VERSION,
        previous_conversation_key: data.previous_conversation_key,
        metadata: data.metadata
      });
      return validateActivityWatchEvent(rebuilt) ? rebuilt : null;
    } catch (_error) {
      return null;
    }
  }

  return {
    ADAPTER_VERSION,
    EVENT_DATA_KEYS,
    EVENT_TYPES,
    MAX_NOTIFICATION_PREVIEW_CHARS,
    NOTIFICATION_SUPPRESSION_REASON_CODES,
    PRIVACY_TIER,
    SAFE_METADATA_KEYS,
    SCHEMA_VERSION,
    SOURCE_EVENT_ID_RE,
    buildActivityWatchEvent,
    buildTrackerNotificationRequest,
    cleanMetadata,
    isoNow,
    randomUuid,
    sanitizeEphemeralNotificationPreview,
    sanitizePersistedActivityWatchEvent,
    validClosedEventData,
    validMetadataForEvent,
    validateActivityWatchEvent
  };
});
