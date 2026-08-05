(function initExportAuthority(global) {
  "use strict";

  if (!global.ParticipantConfig && typeof global.importScripts === "function") {
    global.importScripts("participant_config.js");
  }

  function diagnosticError(code) {
    const error = new Error(code);
    error.diagnosticCode = code;
    return error;
  }

  class MemoryBoundExportAuthority {
    constructor(configLoader) {
      this.configLoader = configLoader || global.ParticipantConfig;
      this.boundParticipantId = null;
    }

    async authorize() {
      if (!this.configLoader || typeof this.configLoader.load !== "function") {
        throw diagnosticError("participant_config_missing");
      }
      const config = await this.configLoader.load();
      if (!config || config.configured !== true) {
        throw diagnosticError(
          config && config.reason === "missing"
            ? "participant_config_missing"
            : "participant_config_invalid"
        );
      }
      if (
        this.boundParticipantId !== null &&
        this.boundParticipantId !== config.participant_id
      ) {
        throw diagnosticError("participant_config_conflict");
      }
      // This identity is retained in service-worker memory only. It is never
      // returned to the event writer, persisted, logged, or added to sidecars.
      this.boundParticipantId = config.participant_id;
      return true;
    }
  }

  global.AIConversation = global.AIConversation || {};
  global.AIConversation.ExportAuthority = Object.freeze({
    MemoryBoundExportAuthority
  });
})(globalThis);
