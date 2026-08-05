(function initStudySessionController(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.StudySession = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function studySessionFactory() {
  "use strict";

  const SCHEMA_VERSION = "1.0";
  const WARNING_AFTER_MS = 90 * 60 * 1000;
  const SESSION_EVENT_TYPES = new Set([
    "study_session_started",
    "study_session_stopped",
    "study_session_cancelled"
  ]);
  const SESSION_SOURCES = new Set(["toolbar_popup"]);
  const SESSION_REASON_CODES = new Set(["participant_cancelled"]);
  const SESSION_DATA_KEYS = new Set([
    "schema_version",
    "event_type",
    "session_id",
    "occurred_at",
    "timezone",
    "utc_offset_minutes",
    "source",
    "start_utc",
    "end_utc",
    "reason_code"
  ]);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isCanonicalUtcIso(value) {
    if (typeof value !== "string" || !value.endsWith("Z")) {
      return false;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }

  function isIanaTimeZone(value) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 64 ||
      (!value.includes("/") && value !== "UTC")
    ) {
      return false;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function validateStudySessionEvent(event) {
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      event.duration !== 0 ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data) ||
      !isCanonicalUtcIso(event.timestamp)
    ) {
      return false;
    }
    if (
      Object.keys(event).some((key) => !["timestamp", "duration", "data"].includes(key)) ||
      Object.keys(event.data).some((key) => !SESSION_DATA_KEYS.has(key))
    ) {
      return false;
    }
    const data = event.data;
    if (
      data.schema_version !== SCHEMA_VERSION ||
      !SESSION_EVENT_TYPES.has(data.event_type) ||
      !UUID_PATTERN.test(data.session_id || "") ||
      !isCanonicalUtcIso(data.occurred_at) ||
      data.occurred_at !== event.timestamp ||
      !isIanaTimeZone(data.timezone) ||
      !Number.isInteger(data.utc_offset_minutes) ||
      data.utc_offset_minutes < -840 ||
      data.utc_offset_minutes > 840 ||
      !SESSION_SOURCES.has(data.source) ||
      !isCanonicalUtcIso(data.start_utc)
    ) {
      return false;
    }
    if (data.event_type === "study_session_started") {
      return (
        data.start_utc === data.occurred_at &&
        !Object.hasOwn(data, "end_utc") &&
        !Object.hasOwn(data, "reason_code")
      );
    }
    if (
      !isCanonicalUtcIso(data.end_utc) ||
      data.end_utc !== data.occurred_at ||
      Date.parse(data.end_utc) < Date.parse(data.start_utc)
    ) {
      return false;
    }
    if (data.event_type === "study_session_stopped") {
      return !Object.hasOwn(data, "reason_code");
    }
    return SESSION_REASON_CODES.has(data.reason_code);
  }

  function buildStudySessionEvent(input) {
    if (
      !input ||
      !SESSION_EVENT_TYPES.has(input.event_type) ||
      !UUID_PATTERN.test(input.session_id || "") ||
      !isCanonicalUtcIso(input.occurred_at) ||
      !isCanonicalUtcIso(input.start_utc) ||
      !isIanaTimeZone(input.timezone) ||
      !Number.isInteger(input.utc_offset_minutes) ||
      !SESSION_SOURCES.has(input.source)
    ) {
      throw new Error("invalid_study_session_marker");
    }
    const data = {
      schema_version: SCHEMA_VERSION,
      event_type: input.event_type,
      session_id: input.session_id,
      occurred_at: input.occurred_at,
      timezone: input.timezone,
      utc_offset_minutes: input.utc_offset_minutes,
      source: input.source,
      start_utc: input.start_utc
    };
    if (input.event_type !== "study_session_started") {
      data.end_utc = input.occurred_at;
    }
    if (input.event_type === "study_session_cancelled") {
      data.reason_code = "participant_cancelled";
    }
    const event = {
      timestamp: input.occurred_at,
      duration: 0,
      data
    };
    if (!validateStudySessionEvent(event)) {
      throw new Error("invalid_study_session_marker");
    }
    return event;
  }

  function studySessionEventId(event) {
    if (!validateStudySessionEvent(event)) {
      return "";
    }
    return `${event.data.session_id}:${event.data.event_type}`;
  }

  function inactiveState(previous) {
    const result = { status: "inactive" };
    if (
      previous &&
      UUID_PATTERN.test(previous.last_session_id || "") &&
      isCanonicalUtcIso(previous.last_start_utc) &&
      isCanonicalUtcIso(previous.last_end_utc) &&
      SESSION_EVENT_TYPES.has(previous.last_event_type) &&
      previous.last_event_type !== "study_session_started"
    ) {
      result.last_session_id = previous.last_session_id;
      result.last_start_utc = previous.last_start_utc;
      result.last_end_utc = previous.last_end_utc;
      result.last_event_type = previous.last_event_type;
    }
    return result;
  }

  function normalizeState(value) {
    if (
      value &&
      value.status === "active" &&
      UUID_PATTERN.test(value.session_id || "") &&
      isCanonicalUtcIso(value.start_utc) &&
      isIanaTimeZone(value.timezone) &&
      Number.isInteger(value.utc_offset_minutes) &&
      SESSION_SOURCES.has(value.source)
    ) {
      return {
        status: "active",
        session_id: value.session_id,
        start_utc: value.start_utc,
        timezone: value.timezone,
        utc_offset_minutes: value.utc_offset_minutes,
        source: value.source
      };
    }
    return inactiveState(value);
  }

  class StudySessionController {
    constructor(options) {
      this.store = options.store;
      this.emitMarker = options.emitMarker;
      this.pendingCount = options.pendingCount || (async () => 0);
      this.now = options.now || (() => Date.now());
      this.randomUuid = options.randomUuid;
      this.timeZone = options.timeZone || (() =>
        Intl.DateTimeFormat().resolvedOptions().timeZone
      );
      this.offsetMinutes = options.offsetMinutes || ((atMs) =>
        -new Date(atMs).getTimezoneOffset()
      );
      this.warningAfterMs = options.warningAfterMs || WARNING_AFTER_MS;
      this.operationChain = Promise.resolve();
    }

    runExclusive(operation) {
      const result = this.operationChain.then(operation, operation);
      this.operationChain = result.catch(() => {});
      return result;
    }

    async load() {
      return normalizeState(await this.store.get());
    }

    async describe(state) {
      const pending = Math.max(0, Number(await this.pendingCount()) || 0);
      if (state.status !== "active") {
        return Object.assign({}, state, {
          active: false,
          pending_count: pending,
          pending_sync: pending > 0
        });
      }
      const elapsedMs = Math.max(0, this.now() - Date.parse(state.start_utc));
      return Object.assign({}, state, {
        active: true,
        elapsed_seconds: Math.floor(elapsedMs / 1000),
        overdue: elapsedMs >= this.warningAfterMs,
        pending_count: pending,
        pending_sync: pending > 0,
        warning_at_utc: new Date(
          Date.parse(state.start_utc) + this.warningAfterMs
        ).toISOString()
      });
    }

    getStatus() {
      return this.runExclusive(async () => this.describe(await this.load()));
    }

    start() {
      return this.runExclusive(async () => {
        const current = await this.load();
        if (current.status === "active") {
          return Object.assign(
            { changed: false, reason: "already_active" },
            await this.describe(current)
          );
        }
        const nowMs = this.now();
        const occurredAt = new Date(nowMs).toISOString();
        const next = normalizeState({
          status: "active",
          session_id: this.randomUuid(),
          start_utc: occurredAt,
          timezone: this.timeZone(),
          utc_offset_minutes: this.offsetMinutes(nowMs),
          source: "toolbar_popup"
        });
        if (next.status !== "active") {
          throw new Error("invalid_study_session_state");
        }
        await this.store.set(next);
        await this.emitMarker(buildStudySessionEvent({
          event_type: "study_session_started",
          session_id: next.session_id,
          occurred_at: occurredAt,
          start_utc: occurredAt,
          timezone: next.timezone,
          utc_offset_minutes: next.utc_offset_minutes,
          source: next.source
        }));
        return Object.assign({ changed: true }, await this.describe(next));
      });
    }

    stop() {
      return this.finish("study_session_stopped");
    }

    cancel() {
      return this.finish("study_session_cancelled");
    }

    finish(eventType) {
      return this.runExclusive(async () => {
        const current = await this.load();
        if (current.status !== "active") {
          return Object.assign(
            { changed: false, reason: "not_active" },
            await this.describe(current)
          );
        }
        const nowMs = this.now();
        const occurredAt = new Date(nowMs).toISOString();
        const next = inactiveState({
          last_session_id: current.session_id,
          last_start_utc: current.start_utc,
          last_end_utc: occurredAt,
          last_event_type: eventType
        });
        await this.store.set(next);
        await this.emitMarker(buildStudySessionEvent({
          event_type: eventType,
          session_id: current.session_id,
          occurred_at: occurredAt,
          start_utc: current.start_utc,
          timezone: current.timezone,
          utc_offset_minutes: this.offsetMinutes(nowMs),
          source: current.source
        }));
        return Object.assign({ changed: true }, await this.describe(next));
      });
    }
  }

  return {
    SCHEMA_VERSION,
    SESSION_DATA_KEYS,
    SESSION_EVENT_TYPES,
    StudySessionController,
    WARNING_AFTER_MS,
    buildStudySessionEvent,
    normalizeState,
    studySessionEventId,
    validateStudySessionEvent
  };
});
