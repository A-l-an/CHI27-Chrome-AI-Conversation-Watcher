importScripts(
  "src/export_authority.js",
  "src/core.js",
  "src/private_return_cues.js",
  "src/authority_provisioning.js",
  "src/authority_client.js",
  "src/local_web_authority.js",
  "src/reopen_controller.js",
  "src/reliable_queue.js",
  "src/ingress.js",
  "src/heartbeat.js",
  "src/session_controller.js"
);

const ExportAuthority = AIConversation.ExportAuthority;
const Core = AIConversation.Core;
const PrivateReturnCues = AIConversation.PrivateReturnCues;
const AuthorityProvisioning = AIConversation.AuthorityProvisioning;
const AuthorityClient = AIConversation.AuthorityClient;
const LocalWebAuthority = AIConversation.LocalWebAuthority;
const ReopenController = AIConversation.ReopenController;
const { ReliableEventQueue } = AIConversation.ReliableQueue;
const Ingress = AIConversation.Ingress;
const Heartbeat = AIConversation.Heartbeat;
const StudySession = AIConversation.StudySession;
const DEFAULT_CONFIG = Object.freeze({
  aw_base_url: "http://127.0.0.1:5600",
  bucket_id: "aw-watcher-ai-conversations",
  session_bucket_id: "aw-watcher-study-sessions",
  notifications_enabled: true
});
const QUEUE_KEY = "reliable_event_queue_v1";
const SESSION_QUEUE_KEY = "study_session_event_queue_v1";
const SESSION_STATE_KEY = "study_session_state_v1";
const RESPONSE_SESSION_STATE_KEY = "response_session_bindings_v1";
const PRIVATE_RETURN_CUES_KEY = "rta_private_return_cues_v1";
const LEGACY_PROFILE_SCOPE_KEY = "profile_scope_id";
const LEGACY_QUEUE_QUARANTINE_KEY = "legacy_reliable_event_queue_quarantine_v1";
const NOTIFICATION_TARGETS_KEY = "notification_targets_v1";
const DIAGNOSTICS_KEY = "background_diagnostics_v1";
const RETRY_ALARM = "flush-ai-conversation-events";
const HEARTBEAT_ALARM = "write-ai-conversation-heartbeat";
const STUDY_SESSION_WARNING_ALARM = "study-session-duration-warning";
const AUTO_CLEAR_SECONDS = 20;
const AUTO_CLEAR_MS = AUTO_CLEAR_SECONDS * 1000;
const RESPONSE_BINDING_TTL_MS = 24 * 60 * 60 * 1000;
const RESPONSE_AUTHORIZATION_TTL_MS = 60 * 1000;
const PRIVATE_CUE_AUTHORIZATION_TTL_MS = 5 * 1000;
const MAX_RESPONSE_SESSION_ENTRIES = 500;
const TRANSPARENT_NOTIFICATION_ICON_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAVklEQVR42u3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBvAI8AAYr5gj4AAAAASUVORK5CYII=";
const NOTIFICATION_EVENT_TYPES = new Set([
  "tracker_notification_suppressed",
  "tracker_notification_attempted",
  "tracker_notification_created",
  "tracker_notification_failed",
  "tracker_notification_clicked",
  "tracker_notification_auto_cleared"
]);
const NOTIFICATION_PHASES = new Set([
  "gate",
  "validate_context",
  "permission",
  "create",
  "store_target",
  "focus",
  "clear"
]);
const NOTIFICATION_ACTIONS = new Set([
  "activated_existing_tab",
  "reopened_via_native_actuator",
  "focus_failed"
]);
const NOTIFICATION_ERROR_CODES = new Set([
  "notification_create_failed",
  "identity_not_exact",
  "notification_icon_load_failed",
  "notification_permission_check_failed",
  "notification_permission_denied",
  "notification_target_storage_failed"
]);
const LEGACY_QUEUE_ADAPTER_VERSIONS = new Set([
  "0.2.8",
  Core.ADAPTER_VERSION
]);
const LEGACY_QUEUE_EVENT_DATA_KEYS = new Set(
  Array.from(Core.EVENT_DATA_KEYS).filter((key) => key !== "turn_link_id")
);
const LEGACY_QUEUE_VALIDATION_LINK =
  "00000000-0000-4000-8000-000000000000";
let ensuredBucketSignature = null;
let ensuredSessionBucketSignature = null;
let backgroundInitializationPromise = null;
let conversationQueueMigrationPromise = null;
let notificationTargetMutationChain = Promise.resolve();
let responseSessionMutationChain = Promise.resolve();
let privateReturnCueMutationChain = Promise.resolve();
let privateCueLifecycleChain = Promise.resolve();
const privateCueAuthorizations = new Map();
const notificationClearTimers = new Map();
const activeNotificationClaims = new Set();
const notificationFocusOperations = new Map();
const reopenCandidateObservers = new Set();
const privateCueExportAuthority = new ExportAuthority.MemoryBoundExportAuthority();
const authorityClient = new AuthorityClient.NativeAuthorityClient({
  runtime: chrome.runtime,
  runtimeExtensionId: chrome.runtime.id,
  provisioning: AuthorityProvisioning.PROVISIONING
});
const localWebAuthority = new LocalWebAuthority.BrowserLocalWebAuthority({
  storageGet,
  storageSet
});
const verifiedReopenController = new ReopenController.VerifiedReopenController({
  authorityClient,
  listTabs: queryProviderTabs,
  readContext: getOpaqueTabContext,
  providerForTab: providerForTab,
  focusTab: focusVerifiedReopenTab,
  subscribeCandidates: subscribeReopenCandidates
});

function runPrivateCueLifecycleExclusive(operation) {
  const result = privateCueLifecycleChain.then(operation, operation);
  privateCueLifecycleChain = result.catch(() => {});
  return result;
}

function prunePrivateCueAuthorizations(nowMs) {
  for (const [authorizationId, authorization] of privateCueAuthorizations) {
    if (!authorization || authorization.expires_at_ms <= nowMs) {
      privateCueAuthorizations.delete(authorizationId);
    }
  }
}

function privateCueSenderContext(sender) {
  const provider = Ingress.providerFromSender(sender, chrome.runtime.id);
  if (!sender.tab || !Number.isInteger(sender.tab.id)) {
    throw makeDiagnosticError("private_cue_authorization_rejected");
  }
  return { provider, tab_id: sender.tab.id };
}

async function authorizePrivateReturnCue(sender) {
  return runPrivateCueLifecycleExclusive(async () => {
    const senderContext = privateCueSenderContext(sender);
    const status = await studySessionController.getStatus();
    const nowMs = Date.now();
    prunePrivateCueAuthorizations(nowMs);
    if (!status.active) {
      return { authorized: false, reason: "study_session_inactive" };
    }
    const authorizationId = `pca_${crypto.randomUUID().replaceAll("-", "")}`;
    const expiresAtMs = nowMs + PRIVATE_CUE_AUTHORIZATION_TTL_MS;
    privateCueAuthorizations.set(authorizationId, {
      expires_at_ms: expiresAtMs,
      provider: senderContext.provider,
      session_id: status.session_id,
      tab_id: senderContext.tab_id
    });
    return {
      authorized: true,
      authorization_id: authorizationId,
      expires_at_utc: new Date(expiresAtMs).toISOString()
    };
  });
}

async function consumePrivateCueAuthorization(authorizationId, sender) {
  const nowMs = Date.now();
  prunePrivateCueAuthorizations(nowMs);
  const authorization = privateCueAuthorizations.get(authorizationId) || null;
  privateCueAuthorizations.delete(authorizationId);
  if (!authorization || authorization.expires_at_ms <= nowMs) {
    return null;
  }
  const senderContext = privateCueSenderContext(sender);
  const status = await studySessionController.getStatus();
  if (
    !status.active ||
    status.session_id !== authorization.session_id ||
    senderContext.provider !== authorization.provider ||
    senderContext.tab_id !== authorization.tab_id
  ) {
    return null;
  }
  return authorization.session_id;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function makeDiagnosticError(code, httpStatus) {
  const error = new Error(code);
  error.diagnosticCode = code;
  error.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
  return error;
}

function safeDiagnostic(code, retryCount, httpStatus, details) {
  const safeCode = (
    typeof code === "string" &&
    /^[a-z0-9_]{1,64}$/.test(code)
  ) ? code : "unknown_failure";
  const diagnostic = {
    timestamp: Core.isoNow(),
    code: safeCode,
    retry_count: Number.isInteger(retryCount) && retryCount >= 0 ? retryCount : 0,
    http_status: Number.isInteger(httpStatus) ? httpStatus : null
  };
  if (details && NOTIFICATION_EVENT_TYPES.has(details.event_type)) {
    diagnostic.event_type = details.event_type;
  }
  if (details && NOTIFICATION_PHASES.has(details.phase)) {
    diagnostic.phase = details.phase;
  }
  if (details && NOTIFICATION_ACTIONS.has(details.action)) {
    diagnostic.action = details.action;
  }
  if (details && typeof details.focus_succeeded === "boolean") {
    diagnostic.focus_succeeded = details.focus_succeeded;
  }
  if (
    details &&
    Number.isInteger(details.item_count) &&
    details.item_count >= 0 &&
    details.item_count <= 100000
  ) {
    diagnostic.item_count = details.item_count;
  }
  return diagnostic;
}

async function recordDiagnostic(code, retryCount, httpStatus, details) {
  const diagnostic = safeDiagnostic(code, retryCount, httpStatus, details);
  console.error("CHI27_AI_WATCHER_DIAGNOSTIC", JSON.stringify(diagnostic));
  try {
    const result = await storageGet(DIAGNOSTICS_KEY);
    const existing = Array.isArray(result[DIAGNOSTICS_KEY])
      ? result[DIAGNOSTICS_KEY]
      : [];
    await storageSet({
      [DIAGNOSTICS_KEY]: existing.concat([diagnostic]).slice(-50)
    });
  } catch (_error) {
    console.error(
      "CHI27_AI_WATCHER_DIAGNOSTIC",
      JSON.stringify(safeDiagnostic("diagnostic_storage_failed", 0, null))
    );
  }
  return diagnostic;
}

async function recordErrorDiagnostic(fallbackCode, error, retryCount) {
  const code = (
    error &&
    typeof error.diagnosticCode === "string"
  ) ? error.diagnosticCode : fallbackCode;
  const httpStatus = error && Number.isInteger(error.httpStatus)
    ? error.httpStatus
    : null;
  return recordDiagnostic(code, retryCount, httpStatus);
}

function strictLegacyContentFreeQueueEvent(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 3 ||
    !["timestamp", "duration", "data"].every((key) =>
      Object.hasOwn(candidate, key)
    ) ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data) ||
    candidate.data.schema_version !== "1.0" ||
    Object.hasOwn(candidate.data, "turn_link_id") ||
    !LEGACY_QUEUE_ADAPTER_VERSIONS.has(candidate.data.adapter_version) ||
    Object.keys(candidate.data).some(
      (key) => !LEGACY_QUEUE_EVENT_DATA_KEYS.has(key)
    )
  ) {
    return false;
  }
  const eventType = candidate.data.event_type;
  const upgradedData = Object.assign({}, candidate.data, {
    schema_version: Core.SCHEMA_VERSION,
    adapter_version: Core.ADAPTER_VERSION
  });
  if (Core.TURN_LINK_EVENT_TYPES.has(eventType)) {
    upgradedData.turn_link_id = LEGACY_QUEUE_VALIDATION_LINK;
  }
  const upgraded = Object.assign({}, candidate, { data: upgradedData });
  return Boolean(Core.sanitizePersistedActivityWatchEvent(upgraded));
}

