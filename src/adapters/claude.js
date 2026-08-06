(function initClaudeAdapter(root, factory) {
  const base = typeof module === "object" && module.exports
    ? require("./base.js")
    : root.AIConversation.Adapters.Base;
  const api = factory(base);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.Adapters.Claude = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function claudeFactory(Base) {
  "use strict";

  class ClaudeAdapter extends Base.ProviderDomAdapter {
    constructor(onAction, options) {
      super(Object.assign({
        provider: "claude",
        onAction,
        mutationObserverOptions: {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-is-streaming"]
        },
        requireSubmissionForResponseSignals: true,
        requireResponseTurnForCompletion: true,
        requireActiveEdgeForCompletion: true,
        selectors: {
          composer: [
            "div[data-testid='chat-input'][role='textbox'].tiptap.ProseMirror",
            "div[data-testid='chat-input'][role='textbox'][contenteditable='true']",
            "div[contenteditable='true'].ProseMirror",
            "div[contenteditable='true'][data-testid*='composer']"
          ],
          send: "button[aria-label='Send message' i], button[data-testid='send-button']",
          stop: "button[aria-label*='Stop response' i], button[data-testid='stop-button']",
          responseActive: "[data-is-streaming='true']",
          responseTurn: ".font-claude-response",
          error: "[data-testid*='error'], [role='alert'][data-is-error='true']"
        }
      }, options || {}));
    }
  }

  return { ClaudeAdapter };
});
