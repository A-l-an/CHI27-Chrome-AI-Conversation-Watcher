(function initHeartbeat(root, factory) {
  const core = typeof module === "object" && module.exports
    ? require("./core.js")
    : root.AIConversation.Core;
  const api = factory(core);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.Heartbeat = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function heartbeatFactory(Core) {
  "use strict";

  function createHeartbeatEvent(at, signal) {
    const timestamp = at || Core.isoNow();
    return Core.buildActivityWatchEvent({
      provider: "watcher",
      event_type: "watcher_heartbeat",
      occurred_at: timestamp,
      observed_at: timestamp,
      conversation: {
        conversation_key: "",
        identity_status: "unknown"
      },
      confidence: "exact",
      source_adapter: "chrome-background-heartbeat-v1",
      metadata: {
        adapter_health: "healthy",
        signal: signal || "sixty_second_alarm"
      }
    });
  }

  return { createHeartbeatEvent };
});
