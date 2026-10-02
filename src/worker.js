import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const MAP_W = 80 * 48;
const MAP_H = 50 * 48;

/* Game settings: you can change these numbers later */
const CFG = {
  matchMs: 8 * 60 * 1000,
  controllerEnergy: 30,
  energyRegenPerSec: 0.05,
  lightsOffCost: 2,
  lightsOffCooldownMs: 12000,
  soundCost: 2,
  soundCooldownMs: 8000,
  soundMinDistance: 500,
  repairNeeded: 20,
  repairRange: 150,
  pulseGapMs: 350,
  terminalNeeded: 20,
  terminalRange: 110,
  terminals: [
    { name: "Laboratory", x: 13.5 * 48, y: 27.5 * 48 },
    { name: "Server Room", x: 70.5 * 48, y: 25.5 * 48 },
    { name: "Control Room", x: 52.5 * 48, y: 10.5 * 48 },
  ],
};
const GEN = { x: 70 * 48, y: 41 * 48 };

/* Spots in each room where a fake sound can come from */
const SOUND_SPOTS = [
  [11, 42], [28, 42], [13, 27], [32, 28], [52, 41],
  [70, 41], [70, 25], [32, 9], [52, 10], [70, 8],
].map((c) => ({ x: (c[0] + 0.5) * 48, y: (c[1] + 0.5) * 48 }));

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
    cdSound: 0,
    terms: CFG.terminals.map(() => 0),
    endAt: 0,
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
      terms: s.terms,
      termNeed: CFG.terminalNeeded,
      termNames: CFG.terminals.map((x) => x.name),
      left: s.phase === "playing" ? Math.max(0, s.endAt - Date.now()) : 0,
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
      await this.ctx.storage.deleteAlarm();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID().slice(0, 8);
    const role = s.phase === "playing" ? "survivor" : null;
    const me = {
      id: id, x: 11 * 48, y: 42 * 48, f: 0,
      role: role, lastRepair: 0, lastTerm: 0,
    };
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
      await this.startGame(ws);
    } else if (data.t === "lights_off") {
      await this.lightsOff(ws, me, now);
    } else if (data.t === "fake_sound") {
      await this.fakeSound(ws, me, now);
    } else if (data.t === "repair") {
      await this.repair(ws, me, now);
    } else if (data.t === "terminal") {
      await this.terminal(ws, me, data, now);
    }
  }

  async startGame(ws) {
    const cur = await this.getState();
    if (cur.phase === "playing") {
      this.sendTo(ws, { t: "deny", why: "A game is already running" });
      return;
    }
    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) {
      this.sendTo(ws, { t: "deny", why: "Need at least 2 players" });
      return;
    }
    const pick = Math.floor(Math.random() * sockets.length);
    const s = freshState();
    s.phase = "playing";
    s.endAt = Date.now() + CFG.matchMs;
    await this.ctx.storage.setAlarm(s.endAt);
    for (let i = 0; i < sockets.length; i++) {
      const sock = sockets[i];
      const a = sock.deserializeAttachment();
      if (!a) continue;
      a.role = i === pick ? "controller" : "survivor";
      a.lastRepair = 0;
      a.lastTerm = 0;
      sock.serializeAttachment(a);
      if (a.role === "controller") {
        this.sendTo(sock, {
          t: "role",
          role: "controller",
          energy: CFG.controllerEnergy,
          max: CFG.controllerEnergy,
          regen: CFG.energyRegenPerSec,
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
      ability: "lights",
      energy: s.energy,
      max: CFG.controllerEnergy,
      regen: CFG.energyRegenPerSec,
      cdMs: CFG.lightsOffCooldownMs,
    });
  }

  async fakeSound(ws, me, now) {
    if (me.role !== "controller") return;
    const s = await this.getState();
    if (s.phase !== "playing") return;
    if (now < (s.cdSound || 0)) {
      this.sendTo(ws, { t: "deny", why: "Ability is recharging" });
      return;
    }
    const e = this.currentEnergy(s, now);
    if (e < CFG.soundCost) {
      this.sendTo(ws, { t: "deny", why: "Not enough energy" });
      return;
    }
    const survivors = [];
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (a && a.role === "survivor") survivors.push({ w: w, a: a });
    }
    if (survivors.length === 0) return;

    let spots = SOUND_SPOTS.filter((sp) =>
      survivors.every((v) => Math.hypot(v.a.x - sp.x, v.a.y - sp.y) > CFG.soundMinDistance)
    );
    if (spots.length === 0) spots = SOUND_SPOTS;
    const spot = spots[Math.floor(Math.random() * spots.length)];

    s.energy = e - CFG.soundCost;
    s.energyAt = now;
    s.cdSound = now + CFG.soundCooldownMs;
    await this.saveState(s);

    for (const v of survivors) {
      this.sendTo(v.w, { t: "sound", x: spot.x, y: spot.y });
    }
    this.sendTo(ws, {
      t: "energy",
      ability: "sound",
      energy: s.energy,
      max: CFG.controllerEnergy,
      regen: CFG.energyRegenPerSec,
      cdMs: CFG.soundCooldownMs,
    });
  }

  async repair(ws, me, now) {
    if (me.role !== "survivor") return;
    const s = await this.getState();
    if (s.phase !== "playing" || s.power) return;
    if (now - (me.lastRepair || 0) < CFG.pulseGapMs) return;
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

  async terminal(ws, me, data, now) {
    if (me.role !== "survivor") return;
    const s = await this.getState();
    if (s.phase !== "playing" || !s.power) return;
    const i = Math.floor(Number(data.i));
    if (!(i >= 0 && i < CFG.terminals.length)) return;
    if (s.terms[i] >= CFG.terminalNeeded) return;
    if (now - (me.lastTerm || 0) < CFG.pulseGapMs) return;
    const t = CFG.terminals[i];
    if (Math.hypot(me.x - t.x, me.y - t.y) > CFG.terminalRange) return;
    me.lastTerm = now;
    ws.serializeAttachment(me);
    s.terms[i] += 1;
    const done = s.terms.every((v) => v >= CFG.terminalNeeded);
    await this.saveState(s);
    this.broadcast(this.stateMsg(s));
    if (done) await this.endGame(s, "survivors", "All terminals activated");
  }

  async endGame(s, winner, reason) {
    s.phase = "ended";
    await this.saveState(s);
    let cid = null;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (a && a.role === "controller") cid = a.id;
    }
    this.broadcast(this.stateMsg(s));
    this.broadcast({ t: "end", winner: winner, reason: reason, controller: cid });
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const s = await this.getState();
    if (s.phase === "playing" && Date.now() >= s.endAt - 100) {
      await this.endGame(s, "controller", "Time ran out");
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const me = ws.deserializeAttachment();
    try {
      ws.close(code, "closing");
    } catch (e) {}
    if (me) {
      this.broadcast({ t: "leave", id: me.id }, ws);
      if (me.role === "controller") {
        const s = await this.getState();
        if (s.phase === "playing") {
          await this.endGame(s, "survivors", "The Controller disconnected");
        }
      }
    }
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
