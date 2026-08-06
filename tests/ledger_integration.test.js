"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createHeartbeatEvent } = require("../src/heartbeat.js");
const { buildActivityWatchEvent } = require("../src/core.js");

function readSimpleCsv(filePath) {
  const lines = fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

test("real 08 contract fixture produces two conversations, three visits, and two turns in 09", () => {
  const ledger = path.join(__dirname, "support", "ai_conversation_ledger.py");
  assert.equal(fs.existsSync(ledger), true, "09 ledger implementation is required");
  const fixture = path.join(__dirname, "fixtures", "ledger_v1_events.json");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chi27-ledger-integration-"));
  const outDir = path.join(tempRoot, "regular");
  try {
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const result = spawnSync(python, [
      ledger,
      "--input",
      fixture,
      "--out-dir",
      outDir,
      "--observation-end",
      "2026-07-23T00:01:05Z",
      "--strict-health"
    ], {
      encoding: "utf8",
      timeout: 30000
    });
    assert.equal(
      result.status,
      0,
      `ledger failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(result.stdout, /AI conversation ledger: healthy/);
    assert.match(result.stdout, /events=17 conversations=2 visits=3 turns=2/);
    const safeEvents = fs.readFileSync(
      path.join(outDir, "ai_conversation_events.jsonl"),
      "utf8"
    ).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(safeEvents.length, 17);
    assert.equal(
      safeEvents.filter((event) => event.data.event_type === "user_engaged").length,
      1
    );
    const conversations = readSimpleCsv(path.join(outDir, "ai_conversations.csv"));
    assert.equal(
      conversations.reduce((total, row) => total + Number(row.engaged_count), 0),
      1
    );
    assert.equal(
      fs.readFileSync(path.join(outDir, "ai_visits.csv"), "utf8")
        .trim().split(/\r?\n/).length - 1,
      3
    );
    assert.equal(
      fs.readFileSync(path.join(outDir, "ai_turns.csv"), "utf8")
        .trim().split(/\r?\n/).length - 1,
      2
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("current v1.1 worker_initialized heartbeat remains strict-healthy in the support ledger", () => {
  const ledger = path.join(__dirname, "support", "ai_conversation_ledger.py");
  assert.equal(fs.existsSync(ledger), true, "09 ledger implementation is required");

  const occurredAt = "2026-07-24T00:00:00.000Z";
  const heartbeat = createHeartbeatEvent(
    occurredAt,
    "worker_initialized"
  );
  assert.equal(heartbeat.data.schema_version, "1.1");
  assert.equal(heartbeat.data.metadata.signal, "worker_initialized");

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "chi27-startup-heartbeat-integration-")
  );
  const fixture = path.join(tempRoot, "startup_heartbeat.json");
  const outDir = path.join(tempRoot, "regular");
  try {
    fs.writeFileSync(fixture, `${JSON.stringify([heartbeat])}\n`, "utf8");
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const result = spawnSync(python, [
      ledger,
      "--input",
      fixture,
      "--out-dir",
      outDir,
      "--observation-end",
      "2026-07-24T00:00:05Z",
      "--strict-health"
    ], {
      encoding: "utf8",
      timeout: 30000
    });
    assert.equal(
      result.status,
      0,
      `ledger failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(result.stdout, /AI conversation ledger: healthy/);

    const health = JSON.parse(
      fs.readFileSync(path.join(outDir, "ai_source_health.json"), "utf8")
    );
    assert.equal(health.status, "healthy");
    assert.equal(health.source_event_count, 1);
    assert.equal(health.liveness_event_count, 1);
    assert.equal(health.metadata_sanitization_issue_count, 0);

    const safeEvents = fs.readFileSync(
      path.join(outDir, "ai_conversation_events.jsonl"),
      "utf8"
    ).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(safeEvents.length, 1);
    assert.equal(safeEvents[0].data.event_type, "watcher_heartbeat");
    assert.deepEqual(safeEvents[0].data.metadata, {
      adapter_health: "healthy",
      signal: "worker_initialized"
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("support ledger pairs interleaved schema v1.1 lifecycles by turn_link_id", () => {
  const ledger = path.join(__dirname, "support", "ai_conversation_ledger.py");
  const conversation = {
    conversation_key: "a".repeat(64),
    identity_status: "exact",
    namespace_generation: 1,
    namespace_fingerprint: "fixture-namespace-fingerprint"
  };
  const linkA = "10000000-0000-4000-8000-000000000001";
  const linkB = "20000000-0000-4000-8000-000000000002";
  const linkC = "30000000-0000-4000-8000-000000000003";
  const lifecycle = [
    createHeartbeatEvent("2026-07-24T00:00:00.000Z", "worker_initialized")
  ];
  const specs = [
    ["prompt_submitted", linkA, 1],
    ["prompt_submitted", linkB, 2],
    ["assistant_response_started", linkB, 3],
    ["assistant_response_completed", linkB, 4],
    ["assistant_response_started", linkA, 5],
    ["assistant_response_completed", linkA, 6],
    ["prompt_submitted", linkC, 7],
    ["assistant_response_cancelled", linkC, 8]
  ];
  for (const [eventType, turnLinkId, second] of specs) {
    const occurredAt = `2026-07-24T00:00:0${second}.000Z`;
    const metadata = eventType === "prompt_submitted"
      ? {
        signal: "send_control_clicked",
        state_transition: "draft_to_submitted"
      }
      : eventType === "assistant_response_started"
        ? {
          signal: "response_active_marker_appeared",
          state_transition: "submitted_to_responding"
        }
        : eventType === "assistant_response_cancelled"
          ? {
            signal: "stop_control_clicked",
            state_transition: "responding_to_cancelled"
          }
          : {
            completion_signal: "response_active_marker_disappeared_after_settle",
            state_transition: "responding_to_completed"
          };
    lifecycle.push(buildActivityWatchEvent({
      provider: "claude",
      event_type: eventType,
      turn_link_id: turnLinkId,
      source_event_id: `00000000-0000-4000-8000-${String(second).padStart(12, "0")}`,
      occurred_at: occurredAt,
      observed_at: occurredAt,
      conversation,
      confidence: "derived",
      source_adapter: "claude-dom-v1",
      metadata
    }));
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chi27-ledger-v11-link-"));
  const fixture = path.join(tempRoot, "interleaved_v11.json");
  const outDir = path.join(tempRoot, "regular");
  try {
    fs.writeFileSync(fixture, `${JSON.stringify(lifecycle)}\n`, "utf8");
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const result = spawnSync(python, [
      ledger,
      "--input",
      fixture,
      "--out-dir",
      outDir,
      "--observation-end",
      "2026-07-24T00:00:09Z",
      "--strict-health"
    ], {
      encoding: "utf8",
      timeout: 30000
    });
    assert.equal(
      result.status,
      0,
      `ledger failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(result.stdout, /AI conversation ledger: healthy/);
    assert.match(result.stdout, /events=9 conversations=1 visits=1 turns=3/);

    const turns = readSimpleCsv(path.join(outDir, "ai_turns.csv"));
    assert.deepEqual(
      turns.map((turn) => [turn.submitted_at, turn.response_ended_at]),
      [
        ["2026-07-24T00:00:01.000000Z", "2026-07-24T00:00:06.000000Z"],
        ["2026-07-24T00:00:02.000000Z", "2026-07-24T00:00:04.000000Z"],
        ["2026-07-24T00:00:07.000000Z", "2026-07-24T00:00:08.000000Z"]
      ]
    );
    assert.equal(turns[2].outcome, "cancelled");
    const regularOutput = fs.readdirSync(outDir)
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(regularOutput, new RegExp(linkA));
    assert.doesNotMatch(regularOutput, new RegExp(linkB));
    assert.doesNotMatch(regularOutput, new RegExp(linkC));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