function strictLegacyContentFreeQueueItem(item) {
  return Boolean(
    item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    Object.keys(item).length === 3 &&
    ["event", "attempts", "next_attempt_at"].every((key) =>
      Object.hasOwn(item, key)
    ) &&
    Number.isInteger(item.attempts) &&
    item.attempts >= 0 &&
    Number.isFinite(item.next_attempt_at) &&
    strictLegacyContentFreeQueueEvent(item.event)
  );
}

function strictLegacyQueueQuarantine(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    value.schema_version === "1.0" &&
    Array.isArray(value.records) &&
    value.records.every((entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 3 &&
      Object.hasOwn(entry, "quarantined_at") &&
      (
        entry.reason_code === "lifecycle_missing_turn_link" &&
        Core.TURN_LINK_EVENT_TYPES.has(
          entry.record && entry.record.event && entry.record.event.data &&
          entry.record.event.data.event_type
        ) ||
        entry.reason_code === "non_lifecycle_invalid_for_current_contract" &&
        !Core.TURN_LINK_EVENT_TYPES.has(
          entry.record && entry.record.event && entry.record.event.data &&
          entry.record.event.data.event_type
        )
      ) &&
      Number.isFinite(Date.parse(entry.quarantined_at)) &&
      strictLegacyContentFreeQueueItem(entry.record)
    )
  );
}

function sanitizeQueueState(value) {
  const source = (
    value &&
    Array.isArray(value.pending) &&
    Array.isArray(value.acknowledged)
  ) ? value : { pending: [], acknowledged: [] };
  const pending = [];
  const quarantined = [];
  let changedCount = 0;
  let rejectedCount = 0;
  let legacyLifecycleQuarantinedCount = 0;
  let legacyNonLifecycleMigratedCount = 0;
  let legacyNonLifecycleQuarantinedCount = 0;
  let legacyUnsafePayloadBlockedCount = 0;
  for (const item of source.pending) {
    const candidate = item && item.event;
    const candidateData = candidate && candidate.data;
    const isLegacy = (
      candidateData && candidateData.schema_version === "1.0"
    );
    let event = Core.sanitizePersistedActivityWatchEvent(candidate);
    if (isLegacy && !event) {
      const contentFree = strictLegacyContentFreeQueueItem(item);
      if (!contentFree) {
        // Keep the original bytes in their existing queue record. Migration
        // will fail closed before any storage write, so no unsafe payload is
        // copied, transmitted, or irreversibly removed.
        legacyUnsafePayloadBlockedCount += 1;
        pending.push(item);
        continue;
      }
      if (Core.TURN_LINK_EVENT_TYPES.has(candidateData.event_type)) {
        // A schema-1.0 lifecycle has no trustworthy join key. Preserve it for
        // audit, but never send it or invent a link during upgrade.
        legacyLifecycleQuarantinedCount += 1;
        quarantined.push({
          reason_code: "lifecycle_missing_turn_link",
          record: item
        });
      } else {
        const migratedCandidate = Object.assign({}, candidate, {
          data: Object.assign({}, candidateData, {
            schema_version: Core.SCHEMA_VERSION
          })
        });
        event = Core.sanitizePersistedActivityWatchEvent(migratedCandidate);
        if (event) {
          legacyNonLifecycleMigratedCount += 1;
        } else {
          legacyNonLifecycleQuarantinedCount += 1;
          quarantined.push({
            reason_code: "non_lifecycle_invalid_for_current_contract",
            record: item
          });
        }
      }
    }
    if (!event) {
      rejectedCount += 1;
      continue;
    }
    if (JSON.stringify(event) !== JSON.stringify(item.event)) {
      changedCount += 1;
    }
    pending.push({
      event,
      attempts: Number.isInteger(item.attempts) && item.attempts >= 0
        ? item.attempts
        : 0,
      next_attempt_at: Number.isFinite(item.next_attempt_at)
        ? item.next_attempt_at
        : 0
    });
  }
  return {
    state: {
      pending,
      acknowledged: source.acknowledged.filter(
        (value) => Core.SOURCE_EVENT_ID_RE.test(value || "")
      ).slice(-1000)
    },
    changed_count: changedCount,
    rejected_count: rejectedCount,
    quarantined,
    legacy_lifecycle_quarantined_count: legacyLifecycleQuarantinedCount,
    legacy_non_lifecycle_migrated_count: legacyNonLifecycleMigratedCount,
    legacy_non_lifecycle_quarantined_count: legacyNonLifecycleQuarantinedCount,
    legacy_unsafe_payload_blocked_count: legacyUnsafePayloadBlockedCount
  };
}

const queueStore = {
  async get() {
    await ensureConversationQueueMigration();
    const result = await storageGet(QUEUE_KEY);
    return sanitizeQueueState(result[QUEUE_KEY]).state;
  },
  async set(state) {
    await ensureConversationQueueMigration();
    await storageSet({ [QUEUE_KEY]: state });
  }
};

const sessionQueueStore = {
  async get() {
    const result = await storageGet(SESSION_QUEUE_KEY);
    return result[SESSION_QUEUE_KEY] || { pending: [], acknowledged: [] };
  },
  async set(state) {
    await storageSet({ [SESSION_QUEUE_KEY]: state });
  }
};

const studySessionStateStore = {
  async get() {
    const result = await storageGet(SESSION_STATE_KEY);
    return result[SESSION_STATE_KEY] || { status: "inactive" };
  },
  async set(state) {
    await storageSet({ [SESSION_STATE_KEY]: state });
  }
};

function validatedBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value || DEFAULT_CONFIG.aw_base_url);
  } catch (_error) {
    throw makeDiagnosticError("config_base_url_invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    (parsed.port && parsed.port !== "5600")
  ) {
    throw makeDiagnosticError("config_base_url_invalid");
  }
  return parsed.origin;
}

function validatedBucketId(value, fallbackId) {
  const bucketId = value || fallbackId || DEFAULT_CONFIG.bucket_id;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(bucketId)) {
    throw makeDiagnosticError("config_bucket_id_invalid");
  }
  return bucketId;
}

function validatedBucketPair(config) {
  const bucketId = validatedBucketId(
    config && config.bucket_id,
    DEFAULT_CONFIG.bucket_id
  );
  const sessionBucketId = validatedBucketId(
    config && config.session_bucket_id,
    DEFAULT_CONFIG.session_bucket_id
  );
  if (bucketId === sessionBucketId) {
    throw makeDiagnosticError("config_bucket_ids_not_distinct");
  }
  return { bucketId, sessionBucketId };
}

async function loadConfig() {
  const stored = await storageGet(Object.keys(DEFAULT_CONFIG));
  const config = Object.assign({}, DEFAULT_CONFIG, stored);
  validatedBucketPair(config);
  return config;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw makeDiagnosticError("activitywatch_fetch_timeout");
    }
    throw makeDiagnosticError("activitywatch_fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBucket(config) {
  const baseUrl = validatedBaseUrl(config.aw_base_url);
  const { bucketId } = validatedBucketPair(config);
  const signature = `${baseUrl}|${bucketId}`;
  if (ensuredBucketSignature === signature) {
    return { baseUrl, bucketId };
  }
  const response = await fetchWithTimeout(
    `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: bucketId,
        type: "ai.conversation.events",
        client: "chi27-chrome-ai-conversation-watcher",
        hostname: "local"
      })
    }
  );
  if (!response.ok && ![304, 409].includes(response.status)) {
    throw makeDiagnosticError("activitywatch_bucket_create_http", response.status);
  }
  ensuredBucketSignature = signature;
  return { baseUrl, bucketId };
}

async function ensureSessionBucket(config) {
  const baseUrl = validatedBaseUrl(config.aw_base_url);
  const { sessionBucketId: bucketId } = validatedBucketPair(config);
  const signature = `${baseUrl}|${bucketId}`;
  if (ensuredSessionBucketSignature === signature) {
    return { baseUrl, bucketId };
  }
  const response = await fetchWithTimeout(
    `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: bucketId,
        type: "study.session.events",
        client: "chi27-chrome-ai-conversation-watcher",
        hostname: "local"
      })
    }
  );
  if (!response.ok && ![304, 409].includes(response.status)) {
    throw makeDiagnosticError(
      "activitywatch_session_bucket_create_http",
      response.status
    );
  }
  ensuredSessionBucketSignature = signature;
  return { baseUrl, bucketId };
}

