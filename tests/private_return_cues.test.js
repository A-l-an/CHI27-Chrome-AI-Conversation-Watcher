"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const PrivateReturnCues = require("../src/private_return_cues.js");

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "private_return_cues_v1_golden.json"),
  "utf8"
));
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const COMPLETION_TIME = "2026-07-30T00:00:02.000Z";
const CREATED_AT = "2026-07-30T00:00:03.000Z";
const BEFORE_EXPIRY = Date.parse("2026-08-01T00:00:00.000Z");

function cue(overrides = {}) {
  return Object.assign({
    raw_completion_id: fixture.event_link_vectors[0].raw_completion_id,
    provider: "chatgpt",
    completion_time: COMPLETION_TIME,
    label: "注意力切换可分为三个阶段",
    generator: PrivateReturnCues.GENERATOR,
    version: PrivateReturnCues.GENERATOR_VERSION,
    status: "generated"
  }, overrides);
}

async function storedRecord(overrides = {}) {
  const source = cue(overrides.cue || {});
  const linkedId = overrides.event_link_id || await PrivateReturnCues.eventLinkId(
    source.raw_completion_id,
    crypto.webcrypto
  );
  return PrivateReturnCues.buildStoredRecord(
    source,
    overrides.study_session_id || SESSION_ID,
    linkedId,
    BEFORE_EXPIRY
  );
}

test("deterministic_response_preview_v1 matches every machine-readable label vector", () => {
  for (const vector of fixture.label_vectors) {
    assert.deepEqual(
      PrivateReturnCues.generateDeterministicLabel(vector.input),
      { label: vector.label, status: vector.status },
      vector.name
    );
  }
});

test("auto labels are at most 24 Unicode characters and edited labels accept only 1-40 safe characters", () => {
  const auto = PrivateReturnCues.generateDeterministicLabel(
    "这是一个足够长并且需要被截断但仍然可以识别具体主题的中文回答标签。"
  );
  assert.equal(auto.status, "generated");
  assert.ok(PrivateReturnCues.unicodeLength(auto.label) <= 24);
  assert.equal(PrivateReturnCues.validateUserEditedLabel("人工标签"), "人工标签");
  assert.equal(
    PrivateReturnCues.validateUserEditedLabel("甲".repeat(40)),
    "甲".repeat(40)
  );
  assert.equal(PrivateReturnCues.validateUserEditedLabel(""), null);
  assert.equal(PrivateReturnCues.validateUserEditedLabel("甲".repeat(41)), null);
  assert.equal(
    PrivateReturnCues.validateUserEditedLabel("contact@example.com"),
    null
  );
});

test("JavaScript SHA-256 event links match the shared golden vectors", async () => {
  for (const vector of fixture.event_link_vectors) {
    assert.equal(
      await PrivateReturnCues.eventLinkId(
        vector.raw_completion_id,
        crypto.webcrypto
      ),
      vector.event_link_id
    );
  }
});

test("machine-readable sidecar example is accepted by the closed schema", () => {
  const contract = fixture.closed_schema_contract;
  assert.equal(
    PrivateReturnCues.validateExportSidecar(
      fixture.sidecar_example,
      BEFORE_EXPIRY
    ),
    true
  );
  assert.deepEqual(
    Object.keys(fixture.sidecar_example).sort(),
    contract.top_level_fields.slice().sort()
  );
  assert.deepEqual(
    Object.keys(fixture.sidecar_example.records[0]).sort(),
    contract.record_fields.slice().sort()
  );
  assert.equal(contract.artifact_class, PrivateReturnCues.ARTIFACT_CLASS);
  assert.equal(contract.generator, PrivateReturnCues.GENERATOR);
  assert.equal(contract.version, PrivateReturnCues.GENERATOR_VERSION);
  assert.deepEqual(
    Array.from(new Set(fixture.label_vectors.map((vector) => vector.status))).sort(),
    contract.statuses.slice().sort()
  );
});

