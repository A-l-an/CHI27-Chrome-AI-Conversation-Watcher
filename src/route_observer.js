(function initRouteObserver(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.RouteObserver = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function routeObserverFactory() {
  "use strict";

  function installRouteObserver(root, onRoute, onError) {
    if (!root || typeof onRoute !== "function") {
      return Object.freeze({ installed: false });
    }
    let lastHref = root.location ? String(root.location.href || "") : "";
    const reportError = () => {
      if (typeof onError === "function") {
        try {
          onError("route_observer_failed");
        } catch (_ignored) {
          // Fail closed without forwarding URLs or arbitrary error text.
        }
      }
    };
    const report = () => {
      try {
        if (root.location) {
          lastHref = String(root.location.href || "");
        }
        onRoute();
      } catch (_error) {
        reportError();
      }
    };
    const add = (target, eventName) => {
      if (target && typeof target.addEventListener === "function") {
        target.addEventListener(eventName, report);
        return true;
      }
      return false;
    };

    let installed = false;
    installed = add(root, "popstate") || installed;
    installed = add(root, "hashchange") || installed;

    if (root.history) {
      for (const methodName of ["pushState", "replaceState"]) {
        const original = root.history[methodName];
        if (typeof original !== "function") {
          continue;
        }
        try {
          root.history[methodName] = function observedHistoryMutation(...args) {
            const result = Reflect.apply(original, this, args);
            report();
            return result;
          };
          installed = true;
        } catch (_error) {
          reportError();
        }
      }
    }

    const hasNavigationApi = Boolean(
      root.navigation &&
      typeof root.navigation.addEventListener === "function"
    );
    if (hasNavigationApi) {
      installed = add(root.navigation, "navigatesuccess") || installed;
      installed = add(root.navigation, "currententrychange") || installed;
    } else if (
      root.location &&
      typeof root.setInterval === "function"
    ) {
      root.setInterval(() => {
        const currentHref = String(root.location.href || "");
        if (currentHref !== lastHref) {
          lastHref = currentHref;
          report();
        }
      }, 500);
      installed = true;
    }

    return Object.freeze({ installed });
  }

  return { installRouteObserver };
});
