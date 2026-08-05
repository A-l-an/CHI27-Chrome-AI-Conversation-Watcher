(function initChatGptAdapter(root, factory) {
  const base = typeof module === "object" && module.exports
    ? require("./base.js")
    : root.AIConversation.Adapters.Base;
  const api = factory(base);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.Adapters.ChatGPT = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function chatGptFactory(Base) {
  "use strict";

  class ChatGptAdapter extends Base.ProviderDomAdapter {
    constructor(onAction, options) {
      super(Object.assign({
        provider: "chatgpt",
        onAction,
        mutationObserverOptions: {
          childList: true,
          subtree: true,
          characterData: true
        },
        selectors: {
          composer: "#prompt-textarea",
          send: "button[data-testid='send-button']",
          stop: "button[data-testid='stop-button']",
          responseTurn: "[data-message-author-role='assistant']",
          responsePreview: ".markdown",
          responsePreviewExclude: "[data-testid='webpage-citation-pill']",
          error: "[data-testid='conversation-turn-error']"
        },
        responseIdentityAttribute: "data-message-id"
      }, options || {}));
    }
  }

  return { ChatGptAdapter };
});
