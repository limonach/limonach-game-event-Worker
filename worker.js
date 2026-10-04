// ROBOT BATTLE ROYALE - Stage 1 - worker.js
// Role: API gateway Worker (/join, /ws, /stats) + MatchRoom Durable Object (one match, server-authoritative).
// Paste/commit as worker.js (see wrangler.toml). Secrets: JOIN_SECRET, ADMIN_KEY. Var: ALLOWED_ORIGIN. KV: RL. DO: MATCH.

const C = {
  TICK_HZ: 20, SNAP_EVERY: 2,                 // TUNE: 20Hz sim, 10Hz snapshots
  MAX_PLAYERS: 52, START_HUMANS: 10, LOBBY_MS: 30000, // TUNE: start when 10 humans or 30s with >=1
  WORLD: 8000, CELL: 200, VIEW_HX: 740, VIEW_HY: 460,
  R: 24, HP: 100, SPEED: 220, DMG: 12, COOLDOWN_MS: 250, BSPEED: 1400, RANGE: 600,
  DC_GRACE_MS: 15000, MAX_MSG_S: 30, MAX_STRIKES: 8, HARD_CAP_S: 600,
  ZONE_R0: 4000, ZONE_OFFSET: 300,
  PHASES: [[120, 45, 2800, 2], [60, 40, 1800, 4], [50, 35, 1000, 8], [40, 30, 450, 14], [30, 25, 0, 22]], // wait,shrink,endR,dps
  BUILDINGS: 36, TOKEN_TTL_MS: 30000, JOIN_PER_MIN: 10,
  PRICE_REQ_PER_M: 0.15, PRICE_GBS_PER_M: 12.5, DO_MEM_GB: 0.128 // TUNE: check current Cloudflare pricing
};

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hkey = (secret, use) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
const sign = async (secret, data) => b64u(await crypto.subtle.sign('HMAC', await hkey(secret, 'sign'), enc.encode(data)));
const verify = async (secret, data, sig) => { try { return await crypto.subtle.verify('HMAC', await hkey(secret, 'verify'), unb64u(sig), enc.encode(data)); } catch { return false; } };
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const J = (o, s, h) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', ...(h || {}) } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });

      if (url.pathname === '/join' && req.method === 'POST') {
        if (!okOrigin) return J({ e: 'denied' }, 403);
        const ip = req.headers.get('CF-Connecting-IP') || 'x';
        const rk = 'rbr:rl:' + ip + ':' + Math.floor(Date.now() / 60000);
        const n = parseInt((await env.RL.get(rk)) || '0', 10); // NOTE: KV is not atomic; soft limit only
        if (n >= C.JOIN_PER_MIN) return J({ e: 'slow' }, 429, cors);
        await env.RL.put(rk, String(n + 1), { expirationTtl: 120 });
        let body; try { body = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!body || typeof body.gid !== 'string' || !/^[a-f0-9]{16}$/.test(body.gid) || Object.keys(body).length !== 1) return J({ e: 'bad' }, 400, cors);
        const data = body.gid + '.' + (Date.now() + C.TOKEN_TTL_MS) + '.' + hex(8);
        return J({ t: data + '.' + (await sign(env.JOIN_SECRET, data)) }, 200, cors);
      }

      if (url.pathname === '/ws') {
        if (!okOrigin) return new Response(null, { status: 403 });
        if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
        const p = (url.searchParams.get('t') || '').split('.');
        if (p.length !== 4 || !/^[a-f0-9]{16}$/.test(p[0]) || !/^\d{10,14}$/.test(p[1]) || !/^[a-f0-9]{16}$/.test(p[2])) return new Response(null, { status: 400 });
        if (+p[1] < Date.now()) return new Response(null, { status: 401 });
        if (!(await verify(env.JOIN_SECRET, p.slice(0, 3).join('.'), p[3]))) return new Response(null, { status: 401 });
        const r2 = new Request(req);
        r2.headers.set('x-gid', p[0]); r2.headers.set('x-nonce', p[2]); r2.headers.set('x-exp', p[1]);
        return env.MATCH.get(env.MATCH.idFromName('stage1')).fetch(r2);
      }

      if (url.pathname === '/stats') {
        if (!env.ADMIN_KEY || req.headers.get('x-admin') !== env.ADMIN_KEY) return new Response(null, { status: 404 });
        return env.MATCH.get(env.MATCH.idFromName('stage1')).fetch(new Request('https://do/stats'));
      }
      return new Response(null, { status: 404 });
    } catch (e) {
      console.log('worker_err', String(e && e.message));
      return J({ e: 'err' }, 500, cors);
    }
  }
};

