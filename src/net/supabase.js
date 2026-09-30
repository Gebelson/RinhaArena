// Public Supabase project configuration. Publishable keys are designed for
// browser use; database access is still restricted by RLS and RPC grants.
export const SUPABASE_URL = 'https://afetdgyzisxqrurzcbdx.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_UfOtExtqcSYXsIFK5QL6LQ_Jl_zYuCL';

function realtimeUrl() {
  return SUPABASE_URL.replace(/^http/, 'ws')
    + `/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;
}

export class SupabaseRealtimeChannel {
  constructor(topic) {
    this.topic = `realtime:${topic}`;
    this.ws = null;
    this.joinRef = null;
    this.ref = 0;
    this.listeners = new Map();
    this.heartbeat = null;
    this.closed = false;
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }

  nextRef() {
    this.ref += 1;
    return String(this.ref);
  }

  push(topic, event, payload, joinRef = this.joinRef) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      topic,
      event,
      payload,
      ref: this.nextRef(),
      join_ref: joinRef,
    }));
    return true;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(realtimeUrl());
      this.ws = ws;
      const timeout = setTimeout(() => reject(new Error('Tempo esgotado ao conectar no multiplayer')), 8000);

      ws.onopen = () => {
        this.joinRef = this.nextRef();
        ws.send(JSON.stringify({
          topic: this.topic,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { ack: false, self: false },
              presence: { enabled: false },
              private: false,
            },
          },
          ref: this.joinRef,
          join_ref: this.joinRef,
        }));
      };

      ws.onmessage = (message) => {
        let data;
        try { data = JSON.parse(message.data); } catch { return; }
        if (data.event === 'phx_reply' && data.ref === this.joinRef) {
          if (data.payload?.status === 'ok') {
            clearTimeout(timeout);
            this.heartbeat = setInterval(() => {
              this.push('phoenix', 'heartbeat', {}, null);
            }, 25_000);
            resolve(this);
          } else {
            clearTimeout(timeout);
            reject(new Error(data.payload?.response?.reason || 'Canal multiplayer recusado'));
          }
          return;
        }
        if (data.event === 'broadcast') {
          this.emit(data.payload?.event, data.payload?.payload);
        } else if (data.event === 'phx_error') {
          this.emit('disconnect', new Error('Canal multiplayer interrompido'));
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Não foi possível conectar ao Supabase Realtime'));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        clearInterval(this.heartbeat);
        if (!this.closed) this.emit('disconnect', new Error('Conexão multiplayer encerrada'));
      };
    });
  }

  send(event, payload) {
    return this.push(this.topic, 'broadcast', { type: 'broadcast', event, payload });
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    try { this.push(this.topic, 'phx_leave', {}); } catch { /* already closed */ }
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}