async function sendEventsToActivityWatch(events) {
  if (!(events || []).every(Core.validateActivityWatchEvent)) {
    throw makeDiagnosticError("internal_event_validation_failed");
  }
  const config = await loadConfig();
  const { baseUrl, bucketId } = await ensureBucket(config);
  const response = await fetchWithTimeout(
    `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events)
    }
  );
  if (!response.ok) {
    ensuredBucketSignature = null;
    throw makeDiagnosticError("activitywatch_event_write_http", response.status);
  }
}

async function sendSessionEventsToActivityWatch(events) {
  if (!(events || []).every(StudySession.validateStudySessionEvent)) {
    throw makeDiagnosticError("internal_session_event_validation_failed");
  }
  const config = await loadConfig();
  const { baseUrl, bucketId } = await ensureSessionBucket(config);
  const response = await fetchWithTimeout(
    `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events)
    }
  );
  if (!response.ok) {
    ensuredSessionBucketSignature = null;
    throw makeDiagnosticError("activitywatch_session_event_write_http", response.status);
  }
}

async function verifyBucketReadable(config) {
  const { baseUrl, bucketId } = await ensureBucket(config);
  const response = await fetchWithTimeout(
    `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}`,
    { method: "GET" }
  );
  if (!response.ok) {
    ensuredBucketSignature = null;
    throw makeDiagnosticError("activitywatch_bucket_verify_http", response.status);
  }
  return { bucketId };
}

async function verifySessionBucketReadable(config) {
  const { baseUrl, bucketId } = await ensureSessionBucket(config);
  const response = await fetchWithTimeout(
    `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}`,
    { method: "GET" }
  );
  if (!response.ok) {
    ensuredSessionBucketSignature = null;
    throw makeDiagnosticError(
      "activitywatch_session_bucket_verify_http",
      response.status
    );
  }
  return { bucketId };
}

const queue = new ReliableEventQueue({
  store: queueStore,
  transport: sendEventsToActivityWatch,
  baseRetryMs: 1000,
  maxRetryMs: 60000
});

const sessionQueue = new ReliableEventQueue({
  store: sessionQueueStore,
  transport: sendSessionEventsToActivityWatch,
  idSelector: StudySession.studySessionEventId,
  baseRetryMs: 1000,
  maxRetryMs: 60000
});

async function processSessionQueueWithDiagnostics() {
  const result = await sessionQueue.process();
  if (result.status === "retry_scheduled") {
    await recordDiagnostic(
      result.error_code || "session_transport_failed",
      result.retry_count,
      result.http_status
    );
  }
  return result;
}

async function enqueueSessionMarker(marker) {
  if (!StudySession.validateStudySessionEvent(marker)) {
    throw makeDiagnosticError("internal_session_event_validation_failed");
  }
  const added = await sessionQueue.enqueue([marker]);
  const flush = await processSessionQueueWithDiagnostics();
  return { added, flush };
}

async function sessionPendingCount() {
  const state = await sessionQueueStore.get();
  return state.pending.length;
}

const studySessionController = new StudySession.StudySessionController({
  store: studySessionStateStore,
  emitMarker: enqueueSessionMarker,
  pendingCount: sessionPendingCount,
  randomUuid: Core.randomUuid
});

const RESPONSE_EXACT_KEY_PATTERN = /^[0-9a-f]{64}$/;
const RESPONSE_UUID_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validResponseConversationKey(value) {
  return (
    typeof value === "string" &&
    (
      RESPONSE_EXACT_KEY_PATTERN.test(value) ||
      RESPONSE_UUID_KEY_PATTERN.test(value)
    )
  );
}

function canonicalResponseTimestamp(value) {
  const parsed = Date.parse(value);
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value
  );
}

function sanitizeResponseSessionEntry(entry, kind, nowMs) {
  const allowedKeys = kind === "binding"
    ? new Set(["session_id", "bound_at", "expires_at"])
    : new Set(["session_id", "completed_at", "expires_at"]);
  const timestampKey = kind === "binding" ? "bound_at" : "completed_at";
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    Object.keys(entry).some((key) => !allowedKeys.has(key)) ||
    (
      kind === "binding"
        ? entry.session_id !== null &&
          !RESPONSE_SESSION_ID_PATTERN.test(entry.session_id || "")
        : !RESPONSE_SESSION_ID_PATTERN.test(entry.session_id || "")
    ) ||
    !canonicalResponseTimestamp(entry[timestampKey]) ||
    !canonicalResponseTimestamp(entry.expires_at) ||
    Date.parse(entry.expires_at) <= nowMs ||
    Date.parse(entry.expires_at) <= Date.parse(entry[timestampKey])
  ) {
    return null;
  }
  return {
    session_id: entry.session_id,
    [timestampKey]: entry[timestampKey],
    expires_at: entry.expires_at
  };
}

function sanitizeResponseSessionState(value, nowMs) {
  const result = { bindings: {}, authorizations: {} };
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  for (const [conversationKey, entry] of Object.entries(source.bindings || {})) {
    if (!validResponseConversationKey(conversationKey)) {
      continue;
    }
    const safe = sanitizeResponseSessionEntry(entry, "binding", nowMs);
    if (safe) {
      result.bindings[conversationKey] = safe;
    }
  }
  for (const [conversationKey, entry] of Object.entries(
    source.authorizations || {}
  )) {
    if (!validResponseConversationKey(conversationKey)) {
      continue;
    }
    const safe = sanitizeResponseSessionEntry(entry, "authorization", nowMs);
    if (safe) {
      result.authorizations[conversationKey] = safe;
    }
  }
  return result;
}

function trimResponseSessionEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries)
      .sort((left, right) =>
        Date.parse(left[1].expires_at) - Date.parse(right[1].expires_at)
      )
      .slice(-MAX_RESPONSE_SESSION_ENTRIES)
  );
}

function mutateResponseSessionState(operation) {
  const result = responseSessionMutationChain.then(async () => {
    const stored = await storageGet(RESPONSE_SESSION_STATE_KEY);
    const state = sanitizeResponseSessionState(
      stored[RESPONSE_SESSION_STATE_KEY],
      Date.now()
    );
    const operationResult = await operation(state);
    state.bindings = trimResponseSessionEntries(state.bindings);
    state.authorizations = trimResponseSessionEntries(state.authorizations);
    await storageSet({ [RESPONSE_SESSION_STATE_KEY]: state });
    return operationResult;
  });
  responseSessionMutationChain = result.catch(() => {});
  return result;
}

async function bindResponseToCurrentSession(event) {
  const conversationKey = event.data.conversation_key;
  if (!validResponseConversationKey(conversationKey)) {
    return false;
  }
  const sessionStatus = await studySessionController.getStatus();
  const nowMs = Date.now();
  const boundAt = new Date(nowMs).toISOString();
  await mutateResponseSessionState((state) => {
    state.bindings[conversationKey] = {
      session_id: sessionStatus.active ? sessionStatus.session_id : null,
      bound_at: boundAt,
      expires_at: new Date(nowMs + RESPONSE_BINDING_TTL_MS).toISOString()
    };
    delete state.authorizations[conversationKey];
  });
  return true;
}

async function aliasResponseSessionBinding(event) {
  const nextKey = event.data.conversation_key;
  const previousKey = event.data.previous_conversation_key;
  if (
    !validResponseConversationKey(nextKey) ||
    !validResponseConversationKey(previousKey) ||
    nextKey === previousKey
  ) {
    return false;
  }
  return mutateResponseSessionState((state) => {
    if (state.bindings[previousKey]) {
      state.bindings[nextKey] = state.bindings[previousKey];
    }
    if (state.authorizations[previousKey]) {
      state.authorizations[nextKey] = state.authorizations[previousKey];
    }
    delete state.bindings[previousKey];
    delete state.authorizations[previousKey];
    return true;
  });
}

async function completeResponseSessionBinding(event) {
  const conversationKey = event.data.conversation_key;
  if (!validResponseConversationKey(conversationKey)) {
    return null;
  }
  const sessionStatus = await studySessionController.getStatus();
  const nowMs = Date.now();
  return mutateResponseSessionState((state) => {
    const binding = state.bindings[conversationKey] || null;
    delete state.bindings[conversationKey];
    delete state.authorizations[conversationKey];
    if (
      event.data.event_type === "assistant_response_completed" &&
      binding &&
      binding.session_id &&
      sessionStatus.active &&
      binding.session_id === sessionStatus.session_id
    ) {
      state.authorizations[conversationKey] = {
        session_id: binding.session_id,
        completed_at: event.data.occurred_at,
        expires_at: new Date(
          nowMs + RESPONSE_AUTHORIZATION_TTL_MS
        ).toISOString()
      };
      return binding.session_id;
    }
    return null;
  });
}

async function processResponseSessionEvents(events) {
  const completions = [];
  for (const event of events || []) {
    const eventType = event && event.data && event.data.event_type;
    if (eventType === "assistant_response_started") {
      await bindResponseToCurrentSession(event);
    } else if (eventType === "conversation_bound") {
      await aliasResponseSessionBinding(event);
    } else if ([
      "assistant_response_completed",
      "assistant_response_failed",
      "assistant_response_cancelled"
    ].includes(eventType)) {
      const studySessionId = await completeResponseSessionBinding(event);
      if (eventType === "assistant_response_completed" && studySessionId) {
        completions.push({
          raw_completion_id: event.data.source_event_id,
          study_session_id: studySessionId
        });
      }
    }
  }
  return completions;
}

function validatePrivateReturnCueAgainstEvents(cue, events) {
  if (!PrivateReturnCues.validatePrivateCue(cue, Date.now())) {
    throw makeDiagnosticError("private_cue_rejected");
  }
  const completions = (events || []).filter(
    (event) => event.data.event_type === "assistant_response_completed"
  );
  if (completions.length !== 1) {
    throw makeDiagnosticError("private_cue_rejected");
  }
  const completion = completions[0];
  if (
    cue.raw_completion_id !== completion.data.source_event_id ||
    cue.provider !== completion.data.provider ||
    cue.completion_time !== completion.data.occurred_at
  ) {
    throw makeDiagnosticError("private_cue_rejected");
  }
  return true;
}

