import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const MAP_W = 80 * 48;
const MAP_H = 50 * 48;

/* Game settings: you can change these numbers later */
const CFG = {
  controllerEnergy: 30,
  energyRegenPerSec: 0.05,
  lightsOffCost: 2,
  lightsOffCooldownMs: 12000,
  repairNeeded: 20,
  repairMinGapMs: 350,
  repairRange: 150,
};
const GEN = { x: 70 * 48, y: 41 * 48 };

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function freshState() {
  return {
    phase: "lobby",
    power: true,
    repair: 0,
    energy: CFG.controllerEnergy,
    energyAt: Date.now(),
    cdLights: 0,
  };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async getState() {
    const s = await this.ctx.storage.get("s");
    return s || freshState();
  }

  async saveState(s) {
    await this.ctx.storage.put("s", s);
  }

  currentEnergy(s, now) {
    const e = s.energy + ((now - s.energyAt) / 1000) * CFG.energyRegenPerSec;
    return Math.min(CFG.controllerEnergy, e);
  }

  stateMsg(s) {
    return {
      t: "state",
      phase: s.phase,
      power: s.power,
      repair: s.repair,
      need: CFG.repairNeeded,
    };
  }

  sendTo(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
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

  async fetch(request) {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return new Response("Room is full", { status: 403 });
    }

    let s = await this.getState();
    if (sockets.length === 0 && s.phase !== "lobby") {
      s = freshState();
      await this.saveState(s);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID().slice(0, 8);
    const role = s.phase === "playing" ? "survivor" : null;
    const me = { id: id, x: 11 * 48, y: 42 * 48, f: 0, role: role, lastRepair: 0 };
    server.serializeAttachment(me);

    const others = [];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a) others.push({ id: a.id, x: a.x, y: a.y, f: a.f });
    }

    server.send(
      JSON.stringify({
        t: "welcome",
        id: id,
        players: others,
        role: role,
        state: this.stateMsg(s),
      })
    );
    this.broadcast({ t: "join", p: { id: id, x: me.x, y: me.y, f: me.f } }, server);

    return new Response(null, { status: 101, webSocket: client });
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
    const now = Date.now();

    if (data.t === "move") {
      me.x = clamp(data.x, 0, MAP_W);
      me.y = clamp(data.y, 0, MAP_H);
      me.f = clamp(data.f, -7, 7);
      ws.serializeAttachment(me);
      this.broadcast({ t: "move", id: me.id, x: me.x, y: me.y, f: me.f }, ws);
    } else if (data.t === "start") {
      await this.startGame();
    } else if (data.t === "lights_off") {
      await this.lightsOff(ws, me, now);
    } else if (data.t === "repair") {
      await this.repair(ws, me, now);
    }
  }

  async startGame() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) return;
    const pick = Math.floor(Math.random() * sockets.length);
    const s = freshState();
    s.phase = "playing";
    for (let i = 0; i < sockets.length; i++) {
      const sock = sockets[i];
      const a = sock.deserializeAttachment();
      if (!a) continue;
      a.role = i === pick ? "controller" : "survivor";
      a.lastRepair = 0;
      sock.serializeAttachment(a);
      if (a.role === "controller") {
        this.sendTo(sock, {
          t: "role",
          role: "controller",
          energy: CFG.controllerEnergy,
          max: CFG.controllerEnergy,
          regen: CFG.energyRegenPerSec,
          cdMs: 0,
        });
      } else {
        this.sendTo(sock, { t: "role", role: "survivor" });
      }
    }
    await this.saveState(s);
    this.broadcast(this.stateMsg(s));
  }

  async lightsOff(ws, me, now) {
    if (me.role !== "controller") return;
    const s = await this.getState();
    if (s.phase !== "playing" || !s.power) {
      this.sendTo(ws, { t: "deny", why: "Lights are already off" });
      return;
    }
    if (now < s.cdLights) {
      this.sendTo(ws, { t: "deny", why: "Ability is recharging" });
      return;
    }
    const e = this.currentEnergy(s, now);
    if (e < CFG.lightsOffCost) {
      this.sendTo(ws, { t: "deny", why: "Not enough energy" });
      return;
    }
    s.energy = e - CFG.lightsOffCost;
    s.energyAt = now;
    s.cdLights = now + CFG.lightsOffCooldownMs;
    s.power = false;
    s.repair = 0;
    await this.saveState(s);
    this.broadcast(this.stateMsg(s));
    this.sendTo(ws, {
      t: "energy",
      energy: s.energy,
      max: CFG.controllerEnergy,
      regen: CFG.energyRegenPerSec,
      cdMs: CFG.lightsOffCooldownMs,
    });
  }

  async repair(ws, me, now) {
    if (me.role !== "survivor") return;
    const s = await this.getState();
    if (s.phase !== "playing" || s.power) return;
    if (now - (me.lastRepair || 0) < CFG.repairMinGapMs) return;
    const d = Math.hypot(me.x - GEN.x, me.y - GEN.y);
    if (d > CFG.repairRange) return;
    me.lastRepair = now;
    ws.serializeAttachment(me);
    s.repair += 1;
    if (s.repair >= CFG.repairNeeded) {
      s.power = true;
      s.repair = 0;
    }
    await this.saveState(s);
    this.broadcast(this.stateMsg(s));
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
