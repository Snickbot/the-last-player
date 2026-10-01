import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const MAP_W = 80 * 48;
const MAP_H = 50 * 48;

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return new Response("Room is full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID().slice(0, 8);
    const me = { id: id, x: 11 * 48, y: 42 * 48, f: 0 };
    server.serializeAttachment(me);

    const others = [];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a) others.push(a);
    }

    server.send(JSON.stringify({ t: "welcome", id: id, players: others }));
    this.broadcast({ t: "join", p: me }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) {
        try {
          ws.send(text);
        } catch (e) {}
      }
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 500) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }
    const me = ws.deserializeAttachment();
    if (!me) return;

    if (data.t === "move") {
      me.x = clamp(data.x, 0, MAP_W);
      me.y = clamp(data.y, 0, MAP_H);
      me.f = clamp(data.f, -7, 7);
      ws.serializeAttachment(me);
      this.broadcast({ t: "move", id: me.id, x: me.x, y: me.y, f: me.f }, ws);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const me = ws.deserializeAttachment();
    try {
      ws.close(code, "closing");
    } catch (e) {}
    if (me) this.broadcast({ t: "leave", id: me.id }, ws);
  }

  async webSocketError(ws, error) {
    const me = ws.deserializeAttachment();
    if (me) this.broadcast({ t: "leave", id: me.id }, ws);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket connection", { status: 426 });
      }
      let room = (url.searchParams.get("room") || "LOBBY").toUpperCase();
      room = room.replace(/[^A-Z0-9]/g, "").slice(0, 8) || "LOBBY";
      const id = env.GAME_ROOM.idFromName(room);
      return env.GAME_ROOM.get(id).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