function mutatePrivateReturnCues(operation) {
  const result = privateReturnCueMutationChain.then(async () => {
    const stored = await storageGet(PRIVATE_RETURN_CUES_KEY);
    const sanitized = PrivateReturnCues.sanitizeStoreState(
      stored[PRIVATE_RETURN_CUES_KEY],
      Date.now()
    );
    const operationResult = await operation(sanitized.state);
    await storageSet({ [PRIVATE_RETURN_CUES_KEY]: sanitized.state });
    return operationResult;
  });
  privateReturnCueMutationChain = result.catch(() => {});
  return result;
}

async function persistPrivateReturnCue(cue, studySessionId) {
  const linkedId = await PrivateReturnCues.eventLinkId(
    cue.raw_completion_id,
    crypto
  );
  const sessionStatus = await studySessionController.getStatus();
  if (
    !sessionStatus.active ||
    sessionStatus.session_id !== studySessionId
  ) {
    return { added: false, reason: "study_session_inactive" };
  }
  const nowMs = Date.now();
  const record = PrivateReturnCues.buildStoredRecord(
    cue,
    studySessionId,
    linkedId,
    nowMs
  );
  // event_link_id is the private record's only completion identity. The raw
  // completion UUID remains transient; study_session_id only scopes consent.
  return mutatePrivateReturnCues((state) => {
    const existing = state.records.find(
      (item) => item.event_link_id === linkedId
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw makeDiagnosticError("private_cue_duplicate_conflict");
      }
      return { added: false, event_link_id: linkedId };
    }
    state.records.push(record);
    state.records.sort((left, right) =>
      Date.parse(left.completion_time) - Date.parse(right.completion_time) ||
      left.event_link_id.localeCompare(right.event_link_id)
    );
    if (state.records.length > PrivateReturnCues.MAX_RECORDS) {
      state.records.splice(
        0,
        state.records.length - PrivateReturnCues.MAX_RECORDS
      );
    }
    return { added: true, event_link_id: linkedId };
  });
}

function purgePrivateReturnCues() {
  return mutatePrivateReturnCues(() => true);
}

function clearPrivateReturnCuesForSession(studySessionId) {
  return mutatePrivateReturnCues((state) => {
    const before = state.records.length;
    state.records = state.records.filter(
      (record) => record.study_session_id !== studySessionId
    );
    return before - state.records.length;
  });
}

async function exportStoppedPrivateReturnCues() {
  await privateCueExportAuthority.authorize();
  const status = await studySessionController.getStatus();
  if (status.active) {
    throw makeDiagnosticError("private_cue_export_session_active");
  }
  if (status.last_event_type === "study_session_cancelled") {
    throw makeDiagnosticError("private_cue_export_session_cancelled");
  }
  if (
    status.last_event_type !== "study_session_stopped" ||
    !status.last_session_id
  ) {
    throw makeDiagnosticError("private_cue_export_not_ready");
  }
  await privateReturnCueMutationChain;
  const stored = await storageGet(PRIVATE_RETURN_CUES_KEY);
  const rawState = stored[PRIVATE_RETURN_CUES_KEY];
  const sanitized = PrivateReturnCues.sanitizeStoreState(rawState, Date.now());
  if (sanitized.expired_count > 0) {
    throw makeDiagnosticError("private_cue_export_expired");
  }
  if (JSON.stringify(rawState) !== JSON.stringify(sanitized.state)) {
    throw makeDiagnosticError("private_cue_export_invalid");
  }
  const createdAt = new Date(Date.now()).toISOString();
  const sidecar = PrivateReturnCues.buildExportSidecar(
    rawState.records,
    status.last_session_id,
    createdAt,
    Date.now()
  );
  return {
    filename: `rta-return-cues-${status.last_session_id}.json`,
    sidecar
  };
}

function consumeResponseNotificationAuthorization(conversationKey) {
  if (!validResponseConversationKey(conversationKey)) {
    return Promise.resolve(null);
  }
  return mutateResponseSessionState((state) => {
    const authorization = state.authorizations[conversationKey] || null;
    delete state.authorizations[conversationKey];
    return authorization;
  });
}

async function enqueueAndFlush(events) {
  const validEvents = (events || []).filter(Core.validateActivityWatchEvent);
  if (validEvents.length !== (events || []).length) {
    throw makeDiagnosticError("internal_event_validation_failed");
  }
  const added = await queue.enqueue(validEvents);
  const flush = await processQueueWithDiagnostics();
  return { added, flush };
}

async function processQueueWithDiagnostics() {
  const result = await queue.process();
  if (result.status === "retry_scheduled") {
    await recordDiagnostic(
      result.error_code || "transport_failed",
      result.retry_count,
      result.http_status
    );
  }
  return result;
}

async function writeHeartbeat(signal) {
  const event = Heartbeat.createHeartbeatEvent(
    undefined,
    signal || "sixty_second_alarm"
  );
  return enqueueAndFlush([event]);
}

async function testActivityWatchConnection() {
  ensuredBucketSignature = null;
  ensuredSessionBucketSignature = null;
  const config = await loadConfig();
  const [conversation, session] = await Promise.all([
    verifyBucketReadable(config),
    verifySessionBucketReadable(config)
  ]);
  return {
    bucketId: conversation.bucketId,
    sessionBucketId: session.bucketId
  };
}

function clearNamedAlarm(name) {
  if (!chrome.alarms || typeof chrome.alarms.clear !== "function") {
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    chrome.alarms.clear(name, (wasCleared) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("alarm_clear_failed"));
      } else {
        resolve(Boolean(wasCleared));
      }
    });
  });
}

async function updateStudySessionAction(status) {
  if (!chrome.action) {
    return;
  }
  let badgeText = "";
  let title = "CHI27 AI Conversation Watcher";
  let color = "#2e7d32";
  if (status.active) {
    badgeText = status.overdue ? "90+" : "ON";
    title = status.overdue
      ? "CHI27 实验会话已超过 90 分钟，请确认是否结束"
      : "CHI27 实验会话进行中";
    color = status.overdue ? "#c2410c" : "#2e7d32";
  }
  if (status.pending_sync) {
    title += "；会话标记等待同步至 ActivityWatch";
  }
  const calls = [
    chrome.action.setBadgeText({ text: badgeText }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title })
  ];
  await Promise.all(calls.map((result) => (
    result && typeof result.then === "function" ? result : Promise.resolve()
  )));
}

async function refreshStudySessionIndicator() {
  const status = await studySessionController.getStatus();
  await updateStudySessionAction(status);
  await clearNamedAlarm(STUDY_SESSION_WARNING_ALARM);
  if (status.active && !status.overdue) {
    const creation = chrome.alarms.create(STUDY_SESSION_WARNING_ALARM, {
      when: Date.parse(status.warning_at_utc)
    });
    if (creation && typeof creation.then === "function") {
      await creation;
    }
  }
  return status;
}

function isTrustedExtensionPageSender(sender) {
  if (
    !sender ||
    sender.id !== chrome.runtime.id ||
    typeof sender.url !== "string"
  ) {
    return false;
  }
  try {
    const parsed = new URL(sender.url);
    return (
      parsed.protocol === "chrome-extension:" &&
      parsed.hostname === chrome.runtime.id &&
      ["/popup.html", "/options.html"].includes(parsed.pathname)
    );
  } catch (_error) {
    return false;
  }
}

async function handleStudySessionCommand(type) {
  return runPrivateCueLifecycleExclusive(async () => {
    let status;
    if (type !== "GET_STUDY_SESSION_STATUS") {
      await loadConfig();
      privateCueAuthorizations.clear();
    }
    if (type === "START_STUDY_SESSION") {
      status = await studySessionController.start();
    } else if (type === "STOP_STUDY_SESSION") {
      status = await studySessionController.stop();
    } else if (type === "CANCEL_STUDY_SESSION") {
      status = await studySessionController.cancel();
    } else {
      status = await studySessionController.getStatus();
    }
    if (
      type === "CANCEL_STUDY_SESSION" &&
      status.last_event_type === "study_session_cancelled" &&
      status.last_session_id
    ) {
      await clearPrivateReturnCuesForSession(status.last_session_id);
    }
    await refreshStudySessionIndicator();
    return status;
  });
}

function createNotification(options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(options.id, options.payload, (notificationId) => {
      if (chrome.runtime.lastError) {
        const message = String(chrome.runtime.lastError.message || "").toLowerCase();
        reject(makeDiagnosticError(
          message.includes("download") && message.includes("image")
            ? "notification_icon_load_failed"
            : "notification_create_failed"
        ));
      } else {
        resolve(notificationId);
      }
    });
  });
}

function getNotificationPermissionLevel() {
  return new Promise((resolve, reject) => {
    if (
      !chrome.notifications ||
      typeof chrome.notifications.getPermissionLevel !== "function"
    ) {
      reject(makeDiagnosticError("notification_permission_check_failed"));
      return;
    }
    chrome.notifications.getPermissionLevel((level) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("notification_permission_check_failed"));
      } else if (!new Set(["granted", "denied"]).has(level)) {
        reject(makeDiagnosticError("notification_permission_check_failed"));
      } else {
        resolve(level);
      }
    });
  });
}

function isValidPersistedTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