// ---------- helpers ----------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cell = (v) => Math.max(0, Math.min(39, Math.floor(v / C.CELL)));
const circRect = (b, x, y, r) => { const dx = x - Math.max(b.x, Math.min(x, b.x + b.w)), dy = y - Math.max(b.y, Math.min(y, b.y + b.h)); return dx * dx + dy * dy < r * r; };
const blocked = (bl, x, y, r) => { for (let i = 0; i < bl.length; i++) if (circRect(bl[i], x, y, r)) return true; return false; };
const nrm = (d) => ((Math.round(d) % 360) + 360) % 360;

// ---------- Durable Object ----------
export class MatchRoom {
  constructor(state, env) { this.env = env; this.nonces = new Map(); this.timer = null; this.msgsIn = 0; this.reset(); }

  reset() {
    this.state = 'lobby'; this.seed = (Math.random() * 4294967296) >>> 0; this.R = rng(this.seed);
    this.players = new Map(); this.byGid = new Map(); this.bullets = []; this.nextId = 1; this.nextB = 1000;
    this.tickN = 0; this.lobbyAt = 0; this.startAt = 0; this.endAt = 0; this.emptyAt = 0;
    this.susp = []; this.sockMs = 0; this.msgsMatch = 0; this.lastZone = null; this.lastLobbyMsg = 0;
    this.genMap(); this.genZone();
  }

  genMap() {
    const R = this.R, bl = [];
    for (let tries = 0; tries < 600 && bl.length < C.BUILDINGS; tries++) {
      const w = 100 * (2 + Math.floor(R() * 4)), h = 100 * (2 + Math.floor(R() * 4));
      const a = R() * 6.2832, d = Math.sqrt(R()) * 3500;
      const x = Math.round((4000 + Math.cos(a) * d - w / 2) / 50) * 50, y = Math.round((4000 + Math.sin(a) * d - h / 2) / 50) * 50;
      if (bl.some((b) => x < b.x + b.w + 150 && x + w + 150 > b.x && y < b.y + b.h + 150 && y + h + 150 > b.y)) continue;
      bl.push({ x, y, w, h });
    }
    this.bl = bl;
  }

  genZone() {
    const R = this.R; const a = R() * 6.2832, d = R() * C.ZONE_OFFSET;
    this.z0 = { cx: 4000 + Math.cos(a) * d, cy: 4000 + Math.sin(a) * d };
    this.zt = []; let pc = this.z0, pr = C.ZONE_R0;
    for (const ph of C.PHASES) {
      const aa = R() * 6.2832, dd = R() * Math.max(0, pr - ph[2]) * 0.9;
      const c = ph[2] === 0 ? { cx: pc.cx, cy: pc.cy } : { cx: pc.cx + Math.cos(aa) * dd, cy: pc.cy + Math.sin(aa) * dd };
      this.zt.push(c); pc = c; pr = ph[2];
    }
  }

