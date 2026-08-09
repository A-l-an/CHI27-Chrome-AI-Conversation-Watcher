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
  const TURN_LINK_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  class ConversationStateMachine {
    constructor(options) {
      const opts = options || {};
      this.now = opts.now || (() => Date.now());
      this.foreground = false;
      this.everBackgrounded = false;
      this.interactionPending = false;
      this.engagementPending = false;
      this.draftNonEmpty = false;
      this.awaitingResponse = false;
      this.responding = false;
      this.activeObservationEpoch = null;
      this.activeTurnLinkId = "";
      this.lastSubmitAt = -Infinity;
      this.lastSubmitTurnLinkId = "";
      this.started = false;
    }

    dispatch(action) {
      const events = [];
      const effects = [];
      const at = Number.isFinite(action.at) ? action.at : this.now();
      const emit = (event_type, confidence, metadata, turnLinkId) => {
        const descriptor = {
          event_type,
          confidence,
          metadata: metadata || {},
          at
        };
        if (TURN_LINK_RE.test(turnLinkId || "")) {
          descriptor.turn_link_id = turnLinkId;
        }
        events.push(descriptor);
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
      const observationMatches = () => (
        (
          this.activeObservationEpoch === null ||
          Number.isInteger(action.observationEpoch) &&
          action.observationEpoch === this.activeObservationEpoch
        ) && (
          !this.activeTurnLinkId ||
          TURN_LINK_RE.test(action.turnLinkId || "") &&
          action.turnLinkId === this.activeTurnLinkId
        )
      );
      const clearResponseObservation = () => {
        this.awaitingResponse = false;
        this.responding = false;
        this.activeObservationEpoch = null;
        this.activeTurnLinkId = "";
      };
      const emitObservationGap = (reason, generationState) => {
        emit("adapter_unhealthy", "exact", {
          adapter_health: "unhealthy",
          generation_state: generationState,
          observation_gap: true,
          reason_code: reason
        });
        clearResponseObservation();
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
          {
            const submittedTurnLinkId = TURN_LINK_RE.test(
              action.turnLinkId || ""
            ) ? action.turnLinkId : "";
            const duplicateWithinWindow = (
              at - this.lastSubmitAt < SUBMIT_DEDUPE_MS &&
              (
                !submittedTurnLinkId ||
                submittedTurnLinkId === this.lastSubmitTurnLinkId
              )
            );
            if (duplicateWithinWindow) {
              break;
            }
            if (this.awaitingResponse || this.responding) {
              emitObservationGap(
                "new_submission_before_previous_terminal",
                "response_observation_incomplete_at_new_submission"
              );
            }
            this.lastSubmitAt = at;
            this.lastSubmitTurnLinkId = submittedTurnLinkId;
            this.draftNonEmpty = false;
            this.awaitingResponse = true;
            this.responding = false;
            this.activeObservationEpoch = Number.isInteger(action.observationEpoch)
              ? action.observationEpoch
              : null;
            this.activeTurnLinkId = submittedTurnLinkId;
            emit("prompt_submitted", action.confidence || "derived", {
              signal: action.signal || "submit_control",
              state_transition: "draft_to_submitted"
            }, this.activeTurnLinkId);
            engageIfPending("prompt_submitted");
          }
          break;
        case "RESPONSE_STARTED":
          if (
            observationMatches() &&
            !this.responding &&
            (
              this.awaitingResponse ||
              (
                action.leftCensored === true &&
                TURN_LINK_RE.test(action.turnLinkId || "")
              )
            )
          ) {
            this.awaitingResponse = true;
            this.responding = true;
            if (Number.isInteger(action.observationEpoch)) {
              this.activeObservationEpoch = action.observationEpoch;
            }
            if (TURN_LINK_RE.test(action.turnLinkId || "")) {
              this.activeTurnLinkId = action.turnLinkId;
            }
            emit("assistant_response_started", action.confidence || "derived", {
              signal: action.signal || "stop_control_appeared",
              state_transition: "submitted_to_responding"
            }, this.activeTurnLinkId);
          }
          break;
        case "RESPONSE_COMPLETED":
          if (observationMatches() && this.responding) {
            const turnLinkId = this.activeTurnLinkId;
            const completionVisibility = this.foreground
              ? "foreground"
              : "background";
            clearResponseObservation();
            emit("assistant_response_completed", action.confidence || "derived", {
              completion_signal: action.signal || "stop_control_disappeared",
              completion_visibility: completionVisibility,
              state_transition: "responding_to_completed"
            }, turnLinkId);
            effects.push({
              type: "SHOW_TRACKER_NOTIFICATION",
              reason_code: this.foreground
                ? "response_completed_while_foreground"
                : "response_completed_while_hidden",
              completion_visibility: completionVisibility
            });
          }
          break;
        case "RESPONSE_FAILED":
          if (observationMatches() && this.responding) {
            const turnLinkId = this.activeTurnLinkId;
            clearResponseObservation();
            emit("assistant_response_failed", action.confidence || "heuristic", {
              reason_code: action.reason || "provider_error_control",
              state_transition: "responding_to_failed"
            }, turnLinkId);
          }
          break;
        case "RESPONSE_CANCELLED":
          if (
            observationMatches() &&
            (this.awaitingResponse || this.responding)
          ) {
            const turnLinkId = this.activeTurnLinkId;
            clearResponseObservation();
            emit("assistant_response_cancelled", action.confidence || "derived", {
              signal: action.signal || "stop_control_clicked",
              state_transition: "responding_to_cancelled"
            }, turnLinkId);
          }
          break;
        case "OBSERVATION_GAP":
          if (
            observationMatches() &&
            (this.awaitingResponse || this.responding)
          ) {
            emitObservationGap(
              action.reason || "navigation_while_response_in_progress",
              action.generationState || "response_in_progress_at_navigation"
            );
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
      if (previous.awaitingResponse || previous.responding) {
        transitions.push({
          conversation_key: previousKey,
          result: previous.dispatch({
            type: "OBSERVATION_GAP",
            reason: "navigation_while_response_in_progress",
            observationEpoch: previous.activeObservationEpoch,
            turnLinkId: previous.activeTurnLinkId,
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
        if (current.awaitingResponse || current.responding) {
          transitions.push({
            conversation_key: oldConversationKey,
            result: current.dispatch({
              type: "OBSERVATION_GAP",
              reason: "identity_bound_to_existing_conversation",
              observationEpoch: current.activeObservationEpoch,
              turnLinkId: current.activeTurnLinkId,
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
