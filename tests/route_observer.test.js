"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { installRouteObserver } = require("../src/route_observer.js");

function fakeWindow(options = {}) {
  const listeners = new Map();
  const intervalCallbacks = [];
  const root = {
    location: { href: "https://chatgpt.com/c/conversation_A" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    history: {
      pushState(_state, _title, url) {
        root.location.href = new URL(url, root.location.href).href;
      },
      replaceState(_state, _title, url) {
        root.location.href = new URL(url, root.location.href).href;
      }
    },
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    }
  };
  if (options.navigation) {
    const navigationListeners = new Map();
    root.navigation = {
      addEventListener(type, listener) {
        navigationListeners.set(type, listener);
      }
    };
    root.navigationListeners = navigationListeners;
  }
  root.listeners = listeners;
  root.intervalCallbacks = intervalCallbacks;
  return root;
}

test("content SPA wiring observes pushState and replaceState across A-B-A", () => {
  const root = fakeWindow();
  const observed = [];
  const result = installRouteObserver(root, () => {
    observed.push(root.location.href);
  });
  assert.equal(result.installed, true);
  root.history.pushState({}, "", "/c/conversation_B");
  root.history.replaceState({}, "", "/c/conversation_A");
  assert.deepEqual(observed, [
    "https://chatgpt.com/c/conversation_B",
    "https://chatgpt.com/c/conversation_A"
  ]);
});

test("Navigation API absence retains history, popstate, and polling compatibility", () => {
  const root = fakeWindow();
  let count = 0;
  installRouteObserver(root, () => {
    count += 1;
  });
  assert.equal(root.navigation, undefined);
  assert.equal(root.intervalCallbacks.length, 1);
  root.location.href = "https://chatgpt.com/c/conversation_B";
  root.intervalCallbacks[0]();
  root.listeners.get("popstate")();
  assert.equal(count, 2);
});

test("Navigation API events are wired when available", () => {
  const root = fakeWindow({ navigation: true });
  let count = 0;
  installRouteObserver(root, () => {
    count += 1;
  });
  root.navigationListeners.get("navigatesuccess")();
  root.navigationListeners.get("currententrychange")();
  assert.equal(count, 2);
  assert.equal(root.intervalCallbacks.length, 0);
});

test("route callback errors fail closed to one fixed code without URL or error text", () => {
  const root = fakeWindow();
  const diagnostics = [];
  installRouteObserver(root, () => {
    throw new Error("https://chatgpt.com/c/raw-route-canary");
  }, (code) => diagnostics.push(code));
  root.history.pushState({}, "", "/c/raw-route-canary");
  assert.deepEqual(diagnostics, ["route_observer_failed"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /https?:\/\//);
  assert.doesNotMatch(JSON.stringify(diagnostics), /raw-route-canary/);
});

test("manifest loads route observer before content and content installs it", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  );
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("src/route_observer.js") >= 0);
  assert.ok(
    scripts.indexOf("src/route_observer.js") < scripts.indexOf("content.js")
  );
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(content, /RouteObserver\.installRouteObserver/);
  assert.match(content, /Core\.buildTrackerNotificationRequest/);
});
