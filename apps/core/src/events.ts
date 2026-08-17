import { EventEmitter } from "node:events";
import type { ServerEvent } from "@lvf/shared";

/**
 * Fan-out of pipeline events to SSE subscribers (the dashboard and the macOS agent HUD).
 *
 * A small ring buffer of recent events is kept so a client that connects mid-dictation
 * still learns the current stage instead of staring at a stale HUD.
 */
export class EventBus extends EventEmitter {
  readonly #recent: ServerEvent[] = [];
  readonly #maxRecent: number;

  constructor(options: { maxRecent?: number } = {}) {
    super();
    this.#maxRecent = options.maxRecent ?? 50;
    // One process may have several SSE clients plus internal listeners.
    this.setMaxListeners(50);
  }

  publish(event: ServerEvent): void {
    this.#recent.push(event);
    if (this.#recent.length > this.#maxRecent) this.#recent.shift();
    this.emit("event", event);
  }

  recent(): readonly ServerEvent[] {
    return this.#recent;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
