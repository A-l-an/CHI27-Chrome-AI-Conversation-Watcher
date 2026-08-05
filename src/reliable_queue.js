(function initReliableQueue(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AIConversation = root.AIConversation || {};
    root.AIConversation.ReliableQueue = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function reliableQueueFactory() {
  "use strict";

  // Queue mutations share one promise chain so concurrent content tabs cannot overwrite each other.
  const DEFAULT_STATE = Object.freeze({ pending: [], acknowledged: [] });

  class ReliableEventQueue {
    constructor(options) {
      this.store = options.store;
      this.transport = options.transport;
      this.now = options.now || (() => Date.now());
      this.baseRetryMs = options.baseRetryMs || 1000;
      this.maxRetryMs = options.maxRetryMs || 60000;
      this.maxAcknowledged = options.maxAcknowledged || 1000;
      this.idSelector = options.idSelector || (
        (event) => event && event.data && event.data.source_event_id
      );
      this.operationChain = Promise.resolve();
    }

    runExclusive(operation) {
      const result = this.operationChain.then(operation, operation);
      this.operationChain = result.catch(() => {});
      return result;
    }

    async load() {
      const state = await this.store.get();
      return state && Array.isArray(state.pending) && Array.isArray(state.acknowledged)
        ? state
        : { pending: [], acknowledged: [] };
    }

    async enqueue(events) {
      return this.runExclusive(async () => {
        const state = await this.load();
        const known = new Set(state.acknowledged);
        for (const item of state.pending) {
          known.add(this.idSelector(item.event));
        }
        let added = 0;
        for (const event of events || []) {
          const sourceId = this.idSelector(event);
          if (!sourceId || known.has(sourceId)) {
            continue;
          }
          state.pending.push({
            event,
            attempts: 0,
            next_attempt_at: 0
          });
          known.add(sourceId);
          added += 1;
        }
        await this.store.set(state);
        return added;
      });
    }

    async process() {
      return this.runExclusive(async () => {
        const state = await this.load();
        const now = this.now();
        const due = state.pending.filter((item) => item.next_attempt_at <= now).slice(0, 50);
        if (!due.length) {
          return { status: "idle", pending: state.pending.length };
        }
        try {
          await this.transport(due.map((item) => item.event));
          const sentIds = new Set(due.map((item) => this.idSelector(item.event)));
          state.pending = state.pending.filter(
            (item) => !sentIds.has(this.idSelector(item.event))
          );
          state.acknowledged = state.acknowledged.concat(Array.from(sentIds));
          if (state.acknowledged.length > this.maxAcknowledged) {
            state.acknowledged = state.acknowledged.slice(-this.maxAcknowledged);
          }
          await this.store.set(state);
          return { status: "sent", sent: sentIds.size, pending: state.pending.length };
        } catch (error) {
          const dueIds = new Set(due.map((item) => this.idSelector(item.event)));
          for (const item of state.pending) {
            if (!dueIds.has(this.idSelector(item.event))) {
              continue;
            }
            item.attempts += 1;
            const delay = Math.min(
              this.maxRetryMs,
              this.baseRetryMs * (2 ** Math.max(0, item.attempts - 1))
            );
            item.next_attempt_at = now + delay;
          }
          const retryCount = due.reduce(
            (maximum, item) => Math.max(maximum, item.attempts),
            0
          );
          await this.store.set(state);
          return {
            status: "retry_scheduled",
            pending: state.pending.length,
            error_code: (
              error &&
              typeof error.diagnosticCode === "string" &&
              error.diagnosticCode
            ) || "transport_failed",
            http_status: (
              error &&
              Number.isInteger(error.httpStatus)
            ) ? error.httpStatus : null,
            retry_count: retryCount
          };
        }
      });
    }
  }

  class MemoryQueueStore {
    constructor(initial) {
      this.state = initial
        ? JSON.parse(JSON.stringify(initial))
        : JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    async get() {
      return JSON.parse(JSON.stringify(this.state));
    }

    async set(state) {
      this.state = JSON.parse(JSON.stringify(state));
    }
  }

  return { MemoryQueueStore, ReliableEventQueue };
});
