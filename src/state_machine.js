(function initStateMachine(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation.StateMachine = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function stateMachineFactory() {
  "use strict";

  const SUBMIT_DEDUPE_MS = 1500;

  class ConversationStateMachine {
    constructor(options) {
      const opts = options || {};
      this.now = opts.now || (() => Date.now());
      this.foreground = false;
      this.everBackgrounded = false;
      this.interactionPending = false;
      this.engagementPending = false;
      this.draftNonEmpty = false;
      this.responding = false;
      this.lastSubmitAt = -Infinity;
      this.started = false;
    }

    dispatch(action) {
      const events = [];
      const effects = [];
      const at = Number.isFinite(action.at) ? action.at : this.now();
      const emit = (event_type, confidence, metadata) => {
        events.push({ event_type, confidence, metadata: metadata || {}, at });
      };
      const interactIfPending = (signal) => {
        if (this.foreground && this.interactionPending) {
          this.interactionPending = false;
          emit("user_interacted", "derived", {
            signal,
            state_transition: "returned_to_interacted"
          });
        }
      };
      const engageIfPending = (signal) => {
        if (this.foreground && this.engagementPending) {
          this.engagementPending = false;
          emit("user_engaged", "derived", {
            signal,
            state_transition: "returned_to_engaged"
          });
        }
      };

      switch (action.type) {
        case "START":
          if (!this.started) {
            this.started = true;
            emit("watcher_started", "exact", { adapter_health: "starting" });
          }
          if (action.visible && !this.foreground) {
            this.foreground = true;
            emit("conversation_foregrounded", "derived", {
              visibility: "visible",
              state_transition: "initial_foreground"
            });
          }
          break;
        case "FOREGROUND":
          if (!this.foreground) {
            this.foreground = true;
            emit("conversation_foregrounded", "derived", {
              visibility: "visible",
              state_transition: "background_to_foreground"
            });
            if (this.everBackgrounded) {
              emit("user_returned", "derived", {
                signal: action.signal || "document_visible",
                state_transition: "background_to_returned"
              });
              this.interactionPending = true;
              this.engagementPending = true;
            }
          }
          break;
        case "BACKGROUND":
          if (this.foreground) {
            this.foreground = false;
            this.everBackgrounded = true;
            this.interactionPending = false;
            this.engagementPending = false;
            emit("conversation_backgrounded", "derived", {
              visibility: "hidden",
              state_transition: "foreground_to_background"
            });
          }
          break;
        case "USER_INTERACTION":
          interactIfPending(action.signal || "click_scroll_or_input");
          break;
        case "INPUT_CHANGED": {
          const nonEmpty = Boolean(action.nonEmpty);
          if (nonEmpty && !this.draftNonEmpty) {
            emit("input_started", "derived", {
              signal: "composer_empty_to_nonempty",
              state_transition: "empty_to_nonempty"
            });
            engageIfPending("input_started");
          }
          this.draftNonEmpty = nonEmpty;
          break;
        }
        case "PROMPT_SUBMITTED":
          if (at - this.lastSubmitAt >= SUBMIT_DEDUPE_MS) {
            this.lastSubmitAt = at;
            this.draftNonEmpty = false;
            emit("prompt_submitted", action.confidence || "derived", {
              signal: action.signal || "submit_control",
              state_transition: "draft_to_submitted"
            });
            engageIfPending("prompt_submitted");
          }
          break;
        case "RESPONSE_STARTED":
          if (!this.responding) {
            this.responding = true;
            emit("assistant_response_started", action.confidence || "derived", {
              signal: action.signal || "stop_control_appeared",
              state_transition: "submitted_to_responding"
            });
          }
          break;
        case "RESPONSE_COMPLETED":
          if (this.responding) {
            this.responding = false;
            emit("assistant_response_completed", action.confidence || "derived", {
              completion_signal: action.signal || "stop_control_disappeared",
              state_transition: "responding_to_completed"
            });
            if (!this.foreground) {
              effects.push({
                type: "SHOW_TRACKER_NOTIFICATION",
                reason_code: "response_completed_while_hidden"
              });
            } else {
              effects.push({
                type: "AUDIT_TRACKER_NOTIFICATION_SUPPRESSED",
                reason_code: "response_completed_while_foreground"
              });
            }
          }
          break;
        case "RESPONSE_FAILED":
          if (this.responding) {
            this.responding = false;
            emit("assistant_response_failed", action.confidence || "heuristic", {
              reason_code: action.reason || "provider_error_control",
              state_transition: "responding_to_failed"
            });
          }
          break;
        case "RESPONSE_CANCELLED":
          if (this.responding) {
            this.responding = false;
            emit("assistant_response_cancelled", action.confidence || "derived", {
              signal: action.signal || "stop_control_clicked",
              state_transition: "responding_to_cancelled"
            });
          }
          break;
        case "OBSERVATION_GAP":
          if (this.responding) {
            this.responding = false;
            emit("adapter_unhealthy", "exact", {
              adapter_health: "unhealthy",
              generation_state: "response_in_progress_at_navigation",
              observation_gap: true,
              reason_code: action.reason || "navigation_while_response_in_progress"
            });
          }
          break;
        case "ADAPTER_UNHEALTHY":
          emit("adapter_unhealthy", "exact", {
            adapter_health: "unhealthy",
            reason_code: action.reason || "unknown"
          });
          break;
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
      return { events, effects };
    }
  }

  class ConversationSessionRegistry {
    constructor(options) {
      this.options = options || {};
      this.sessions = new Map();
      this.currentKey = null;
    }

    createSession(started) {
      const machine = new ConversationStateMachine(this.options);
      machine.started = Boolean(started);
      return machine;
    }

    start(conversationKey, options) {
      if (this.currentKey) {
        throw new Error("registry already started");
      }
      const machine = this.createSession(false);
      this.sessions.set(conversationKey, machine);
      this.currentKey = conversationKey;
      return [{
        conversation_key: conversationKey,
        result: machine.dispatch({
          type: "START",
          visible: Boolean(options && options.visible),
          at: options && options.at
        })
      }];
    }

    switchTo(conversationKey, options) {
      const transitions = [];
      const opts = options || {};
      if (!this.currentKey) {
        return this.start(conversationKey, opts);
      }
      if (this.currentKey === conversationKey) {
        return transitions;
      }
      const previousKey = this.currentKey;
      const previous = this.sessions.get(previousKey);
      if (previous.responding) {
        transitions.push({
          conversation_key: previousKey,
          result: previous.dispatch({
            type: "OBSERVATION_GAP",
            reason: "navigation_while_response_in_progress",
            at: opts.at
          })
        });
      }
      transitions.push({
        conversation_key: previousKey,
        result: previous.dispatch({ type: "BACKGROUND", at: opts.at })
      });
      let next = this.sessions.get(conversationKey);
      if (!next) {
        next = this.createSession(true);
        this.sessions.set(conversationKey, next);
      }
      this.currentKey = conversationKey;
      if (opts.visible) {
        transitions.push({
          conversation_key: conversationKey,
          result: next.dispatch({
            type: "FOREGROUND",
            signal: opts.signal || "conversation_switch",
            at: opts.at
          })
        });
      }
      return transitions;
    }

    bindCurrent(newConversationKey, options) {
      const transitions = [];
      const opts = options || {};
      const oldConversationKey = this.currentKey;
      if (!oldConversationKey || oldConversationKey === newConversationKey) {
        return {
          old_conversation_key: oldConversationKey,
          reused_existing: false,
          transitions
        };
      }
      const current = this.sessions.get(oldConversationKey);
      const existing = this.sessions.get(newConversationKey);
      if (existing) {
        if (current.responding) {
          transitions.push({
            conversation_key: oldConversationKey,
            result: current.dispatch({
              type: "OBSERVATION_GAP",
              reason: "identity_bound_to_existing_conversation",
              at: opts.at
            })
          });
        }
        transitions.push({
          conversation_key: oldConversationKey,
          result: current.dispatch({ type: "BACKGROUND", at: opts.at })
        });
        this.currentKey = newConversationKey;
        this.sessions.delete(oldConversationKey);
        if (opts.visible) {
          transitions.push({
            conversation_key: newConversationKey,
            result: existing.dispatch({
              type: "FOREGROUND",
              signal: opts.signal || "identity_bound_to_existing_conversation",
              at: opts.at
            })
          });
        }
        return {
          old_conversation_key: oldConversationKey,
          reused_existing: true,
          discarded_machine: current,
          transitions
        };
      }
      this.sessions.delete(oldConversationKey);
      this.sessions.set(newConversationKey, current);
      this.currentKey = newConversationKey;
      return {
        old_conversation_key: oldConversationKey,
        reused_existing: false,
        transitions
      };
    }

    dispatch(action) {
      if (!this.currentKey) {
        throw new Error("registry has not started");
      }
      const machine = this.sessions.get(this.currentKey);
      return {
        conversation_key: this.currentKey,
        result: machine.dispatch(action)
      };
    }

    currentMachine() {
      return this.sessions.get(this.currentKey) || null;
    }
  }

  return {
    ConversationSessionRegistry,
    ConversationStateMachine,
    SUBMIT_DEDUPE_MS
  };
});
