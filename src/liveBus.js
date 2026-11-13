'use strict';

/** Canli (anlik) token tiklerini birden fazla kaynaktan (collector, proxy) SSE istemcilerine tasiyan basit pub/sub. */
class LiveBus {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(tick) {
    for (const listener of this.listeners) {
      try {
        listener(tick);
      } catch {
        // bir dinleyicinin hatasi digerlerini etkilemesin
      }
    }
  }
}

module.exports = { LiveBus };
