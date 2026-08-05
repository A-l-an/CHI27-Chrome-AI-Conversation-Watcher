(function initIdentity(root, factory) {
  const core = typeof module === "object" && module.exports
    ? require("./core.js")
    : root.AIConversation.Core;
  const api = factory(core);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.Identity = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function identityFactory(Core) {
  "use strict";

  const PROVIDERS = {
    chatgpt: {
      hosts: new Set(["chatgpt.com"]),
      route: /^\/c\/([A-Za-z0-9_-]{8,128})\/?$/
    },
    claude: {
      hosts: new Set(["claude.ai"]),
      route: /^\/chat\/([0-9a-fA-F-]{36})\/?$/
    }
  };

  function providerFromUrl(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_error) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    for (const [provider, config] of Object.entries(PROVIDERS)) {
      if (config.hosts.has(hostname)) {
        return provider;
      }
    }
    return null;
  }

  function extractProviderConversationId(provider, rawUrl) {
    const config = PROVIDERS[provider];
    if (!config) {
      return null;
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_error) {
      return null;
    }
    if (!config.hosts.has(parsed.hostname.toLowerCase())) {
      return null;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return null;
    }
    const match = parsed.pathname.match(config.route);
    if (!match) {
      return null;
    }
    if (provider === "claude") {
      const candidate = match[1].toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)) {
        return null;
      }
      return candidate;
    }
    return match[1];
  }

  class IdentityTracker {
    constructor(options, uuidFactory) {
      const config = options || {};
      this.resolveExact = typeof config.resolveExact === "function"
        ? config.resolveExact
        : async () => ({ status: "unavailable" });
      this.namespace = (
        Number.isInteger(config.namespace_generation) &&
        config.namespace_generation > 0 &&
        typeof config.namespace_fingerprint === "string" &&
        config.namespace_fingerprint
      ) ? {
          namespace_generation: config.namespace_generation,
          namespace_fingerprint: config.namespace_fingerprint
        }
        : null;
      this.uuidFactory = uuidFactory || Core.randomUuid;
      this.current = null;
    }

    provisional(provider) {
      const retained = (
        this.current &&
        this.current.identity_status === "provisional" &&
        this.current.provider === provider
      ) ? this.current.conversation_key : this.uuidFactory();
      return Object.assign({
        conversation_key: retained,
        identity_status: "provisional",
        provider
      }, this.namespace || {});
    }

    async update(provider, fullUrl) {
      const providerConversationId = extractProviderConversationId(provider, fullUrl);
      let next;
      if (providerConversationId) {
        const resolved = await this.resolveExact({
          provider,
          provider_conversation_id: providerConversationId
        });
        if (resolved && resolved.status === "issued") {
          next = {
            conversation_key: resolved.conversation_key,
            identity_status: "exact",
            provider,
            locator_handle: resolved.locator_handle,
            namespace_generation: resolved.namespace_generation,
            namespace_fingerprint: resolved.namespace_fingerprint
          };
        } else {
          next = this.provisional(provider);
        }
      } else {
        next = this.provisional(provider);
      }

      const previous = this.current;
      this.current = next;
      if (!previous) {
        return { change: "initial", current: next, previous: null };
      }
      if (
        previous.identity_status === "provisional" &&
        next.identity_status === "exact" &&
        previous.provider === next.provider &&
        previous.namespace_generation === next.namespace_generation &&
        previous.namespace_fingerprint === next.namespace_fingerprint
      ) {
        return { change: "bound", current: next, previous };
      }
      if (previous.conversation_key !== next.conversation_key) {
        return { change: "switched", current: next, previous };
      }
      return { change: "url_updated", current: next, previous };
    }
  }

  return {
    IdentityTracker,
    extractProviderConversationId,
    providerFromUrl
  };
});
