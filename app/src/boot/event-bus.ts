// Tiny typed event bus for FaceplateEvents. Single instance per renderer.
// Renderer modules subscribe via `eventBus.on(type, cb)`. Cross-window
// broadcasts go through the preload `events.subscribe`/`events.publish`
// IPC pair, which the bridge below relays into the local bus.

import type { FaceplateEvent, FaceplateEventType, FaceplateEventOf } from '../hermes/event-schema';

type AnyHandler = (event: FaceplateEvent) => void;
type TypedHandler<T extends FaceplateEventType> = (event: FaceplateEventOf<T>) => void;

const REMOTE_FLAG = Symbol.for('faceplate.event.remote');

interface RemoteFlagged {
  [REMOTE_FLAG]?: true;
}

export class EventBus {
  private wildcard = new Set<AnyHandler>();
  private typed = new Map<FaceplateEventType, Set<AnyHandler>>();

  on<T extends FaceplateEventType>(type: T, cb: TypedHandler<T>): () => void {
    let set = this.typed.get(type);
    if (!set) {
      set = new Set();
      this.typed.set(type, set);
    }
    const wrapped: AnyHandler = (e) => cb(e as FaceplateEventOf<T>);
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }

  onAny(cb: AnyHandler): () => void {
    this.wildcard.add(cb);
    return () => this.wildcard.delete(cb);
  }

  /** Emit a locally-originated event (will also be published to main for cross-window broadcast). */
  emit(event: FaceplateEvent): void {
    this.dispatch(event);
  }

  /** Emit an event that arrived from main; tagged so the bridge does not re-publish it. */
  emitFromRemote(event: FaceplateEvent): void {
    (event as FaceplateEvent & RemoteFlagged)[REMOTE_FLAG] = true;
    this.dispatch(event);
  }

  private dispatch(event: FaceplateEvent): void {
    for (const cb of this.wildcard) cb(event);
    const set = this.typed.get(event.type);
    if (set) for (const cb of set) cb(event);
  }
}

export const eventBus = new EventBus();

let bridged = false;

export function wirePreloadBridge(bus: EventBus): void {
  if (bridged) return;
  bridged = true;
  const fp = window.faceplate;
  if (!fp) return;
  // Inbound: main broadcasts an event, mark it as remote so the outbound
  // listener below doesn't echo it back.
  fp.events.subscribe((event) => bus.emitFromRemote(event));
  // Outbound: local emissions get published to main; tagged remote events
  // skip the round-trip.
  bus.onAny((event) => {
    if ((event as FaceplateEvent & RemoteFlagged)[REMOTE_FLAG]) return;
    fp.events.publish(event);
  });
}
