(function initParticipantConfig(global) {
  "use strict";

  const ID_PATTERN = /^P[0-9]{2,4}$/;

  function validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid_config_shape");
    }
    const keys = Object.keys(payload).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "participant_id" ||
      keys[1] !== "schema_version" ||
      payload.schema_version !== "1.0" ||
      !ID_PATTERN.test(payload.participant_id)
    ) {
      throw new Error("invalid_participant_config");
    }
    return Object.freeze({
      configured: true,
      participant_id: payload.participant_id
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