test("cue derivation waits for one explicit active-session authorization", async () => {
  const event = {
    data: {
      event_type: "assistant_response_completed",
      source_event_id: fixture.event_link_vectors[0].raw_completion_id,
      provider: "chatgpt",
      occurred_at: COMPLETION_TIME
    }
  };
  let inactiveChecks = 0;
  const inactive = await PrivateReturnCues.buildPrivateCueAfterAuthorization(
    async () => {
      inactiveChecks += 1;
      return { authorized: false, reason: "study_session_inactive" };
    },
    event,
    "This preview must not be derived while inactive.",
    Date.parse(COMPLETION_TIME)
  );
  assert.equal(inactiveChecks, 1);
  assert.equal(inactive, null);

  const nowMs = Date.parse(COMPLETION_TIME);
  const active = await PrivateReturnCues.buildPrivateCueAfterAuthorization(
    async (...authorizationArguments) => {
      assert.deepEqual(authorizationArguments, []);
      return {
        authorized: true,
        authorization_id: `pca_${"a".repeat(32)}`,
        expires_at_utc: new Date(nowMs + 5000).toISOString()
      };
    },
    event,
    "Attention shifts have measurable costs.",
    nowMs
  );
  assert.equal(active.authorization_id, `pca_${"a".repeat(32)}`);
  assert.equal(active.cue.status, "generated");
});

test("private store retains only the short label and opaque event link", async () => {
  const rawPreview = "Attention shifts are costly. THIS TRAILING PREVIEW MUST NOT PERSIST";
  const generated = PrivateReturnCues.generateDeterministicLabel(rawPreview);
  const source = cue({ label: generated.label, status: generated.status });
  const linkedId = await PrivateReturnCues.eventLinkId(
    source.raw_completion_id,
    crypto.webcrypto
  );
  const record = PrivateReturnCues.buildStoredRecord(
    source,
    SESSION_ID,
    linkedId,
    BEFORE_EXPIRY
  );
  assert.deepEqual(Object.keys(record).sort(), [
    "completion_time",
    "event_link_id",
    "expires_at_utc",
    "generator",
    "label",
    "provider",
    "status",
    "study_session_id",
    "version"
  ]);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /THIS TRAILING PREVIEW MUST NOT PERSIST/);
  assert.doesNotMatch(serialized, new RegExp(source.raw_completion_id));
  for (const forbiddenKey of [
    "response_preview",
    "raw_completion_id",
    "prompt",
    "embedding",
    "hash"
  ]) {
    assert.equal(Object.hasOwn(record, forbiddenKey), false);
  }
  assert.match(record.event_link_id, /^evt_[0-9a-f]{20}$/);
});

test("U+061C is stripped during generation and rejected in private records", async () => {
  assert.deepEqual(
    PrivateReturnCues.generateDeterministicLabel("Useful\u061c finding"),
    { label: "Useful finding", status: "generated" }
  );
  const poisonedCue = cue({ label: "Unsafe\u061c label" });
  assert.equal(
    PrivateReturnCues.validatePrivateCue(poisonedCue, BEFORE_EXPIRY),
    false
  );
  const record = await storedRecord();
  record.label = "Unsafe\u061c label";
  assert.equal(
    PrivateReturnCues.validateStoredRecord(record, BEFORE_EXPIRY),
    false
  );
});

test("completion, export creation, and expiry obey causal clock-skew boundaries", async () => {
  const nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  const atBoundary = cue({
    completion_time: new Date(
      nowMs + PrivateReturnCues.MAX_CLOCK_SKEW_MS
    ).toISOString()
  });
  assert.equal(PrivateReturnCues.validatePrivateCue(atBoundary, nowMs), true);
  const beyondBoundary = Object.assign({}, atBoundary, {
    completion_time: new Date(
      nowMs + PrivateReturnCues.MAX_CLOCK_SKEW_MS + 1
    ).toISOString()
  });
  assert.equal(PrivateReturnCues.validatePrivateCue(beyondBoundary, nowMs), false);

  const linkedId = await PrivateReturnCues.eventLinkId(
    atBoundary.raw_completion_id,
    crypto.webcrypto
  );
  const record = PrivateReturnCues.buildStoredRecord(
    atBoundary,
    SESSION_ID,
    linkedId,
    nowMs
  );
  const beforeCompletion = {
    schema_version: PrivateReturnCues.EXPORT_SCHEMA_VERSION,
    artifact_class: PrivateReturnCues.ARTIFACT_CLASS,
    study_session_id: SESSION_ID,
    created_at_utc: new Date(
      Date.parse(record.completion_time) - 1
    ).toISOString(),
    records: [{
      event_link_id: record.event_link_id,
      provider: record.provider,
      completion_time: record.completion_time,
      label: record.label,
      generator: record.generator,
      version: record.version,
      status: record.status,
      expires_at_utc: record.expires_at_utc
    }]
  };
  assert.equal(
    PrivateReturnCues.validateExportSidecar(beforeCompletion, nowMs),
    false
  );
  const createdTooFarFuture = structuredClone(beforeCompletion);
  createdTooFarFuture.created_at_utc = new Date(
    nowMs + PrivateReturnCues.MAX_CLOCK_SKEW_MS + 1
  ).toISOString();
  assert.equal(
    PrivateReturnCues.validateExportSidecar(createdTooFarFuture, nowMs),
    false
  );

  const extendedExpiry = structuredClone(record);
  extendedExpiry.expires_at_utc = new Date(
    Date.parse(record.expires_at_utc) + 1
  ).toISOString();
  assert.equal(
    PrivateReturnCues.validateStoredRecord(extendedExpiry, nowMs),
    false
  );
});