function sanitizePersistedNotificationTarget(target) {
  if (
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    !["chatgpt", "claude"].includes(target.provider) ||
    !target.conversation ||
    target.conversation.identity_status !== "exact" ||
    !RESPONSE_EXACT_KEY_PATTERN.test(
      target.conversation.conversation_key || ""
    ) ||
    !Number.isFinite(Date.parse(target.due_at))
  ) {
    return null;
  }
  const namespaceValid = (
    Number.isInteger(target.conversation.namespace_generation) &&
    target.conversation.namespace_generation > 0 &&
    Ingress.NAMESPACE_FINGERPRINT_RE.test(
      target.conversation.namespace_fingerprint || ""
    )
  );
  const rawLocatorHandle =
    target.locator_handle || target.conversation.locator_handle || "";
  const legacyProviderConversationId =
    target.provider_conversation_id ||
    target.conversation.provider_conversation_id ||
    null;
  const locatorHandle = AuthorityClient.isValidLocatorHandle(
    rawLocatorHandle,
    legacyProviderConversationId
  )
    ? rawLocatorHandle
    : null;
  const tabIdValid = isValidPersistedTabId(target.tab_id);
  const result = {
    tab_id: tabIdValid ? target.tab_id : null,
    window_id: Number.isInteger(target.window_id) ? target.window_id : null,
    provider: target.provider,
    conversation: {
      conversation_key: target.conversation.conversation_key,
      identity_status: "exact"
    },
    locator_handle: namespaceValid ? locatorHandle : null,
    target_status: namespaceValid && locatorHandle && tabIdValid
      ? "ready"
      : "unavailable",
    reason_code: target.reason_code === "response_completed_while_hidden"
      ? target.reason_code
      : "response_completed_while_hidden",
    due_at: new Date(Date.parse(target.due_at)).toISOString()
  };
  if (namespaceValid) {
    result.conversation.namespace_generation =
      target.conversation.namespace_generation;
    result.conversation.namespace_fingerprint =
      target.conversation.namespace_fingerprint;
  }
  if (["clicked", "timeout"].includes(target.terminal_state)) {
    result.terminal_state = target.terminal_state;
  }
  return result;
}

function sanitizeNotificationTargetMap(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const targets = {};
  let changedCount = 0;
  let rejectedCount = 0;
  for (const [notificationId, target] of Object.entries(source).slice(-200)) {
    if (!/^chi27-ai-[0-9a-f-]{36}$/i.test(notificationId)) {
      rejectedCount += 1;
      continue;
    }
    const sanitized = sanitizePersistedNotificationTarget(target);
    if (!sanitized) {
      rejectedCount += 1;
      continue;
    }
    if (JSON.stringify(sanitized) !== JSON.stringify(target)) {
      changedCount += 1;
    }
    targets[notificationId] = sanitized;
  }
  return {
    targets,
    changed_count: changedCount,
    rejected_count: rejectedCount
  };
}

function mutateNotificationTargets(operation) {
  const result = notificationTargetMutationChain.then(async () => {
    const stored = await storageGet(NOTIFICATION_TARGETS_KEY);
    const targets = sanitizeNotificationTargetMap(
      stored[NOTIFICATION_TARGETS_KEY]
    ).targets;
    const operationResult = await operation(targets);
    const entries = Object.entries(
      sanitizeNotificationTargetMap(targets).targets
    ).slice(-200);
    await storageSet({
      [NOTIFICATION_TARGETS_KEY]: Object.fromEntries(entries)
    });
    return operationResult;
  });
  notificationTargetMutationChain = result.catch(() => {});
  return result;
}

function storeNotificationTarget(notificationId, target) {
  return mutateNotificationTargets((targets) => {
    targets[notificationId] = target;
  });
}

function removeNotificationTarget(notificationId) {
  const result = mutateNotificationTargets((targets) => {
    delete targets[notificationId];
    activeNotificationClaims.delete(notificationId);
  });
  cancelNotificationAutoClear(notificationId);
  return result;
}

function claimNotificationTarget(notificationId, terminalState) {
  return mutateNotificationTargets((targets) => {
    const target = targets[notificationId];
    if (!target || target.terminal_state) {
      return null;
    }
    target.terminal_state = terminalState;
    activeNotificationClaims.add(notificationId);
    return target;
  });
}

function releaseNotificationTargetClaim(
  notificationId,
  terminalState,
  fallbackDueAt
) {
  return mutateNotificationTargets((targets) => {
    const target = targets[notificationId];
    if (target && target.terminal_state === terminalState) {
      delete target.terminal_state;
    }
    activeNotificationClaims.delete(notificationId);
    if (
      target &&
      !Number.isFinite(Date.parse(target.due_at)) &&
      Number.isFinite(Date.parse(fallbackDueAt))
    ) {
      target.due_at = fallbackDueAt;
    }
    return target ? target.due_at : null;
  });
}

async function recoverInterruptedNotificationClaims() {
  await notificationTargetMutationChain;
  const stored = await storageGet(NOTIFICATION_TARGETS_KEY);
  const storedTargets = sanitizeNotificationTargetMap(
    stored[NOTIFICATION_TARGETS_KEY]
  ).targets;
  const hasInterruptedClaim = Object.entries(storedTargets).some(
    ([notificationId, target]) =>
      target &&
      target.terminal_state &&
      !activeNotificationClaims.has(notificationId)
  );
  if (!hasInterruptedClaim) {
    return 0;
  }
  return mutateNotificationTargets((targets) => {
    let recoveredCount = 0;
    for (const [notificationId, target] of Object.entries(targets)) {
      if (
        target &&
        target.terminal_state &&
        !activeNotificationClaims.has(notificationId)
      ) {
        delete target.terminal_state;
        recoveredCount += 1;
      }
    }
    return recoveredCount;
  });
}

function notificationLifecycleEvent(target, eventType, metadata) {
  return Core.buildActivityWatchEvent({
    provider: target.provider,
    event_type: eventType,
    conversation: target.conversation,
    confidence: target.conversation.identity_status === "exact"
      ? "exact"
      : "derived",
    source_adapter: "chrome-background-notification-v2",
    metadata
  });
}

async function recordNotificationLifecycle(target, eventType, metadata, diagnosticCode) {
  const details = Object.assign({ event_type: eventType }, metadata);
  await recordDiagnostic(diagnosticCode, 0, null, details);
  const event = notificationLifecycleEvent(target, eventType, metadata);
  return enqueueAndFlush([event]);
}

async function suppressTrackerNotification(message, sender, reasonCode, responseReason) {
  const auditTarget = {
    tab_id: sender.tab && sender.tab.id,
    window_id: sender.tab && sender.tab.windowId,
    provider: message.provider,
    conversation: {
      conversation_key: message.context.identity.conversation_key,
      identity_status: message.context.identity.identity_status,
      namespace_generation: message.context.identity.namespace_generation,
      namespace_fingerprint: message.context.identity.namespace_fingerprint
    },
    locator_handle: message.context.identity.locator_handle,
    reason_code: message.reason_code
  };
  try {
    await recordNotificationLifecycle(
      auditTarget,
      "tracker_notification_suppressed",
      {
        phase: "gate",
        reason_code: reasonCode
      },
      "notification_suppressed"
    );
  } catch (error) {
    await recordErrorDiagnostic(
      "notification_suppression_audit_failed",
      error,
      0
    );
  }
  return { created: false, reason: responseReason || reasonCode };
}

function safeNotificationErrorCode(error) {
  return (
    error &&
    NOTIFICATION_ERROR_CODES.has(error.diagnosticCode)
  ) ? error.diagnosticCode : "notification_create_failed";
}

function exactOpaqueNotificationContext(provider, identity) {
  if (
    !["chatgpt", "claude"].includes(provider) ||
    !identity ||
    identity.identity_status !== "exact" ||
    !RESPONSE_EXACT_KEY_PATTERN.test(identity.conversation_key || "") ||
    !AuthorityClient.isValidLocatorHandle(identity.locator_handle) ||
    !Number.isInteger(identity.namespace_generation) ||
    identity.namespace_generation <= 0 ||
    !Ingress.NAMESPACE_FINGERPRINT_RE.test(
      identity.namespace_fingerprint || ""
    )
  ) {
    return false;
  }
  return true;
}

async function showTrackerNotification(message, sender) {
  const config = await loadConfig();
  if (message.reason_code === "response_completed_while_foreground") {
    await consumeResponseNotificationAuthorization(
      message.context.identity.conversation_key
    );
    return suppressTrackerNotification(
      message,
      sender,
      "response_completed_while_foreground"
    );
  }
  if (!config.notifications_enabled) {
    return suppressTrackerNotification(
      message,
      sender,
      "notifications_disabled",
      "disabled"
    );
  }
  const sessionStatus = await studySessionController.getStatus();
  if (!sessionStatus.active) {
    return suppressTrackerNotification(
      message,
      sender,
      "study_session_inactive"
    );
  }
  const responseAuthorization = await consumeResponseNotificationAuthorization(
    message.context.identity.conversation_key
  );
  if (
    !responseAuthorization ||
    responseAuthorization.session_id !== sessionStatus.session_id
  ) {
    return suppressTrackerNotification(
      message,
      sender,
      "response_session_not_authorized"
    );
  }
  const auditTarget = {
    tab_id: sender.tab && sender.tab.id,
    window_id: sender.tab && sender.tab.windowId,
    provider: message.provider,
    conversation: {
      conversation_key: message.context.identity.conversation_key,
      identity_status: message.context.identity.identity_status,
      namespace_generation: message.context.identity.namespace_generation,
      namespace_fingerprint: message.context.identity.namespace_fingerprint
    },
    locator_handle: message.context.identity.locator_handle,
    reason_code: message.reason_code
  };
  if (!exactOpaqueNotificationContext(
    message.provider,
    message.context.identity
  )) {
    await recordNotificationLifecycle(
      auditTarget,
      "tracker_notification_failed",
      {
        phase: "validate_context",
        error_code: "identity_not_exact"
      },
      "identity_not_exact"
    );
    return { created: false, error_code: "identity_not_exact" };
  }
  const notificationId = `chi27-ai-${Core.randomUuid()}`;
  const providerLabel = message.provider === "chatgpt" ? "ChatGPT" : "Claude";
  const notificationPreview = Core.sanitizeEphemeralNotificationPreview(
    message.notification_preview
  );
  const target = Object.assign({}, auditTarget, {
    due_at: new Date(Date.now() + AUTO_CLEAR_MS).toISOString()
  });
  await recordNotificationLifecycle(
    target,
    "tracker_notification_attempted",
    {
      phase: "create",
      reason_code: message.reason_code
    },
    "notification_attempted"
  );
  let permissionLevel;
  try {
    permissionLevel = await getNotificationPermissionLevel();
  } catch (_error) {
    await recordNotificationLifecycle(
      target,
      "tracker_notification_failed",
      {
        phase: "permission",
        error_code: "notification_permission_check_failed"
      },
      "notification_permission_check_failed"
    );
    return {
      created: false,
      error_code: "notification_permission_check_failed"
    };
  }
  if (permissionLevel !== "granted") {
    await recordNotificationLifecycle(
      target,
      "tracker_notification_failed",
      {
        phase: "permission",
        error_code: "notification_permission_denied"
      },
      "notification_permission_denied"
    );
    return { created: false, error_code: "notification_permission_denied" };
  }
  try {
    await storeNotificationTarget(notificationId, target);
  } catch (_error) {
    await recordNotificationLifecycle(
      target,
      "tracker_notification_failed",
      {
        phase: "store_target",
        error_code: "notification_target_storage_failed"
      },
      "notification_target_storage_failed"
    );
    return {
      created: false,
      error_code: "notification_target_storage_failed"
    };
  }
  let createdId;
  try {
    createdId = await createNotification({
      id: notificationId,
      payload: {
        type: "basic",
        iconUrl: TRANSPARENT_NOTIFICATION_ICON_URL,
        title: `CHI27 · ${providerLabel} 回答已完成`,
        message: notificationPreview || "回答已完成。点击返回对应对话。",
        requireInteraction: false
      }
    });
  } catch (error) {
    const errorCode = safeNotificationErrorCode(error);
    try {
      await removeNotificationTarget(notificationId);
    } catch (_cleanupError) {
      await recordDiagnostic("notification_target_cleanup_failed", 0, null, {
        event_type: "tracker_notification_failed",
        phase: "create"
      });
    }
    await recordNotificationLifecycle(
      target,
      "tracker_notification_failed",
      {
        phase: "create",
        error_code: errorCode
      },
      errorCode
    );
    return { created: false, error_code: errorCode };
  }
  scheduleNotificationAutoClear(notificationId, target.due_at);
  await recordNotificationLifecycle(
    target,
    "tracker_notification_created",
    {
      phase: "create",
      reason_code: message.reason_code
    },
    "notification_created"
  );
  return { created: true, notification_id: createdId };
}