  zoneAt(el) {
    let t = el, cx = this.z0.cx, cy = this.z0.cy, r = C.ZONE_R0;
    for (let i = 0; i < C.PHASES.length; i++) {
      const [w, s, er, dps] = C.PHASES[i], g = this.zt[i];
      if (t < w) return { cx, cy, r, tcx: g.cx, tcy: g.cy, tr: er, left: w - t, ph: i + 1, dps, shrink: 0 };
      t -= w;
      if (t < s) { const a = t / s; return { cx: cx + (g.cx - cx) * a, cy: cy + (g.cy - cy) * a, r: r + (er - r) * a, tcx: g.cx, tcy: g.cy, tr: er, left: s - t, ph: i + 1, dps, shrink: 1 }; }
      t -= s; cx = g.cx; cy = g.cy; r = er;
    }
    return { cx, cy, r: 0, tcx: cx, tcy: cy, tr: 0, left: 0, ph: 5, dps: C.PHASES[4][3], shrink: 0 };
  }

  name() { return 'Unit-' + (1000 + Math.floor(Math.random() * 9000)); }

  spawn() {
    for (let i = 0; i < 100; i++) {
      const a = Math.random() * 6.2832, d = Math.sqrt(Math.random()) * 3500;
      const x = 4000 + Math.cos(a) * d, y = 4000 + Math.sin(a) * d;
      if (!blocked(this.bl, x, y, C.R + 10)) return [x, y];
    }
    return [4000, 4000];
  }

  mk(bot, gid, ws) {
    const [x, y] = this.spawn();
    const p = { id: this.nextId++, name: this.name(), bot, gid, ws, x, y, mx: 0, my: 0, aim: 0, fire: 0, cd: 0, hp: C.HP, alive: true, kills: 0, dmg: 0, place: 0, dcAt: 0, seq: 0, ack: 0, known: new Map(), strikes: 0, win: 0, cnt: 0, tx: 0, ty: 0, lx: x, ly: y, thinkAt: 0, killer: 0 };
    this.players.set(p.id, p); return p;
  }

