/**
 * Live Smart Pump updates over Frappe's socket.io, so a pump's confirmed state
 * reaches the screen the moment the device acks instead of on the next poll.
 *
 * The server already pushes `smart_pump_update` (Smart Pump.publish_update) to
 * each pump's document room; the web portal listens to the same event.
 *
 * Two server rules shape this:
 *  - the namespace must be the SITE NAME, which on Frappe Cloud is not the
 *    public domain (sensor2.c.frappe.cloud behind sensor.upande.com), so it is
 *    taken from whoami's `site_name` and only falls back to the hostname;
 *  - auth is the session cookie, sent as a header (React Native's WebSocket
 *    accepts headers; a browser one would not need to).
 *
 * Polling stays on as the fallback: a socket that cannot connect costs nothing
 * but a slower update.
 */

import { io } from 'socket.io-client';

import { client } from './client';

let socket = null;
let socketKey = null;
const rooms = new Map(); // pump name -> subscriber count
const listeners = new Set();
let retryDelay = 2000;

function hostname(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/[/:].*$/, '');
}

function ensureSocket(siteName) {
  const base = String(client.baseUrl || '').replace(/\/+$/, '');
  const sid = client.sid;
  if (!base || !sid) return null;
  const ns = siteName || hostname(base);
  const key = `${base}|${ns}|${sid}`;
  if (socket && socketKey === key) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socketKey = key;
  socket = io(`${base}/${ns}`, {
    transports: ['websocket'],
    extraHeaders: { Cookie: `sid=${sid}` },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  // Rooms are per connection: rejoin every subscribed pump on each (re)connect.
  socket.on('connect', () => {
    for (const name of rooms.keys()) socket.emit('doc_subscribe', 'Smart Pump', name);
  });
  socket.on('smart_pump_update', (update) => {
    if (!update?.name) return;
    for (const fn of listeners) {
      try {
        fn(update);
      } catch {
        /* a bad listener must not starve the others */
      }
    }
  });
  // A transport failure is retried by socket.io itself, but a rejection from
  // the server's auth middleware (bad sid, deploy-time 502 on its user check)
  // destroys the socket for good. Rebuild it with the current sid, backing off.
  const mine = socket;
  socket.on('connect', () => {
    retryDelay = 2000;
  });
  socket.on('connect_error', () => {
    if (mine.active) return;
    setTimeout(() => {
      if (socket !== mine || !listeners.size) return;
      socket.removeAllListeners();
      socket = null;
      socketKey = null;
      ensureSocket(siteName);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });
  return socket;
}

/**
 * Subscribe to live updates for `names`. Returns an unsubscribe that leaves the
 * rooms and, when nothing is listening any more, closes the socket.
 */
export function subscribeToPumpUpdates(names, onUpdate, { siteName } = {}) {
  const s = ensureSocket(siteName);
  if (!s) return () => {};

  listeners.add(onUpdate);
  for (const name of names) {
    const count = rooms.get(name) || 0;
    rooms.set(name, count + 1);
    if (count === 0 && s.connected) s.emit('doc_subscribe', 'Smart Pump', name);
  }

  return () => {
    listeners.delete(onUpdate);
    for (const name of names) {
      const count = (rooms.get(name) || 1) - 1;
      if (count <= 0) {
        rooms.delete(name);
        if (socket?.connected) socket.emit('doc_unsubscribe', 'Smart Pump', name);
      } else {
        rooms.set(name, count);
      }
    }
    if (!listeners.size && socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
      socketKey = null;
    }
  };
}