function isExplicitTabNotFoundError(message, tabId) {
  if (!isValidPersistedTabId(tabId) || typeof message !== "string") {
    return false;
  }
  // Chromium currently reports this exact fixed form. Any wording drift,
  // permission error, or appended text remains unknown and fails closed.
  return message === `No tab with id: ${tabId}.`;
}

function getTabState(tabId) {
  return new Promise((resolve, reject) => {
    if (!isValidPersistedTabId(tabId)) {
      reject(makeDiagnosticError("notification_tab_lookup_failed"));
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        if (isExplicitTabNotFoundError(
          chrome.runtime.lastError.message,
          tabId
        )) {
          resolve(Object.freeze({ state: "missing", tab: null }));
        } else {
          reject(makeDiagnosticError("notification_tab_lookup_failed"));
        }
        return;
      }
      if (
        !tab ||
        typeof tab !== "object" ||
        !Number.isInteger(tab.id) ||
        tab.id !== tabId
      ) {
        reject(makeDiagnosticError("notification_tab_lookup_failed"));
        return;
      }
      resolve(Object.freeze({ state: "present", tab }));
    });
  });
}

function providerForTab(tab) {
  const candidate = tab && (
    typeof tab.pendingUrl === "string" ? tab.pendingUrl : tab.url
  );
  try {
    const parsed = new URL(candidate || "");
    if (parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.hostname === "chatgpt.com") {
      return "chatgpt";
    }
    if (parsed.hostname === "claude.ai") {
      return "claude";
    }
  } catch (_error) {
    // The URL is used only as an in-memory provider gate and is never logged.
  }
  return null;
}

function queryProviderTabs() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({
      url: ["https://chatgpt.com/*", "https://claude.ai/*"]
    }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("reopen_tab_observation_failed"));
      } else {
        resolve((Array.isArray(tabs) ? tabs : []).filter(providerForTab));
      }
    });
  });
}

function notifyReopenCandidate(tab) {
  if (!tab || !Number.isInteger(tab.id) || !providerForTab(tab)) {
    return;
  }
  for (const observer of reopenCandidateObservers) {
    try {
      observer(tab);
    } catch (_error) {
      // One failed observer must not expose a tab or break another attempt.
    }
  }
}

function subscribeReopenCandidates(observer) {
  if (typeof observer !== "function") {
    throw makeDiagnosticError("reopen_tab_observation_failed");
  }
  reopenCandidateObservers.add(observer);
  return () => reopenCandidateObservers.delete(observer);
}

async function focusVerifiedReopenTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) {
    throw makeDiagnosticError("reopen_focus_failed");
  }
  const updated = await updateTab(tab.id, { active: true });
  const windowId = Number.isInteger(updated && updated.windowId)
    ? updated.windowId
    : tab.windowId;
  if (Number.isInteger(windowId)) {
    await updateWindow(windowId, { focused: true });
  }
}

function updateTab(tabId, details) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, details, (tab) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("notification_tab_update_failed"));
      } else {
        resolve(tab);
      }
    });
  });
}

function updateWindow(windowId, details) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, details, (window) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("notification_window_update_failed"));
      } else {
        resolve(window);
      }
    });
  });
}

function clearNotification(notificationId) {
  return new Promise((resolve, reject) => {
    chrome.notifications.clear(notificationId, (matched) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("notification_clear_failed"));
      } else {
        resolve(matched === true);
      }
    });
  });
}

function cancelNotificationAutoClear(notificationId) {
  const timer = notificationClearTimers.get(notificationId);
  if (timer !== undefined) {
    clearTimeout(timer);
    notificationClearTimers.delete(notificationId);
  }
}

function scheduleNotificationAutoClear(notificationId, dueAt) {
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) {
    return false;
  }
  cancelNotificationAutoClear(notificationId);
  const timer = setTimeout(() => {
    notificationClearTimers.delete(notificationId);
    autoClearNotification(notificationId).catch((error) => {
      recordErrorDiagnostic("notification_auto_clear_failed", error, 0);
    });
  }, Math.max(0, dueMs - Date.now()));
  notificationClearTimers.set(notificationId, timer);
  return true;
}

