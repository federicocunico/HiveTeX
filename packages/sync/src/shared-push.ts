import { ntfyChannel, type PushChannel, type PushState } from './doorbell.js';

/** One physical push subscription per device/service, including foreground and dormant projects. */
export class SharedPushChannels {
  private channels = new Map<string, {
    upstream: PushChannel;
    listeners: Set<{ topics: Set<string>; message: (topic: string, data: string) => void; state: (s: PushState) => void }>;
    close: (() => void) | null;
    timer: ReturnType<typeof setTimeout> | null;
    generation: number;
    state: PushState;
  }>();
  constructor(private create: (url: string) => PushChannel = ntfyChannel) {}
  channel = (url: string): PushChannel => {
    const key = url.replace(/\/+$/, '');
    let entry = this.channels.get(key);
    if (!entry) {
      entry = { upstream: this.create(key), listeners: new Set(), close: null, timer: null, generation: 0, state: 'off' };
      this.channels.set(key, entry);
    }
    const e = entry;
    const schedule = () => {
      if (e.timer) return;
      e.timer = setTimeout(() => {
        e.timer = null;
        const generation = ++e.generation;
        e.close?.(); e.close = null;
        const topics = [...new Set([...e.listeners].flatMap((l) => [...l.topics]))].sort();
        if (!topics.length) { e.state = 'off'; return; }
        e.close = e.upstream.subscribe(topics,
          (topic, data) => {
            if (generation !== e.generation) return;
            for (const l of e.listeners) if (l.topics.has(topic)) l.message(topic, data);
          },
          (state) => {
            if (generation !== e.generation) return;
            e.state = state;
            for (const l of e.listeners) l.state(state);
          },
        );
      }, 0);
    };
    return {
      publish: (topic, data) => e.upstream.publish(topic, data),
      subscribe: (topics, message, state) => {
        const listener = { topics: new Set(topics), message, state };
        e.listeners.add(listener);
        state(e.state === 'off' ? 'connecting' : e.state);
        schedule();
        return () => {
          if (!e.listeners.delete(listener)) return;
          state('off'); schedule();
        };
      },
    };
  };
  /** Resume forces fresh push streams without calling the control plane. */
  restart() {
    for (const [url, e] of this.channels) {
      const listeners = [...e.listeners];
      ++e.generation; e.close?.(); e.close = null;
      if (e.timer) clearTimeout(e.timer); e.timer = null;
      if (!listeners.length) continue;
      const generation = e.generation;
      const topics = [...new Set(listeners.flatMap((l) => [...l.topics]))].sort();
      e.close = e.upstream.subscribe(topics, (topic, data) => {
        if (generation === e.generation) for (const l of e.listeners) if (l.topics.has(topic)) l.message(topic, data);
      }, (state) => {
        if (generation === e.generation) { e.state = state; for (const l of e.listeners) l.state(state); }
      });
      this.channels.set(url, e);
    }
  }
  close() {
    for (const e of this.channels.values()) {
      ++e.generation;
      if (e.timer) clearTimeout(e.timer);
      e.close?.(); e.listeners.clear();
    }
    this.channels.clear();
  }
}