  humans() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  connected() { let n = 0; for (const p of this.players.values()) if (!p.bot && p.ws) n++; return n; }
  send(ws, arr) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(arr)); } catch {} }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/stats') return J(this.stats());
    if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
    const gid = req.headers.get('x-gid'), nonce = req.headers.get('x-nonce'), exp = +req.headers.get('x-exp');
    if (!gid || !nonce || this.nonces.has(nonce)) return new Response(null, { status: 403 }); // replay protection
    const now = Date.now(); this.nonces.set(nonce, exp);
    for (const [k, v] of this.nonces) if (v < now) this.nonces.delete(k);
    const pair = new WebSocketPair(); const [cl, sv] = Object.values(pair);
    sv.accept(); this.onOpen(sv, gid);
    return new Response(null, { status: 101, webSocket: cl });
  }

  onOpen(ws, gid) {
    const now = Date.now(); ws._t0 = now; ws._win = 0; ws._cnt = 0;
    let p = this.byGid.get(gid);
    if (p && !p.bot) { if (p.ws && p.ws !== ws) { try { p.ws.close(1000, 'dup'); } catch {} } p.ws = ws; p.dcAt = 0; }
    else if (this.state === 'lobby' && this.humans() < C.MAX_PLAYERS) { p = this.mk(false, gid, ws); this.byGid.set(gid, p); if (!this.lobbyAt) this.lobbyAt = now; }
    else { this.send(ws, [3, 'busy']); try { ws.close(1000, 'busy'); } catch {} return; }
    ws._p = p;
    this.send(ws, [0, p.id, this.seed, this.bl.map((b) => [b.x, b.y, b.w, b.h])]);
    ws.addEventListener('message', (e) => this.onMsg(p, ws, e.data));
    ws.addEventListener('close', () => this.onClose(p, ws));
    ws.addEventListener('error', () => this.onClose(p, ws));
    if (!this.timer) this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.log('tick_err', String(e && e.stack)); } }, 1000 / C.TICK_HZ);
  }

  onClose(p, ws) {
    if (p.ws !== ws) return;
    this.sockMs += Date.now() - ws._t0; p.ws = null; p.dcAt = Date.now(); p.mx = 0; p.my = 0; p.fire = 0;
  }

  strike(p, ws, kind) {
    p.strikes++; if (this.susp.length < 200) this.susp.push({ p: p.id, k: kind, t: Date.now() });
    if (p.strikes >= C.MAX_STRIKES) { try { ws.close(1008, 'policy'); } catch {} }
  }

  onMsg(p, ws, d) {
    this.msgsIn++; this.msgsMatch++;
    const now = Date.now(), sec = Math.floor(now / 1000);
    if (ws._win !== sec) { ws._win = sec; ws._cnt = 0; }
    if (++ws._cnt > C.MAX_MSG_S) { this.strike(p, ws, 'flood'); try { ws.close(1008, 'rate'); } catch {} return; }
    if (typeof d !== 'string' || d.length > 40) return this.strike(p, ws, 'size');
    let a; try { a = JSON.parse(d); } catch { return this.strike(p, ws, 'json'); }
    if (!Array.isArray(a) || a.length !== 5 || !a.every(Number.isInteger)) return this.strike(p, ws, 'shape');
    const [seq, mx, my, aim, fire] = a;
    if (seq <= p.seq || seq > p.seq + 1000 || Math.abs(mx) > 100 || Math.abs(my) > 100 || aim < 0 || aim > 359 || (fire !== 0 && fire !== 1)) return this.strike(p, ws, 'range');
    p.seq = seq; p.ack = seq;
    if (p.alive) { p.mx = mx; p.my = my; p.aim = aim; p.fire = fire; }
  }

  // spatial grid: key = cx*100+cy
  grid(withBullets) {
    const g = new Map();
    const add = (e) => { const k = cell(e.x) * 100 + cell(e.y); const a = g.get(k); if (a) a.push(e); else g.set(k, [e]); };
    for (const p of this.players.values()) if (p.alive) add(p);
    if (withBullets) for (const b of this.bullets) add(b);
    return g;
  }
  q(g, x, y, r, fn) {
    for (let cx = cell(x - r); cx <= cell(x + r); cx++) for (let cy = cell(y - r); cy <= cell(y + r); cy++) { const a = g.get(cx * 100 + cy); if (a) for (const e of a) fn(e); }
  }

  startMatch(now) {
    const fill = C.MAX_PLAYERS - this.players.size;
    for (let i = 0; i < fill; i++) this.mk(true, null, null);
    this.state = 'running'; this.startAt = now; this.msgsMatch = 0;
    console.log(JSON.stringify({ ev: 'start', seed: this.seed, humans: this.humans(), bots: fill }));
  }

  think(b, now) {
    const z = this.z; let en = null, best = 1e9;
    this.q(this.gP, b.x, b.y, 600, (e) => { if (e === b) return; const d = Math.hypot(e.x - b.x, e.y - b.y); if (d < best) { best = d; en = e; } });
    const out = Math.hypot(b.x - z.cx, b.y - z.cy) > z.r - 250 || Math.hypot(b.x - z.tcx, b.y - z.tcy) > z.tr - 250;
    b.fire = 0; let dx, dy;
    if (out) { dx = z.tcx - b.x; dy = z.tcy - b.y; }
    else if (en) {
      const ex = en.x - b.x, ey = en.y - b.y;
      b.aim = nrm(Math.atan2(ey, ex) * 57.2958 + (Math.random() * 16 - 8));
      b.fire = best < 520 && Math.random() < 0.7 ? 1 : 0;
      if (best > 350) { dx = ex; dy = ey; } else { dx = -ey; dy = ex; }
    } else {
      if (!b.tx || Math.hypot(b.tx - b.x, b.ty - b.y) < 80 || Math.hypot(b.x - b.lx, b.y - b.ly) < 5) { b.tx = Math.max(100, Math.min(7900, b.x + (Math.random() - 0.5) * 1800)); b.ty = Math.max(100, Math.min(7900, b.y + (Math.random() - 0.5) * 1800)); }
      dx = b.tx - b.x; dy = b.ty - b.y;
    }
    b.lx = b.x; b.ly = b.y;
    const m = Math.hypot(dx, dy) || 1; b.mx = Math.round((dx / m) * 100); b.my = Math.round((dy / m) * 100);
    if (out || !en) b.aim = nrm(Math.atan2(dy, dx) * 57.2958);
  }

  kill(p, now) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.fire = 0; p.mx = 0; p.my = 0;
    let alive = 0; for (const o of this.players.values()) if (o.alive) alive++;
    p.place = alive + 1;
    const k = this.players.get(p.killer); if (k && k !== p) k.kills++;
    this.send(p.ws, [2, p.place, p.kills]);
  }

  tick() {
    const now = Date.now(), dt = 1 / C.TICK_HZ; this.tickN++;
    if (this.state === 'lobby') {
      if (!this.humans()) { if (this.timer) { clearInterval(this.timer); this.timer = null; } return; }
      const hum = this.humans();
      if (hum >= C.START_HUMANS || now - this.lobbyAt >= C.LOBBY_MS) this.startMatch(now);
      else if (now - this.lastLobbyMsg >= 1000) {
        this.lastLobbyMsg = now; const left = Math.ceil((C.LOBBY_MS - (now - this.lobbyAt)) / 1000);
        for (const p of this.players.values()) this.send(p.ws, [4, hum, left]);
      }
      return;
    }
    if (this.state === 'ended') {
      if (now - this.endAt > 5000) { for (const p of this.players.values()) { try { p.ws && p.ws.close(1000, 'end'); } catch {} } this.reset(); }
      return;
    }
    // running
    const el = (now - this.startAt) / 1000; const z = this.z = this.zoneAt(el);
    const dps = el > C.HARD_CAP_S ? 200 : z.dps;
    if (this.connected() === 0) { if (!this.emptyAt) this.emptyAt = now; else if (now - this.emptyAt > 20000) { this.finish(now, 'empty'); return; } } else this.emptyAt = 0;
    this.gP = this.grid(false);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!p.bot && !p.ws && p.dcAt && now - p.dcAt > C.DC_GRACE_MS) { p.hp = 0; this.kill(p, now); continue; }
      if (p.bot && now >= p.thinkAt) { p.thinkAt = now + 200; this.think(p, now); }
      let mx = p.mx, my = p.my; const m = Math.hypot(mx, my);
      if (m > 0) {
        const f = Math.min(m, 100) / m, sp = C.SPEED * (Math.min(m, 100) / 100);
        const nx = p.x + (mx / m) * sp * dt, ny = p.y + (my / m) * sp * dt;
        if (!blocked(this.bl, nx, p.y, C.R)) p.x = nx;
        if (!blocked(this.bl, p.x, ny, C.R)) p.y = ny;
        p.x = Math.max(C.R, Math.min(C.WORLD - C.R, p.x)); p.y = Math.max(C.R, Math.min(C.WORLD - C.R, p.y));
      }
      if (p.fire && now >= p.cd) {
        p.cd = now + C.COOLDOWN_MS; const r = p.aim * 0.0174533, c = Math.cos(r), s = Math.sin(r);
        this.bullets.push({ id: this.nextB++, b: 1, o: p.id, x: p.x + c * 30, y: p.y + s * 30, vx: c * C.BSPEED, vy: s * C.BSPEED, dist: 0 });
      }
      if (Math.hypot(p.x - z.cx, p.y - z.cy) > z.r) { p.hp -= dps * dt; if (p.hp <= 0) p.killer = 0; }
    }
    // bullets (3 substeps, vs walls and players)
    const keep = [];
    for (const b of this.bullets) {
      let dead = false;
      for (let s = 0; s < 3 && !dead; s++) {
        b.x += (b.vx * dt) / 3; b.y += (b.vy * dt) / 3;
        if (b.x < 0 || b.y < 0 || b.x > C.WORLD || b.y > C.WORLD || blocked(this.bl, b.x, b.y, 0)) { dead = true; break; }
        this.q(this.gP, b.x, b.y, 30, (e) => {
          if (dead || e.id === b.o || !e.alive) return;
          if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < (C.R + 4) ** 2) {
            dead = true; e.hp -= C.DMG; const o = this.players.get(b.o); if (o) o.dmg += C.DMG; if (e.hp <= 0 && !e.killer) e.killer = b.o;
          }
        });
      }
      b.dist += C.BSPEED * dt; if (b.dist >= C.RANGE) dead = true;
      if (!dead) keep.push(b);
    }
    this.bullets = keep;
    for (const p of this.players.values()) if (p.alive && p.hp <= 0) this.kill(p, now);
    let alive = 0, last = null; for (const p of this.players.values()) if (p.alive) { alive++; last = p; }
    if (alive <= 1 || el > C.HARD_CAP_S + 15) { if (last) { last.place = 1; } this.finish(now, alive <= 1 ? 'last' : 'cap'); return; }
    if (this.tickN % C.SNAP_EVERY === 0) {
      const gAll = this.grid(true), zArr = [z.cx | 0, z.cy | 0, z.r | 0, z.tcx | 0, z.tcy | 0, z.tr | 0, Math.ceil(z.left), z.ph, z.dps, z.shrink];
      for (const h of this.players.values()) if (!h.bot && h.ws) this.snap(h, gAll, zArr, alive, el);
    }
  }

  snap(h, g, zArr, alive, el) {
    const known = h.known, seen = new Set(), P = [], B = [];
    const x0 = h.x - C.VIEW_HX, x1 = h.x + C.VIEW_HX, y0 = h.y - C.VIEW_HY, y1 = h.y + C.VIEW_HY; // fixed server-side window
    for (let cx = cell(x0); cx <= cell(x1); cx++) for (let cy = cell(y0); cy <= cell(y1); cy++) {
      const a = g.get(cx * 100 + cy); if (!a) continue;
      for (const e of a) {
        if (e === h || e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) continue;
        seen.add(e.id);
        if (e.b) { if (!known.has(e.id)) { known.set(e.id, 1); B.push([e.id, e.x | 0, e.y | 0, e.vx | 0, e.vy | 0]); } }
        else { const s = (e.x | 0) + ',' + (e.y | 0) + ',' + e.aim + ',' + Math.ceil(e.hp); if (known.get(e.id) !== s) { known.set(e.id, s); P.push([e.id, e.x | 0, e.y | 0, e.aim, Math.ceil(e.hp)]); } }
      }
    }
    const G = []; for (const id of known.keys()) if (!seen.has(id)) { G.push(id); known.delete(id); }
    this.send(h.ws, [1, this.tickN, h.ack, [h.x | 0, h.y | 0, Math.ceil(Math.max(0, h.hp)), h.alive ? 1 : 0, h.kills], P, B, G, zArr, alive, el | 0]);
  }

  finish(now, reason) {
    this.state = 'ended'; this.endAt = now;
    const s = this.stats();
    for (const p of this.players.values()) { if (p.ws) this.sockMs += now - p.ws._t0; if (!p.bot) this.send(p.ws, [3, reason, p.place || 1, p.kills, Math.round(p.dmg)]); }
    for (const p of this.players.values()) if (p.ws) p.ws._t0 = now;
    console.log(JSON.stringify({ ev: 'end', reason, ...s, suspicious: this.susp.length }));
    // Stage 3: batch-write match + match_players + suspicion_logs to Supabase here (one write, via service key secret).
  }

  stats() {
    const secs = this.startAt ? ((this.endAt || Date.now()) - this.startAt) / 1000 : 0;
    const reqs = this.msgsMatch / 20 + this.humans();
    const gbs = C.DO_MEM_GB * secs;
    const cost = (reqs * C.PRICE_REQ_PER_M) / 1e6 + (gbs * C.PRICE_GBS_PER_M) / 1e6;
    return { state: this.state, humans: this.humans(), players: this.players.size, msgsInMatch: this.msgsMatch, msgsInTotal: this.msgsIn, matchSecs: Math.round(secs), billedReqEst: Math.round(reqs), socketSecs: Math.round(this.sockMs / 1000), costUsdEst: +cost.toFixed(5) };
  }
}
