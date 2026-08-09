(function initParticipantConfig(global) {
  "use strict";

  const ID_PATTERN = /^P[0-9]{2,4}$/;
  const SURFACES = new Set([
    "web",
    "chatgpt_codex_app",
    "claude_code_runtime",
    "claude_cowork",
    "chatgpt_desktop_ordinary",
    "claude_desktop_ordinary"
  ]);

  function validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid_config_shape");
    }
    const keys = Object.keys(payload).sort();
    const legacy =
      keys.length === 2 &&
      keys[0] === "participant_id" &&
      keys[1] === "schema_version" &&
      payload.schema_version === "1.0";
    const current =
      keys.length === 3 &&
      keys[0] === "expected_surfaces" &&
      keys[1] === "participant_id" &&
      keys[2] === "schema_version" &&
      payload.schema_version === "2.0" &&
      Array.isArray(payload.expected_surfaces) &&
      payload.expected_surfaces.length > 0 &&
      payload.expected_surfaces[0] === "web" &&
      new Set(payload.expected_surfaces).size === payload.expected_surfaces.length &&
      payload.expected_surfaces.every((surface) => SURFACES.has(surface));
    if ((!legacy && !current) || !ID_PATTERN.test(payload.participant_id)) {
      throw new Error("invalid_participant_config");
    }
    return Object.freeze({
      configured: true,
      participant_id: payload.participant_id,
      expected_surfaces: Object.freeze(
        current ? payload.expected_surfaces.slice() : ["web"]
      )
    });
  }

  async function load() {
    try {
      const url = chrome.runtime.getURL("participant_config.json");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        return Object.freeze({ configured: false, reason: "missing" });
      }
      return validate(await response.json());
    } catch (_error) {
      return Object.freeze({ configured: false, reason: "missing_or_invalid" });
    }
  }

  global.ParticipantConfig = Object.freeze({ load, validate });
})(globalThis);
