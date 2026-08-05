(function initPrivateReturnCues(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.PrivateReturnCues = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function privateReturnCuesFactory() {
  "use strict";

  const STORE_SCHEMA_VERSION = "1.0";
  const EXPORT_SCHEMA_VERSION = "chi27-rta-private-return-cues/1.0";
  const ARTIFACT_CLASS = "local_content_derived_private";
  const GENERATOR = "deterministic_response_preview_v1";
  const GENERATOR_VERSION = "1.0";
  const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_RECORDS = 500;
  const MAX_EXPORT_BYTES = 1024 * 1024;
  const MAX_AUTO_LABEL_CHARS = 24;
  const MAX_EDITED_LABEL_CHARS = 40;
  const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const EVENT_LINK_PATTERN = /^evt_[0-9a-f]{20}$/;
  const AUTHORIZATION_ID_PATTERN = /^pca_[0-9a-f]{32}$/;
  const SESSION_ID_PATTERN = UUID_PATTERN;
  const PROVIDERS = new Set(["chatgpt", "claude"]);
  const STATUSES = new Set([
    "generated",
    "sensitive_pattern_blocked",
    "low_information"
  ]);
  const PRIVATE_CUE_KEYS = new Set([
    "raw_completion_id",
    "provider",
    "completion_time",
    "label",
    "generator",
    "version",
    "status"
  ]);
  const STORED_RECORD_KEYS = new Set([
    "study_session_id",
    "event_link_id",
    "provider",
    "completion_time",
    "label",
    "generator",
    "version",
    "status",
    "expires_at_utc"
  ]);
  const EXPORT_RECORD_KEYS = new Set([
    "event_link_id",
    "provider",
    "completion_time",
    "label",
    "generator",
    "version",
    "status",
    "expires_at_utc"
  ]);
  const EXPORT_KEYS = new Set([
    "schema_version",
    "artifact_class",
    "study_session_id",
    "created_at_utc",
    "records"
  ]);
  const GENERIC_OPENINGS = [
    /^(?:当然|好的|好呀|可以|没问题|以下是|这里是|总结一下|简而言之|首先|根据你的要求)(?:[，,。.!！：:]|\s)*/i,
    /^(?:sure|certainly|of course|okay|ok|here(?:'s| is| are)|in summary|to summarize|first(?:ly)?)(?:[,.!:\s]|$)*/i
  ];
  const LOW_INFORMATION = new Set([
    "好", "好的", "好呀", "可以", "没问题", "收到", "明白", "完成", "谢谢",
    "ok", "okay", "sure", "yes", "no", "done", "thanks", "thank you"
  ]);

  function hasOnlyKeys(value, allowed) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.has(key))
    );
  }

  function unicodeLength(value) {
    return Array.from(value || "").length;
  }

  function isCanonicalUtcIso(value) {
    if (typeof value !== "string" || !value.endsWith("Z")) {
      return false;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }

  function normalizeSource(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value
      .normalize("NFKC")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ")
      .replace(/[\t\v\f ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function containsSensitivePattern(value) {
    if (!value) {
      return false;
    }
    const patterns = [
      /(?:https?|ftp):\/\/|\bwww\./i,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
      /(?:^|[\s("'\[])(?:~\/|\.{1,2}\/|\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\|\\\\)[^\s)"'\]]+/i,
      /@[A-Za-z0-9_]{2,}/,
      /\b(?:sk|pk|api|token|bearer|secret|loc|rpa)_[A-Za-z0-9_-]{12,}\b/i,
      /\b[A-Fa-f0-9]{24,}\b/,
      /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/
    ];
    if (patterns.some((pattern) => pattern.test(value))) {
      return true;
    }
    const phoneOrLongDigits = value.match(/\+?\d[\d ()-]{5,}\d/g) || [];
    return phoneOrLongDigits.some(
      (candidate) => (candidate.match(/\d/g) || []).length >= 7
    );
  }

  function stripMarkdownWrappers(value) {
    return value
      .replace(/```[^\n`]*\n?/g, " ")
      .replace(/```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(?:\*\*|__|~~)(.*?)(?:\*\*|__|~~)/g, "$1")
      .replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=\s|$)/g, "$1")
      .trim();
  }

  function removeGenericOpenings(value) {
    let result = value.trim();
    let changed = true;
    while (result && changed) {
      changed = false;
      for (const pattern of GENERIC_OPENINGS) {
        const next = result.replace(pattern, "").trim();
        if (next !== result) {
          result = next;
          changed = true;
        }
      }
    }
    return result;
  }

  function cleanClause(value) {
    return removeGenericOpenings(value)
      .replace(/^[\s\-–—:：,，.。!！?？;；]+|[\s\-–—:：,，.。!！?？;；]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncateLabel(value, limit) {
    const chars = Array.from(value);
    if (chars.length <= limit) {
      return value;
    }
    const truncated = chars.slice(0, limit).join("");
    if (/^[\x00-\x7f]+$/.test(truncated)) {
      const lastSpace = truncated.lastIndexOf(" ");
      if (lastSpace >= Math.floor(limit * 0.55)) {
        return truncated.slice(0, lastSpace).trim();
      }
    }
    return truncated.trim();
  }

  function generateDeterministicLabel(value) {
    const normalized = normalizeSource(value);
    if (!normalized) {
      return { label: "", status: "low_information" };
    }
    if (containsSensitivePattern(normalized)) {
      return { label: "", status: "sensitive_pattern_blocked" };
    }
    const withoutWrappers = stripMarkdownWrappers(normalized);
    const sentences = withoutWrappers.split(/[。！？!?；;\n]+/u);
    for (const sentence of sentences) {
      const clauses = sentence.split(/[，,：:]+/u);
      for (const rawClause of clauses) {
        const clause = cleanClause(rawClause);
        if (
          unicodeLength(clause) < 4 ||
          LOW_INFORMATION.has(clause.toLocaleLowerCase("en-US"))
        ) {
          continue;
        }
        const label = truncateLabel(clause, MAX_AUTO_LABEL_CHARS);
        if (unicodeLength(label) >= 4 && !containsSensitivePattern(label)) {
          return { label, status: "generated" };
        }
      }
    }
    return { label: "", status: "low_information" };
  }

  function validateUserEditedLabel(value) {
    const normalized = normalizeSource(value).replace(/\n+/g, " ").trim();
    if (
      unicodeLength(normalized) < 1 ||
      unicodeLength(normalized) > MAX_EDITED_LABEL_CHARS ||
      containsSensitivePattern(normalized)
    ) {
      return null;
    }
    return normalized;
  }

  function validatePrivateCue(value, nowMs) {
    const validationNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (
      !hasOnlyKeys(value, PRIVATE_CUE_KEYS) ||
      Object.keys(value).length !== PRIVATE_CUE_KEYS.size ||
      !UUID_PATTERN.test(value.raw_completion_id || "") ||
      !PROVIDERS.has(value.provider) ||
      !isCanonicalUtcIso(value.completion_time) ||
      Date.parse(value.completion_time) > validationNow + MAX_CLOCK_SKEW_MS ||
      value.generator !== GENERATOR ||
      value.version !== GENERATOR_VERSION ||
      !STATUSES.has(value.status) ||
      typeof value.label !== "string"
    ) {
      return false;
    }
    const labelLength = unicodeLength(value.label);
    if (value.status === "generated") {
      return (
        labelLength >= 4 &&
        labelLength <= MAX_AUTO_LABEL_CHARS &&
        normalizeSource(value.label).replace(/\n+/g, " ") === value.label &&
        !containsSensitivePattern(value.label)
      );
    }
    return value.label === "";
  }

  function buildPrivateCue(event, responsePreview, nowMs) {
    if (
      !event ||
      !event.data ||
      event.data.event_type !== "assistant_response_completed"
    ) {
      return null;
    }
    const generated = generateDeterministicLabel(responsePreview);
    const result = {
      raw_completion_id: event.data.source_event_id,
      provider: event.data.provider,
      completion_time: event.data.occurred_at,
      label: generated.label,
      generator: GENERATOR,
      version: GENERATOR_VERSION,
      status: generated.status
    };
    return validatePrivateCue(result, nowMs) ? result : null;
  }

  async function buildPrivateCueAfterAuthorization(
    requestAuthorization,
    event,
    responsePreview,
    nowMs
  ) {
    if (typeof requestAuthorization !== "function") {
      return null;
    }
    const authorization = await requestAuthorization();
    if (
      !authorization ||
      authorization.authorized !== true ||
      !AUTHORIZATION_ID_PATTERN.test(authorization.authorization_id || "") ||
      !isCanonicalUtcIso(authorization.expires_at_utc) ||
      Date.parse(authorization.expires_at_utc) <=
        (Number.isFinite(nowMs) ? nowMs : Date.now())
    ) {
      return null;
    }
    const cue = buildPrivateCue(event, responsePreview, nowMs);
    if (!cue) {
      return null;
    }
    return {
      authorization_id: authorization.authorization_id,
      cue
    };
  }

  async function eventLinkId(rawCompletionId, cryptoImpl) {
    if (!UUID_PATTERN.test(rawCompletionId || "")) {
      throw new Error("private_cue_raw_id_invalid");
    }
    const cryptoApi = cryptoImpl || globalThis.crypto;
    if (!cryptoApi || !cryptoApi.subtle) {
      throw new Error("private_cue_crypto_unavailable");
    }
    const digest = await cryptoApi.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(rawCompletionId)
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    return `evt_${hex.slice(0, 20)}`;
  }

  function validateStoredRecord(value, nowMs) {
    const validationNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (
      !hasOnlyKeys(value, STORED_RECORD_KEYS) ||
      Object.keys(value).length !== STORED_RECORD_KEYS.size ||
      !SESSION_ID_PATTERN.test(value.study_session_id || "") ||
      !EVENT_LINK_PATTERN.test(value.event_link_id || "") ||
      !PROVIDERS.has(value.provider) ||
      !isCanonicalUtcIso(value.completion_time) ||
      Date.parse(value.completion_time) > validationNow + MAX_CLOCK_SKEW_MS ||
      !isCanonicalUtcIso(value.expires_at_utc) ||
      value.generator !== GENERATOR ||
      value.version !== GENERATOR_VERSION ||
      !STATUSES.has(value.status) ||
      typeof value.label !== "string" ||
      Date.parse(value.expires_at_utc) !==
        Date.parse(value.completion_time) + RECORD_TTL_MS
    ) {
      return false;
    }
    if (value.status === "generated") {
      return (
        unicodeLength(value.label) >= 4 &&
        unicodeLength(value.label) <= MAX_AUTO_LABEL_CHARS &&
        validateUserEditedLabel(value.label) === value.label
      );
    }
    return value.label === "";
  }

  function buildStoredRecord(cue, studySessionId, linkedId, nowMs) {
    if (
      !validatePrivateCue(cue, nowMs) ||
      !SESSION_ID_PATTERN.test(studySessionId || "") ||
      !EVENT_LINK_PATTERN.test(linkedId || "")
    ) {
      throw new Error("private_cue_record_invalid");
    }
    const result = {
      study_session_id: studySessionId,
      event_link_id: linkedId,
      provider: cue.provider,
      completion_time: cue.completion_time,
      label: cue.label,
      generator: cue.generator,
      version: cue.version,
      status: cue.status,
      expires_at_utc: new Date(
        Date.parse(cue.completion_time) + RECORD_TTL_MS
      ).toISOString()
    };
    if (!validateStoredRecord(result, nowMs)) {
      throw new Error("private_cue_record_invalid");
    }
    return result;
  }

  function sanitizeStoreState(value, nowMs) {
    const records = [];
    const seen = new Set();
    let rejectedCount = 0;
    let expiredCount = 0;
    const source = (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      value.schema_version === STORE_SCHEMA_VERSION &&
      Array.isArray(value.records)
    ) ? value.records : [];
    if (source !== (value && value.records)) {
      rejectedCount += 1;
    }
    for (const record of source) {
      if (!validateStoredRecord(record, nowMs) || seen.has(record.event_link_id)) {
        rejectedCount += 1;
        continue;
      }
      if (Date.parse(record.expires_at_utc) <= nowMs) {
        expiredCount += 1;
        continue;
      }
      seen.add(record.event_link_id);
      records.push(Object.assign({}, record));
    }
    records.sort((left, right) =>
      Date.parse(left.completion_time) - Date.parse(right.completion_time) ||
      left.event_link_id.localeCompare(right.event_link_id)
    );
    if (records.length > MAX_RECORDS) {
      rejectedCount += records.length - MAX_RECORDS;
      records.splice(0, records.length - MAX_RECORDS);
    }
    return {
      state: { schema_version: STORE_SCHEMA_VERSION, records },
      rejected_count: rejectedCount,
      expired_count: expiredCount
    };
  }

  function exportRecord(record) {
    return {
      event_link_id: record.event_link_id,
      provider: record.provider,
      completion_time: record.completion_time,
      label: record.label,
      generator: record.generator,
      version: record.version,
      status: record.status,
      expires_at_utc: record.expires_at_utc
    };
  }

  function validateExportRecord(value, createdAtMs, nowMs) {
    if (
      !hasOnlyKeys(value, EXPORT_RECORD_KEYS) ||
      Object.keys(value).length !== EXPORT_RECORD_KEYS.size
    ) {
      return false;
    }
    const withSession = Object.assign({
      study_session_id: "00000000-0000-4000-8000-000000000000"
    }, value);
    return (
      validateStoredRecord(withSession, nowMs) &&
      Date.parse(value.completion_time) <= createdAtMs &&
      Date.parse(value.expires_at_utc) > nowMs
    );
  }

  function validateExportSidecar(value, nowMs) {
    if (
      !hasOnlyKeys(value, EXPORT_KEYS) ||
      Object.keys(value).length !== EXPORT_KEYS.size ||
      value.schema_version !== EXPORT_SCHEMA_VERSION ||
      value.artifact_class !== ARTIFACT_CLASS ||
      !SESSION_ID_PATTERN.test(value.study_session_id || "") ||
      !isCanonicalUtcIso(value.created_at_utc) ||
      Date.parse(value.created_at_utc) > nowMs + MAX_CLOCK_SKEW_MS ||
      !Array.isArray(value.records) ||
      value.records.length > MAX_RECORDS
    ) {
      return false;
    }
    const createdAtMs = Date.parse(value.created_at_utc);
    const seen = new Set();
    for (const record of value.records) {
      if (
        !validateExportRecord(record, createdAtMs, nowMs) ||
        seen.has(record.event_link_id)
      ) {
        return false;
      }
      seen.add(record.event_link_id);
    }
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_EXPORT_BYTES;
  }

  function buildExportSidecar(records, studySessionId, createdAtUtc, nowMs) {
    if (
      !SESSION_ID_PATTERN.test(studySessionId || "") ||
      !isCanonicalUtcIso(createdAtUtc) ||
      !Array.isArray(records) ||
      records.length > MAX_RECORDS
    ) {
      throw new Error("private_cue_export_invalid");
    }
    const selected = records
      .filter((record) => record.study_session_id === studySessionId)
      .map((record) => {
        if (!validateStoredRecord(record, nowMs)) {
          throw new Error("private_cue_export_invalid");
        }
        return exportRecord(record);
      })
      .sort((left, right) =>
        Date.parse(left.completion_time) - Date.parse(right.completion_time) ||
        left.event_link_id.localeCompare(right.event_link_id)
      );
    const result = {
      schema_version: EXPORT_SCHEMA_VERSION,
      artifact_class: ARTIFACT_CLASS,
      study_session_id: studySessionId,
      created_at_utc: createdAtUtc,
      records: selected
    };
    if (!validateExportSidecar(result, nowMs)) {
      throw new Error("private_cue_export_invalid");
    }
    return result;
  }

  return {
    ARTIFACT_CLASS,
    EXPORT_SCHEMA_VERSION,
    GENERATOR,
    GENERATOR_VERSION,
    MAX_CLOCK_SKEW_MS,
    MAX_AUTO_LABEL_CHARS,
    MAX_EDITED_LABEL_CHARS,
    MAX_EXPORT_BYTES,
    MAX_RECORDS,
    RECORD_TTL_MS,
    STORE_SCHEMA_VERSION,
    buildExportSidecar,
    buildPrivateCue,
    buildPrivateCueAfterAuthorization,
    buildStoredRecord,
    containsSensitivePattern,
    eventLinkId,
    generateDeterministicLabel,
    isCanonicalUtcIso,
    normalizeSource,
    sanitizeStoreState,
    unicodeLength,
    validateExportSidecar,
    validatePrivateCue,
    validateStoredRecord,
    validateUserEditedLabel
  };
});