function getOpaqueTabContext(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, {
      type: "GET_OPAQUE_CONVERSATION_CONTEXT"
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

function validStoredNotificationTarget(target) {
  return Boolean(
    target &&
    target.target_status === "ready" &&
    isValidPersistedTabId(target.tab_id) &&
    exactOpaqueNotificationContext(
      target.provider,
      Object.assign({}, target.conversation, {
        locator_handle: target.locator_handle
      })
    )
  );
}

function liveOpaqueContextMatches(target, current) {
  return Boolean(
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    Object.keys(current).length === 4 &&
    current.conversation_key === target.conversation.conversation_key &&
    current.locator_handle === target.locator_handle &&
    current.namespace_generation ===
      target.conversation.namespace_generation &&
    current.namespace_fingerprint ===
      target.conversation.namespace_fingerprint
  );
}

async function validateNotificationTargetWithAuthority(target) {
  if (LocalWebAuthority.isBrowserLocalNamespace(
    target.conversation.namespace_fingerprint
  )) {
    return true;
  }
  const result = await authorityClient.validateLocatorFailClosed({
    provider: target.provider,
    conversation_key: target.conversation.conversation_key,
    locator_handle: target.locator_handle,
    namespace_generation: target.conversation.namespace_generation,
    namespace_fingerprint: target.conversation.namespace_fingerprint
  });
  return Boolean(
    result &&
    result.status === "issued" &&
    result.conversation_key === target.conversation.conversation_key &&
    result.locator_handle === target.locator_handle &&
    result.namespace_generation ===
      target.conversation.namespace_generation &&
    result.namespace_fingerprint ===
      target.conversation.namespace_fingerprint
  );
}

async function performNotificationFocus(notificationId, target) {
  let originalTabState = "unknown";
  if (isValidPersistedTabId(target.tab_id)) {
    const lookup = await getTabState(target.tab_id);
    originalTabState = lookup.state;
    const existingTab = lookup.state === "present" ? lookup.tab : null;
    const current = existingTab
      ? await getOpaqueTabContext(target.tab_id)
      : null;
    if (
      existingTab &&
      liveOpaqueContextMatches(target, current)
    ) {
      try {
        if (!await validateNotificationTargetWithAuthority(target)) {
          throw makeDiagnosticError(
            "notification_authority_precondition_failed"
          );
        }
        await updateTab(target.tab_id, { active: true });
        const windowId = Number.isInteger(existingTab.windowId)
          ? existingTab.windowId
          : target.window_id;
        if (Number.isInteger(windowId)) {
          await updateWindow(windowId, { focused: true });
        }
        const postFocus = await getOpaqueTabContext(target.tab_id);
        if (!liveOpaqueContextMatches(target, postFocus)) {
          const error = makeDiagnosticError(
            "notification_post_focus_context_mismatch"
          );
          error.notificationAction = "activated_existing_tab";
          throw error;
        }
        if (!await validateNotificationTargetWithAuthority(target)) {
          const error = makeDiagnosticError(
            "notification_authority_postcondition_failed"
          );
          error.notificationAction = "activated_existing_tab";
          throw error;
        }
        return "activated_existing_tab";
      } catch (error) {
        error.notificationAction = "activated_existing_tab";
        throw error;
      }
    }
  }
  if (originalTabState === "missing") {
    if (LocalWebAuthority.isBrowserLocalNamespace(
      target.conversation.namespace_fingerprint
    )) {
      throw makeDiagnosticError("notification_opaque_target_not_open");
    }
    const result = await verifiedReopenController.reopen(notificationId, {
      provider: target.provider,
      conversation_key: target.conversation.conversation_key,
      locator_handle: target.locator_handle,
      namespace_generation: target.conversation.namespace_generation,
      namespace_fingerprint: target.conversation.namespace_fingerprint
    });
    if (result && result.focus_succeeded === true) {
      return result.action;
    }
    const safeReason = (
      result &&
      typeof result.reason === "string" &&
      /^[a-z0-9_]{1,40}$/.test(result.reason)
    ) ? result.reason : "authority_unavailable";
    const error = makeDiagnosticError(`notification_reopen_${safeReason}`);
    error.notificationAction = "focus_failed";
    throw error;
  }
  throw makeDiagnosticError("notification_opaque_target_not_open");
}

async function runNotificationTargetFocus(notificationId) {
  const target = await claimNotificationTarget(notificationId, "clicked");
  if (!validStoredNotificationTarget(target)) {
    if (target) {
      await removeNotificationTarget(notificationId);
    }
    await recordDiagnostic("notification_target_missing_or_invalid", 0, null, {
      event_type: "tracker_notification_clicked",
      phase: "focus",
      action: "focus_failed",
      focus_succeeded: false
    });
    return { focus_succeeded: false, action: "focus_failed" };
  }
  cancelNotificationAutoClear(notificationId);
  let action = "focus_failed";
  let focusSucceeded = false;
  let focusError = null;
  try {
    action = await performNotificationFocus(notificationId, target);
    focusSucceeded = true;
  } catch (error) {
    focusError = error;
    action = (
      error &&
      NOTIFICATION_ACTIONS.has(error.notificationAction)
    ) ? error.notificationAction : "focus_failed";
  }
  let lifecycleError = null;
  try {
    await recordNotificationLifecycle(
      target,
      "tracker_notification_clicked",
      {
        phase: "focus",
        action,
        focus_succeeded: focusSucceeded
      },
      focusSucceeded
        ? "notification_clicked"
        : (
          focusError &&
          typeof focusError.diagnosticCode === "string"
            ? focusError.diagnosticCode
            : "notification_focus_failed"
        )
    );
  } catch (error) {
    lifecycleError = error;
  }
  if (!focusSucceeded) {
    const dueAt = await releaseNotificationTargetClaim(
      notificationId,
      "clicked",
      Core.isoNow()
    );
    if (dueAt) {
      scheduleNotificationAutoClear(notificationId, dueAt);
    }
  }
  if (focusSucceeded) {
    await removeNotificationTarget(notificationId);
    try {
      await clearNotification(notificationId);
    } catch (error) {
      await recordErrorDiagnostic("notification_clear_failed", error, 0);
    }
  }
  if (lifecycleError) {
    throw lifecycleError;
  }
  return { focus_succeeded: focusSucceeded, action };
}

function focusNotificationTarget(notificationId) {
  if (notificationFocusOperations.has(notificationId)) {
    return notificationFocusOperations.get(notificationId);
  }
  const operation = runNotificationTargetFocus(notificationId).finally(() => {
    if (notificationFocusOperations.get(notificationId) === operation) {
      notificationFocusOperations.delete(notificationId);
    }
  });
  notificationFocusOperations.set(notificationId, operation);
  return operation;
}

async function autoClearNotification(notificationId) {
  const target = await claimNotificationTarget(notificationId, "timeout");
  if (!validStoredNotificationTarget(target)) {
    if (target) {
      await removeNotificationTarget(notificationId);
    }
    return { cleared: false, matched: false };
  }
  let matched;
  try {
    matched = await clearNotification(notificationId);
  } catch (error) {
    await releaseNotificationTargetClaim(notificationId, "timeout");
    await recordErrorDiagnostic("notification_clear_failed", error, 0);
    return { cleared: false, matched: false };
  }
  if (!matched) {
    await removeNotificationTarget(notificationId);
    return { cleared: false, matched: false };
  }
  try {
    await recordNotificationLifecycle(
      target,
      "tracker_notification_auto_cleared",
      {
        phase: "clear",
        reason_code: "notification_timeout",
        timeout_seconds: AUTO_CLEAR_SECONDS
      },
      "notification_auto_cleared"
    );
  } finally {
    await removeNotificationTarget(notificationId);
  }
  return { cleared: true, matched: true };
}

async function sweepExpiredNotifications() {
  await notificationTargetMutationChain;
  const result = await storageGet(NOTIFICATION_TARGETS_KEY);
  const targets = sanitizeNotificationTargetMap(
    result[NOTIFICATION_TARGETS_KEY]
  ).targets;
  const now = Date.now();
  for (const [notificationId, target] of Object.entries(targets)) {
    if (!target || target.terminal_state) {
      continue;
    }
    const dueMs = Date.parse(target.due_at);
    if (!Number.isFinite(dueMs)) {
      continue;
    }
    if (dueMs <= now) {
      await autoClearNotification(notificationId);
    } else {
      scheduleNotificationAutoClear(notificationId, target.due_at);
    }
  }
}

function ensureConversationQueueMigration() {
  if (!conversationQueueMigrationPromise) {
    conversationQueueMigrationPromise = migrateLegacyStorageSafely();
  }
  return conversationQueueMigrationPromise;
}

async function migrateLegacyStorageSafely() {
  const stored = await storageGet([
    LEGACY_PROFILE_SCOPE_KEY,
    QUEUE_KEY,
    LEGACY_QUEUE_QUARANTINE_KEY,
    NOTIFICATION_TARGETS_KEY
  ]);
  if (
    typeof stored[LEGACY_PROFILE_SCOPE_KEY] === "string" &&
    stored[LEGACY_PROFILE_SCOPE_KEY]
  ) {
    await recordDiagnostic(
      "legacy_scope_present_migration_required",
      0,
      null
    );
  }
  const queueMigration = sanitizeQueueState(stored[QUEUE_KEY]);
  if (queueMigration.legacy_unsafe_payload_blocked_count > 0) {
    await recordDiagnostic(
      "legacy_queue_unsafe_payload_blocked",
      0,
      null,
      { item_count: queueMigration.legacy_unsafe_payload_blocked_count }
    );
    throw makeDiagnosticError("legacy_queue_unsafe_payload_blocked");
  }
  if (
    queueMigration.changed_count > 0 ||
    queueMigration.rejected_count > 0
  ) {
    const storageUpdate = { [QUEUE_KEY]: queueMigration.state };
    if (queueMigration.quarantined.length > 0) {
      const existing = stored[LEGACY_QUEUE_QUARANTINE_KEY];
      if (
        typeof existing !== "undefined" &&
        !strictLegacyQueueQuarantine(existing)
      ) {
        throw makeDiagnosticError("legacy_queue_quarantine_store_invalid");
      }
      const existingRecords = existing ? existing.records : [];
      const quarantinedAt = new Date().toISOString();
      storageUpdate[LEGACY_QUEUE_QUARANTINE_KEY] = {
        schema_version: "1.0",
        records: existingRecords.concat(
          queueMigration.quarantined.map((entry) => ({
            quarantined_at: quarantinedAt,
            reason_code: entry.reason_code,
            record: entry.record
          }))
        )
      };
    }
    await storageSet(storageUpdate);
    if (queueMigration.changed_count > 0) {
      await recordDiagnostic(
        "legacy_queue_records_sanitized",
        0,
        null,
        { item_count: queueMigration.changed_count }
      );
    }
    if (queueMigration.rejected_count > 0) {
      await recordDiagnostic(
        "legacy_queue_records_rejected",
        0,
        null,
        { item_count: queueMigration.rejected_count }
      );
    }
    if (queueMigration.legacy_non_lifecycle_migrated_count > 0) {
      await recordDiagnostic(
        "legacy_queue_safe_non_lifecycle_migrated",
        0,
        null,
        { item_count: queueMigration.legacy_non_lifecycle_migrated_count }
      );
    }
    if (queueMigration.legacy_lifecycle_quarantined_count > 0) {
      await recordDiagnostic(
        "legacy_queue_lifecycle_quarantined_missing_turn_link",
        0,
        null,
        { item_count: queueMigration.legacy_lifecycle_quarantined_count }
      );
    }
    if (queueMigration.legacy_non_lifecycle_quarantined_count > 0) {
      await recordDiagnostic(
        "legacy_queue_non_lifecycle_quarantined_invalid",
        0,
        null,
        { item_count: queueMigration.legacy_non_lifecycle_quarantined_count }
      );
    }
  }
  const targetMigration = sanitizeNotificationTargetMap(
    stored[NOTIFICATION_TARGETS_KEY]
  );
  if (
    targetMigration.changed_count > 0 ||
    targetMigration.rejected_count > 0
  ) {
    await storageSet({
      [NOTIFICATION_TARGETS_KEY]: targetMigration.targets
    });
    await recordDiagnostic(
      "legacy_notification_targets_sanitized",
      0,
      null,
      {
        item_count:
          targetMigration.changed_count + targetMigration.rejected_count
      }
    );
  }
}

function acceptExactReopenContextAnnouncement(message, sender) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    Object.keys(message).length !== 3 ||
    !["type", "provider", "context"].every((key) =>
      Object.hasOwn(message, key)
    ) ||
    message.type !== "ANNOUNCE_EXACT_CONVERSATION_CONTEXT" ||
    !["chatgpt", "claude"].includes(message.provider) ||
    !sender ||
    sender.id !== chrome.runtime.id ||
    !sender.tab ||
    !Number.isInteger(sender.tab.id) ||
    !ReopenController.canonicalObservedContext(message.context)
  ) {
    return false;
  }
  const tab = Object.assign({}, sender.tab, {
    url: typeof sender.url === "string" ? sender.url : sender.tab.url
  });
  if (providerForTab(tab) !== message.provider) {
    return false;
  }
  notifyReopenCandidate(tab);
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }
  if (message.type === "ANNOUNCE_EXACT_CONVERSATION_CONTEXT") {
    sendResponse({
      accepted: acceptExactReopenContextAnnouncement(message, sender)
    });
    return false;
  }
  if (message.type === "AUTHORIZE_PRIVATE_RETURN_CUE") {
    if (Object.keys(message).length !== 1) {
      sendResponse({ authorized: false, reason: "request_rejected" });
      return false;
    }
    authorizePrivateReturnCue(sender)
      .then(sendResponse)
      .catch(() => sendResponse({
        authorized: false,
        reason: "request_rejected"
      }));
    return true;
  }
  if ([
    "GET_STUDY_SESSION_STATUS",
    "START_STUDY_SESSION",
    "STOP_STUDY_SESSION",
    "CANCEL_STUDY_SESSION"
  ].includes(message.type)) {
    if (
      Object.keys(message).length !== 1 ||
      !isTrustedExtensionPageSender(sender)
    ) {
      sendResponse({
        ok: false,
        error_code: "study_session_request_rejected"
      });
      return false;
    }
    handleStudySessionCommand(message.type)
      .then((status) => sendResponse({ ok: true, status }))
      .catch(async (error) => {
        const diagnostic = await recordErrorDiagnostic(
          "study_session_command_failed",
          error,
          0
        );
        sendResponse({ ok: false, error_code: diagnostic.code });
      });
    return true;
  }
  if (message.type === "EXPORT_PRIVATE_RETURN_CUES") {
    if (
      Object.keys(message).length !== 1 ||
      !isTrustedExtensionPageSender(sender) ||
      !sender.url.endsWith("/options.html")
    ) {
      sendResponse({
        ok: false,
        error_code: "private_cue_export_rejected"
      });
      return false;
    }
    runPrivateCueLifecycleExclusive(exportStoppedPrivateReturnCues)
      .then((result) => sendResponse({
        ok: true,
        filename: result.filename,
        sidecar: result.sidecar
      }))
      .catch(async (error) => {
        const diagnostic = await recordErrorDiagnostic(
          "private_cue_export_failed",
          error,
          0
        );
        sendResponse({ ok: false, error_code: diagnostic.code });
      });
    return true;
  }
  if (message.type === "GET_AUTHORITY_CONTEXT") {
    try {
      if (Object.keys(message).length !== 1) {
        throw new Error("authority_context_request_rejected");
      }
      Ingress.providerFromSender(sender, chrome.runtime.id);
      const nativeContext = authorityClient.context();
      if (nativeContext.status === "ready") {
        sendResponse(nativeContext);
      } else {
        localWebAuthority.context().then(sendResponse);
        return true;
      }
    } catch (_error) {
      sendResponse({
        status: "unavailable",
        reason: "authority_unavailable"
      });
    }
    return false;
  }
  if (message.type === "RESOLVE_CONVERSATION") {
    let request;
    try {
      request = Ingress.validateAuthorityRequest(
        message,
        sender,
        chrome.runtime.id
      );
    } catch (_error) {
      sendResponse({
        status: "unavailable",
        reason: "authority_unavailable"
      });
      return false;
    }
    const nativeContext = authorityClient.context();
    const operation = nativeContext.status === "ready"
      ? authorityClient.resolveFailClosed(request)
      : localWebAuthority.resolve(request);
    operation.then(sendResponse);
    return true;
  }
  if (message.type === "ENQUEUE_EVENTS") {
    let rebuiltEvents;
    let privateReturnCue = null;
    let privateCueAuthorizationId = null;
    try {
      if (
        Object.keys(message).some((key) =>
          ![
            "type",
            "events",
            "private_return_cue",
            "private_return_cue_authorization"
          ].includes(key)
        ) ||
        !Array.isArray(message.events) ||
        message.events.length < 1 ||
        message.events.length > 100
      ) {
        throw new Error("rejected_content_event:message_shape_invalid");
      }
      rebuiltEvents = message.events.map((event) =>
        Ingress.rebuildContentEvent(event, sender, chrome.runtime.id)
      );
      const cuePresent = Object.hasOwn(message, "private_return_cue");
      const authorizationPresent = Object.hasOwn(
        message,
        "private_return_cue_authorization"
      );
      if (cuePresent !== authorizationPresent) {
        throw makeDiagnosticError("private_cue_rejected");
      }
      if (cuePresent) {
        privateReturnCue = message.private_return_cue;
        privateCueAuthorizationId =
          message.private_return_cue_authorization;
        if (!/^pca_[0-9a-f]{32}$/.test(privateCueAuthorizationId || "")) {
          throw makeDiagnosticError("private_cue_rejected");
        }
        validatePrivateReturnCueAgainstEvents(privateReturnCue, rebuiltEvents);
      }
    } catch (_error) {
      sendResponse({ error: "rejected_content_event", rejected: true });
      return false;
    }
    const processResponse = async () => {
      let authorizedSessionId = null;
      if (privateReturnCue) {
        authorizedSessionId = await consumePrivateCueAuthorization(
          privateCueAuthorizationId,
          sender
        );
      }
      const completions = await processResponseSessionEvents(rebuiltEvents);
      if (!privateReturnCue || !authorizedSessionId) {
        return;
      }
      const authorization = completions.find(
        (item) =>
          item.raw_completion_id === privateReturnCue.raw_completion_id &&
          item.study_session_id === authorizedSessionId
      );
      if (!authorization) {
        return;
      }
      try {
        await persistPrivateReturnCue(
          privateReturnCue,
          authorization.study_session_id
        );
      } catch (error) {
        await recordErrorDiagnostic("private_cue_persist_failed", error, 0);
      }
    };
    const responseSessionOperation = privateReturnCue
      ? runPrivateCueLifecycleExclusive(processResponse)
      : processResponse();
    responseSessionOperation
      .catch((error) => recordErrorDiagnostic(
        "response_session_binding_failed",
        error,
        0
      ))
      .then(() => enqueueAndFlush(rebuiltEvents))
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "SHOW_TRACKER_NOTIFICATION") {
    let sanitizedMessage;
    try {
      sanitizedMessage = Ingress.validateNotificationRequest(
        message,
        sender,
        chrome.runtime.id
      );
    } catch (_error) {
      recordDiagnostic("notification_request_rejected", 0, null)
        .then(() => sendResponse({
          created: false,
          error_code: "notification_request_rejected",
          rejected: true
        }))
        .catch(() => sendResponse({
          created: false,
          error_code: "notification_request_rejected",
          rejected: true
        }));
      return true;
    }
    showTrackerNotification(sanitizedMessage, sender)
      .then(sendResponse)
      .catch(async (error) => {
        const diagnostic = await recordErrorDiagnostic(
          "notification_lifecycle_failed",
          error,
          0
        );
        sendResponse({ created: false, error_code: diagnostic.code });
      });
    return true;
  }
  if (message.type === "TEST_CONNECTION") {
    testActivityWatchConnection()
      .then(({ bucketId, sessionBucketId }) => sendResponse({
        ok: true,
        bucket_id: bucketId,
        session_bucket_id: sessionBucketId
      }))
      .catch(async (error) => {
        const diagnostic = await recordErrorDiagnostic(
          "options_test_failed",
          error,
          0
        );
        sendResponse({
          ok: false,
          error_code: diagnostic.code,
          http_status: diagnostic.http_status
        });
      });
    return true;
  }
  return false;
});

