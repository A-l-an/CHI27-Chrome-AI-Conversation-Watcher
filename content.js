(function startContentWatcher(root) {
  "use strict";

  const {
    Core,
    Identity,
    PrivateReturnCues,
    RouteObserver,
    StateMachine,
    Adapters
  } = root.AIConversation;
  const provider = Identity.providerFromUrl(root.location.href);
  if (!provider) {
    return;
  }

  let identityTracker;
  let context;
  let registry;
  const contextsByKey = new Map();
  let adapter;
  let routeChain = Promise.resolve();
  let transitionChain = Promise.resolve();

  function reportContentDiagnostic(code) {
    console.warn("CHI27_AI_WATCHER_CONTENT", code);
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function isForeground() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function buildEvent(descriptor, eventContext, overrides) {
    const extra = overrides || {};
    return Core.buildActivityWatchEvent({
      provider,
      event_type: descriptor.event_type,
      occurred_at: new Date(descriptor.at || Date.now()).toISOString(),
      conversation: eventContext.identity,
      confidence: descriptor.confidence,
      source_adapter: `${provider}-dom-v1`,
      metadata: descriptor.metadata,
      previous_conversation_key: extra.previous_conversation_key
    });
  }

  function enqueue(events, authorizedPrivateReturnCue) {
    if (!events.length) {
      return Promise.resolve({ added: 0 });
    }
    const message = { type: "ENQUEUE_EVENTS", events };
    if (authorizedPrivateReturnCue) {
      message.private_return_cue = authorizedPrivateReturnCue.cue;
      message.private_return_cue_authorization =
        authorizedPrivateReturnCue.authorization_id;
    }
    return runtimeMessage(message)
      .then((response) => {
        if (response && response.error) {
          throw new Error(response.error);
        }
        return response;
      });
  }

  function queueTransitionOperation(operation) {
    transitionChain = transitionChain
      .then(operation)
      .catch(() => {
        reportContentDiagnostic("content_transition_failed");
      });
    return transitionChain;
  }

  function announceExactConversationContext(eventContext) {
    const identity = eventContext && eventContext.identity;
    if (!identity || identity.identity_status !== "exact") {
      return;
    }
    runtimeMessage({
      type: "ANNOUNCE_EXACT_CONVERSATION_CONTEXT",
      provider,
      context: {
        conversation_key: identity.conversation_key,
        locator_handle: identity.locator_handle,
        namespace_generation: identity.namespace_generation,
        namespace_fingerprint: identity.namespace_fingerprint
      }
    }).catch(() => {
      // The announcement is an in-memory reopen hint, never a measurement.
    });
  }

  function emitDirect(eventType, eventContext, options) {
    const opts = options || {};
    const event = buildEvent(
      {
        event_type: eventType,
        confidence: opts.confidence || "derived",
        metadata: opts.metadata || {},
        at: Date.now()
      },
      eventContext,
      { previous_conversation_key: opts.previous_conversation_key }
    );
    queueTransitionOperation(() => enqueue([event]));
  }

  function emitMachineTransition(transition, options) {
    const opts = options || {};
    const eventContext = contextsByKey.get(transition.conversation_key);
    if (!eventContext) {
      return;
    }
    const result = transition.result;
    const events = result.events.map(
      (descriptor) => buildEvent(descriptor, eventContext)
    );
    const effects = result.effects.slice();
    const completedEvents = events.filter(
      (event) => event.data.event_type === "assistant_response_completed"
    );
    queueTransitionOperation(async () => {
      let authorizedPrivateReturnCue = null;
      if (completedEvents.length === 1) {
        try {
          authorizedPrivateReturnCue =
            await PrivateReturnCues.buildPrivateCueAfterAuthorization(
              () => runtimeMessage({
                type: "AUTHORIZE_PRIVATE_RETURN_CUE"
              }),
              completedEvents[0],
              opts.notification_preview,
              Date.now()
            );
        } catch (_error) {
          // Regular content-free events continue when private cue consent is absent.
        }
      }
      try {
        await enqueue(events, authorizedPrivateReturnCue);
      } catch (_error) {
        // A lost ENQUEUE_EVENTS response must not suppress a separately
        // authorized notification request. The background remains the gate.
        reportContentDiagnostic("content_event_enqueue_failed");
      }
      for (const effect of effects) {
        if (![
          "SHOW_TRACKER_NOTIFICATION",
          "AUDIT_TRACKER_NOTIFICATION_SUPPRESSED"
        ].includes(effect.type)) {
          continue;
        }
        const notificationRequest = Core.buildTrackerNotificationRequest({
          provider,
          identity: eventContext.identity,
          reason_code: effect.reason_code,
          notification_preview: opts.notification_preview
        });
        try {
          const response = await runtimeMessage(notificationRequest);
          if (response && response.created === false && response.error_code) {
            reportContentDiagnostic(
              response.error_code === "notification_request_rejected"
                ? "content_notification_request_rejected"
                : "content_notification_not_created"
            );
          }
        } catch (_error) {
          reportContentDiagnostic("content_notification_message_failed");
        }
      }
    });
  }

  function emitMachineTransitions(transitions) {
    for (const transition of transitions) {
      emitMachineTransition(transition);
    }
  }

  function applyAction(action) {
    if (!registry || !context) {
      return;
    }
    const notificationPreview = action.type === "RESPONSE_COMPLETED"
      ? Core.sanitizeEphemeralNotificationPreview(
          action.notification_preview
        )
      : "";
    const transition = registry.dispatch(Object.assign({ at: Date.now() }, action));
    emitMachineTransition(transition, {
      notification_preview: notificationPreview
    });
  }

  async function updateRoute(fullUrl) {
    if (Identity.providerFromUrl(fullUrl) !== provider) {
      return;
    }
    const result = await identityTracker.update(provider, fullUrl);
    const nextContext = {
      identity: result.current
    };
    if (result.change === "initial") {
      context = nextContext;
      contextsByKey.set(result.current.conversation_key, nextContext);
      registry = new StateMachine.ConversationSessionRegistry();
      emitMachineTransitions(registry.start(result.current.conversation_key, {
        visible: isForeground(),
        at: Date.now()
      }));
      announceExactConversationContext(context);
      return;
    }
    if (result.change === "bound") {
      const oldKey = result.previous.conversation_key;
      contextsByKey.set(result.current.conversation_key, nextContext);
      const binding = registry.bindCurrent(result.current.conversation_key, {
        visible: isForeground(),
        signal: "spa_identity_binding",
        at: Date.now()
      });
      emitMachineTransitions(binding.transitions);
      contextsByKey.delete(oldKey);
      context = nextContext;
      announceExactConversationContext(context);
      emitDirect("conversation_bound", context, {
        confidence: "exact",
        previous_conversation_key: result.previous.conversation_key,
        metadata: {
          route_pattern: provider === "chatgpt" ? "/c/<id>" : "/chat/<id>",
          state_transition: "provisional_to_exact"
        }
      });
      return;
    }
    if (result.change === "switched") {
      contextsByKey.set(result.current.conversation_key, nextContext);
      const transitions = registry.switchTo(result.current.conversation_key, {
        visible: isForeground(),
        signal: "spa_route_change",
        at: Date.now()
      });
      if (adapter) {
        adapter.resetConversation();
      }
      context = nextContext;
      emitMachineTransitions(transitions);
      announceExactConversationContext(context);
      return;
    }
    context = nextContext;
    contextsByKey.set(result.current.conversation_key, nextContext);
    announceExactConversationContext(context);
  }

  function queueRoute(fullUrl) {
    routeChain = routeChain
      .then(() => updateRoute(fullUrl))
      .catch((_error) => {
        if (context) {
          applyAction({
            type: "ADAPTER_UNHEALTHY",
            reason: "route_identity_resolution_failed"
          });
        }
        reportContentDiagnostic("content_route_update_failed");
      });
  }

  function bindLifecycle() {
    document.addEventListener("visibilitychange", () => {
      applyAction({
        type: document.visibilityState === "visible" ? "FOREGROUND" : "BACKGROUND",
        signal: "document_visibility"
      });
    });
    root.addEventListener("focus", () => {
      applyAction({ type: "FOREGROUND", signal: "window_focus" });
    });
    root.addEventListener("blur", () => {
      applyAction({ type: "BACKGROUND", signal: "window_blur" });
    });
    RouteObserver.installRouteObserver(root, () => {
      queueRoute(root.location.href);
    }, () => {
      if (context) {
        applyAction({
          type: "ADAPTER_UNHEALTHY",
          reason: "route_identity_resolution_failed"
        });
      }
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (
        message &&
        message.type === "GET_OPAQUE_CONVERSATION_CONTEXT" &&
        context &&
        context.identity.identity_status === "exact"
      ) {
        sendResponse({
          conversation_key: context.identity.conversation_key,
          locator_handle: context.identity.locator_handle,
          namespace_generation: context.identity.namespace_generation,
          namespace_fingerprint: context.identity.namespace_fingerprint
        });
      }
      return false;
    });
  }

  async function boot() {
    const authorityContext = await runtimeMessage({
      type: "GET_AUTHORITY_CONTEXT"
    });
    const namespace = authorityContext && authorityContext.status === "ready"
      ? {
          namespace_generation: authorityContext.namespace_generation,
          namespace_fingerprint: authorityContext.namespace_fingerprint
        }
      : {};
    identityTracker = new Identity.IdentityTracker(Object.assign({}, namespace, {
      resolveExact: (request) => runtimeMessage({
        type: "RESOLVE_CONVERSATION",
        provider: request.provider,
        provider_conversation_id: request.provider_conversation_id
      })
    }));
    await updateRoute(root.location.href);
    const AdapterClass = provider === "chatgpt"
      ? Adapters.ChatGPT.ChatGptAdapter
      : Adapters.Claude.ClaudeAdapter;
    adapter = new AdapterClass((action) => applyAction(action));
    adapter.start();
    bindLifecycle();
  }

  boot().catch((_error) => {
    reportContentDiagnostic("content_boot_failed");
  });
})(globalThis);