test("closed sidecar accepts valid records and rejects unknown, duplicate, invalid, controlled, and expired records", async () => {
  const record = await storedRecord();
  const valid = PrivateReturnCues.buildExportSidecar(
    [record],
    SESSION_ID,
    CREATED_AT,
    BEFORE_EXPIRY
  );
  assert.equal(
    PrivateReturnCues.validateExportSidecar(valid, BEFORE_EXPIRY),
    true
  );
  assert.equal(JSON.stringify(valid).includes("study_session_id\":\"111"), true);
  assert.equal(Object.hasOwn(valid.records[0], "study_session_id"), false);

  const unknown = structuredClone(valid);
  unknown.records[0].url = "https://example.com";
  assert.equal(PrivateReturnCues.validateExportSidecar(unknown, BEFORE_EXPIRY), false);

  const duplicate = structuredClone(valid);
  duplicate.records.push(structuredClone(duplicate.records[0]));
  assert.equal(PrivateReturnCues.validateExportSidecar(duplicate, BEFORE_EXPIRY), false);

  const invalidTime = structuredClone(valid);
  invalidTime.records[0].completion_time = "2026-07-30 00:00:02";
  assert.equal(PrivateReturnCues.validateExportSidecar(invalidTime, BEFORE_EXPIRY), false);

  const controlled = structuredClone(valid);
  controlled.records[0].label = "unsafe\u202elabel";
  assert.equal(PrivateReturnCues.validateExportSidecar(controlled, BEFORE_EXPIRY), false);

  assert.equal(
    PrivateReturnCues.validateExportSidecar(
      valid,
      Date.parse(valid.records[0].expires_at_utc)
    ),
    false
  );
});

test("store sanitizer expires old records, drops corrupt records, and enforces the 500-record cap", async () => {
  const valid = await storedRecord();
  const corrupt = Object.assign({}, valid, { raw_completion_id: "raw-secret" });
  const expiredNow = Date.parse(valid.expires_at_utc);
  const expired = PrivateReturnCues.sanitizeStoreState({
    schema_version: PrivateReturnCues.STORE_SCHEMA_VERSION,
    records: [valid, corrupt]
  }, expiredNow);
  assert.deepEqual(expired.state.records, []);
  assert.equal(expired.expired_count, 1);
  assert.equal(expired.rejected_count, 1);

  const baseTime = Date.parse("2026-07-30T00:00:02.000Z");
  const many = Array.from({ length: 501 }, (_unused, index) => {
    const completionTime = new Date(baseTime + index).toISOString();
    return Object.assign({}, valid, {
      event_link_id: `evt_${index.toString(16).padStart(20, "0")}`,
      completion_time: completionTime,
      expires_at_utc: new Date(
        Date.parse(completionTime) + PrivateReturnCues.RECORD_TTL_MS
      ).toISOString()
    });
  });
  const capped = PrivateReturnCues.sanitizeStoreState({
    schema_version: PrivateReturnCues.STORE_SCHEMA_VERSION,
    records: many
  }, BEFORE_EXPIRY);
  assert.equal(capped.state.records.length, 500);
  assert.equal(capped.rejected_count, 1);
});