chrome.notifications.onClicked.addListener((notificationId) => {
  focusNotificationTarget(notificationId).catch((error) => {
    recordErrorDiagnostic("notification_focus_failed", error, 0);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  notifyReopenCandidate(tab);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (
    changeInfo &&
    (
      typeof changeInfo.url === "string" ||
      ["loading", "complete"].includes(changeInfo.status)
    )
  ) {
    notifyReopenCandidate(tab);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) {
    processQueueWithDiagnostics().catch((error) => {
      recordErrorDiagnostic("retry_alarm_failed", error, 0);
    });
    processSessionQueueWithDiagnostics()
      .then(refreshStudySessionIndicator)
      .catch((error) => {
        recordErrorDiagnostic("session_retry_alarm_failed", error, 0);
      });
    sweepExpiredNotifications().catch((error) => {
      recordErrorDiagnostic("notification_sweep_failed", error, 0);
    });
    purgePrivateReturnCues().catch((error) => {
      recordErrorDiagnostic("private_cue_ttl_purge_failed", error, 0);
    });
  } else if (alarm.name === HEARTBEAT_ALARM) {
    writeHeartbeat("sixty_second_alarm").catch((error) => {
      recordErrorDiagnostic("heartbeat_alarm_failed", error, 0);
    });
  } else if (alarm.name === STUDY_SESSION_WARNING_ALARM) {
    refreshStudySessionIndicator().catch((error) => {
      recordErrorDiagnostic("study_session_warning_failed", error, 0);
    });
  }
});

function initializeBackground() {
  if (!backgroundInitializationPromise) {
    backgroundInitializationPromise = (async () => {
      const alarmResults = await Promise.allSettled([
        ensurePeriodicAlarm(RETRY_ALARM, 0.5),
        ensurePeriodicAlarm(HEARTBEAT_ALARM, 1)
      ]);
      for (const result of alarmResults) {
        if (result.status === "rejected") {
          await recordErrorDiagnostic("alarm_setup_failed", result.reason, 0);
        }
      }
      await ensureConversationQueueMigration();
      await recoverInterruptedNotificationClaims();
      await sweepExpiredNotifications();
      await purgePrivateReturnCues();
      await processSessionQueueWithDiagnostics();
      await refreshStudySessionIndicator();
      return writeHeartbeat("worker_initialized");
    })().catch(async (error) => {
      const diagnostic = await recordErrorDiagnostic(
        "background_init_failed",
        error,
        0
      );
      backgroundInitializationPromise = null;
      return { status: "failed", diagnostic };
    });
  }
  return backgroundInitializationPromise;
}

function ensurePeriodicAlarm(name, periodInMinutes) {
  return new Promise((resolve, reject) => {
    chrome.alarms.get(name, (existing) => {
      if (chrome.runtime.lastError) {
        reject(makeDiagnosticError("alarm_get_failed"));
        return;
      }
      if (existing) {
        resolve(existing);
        return;
      }
      try {
        const creation = chrome.alarms.create(name, { periodInMinutes });
        if (creation && typeof creation.then === "function") {
          creation.then(resolve).catch(() => {
            reject(makeDiagnosticError("alarm_create_failed"));
          });
        } else {
          resolve();
        }
      } catch (_error) {
        reject(makeDiagnosticError("alarm_create_failed"));
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(initializeBackground);
chrome.runtime.onStartup.addListener(initializeBackground);
initializeBackground();
