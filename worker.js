// ROBOT BATTLE ROYALE - Stage 3 - worker.js
// Role: API gateway (/auth /join /party/* /leave /stats /ws), Matchmaker DO (queues + parties), MatchRoom DO (one match per DO), Supabase writes at match end.
// Commit as worker.js next to wrangler.toml. Secrets: JOIN_SECRET, ADMIN_KEY, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN.

const C = {
  TICK_HZ: 20, SNAP_EVERY: 2,                 // TUNE: 20Hz sim, 10Hz snapshots
  MAX_PLAYERS: 52, START_HUMANS: 10, LOBBY_MS: 30000, // TUNE: start when 10 humans or 30s with >=1
  WORLD: 8000, CELL: 200, VIEW_HX: 740, VIEW_HY: 460,
  R: 24, HP: 100, SPEED: 220, DMG: 12, COOLDOWN_MS: 250, BSPEED: 1400, RANGE: 240, MAX_RANGE: 300, // TUNE: reach = range+58 must stay < 360 (half of 720 view height)
  WEAPONS: [{ dmg: 12, cd: 250, sp: 1400, rg: 240, n: 1, spread: 0 }, { dmg: 7, cd: 850, sp: 1200, rg: 170, n: 5, spread: 9 }, { dmg: 24, cd: 650, sp: 2400, rg: 300, n: 1, spread: 0 }], RAR: [1, 1.2, 1.45], // TUNE: blaster, shotgun, laser; rarity dmg multipliers
  BOT_DMG: 0.5, BOT_CD: 1.8, BOT_RANGE: 260, BOT_SEE: 330, BOT_PEACE_S: 75, BOT_VS_BOT: 0.5, BOT_LOOT_R: 450, BOT_AIM_ERR: 18, BOT_FIRE_P: 0.35, BOT_SPEED: 0.8, GRACE_MS: 6000, BOT_COS: { skin: ['skin_crimson', 'skin_forest'], trail: ['trail_cyan', 'trail_pink'], fx: ['fx_blue', 'fx_green'] },
  AC: { MIN_SHOTS: 50, ACC: 0.9, SNAPS: 30, NEAR_S: 120 }, // TUNE anti-cheat flags: manual-aim hit rate >=90% over 50+ shots, 30+ instant 120deg aim snaps while firing, 120s next to another human without any damage between them // TUNE: bots were too aggressive; 6s spawn grace
  AUTO_RANGE: 280, AUTO_ERR: 6, // TUNE: auto-aim range (< weapon range) and random aim error in degrees
  DC_GRACE_MS: 15000, MAX_MSG_S: 30, MAX_STRIKES: 8, HARD_CAP_S: 600,
  ZONE_R0: 4000, ZONE_OFFSET: 300,
  PHASES: [[120, 45, 2800, 2], [60, 40, 1800, 4], [50, 35, 1000, 8], [40, 30, 450, 14], [30, 25, 0, 22]], // wait,shrink,endR,dps
  BUILDINGS: 56, ROCKS: 160, TREES: 240, LOOT_IN: 4, LOOT_OUT: 160, PICK_R: 60, SHIELD_BASE: 50, PHASE_XP: 15, BOT_KILL_XP: 30, // TUNE
  XP_LV: [0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200], XP_ITEM: [10, 25, 60],
  TOKEN_TTL_MS: 30000, JOIN_PER_MIN: 10,
  PRICE_REQ_PER_M: 0.15, PRICE_GBS_PER_M: 12.5, DO_MEM_GB: 0.128 // TUNE: check current Cloudflare pricing
};

const K = { SESSION_MS: 4 * 3600 * 1000, TG_MAX_AGE_S: 86400, JOIN_MS: 30000, OPEN_MS: 35000, PARTY_MAX: 4, PARTY_TTL_MS: 1800000, TEAM: { solo: 1, duo: 2, squad: 4 }, RL: { auth: 20, join: 15, party: 40, stats: 30, shop: 30 } }; // TUNE
const COS_ID = /^(skin|trail|fx)_[a-z0-9]{2,12}$/;
const pickCos = (rows) => { const got = {}; for (const r of Array.isArray(rows) ? rows : []) { const m = r && typeof r.cosmetic_id === 'string' ? COS_ID.exec(r.cosmetic_id) : null; if (m && !got[m[1]]) got[m[1]] = r.cosmetic_id; } return Object.values(got).join(','); }; // one equipped id per type, validated
const parseCos = (s) => { const o = {}; for (const id of String(s).split(',')) { const m = COS_ID.exec(id); if (m && !o[m[1]]) o[m[1]] = id; } return o; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hkey = (secret, use) => crypto.subtle.importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
const sign = async (secret, data) => b64u(await crypto.subtle.sign('HMAC', await hkey(secret, 'sign'), enc.encode(data)));
const verify = async (secret, data, sig) => { try { return await crypto.subtle.verify('HMAC', await hkey(secret, 'verify'), unb64u(sig), enc.encode(data)); } catch { return false; } };
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const J = (o, s, h) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...(h || {}) } });
const reward = (place, kills) => 20 + kills * 15 + (place === 1 ? 150 : place <= 3 ? 75 : place <= 10 ? 30 : 0); // TUNE: soft currency per match (server-side only; SQL also caps it)

// Signed tokens: base64url(json) + '.' + HMAC(domain + payload). Domains separate session tokens (S1.) from match-join tokens (J1.).
async function mkTok(env, dom, obj) { const p = b64u(enc.encode(JSON.stringify(obj))); return p + '.' + (await sign(env.JOIN_SECRET, dom + p)); }
async function rdTok(env, dom, t) {
  if (typeof t !== 'string' || t.length > 700) return null; const a = t.split('.'); if (a.length !== 2 || !a[0] || !a[1]) return null;
  if (!(await verify(env.JOIN_SECRET, dom + a[0], a[1]))) return null;
  try { const o = JSON.parse(new TextDecoder().decode(unb64u(a[0]))); return o && o.exp > Date.now() ? o : null; } catch { return null; }
}
// Telegram Mini App initData check (HMAC-SHA256, per Telegram docs) + freshness window
async function tgVerify(env, initData) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096 || !env.TELEGRAM_BOT_TOKEN) return null;
  const sp = new URLSearchParams(initData), hash = sp.get('hash'); if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null; sp.delete('hash');
  const dcs = [...sp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const sk = await crypto.subtle.sign('HMAC', await hkey('WebAppData', 'sign'), enc.encode(env.TELEGRAM_BOT_TOKEN));
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', await hkey(sk, 'sign'), enc.encode(dcs)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!teq(mac, hash)) return null;
  const ad = parseInt(sp.get('auth_date'), 10), now = Date.now() / 1000; if (!(ad > 0) || now - ad > K.TG_MAX_AGE_S || ad > now + 60) return null;
  let u; try { u = JSON.parse(sp.get('user')); } catch { return null; }
  if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
  return { id: u.id, name: String(u.first_name || 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 24) || 'Player' };
}
// Supabase REST via service key (secret only; never logged, never sent to clients)
const sb = (env, path, init = {}) => {
  const k = env.SUPABASE_SERVICE_ROLE_KEY, h = { apikey: k, 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (!k.startsWith('sb_')) h.Authorization = 'Bearer ' + k; // new-style sb_secret_ keys are sent as apikey only
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, { ...init, headers: h });
};
async function rl(env, key, max) { // soft per-IP limit (KV is not atomic). Per-user atomic limits live in Matchmaker.
  const k = 'rbr:rl:' + key + ':' + Math.floor(Date.now() / 60000), n = parseInt((await env.RL.get(k)) || '0', 10);
  if (n >= max) return false; await env.RL.put(k, String(n + 1), { expirationTtl: 120 }); return true;
}
async function flushPending(env) { // retry end-of-match writes that failed (idempotent RPC)
  const l = await env.RL.list({ prefix: 'rbr:pend:', limit: 20 });
  for (const k of l.keys) { const v = await env.RL.get(k.name); if (!v) continue; try { const r = await sb(env, 'rpc/finish_match', { method: 'POST', body: v }); if (r.ok) await env.RL.delete(k.name); } catch {} }
}
const mmStub = (env) => env.MM.get(env.MM.idFromName('mm'));
const mmCall = async (env, path, body) => { const r = await mmStub(env).fetch('https://mm' + path, { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(flushPending(env)); },
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean), okOrigin = allowed.includes(origin);
    const cors = okOrigin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const ip = req.headers.get('CF-Connecting-IP') || 'x', P = url.pathname;
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } });
      if (P === '/admin/stats') { // admin only: matchmaker + (optional) one match room
        if (!env.ADMIN_KEY || !teq(req.headers.get('x-admin'), env.ADMIN_KEY)) return new Response(null, { status: 404 });
        const m = url.searchParams.get('m'), out = { mm: await (await mmStub(env).fetch('https://mm/stats', { method: 'POST', body: '{}' })).json() };
        if (m && UUID.test(m)) out.room = await (await env.MATCH.get(env.MATCH.idFromName(m)).fetch('https://do/stats')).json();
        return J(out);
      }
      if (!okOrigin) return new Response(null, { status: 403 });

      if (P === '/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
        const t = await rdTok(env, 'J1.', url.searchParams.get('t'));
        if (!t || !/^[pg]:[0-9a-f-]{8,36}$/.test(t.u) || !(t.pid === null || UUID.test(t.pid)) || !UUID.test(t.m) || !K.TEAM[t.md] || !/^([A-Z2-9]{6})?$/.test(t.pt) || !/^[a-f0-9]{16}$/.test(t.n) || !/^[a-z0-9_,]{0,60}$/.test(t.cs || '')) return new Response(null, { status: 401 });
        const ipc = (await sign(env.JOIN_SECRET, 'ip|' + ip + '|' + t.m)).slice(0, 10); // salted per match: same-network detection inside one match, no raw IP stored anywhere
        const r2 = new Request(req);
        for (const [k, v] of [['x-u', t.u], ['x-pid', t.pid || ''], ['x-m', t.m], ['x-md', t.md], ['x-pt', t.pt], ['x-nonce', t.n], ['x-exp', String(t.exp)], ['x-ipc', ipc], ['x-cs', t.cs || '']]) r2.headers.set(k, v);
        return env.MATCH.get(env.MATCH.idFromName(t.m)).fetch(r2);
      }

      if (P === '/auth' && req.method === 'POST') {
        if (!(await rl(env, 'auth:' + ip, K.RL.auth))) return J({ e: 'slow' }, 429, cors);
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'initData')) return J({ e: 'bad' }, 400, cors);
        if (b.initData) {
          const tg = await tgVerify(env, b.initData); if (!tg) return J({ e: 'auth' }, 401, cors);
          const r = await sb(env, 'players?on_conflict=telegram_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ telegram_id: tg.id, name: tg.name }]) });
          const row = r.ok ? (await r.json())[0] : null; if (!row) { console.log('auth_db', r.status); return J({ e: 'err' }, 502, cors); }
          if (row.banned) return J({ e: 'banned' }, 403, cors);
          return J({ s: await mkTok(env, 'S1.', { u: 'p:' + row.id, pid: row.id, exp: Date.now() + K.SESSION_MS }), lvl: row.level, xp: row.total_xp, soft: row.soft_currency }, 200, cors);
        }
        if (env.ALLOW_GUEST !== '1') return J({ e: 'auth' }, 401, cors);
        return J({ s: await mkTok(env, 'S1.', { u: 'g:' + hex(8), pid: null, exp: Date.now() + K.SESSION_MS }), guest: 1 }, 200, cors);
      }

      const ses = await rdTok(env, 'S1.', (req.headers.get('Authorization') || '').slice(7));
      if (!ses || !/^[pg]:[0-9a-f-]{8,36}$/.test(ses.u)) return J({ e: 'auth' }, 401, cors);

      if (P === '/stats' && req.method === 'GET') {
        if (!(await rl(env, 'stats:' + ses.u, K.RL.stats))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ guest: 1 }, 200, cors);
        const r = await sb(env, 'players?id=eq.' + ses.pid + '&select=level,total_xp,soft_currency,premium_currency');
        const row = r.ok ? (await r.json())[0] : null; return row ? J(row, 200, cors) : J({ e: 'err' }, 502, cors);
      }
      if (P === '/shop' || P === '/shop/buy' || P === '/shop/equip') { // cosmetics only: no stat advantages are for sale
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/shop' && req.method === 'GET') {
          let cat = await env.RL.get('rbr:cat');
          if (!cat) { const r = await sb(env, 'cosmetics?select=id,type,name,rarity,price,currency&currency=eq.soft&order=price.asc'); if (!r.ok) return J({ e: 'err' }, 502, cors); cat = JSON.stringify(await r.json()); await env.RL.put('rbr:cat', cat, { expirationTtl: 300 }); }
          const r = await sb(env, 'players?id=eq.' + ses.pid + '&select=soft_currency,player_cosmetics(cosmetic_id,equipped)'); const row = r.ok ? (await r.json())[0] : null;
          if (!row) return J({ e: 'err' }, 502, cors);
          return J({ cat: JSON.parse(cat), soft: row.soft_currency, own: row.player_cosmetics }, 200, cors);
        }
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object') return J({ e: 'bad' }, 400, cors);
        let call;
        if (P === '/shop/buy') {
          if (Object.keys(b).some((k) => k !== 'id') || typeof b.id !== 'string' || !COS_ID.test(b.id)) return J({ e: 'bad' }, 400, cors);
          call = ['buy_cosmetic', { pid: ses.pid, cid: b.id }];
        } else {
          if (Object.keys(b).some((k) => k !== 'id' && k !== 'type') || !(b.id === null || (typeof b.id === 'string' && COS_ID.test(b.id))) || (b.id === null && !['skin', 'trail', 'fx'].includes(b.type))) return J({ e: 'bad' }, 400, cors);
          call = ['equip_cosmetic', { pid: ses.pid, cid: b.id, type: b.type || null }];
        }
        const r = await sb(env, 'rpc/' + call[0], { method: 'POST', body: JSON.stringify({ p: call[1] }) });
        if (!r.ok) { console.log('shop_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json();
        if (j.ok) return J(j, 200, cors);
        return J({ e: j.e || 'err' }, j.e === 'owned' || j.e === 'funds' ? 409 : j.e === 'item' || j.e === 'notowned' ? 404 : 400, cors);
      }
      if (P.startsWith('/party/') || P === '/leave' || P === '/join') {
        if (!(await rl(env, (P === '/join' ? 'join:' : 'party:') + ip, P === '/join' ? K.RL.join : K.RL.party))) return J({ e: 'slow' }, 429, cors);
        let b = {}; if (req.method === 'POST') { try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); } }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'mode' && k !== 'code')) return J({ e: 'bad' }, 400, cors);
        if (P === '/join') {
          if (!K.TEAM[b.mode] || typeof b.mode !== 'string') return J({ e: 'bad' }, 400, cors);
          let cs = '';
          if (ses.pid) { const r = await sb(env, 'players?id=eq.' + ses.pid + '&select=banned,player_cosmetics(cosmetic_id)&player_cosmetics.equipped=eq.true'); const row = r.ok ? (await r.json())[0] : null; if (!row) return J({ e: 'err' }, 503, cors); if (row.banned) return J({ e: 'banned' }, 403, cors); cs = pickCos(row.player_cosmetics); } // fail closed
          const [st, j] = await mmCall(env, '/join', { u: ses.u, md: b.mode });
          if (st !== 200) return J({ e: j.e || 'err' }, st, cors);
          const t = await mkTok(env, 'J1.', { u: ses.u, pid: ses.pid, m: j.m, md: j.md, pt: j.pt, cs, exp: Date.now() + K.JOIN_MS, n: hex(8) });
          return J({ t, md: j.md }, 200, cors);
        }
        const [st, j] = await mmCall(env, P, { u: ses.u, code: b.code });
        return J(j, st, cors);
      }
      return new Response(null, { status: 404 });
    } catch (e) {
      console.log('worker_err', String(e && e.message));
      return J({ e: 'err' }, 500, cors);
    }
  }
};

// ---------- Matchmaker Durable Object (singleton "mm") ----------
// Why a DO and not KV: KV is eventually consistent and has no atomic ops, so two simultaneous joins can overfill a match or break
// "one active match per user". A single-threaded DO serialises every decision. State is in memory: an eviction loses queues/parties
// (players already inside a match are unaffected; they can simply queue again).
export class Matchmaker {
  constructor(state, env) { this.open = {}; this.um = new Map(); this.parties = new Map(); this.up = new Map(); this.last = new Map(); }
  gc(now) {
    for (const [c, p] of this.parties) if (!p.match && now - p.at > K.PARTY_TTL_MS) this.drop(c);
    for (const [u, e] of this.um) if (now - e.t > 1200000) this.um.delete(u);
    if (this.last.size > 2000) this.last.clear();
  }
  drop(c) { const p = this.parties.get(c); if (!p) return; for (const u of p.members) if (this.up.get(u) === c) this.up.delete(u); this.parties.delete(c); }
  slot(md, n, now) {
    let o = this.open[md];
    if (!o || o.n + n > C.MAX_PLAYERS || now - o.since > K.OPEN_MS) o = this.open[md] = { m: crypto.randomUUID(), since: now, n: 0 };
    o.n += n; return o.m;
  }
  async fetch(req) {
    let b = {}; try { b = await req.json(); } catch {}
    const P = new URL(req.url).pathname, now = Date.now(); this.gc(now);
    if (P === '/stats') return J({ open: Object.keys(this.open).length, active: this.um.size, parties: this.parties.size });
    if (P === '/started') { if (K.TEAM[b.md] && this.open[b.md] && this.open[b.md].m === b.m) delete this.open[b.md]; return J({ ok: 1 }); }
    if (P === '/ended') {
      if (!UUID.test(b.m) || !Array.isArray(b.us) || b.us.length > 60) return J({ e: 'bad' }, 400);
      for (const x of b.us) { const e = this.um.get(x); if (e && e.m === b.m) this.um.delete(x); }
      for (const p of this.parties.values()) if (p.match && p.match.m === b.m) delete p.match;
      return J({ ok: 1 });
    }
    const u = typeof b.u === 'string' && /^[pg]:[0-9a-f-]{8,36}$/.test(b.u) ? b.u : null; if (!u) return J({ e: 'bad' }, 400);
    const lk = P + u; if (now - (this.last.get(lk) || 0) < (P === '/join' ? 1500 : 800)) return J({ e: 'slow' }, 429); this.last.set(lk, now);
    const code = this.up.get(u), pa = code && this.parties.get(code);
    if (P === '/join') {
      const md = b.md, cur = this.um.get(u);
      if (!K.TEAM[md]) return J({ e: 'bad' }, 400);
      if (cur) return J({ m: cur.m, md: cur.md, pt: cur.pt }); // one active match per user: re-issue a token for the same match
      if (pa) {
        if (!pa.match) {
          if (pa.leader !== u) return J({ e: 'leader' }, 409);
          pa.match = { m: this.slot(md, pa.members.size, now), md };
        }
        this.um.set(u, { m: pa.match.m, md: pa.match.md, pt: code, t: now });
        return J({ m: pa.match.m, md: pa.match.md, pt: code });
      }
      const m = this.slot(md, 1, now); this.um.set(u, { m, md, pt: '', t: now }); return J({ m, md, pt: '' });
    }
    if (P === '/leave') {
      const cur = this.um.get(u);
      if (cur) { const o = this.open[cur.md]; if (o && o.m === cur.m && o.n > 0) o.n--; this.um.delete(u); }
      if (pa) { if (pa.leader === u) this.drop(code); else { pa.members.delete(u); this.up.delete(u); } }
      return J({ ok: 1 });
    }
    if (P === '/party/create') {
      if (code) return J({ code });
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c;
      do { c = [...crypto.getRandomValues(new Uint8Array(6))].map((x) => A[x % A.length]).join(''); } while (this.parties.has(c));
      this.parties.set(c, { leader: u, members: new Set([u]), at: now }); this.up.set(u, c); return J({ code: c });
    }
    if (P === '/party/join') {
      const c = typeof b.code === 'string' && /^[A-Z2-9]{6}$/.test(b.code) ? b.code : null, p = c && this.parties.get(c);
      if (!p || p.match || (p.members.size >= K.PARTY_MAX && !p.members.has(u)) || (code && code !== c)) return J({ e: 'nope' }, 404); // one generic error: no code oracle
      p.members.add(u); this.up.set(u, c); return J({ code: c });
    }
    if (P === '/party/leave') {
      if (pa) { if (pa.leader === u) this.drop(code); else { pa.members.delete(u); this.up.delete(u); } }
      return J({ ok: 1 });
    }
    if (P === '/party/status') return J(pa ? { code, leader: pa.leader === u, n: pa.members.size, matched: !!pa.match } : { code: null });
    return J({ e: 'bad' }, 404);
  }
}

// ---------- helpers ----------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cell = (v) => Math.max(0, Math.min(39, Math.floor(v / C.CELL)));
const circRect = (b, x, y, r) => { const dx = x - Math.max(b.x, Math.min(x, b.x + b.w)), dy = y - Math.max(b.y, Math.min(y, b.y + b.h)); return dx * dx + dy * dy < r * r; };
const blocked = (bl, x, y, r) => { for (let i = 0; i < bl.length; i++) { const b = bl[i]; if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) continue; const w = b.walls; for (let j = 0; j < w.length; j++) if (circRect(w[j], x, y, r)) return true; } return false; };
const teq = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
function wallsOf(x, y, w, h, s) { // building = 4 walls (20u thick), 100u door gap on side s (0 top,1 right,2 bottom,3 left). MUST match client.
  const t = 20, g = 100, o = [];
  const hs = (yy, gap) => { if (gap) { const a = x + (w - g) / 2; o.push({ x, y: yy, w: a - x, h: t }, { x: a + g, y: yy, w: x + w - a - g, h: t }); } else o.push({ x, y: yy, w, h: t }); };
  const vs = (xx, gap) => { if (gap) { const a = y + t + (h - 2 * t - g) / 2; o.push({ x: xx, y: y + t, w: t, h: a - y - t }, { x: xx, y: a + g, w: t, h: y + h - t - a - g }); } else o.push({ x: xx, y: y + t, w: t, h: h - 2 * t }); };
  hs(y, s === 0); hs(y + h - t, s === 2); vs(x, s === 3); vs(x + w - t, s === 1); return o;
}
const nrm = (d) => ((Math.round(d) % 360) + 360) % 360;

// ---------- Durable Object ----------
export class MatchRoom {
  constructor(state, env) { this.state = state; this.mode = ''; this.mid = ''; this.closed = false; this.env = env; this.nonces = new Map(); this.timer = null; this.msgsIn = 0; this.reset(); }

  reset() {
    this.state = 'lobby'; this.seed = (Math.random() * 4294967296) >>> 0; this.R = rng(this.seed);
    this.players = new Map(); this.byGid = new Map(); this.bullets = []; this.nextId = 1; this.nextB = 1000;
    this.tickN = 0; this.lobbyAt = 0; this.startAt = 0; this.endAt = 0; this.emptyAt = 0;
    this.susp = []; this.sockMs = 0; this.msgsMatch = 0; this.lastZone = null; this.lastLobbyMsg = 0;
    this.lastPh = 0; this.lastTk = 0; this.tl = []; this.teams = 0; this.lastNear = 0; this.near = new Map(); this.rosterMsg = null; this.rm = []; this.genMap(); this.genZone(); this.genLoot();
  }

  genMap() { // seeded: same seed -> same map. Buildings on 50u grid, 4 horizontal + 4 vertical roads, 16 district tints.
    const R = this.R, bl = [];
    for (let tries = 0; tries < 2000 && bl.length < C.BUILDINGS; tries++) {
      const w = 50 * (4 + Math.floor(R() * 6)), h = 50 * (4 + Math.floor(R() * 6));
      const a = R() * 6.2832, d = Math.sqrt(R()) * 3700;
      const x = Math.round((4000 + Math.cos(a) * d - w / 2) / 50) * 50, y = Math.round((4000 + Math.sin(a) * d - h / 2) / 50) * 50, s = Math.floor(R() * 4);
      if (x < 100 || y < 100 || x + w > 7900 || y + h > 7900) continue;
      if (bl.some((b) => x < b.x + b.w + 120 && x + w + 120 > b.x && y < b.y + b.h + 120 && y + h + 120 > b.y)) continue;
      bl.push({ x, y, w, h, s, walls: wallsOf(x, y, w, h, s) });
    }
    this.bl = bl; this.rh = []; this.rv = [];
    for (let i = 0; i < 4; i++) { this.rh.push(Math.round(1000 + i * 2000 + (R() - 0.5) * 600)); this.rv.push(Math.round(1000 + i * 2000 + (R() - 0.5) * 600)); }
    this.dist = []; for (let i = 0; i < 16; i++) this.dist.push(Math.floor(R() * 3));
    this.ob = []; const nearRoad = (x, y) => this.rh.some((v) => Math.abs(y - v) < 120) || this.rv.some((v) => Math.abs(x - v) < 120);
    for (let tries = 0; tries < 4000 && this.ob.length < C.ROCKS + C.TREES; tries++) { // rocks first, then trees; trees collide only with the trunk
      const x = Math.round(150 + R() * 7700), y = Math.round(150 + R() * 7700), tree = this.ob.length >= C.ROCKS ? 1 : 0, r = tree ? 55 + Math.floor(R() * 26) : 22 + Math.floor(R() * 21), v = Math.floor(R() * 63);
      if (nearRoad(x, y) || bl.some((b) => x > b.x - 80 && x < b.x + b.w + 80 && y > b.y - 80 && y < b.y + b.h + 80)) continue;
      this.ob.push({ x, y, r, t: tree, v });
    }
    this.col = bl.concat(this.ob.map((o) => { const h = o.t ? 14 : o.r * 0.85, q = { x: o.x - h, y: o.y - h, w: 2 * h, h: 2 * h }; return { ...q, walls: [q] }; }));
    this.cg = new Map(); for (const b of this.col) for (let cx = cell(b.x); cx <= cell(b.x + b.w); cx++) for (let cy = cell(b.y); cy <= cell(b.y + b.h); cy++) { const k = cx * 100 + cy, a = this.cg.get(k); if (a) a.push(b); else this.cg.set(k, [b]); }
  }
  hit(x, y, r) { // circle vs buildings+obstacles through the 200u grid
    for (let cx = cell(x - r); cx <= cell(x + r); cx++) for (let cy = cell(y - r); cy <= cell(y + r); cy++) { const a = this.cg.get(cx * 100 + cy); if (!a) continue; for (const b of a) { if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) continue; for (const w of b.walls) if (circRect(w, x, y, r)) return true; } }
    return false;
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
      if (!this.hit(x, y, C.R + 10)) return [x, y];
    }
    return [4000, 4000];
  }

  mk(bot, gid, ws) {
    const [x, y] = this.spawn();
    const p = { id: this.nextId++, name: this.name(), bot, gid, ws, x, y, mx: 0, my: 0, aim: 0, fire: 0, cd: 0, hp: C.HP, alive: true, kills: 0, dmg: 0, place: 0, dcAt: 0, seq: 0, ack: 0, known: new Map(), strikes: 0, win: 0, cnt: 0, tx: 0, ty: 0, lx: x, ly: y, thinkAt: 0, killer: 0, auto: 0, maim: 0, mfire: 0, noise: 0, noiseAt: 0, dl: [], w: 0, wr: 0, xp: 0, lvl: 1, lq: 0, pend: null, b: [0, 0, 0, 0, 0, 0, 0, 0], maxHp: C.HP, shield: 0, maxSh: C.SHIELD_BASE, hitAt: 0, shots: 0, hits: 0, snaps: 0, lastIn: 0, dcOut: 0, ipc: '', cs: {}, skill: 0.6 + Math.random() * 0.4, aggr: Math.random(), tgt: 0, tgtAt: 0, side: 1, sideAt: 0, idleUntil: 0, ssd: 1, forceRoam: 0, skip: 0, skipUntil: 0, stuckN: 0, want: 0, cur: 0, chkAt: 0, cx: 0, cy: 0, pid: null, party: '', team: 0, assists: 0, dieAt: 0 };
    this.players.set(p.id, p); return p;
  }

  genLoot() { // server-only loot: 0 scrap,1 part,2 chip,3 small shield,4 large shield,5 repair,6 crate
    this.loot = new Map(); this.lg = new Map(); this.nextL = 10000000; const R = this.R;
    const roll = () => { const r = R(); return r < 0.4 ? 0 : r < 0.64 ? 1 : r < 0.72 ? 2 : r < 0.8 ? 3 : r < 0.84 ? 4 : r < 0.89 ? 5 : r < 0.94 ? 6 : r < 0.97 ? 7 : 8; };
    const lv = (t) => t === 6 ? 40 + Math.floor(R() * 61) : t >= 7 ? (R() < 0.6 ? 0 : R() < 0.75 ? 1 : 2) : 0; // crate xp / weapon rarity
    for (const b of this.bl) for (let i = 0; i < C.LOOT_IN; i++) { const t = roll(); this.addLoot(t, b.x + 50 + R() * (b.w - 100), b.y + 50 + R() * (b.h - 100), lv(t)); }
    for (let i = 0; i < C.LOOT_OUT; i++) { const a = R() * 6.2832, d = Math.sqrt(R()) * 3700, x = 4000 + Math.cos(a) * d, y = 4000 + Math.sin(a) * d; if (this.hit(x, y, 14)) continue; const t = roll(); this.addLoot(t, x, y, lv(t)); }
  }
  addLoot(t, x, y, v) { const it = { id: this.nextL++, l: 1, t, x, y, v }; this.loot.set(it.id, it); const k = cell(x) * 100 + cell(y), a = this.lg.get(k); if (a) a.push(it); else this.lg.set(k, [it]); return it; }
  removeLoot(it) { this.loot.delete(it.id); const a = this.lg.get(cell(it.x) * 100 + cell(it.y)); if (a) { const i = a.indexOf(it); if (i >= 0) a.splice(i, 1); } }
  take(p, it) {
    const t = it.t;
    if (t === 5 && p.hp >= p.maxHp) return; if ((t === 3 || t === 4) && p.shield >= p.maxSh) return; if (t >= 7 && p.w === t - 6 && p.wr >= it.v) return;
    if (t < 3) this.addXp(p, C.XP_ITEM[t]); else if (t === 3) p.shield = Math.min(p.maxSh, p.shield + 25); else if (t === 4) p.shield = Math.min(p.maxSh, p.shield + 50);
    else if (t === 5) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.4); else if (t === 6) this.addXp(p, it.v); else { p.w = t - 6; p.wr = it.v; }
    it.gone = true; this.rm.push(it); // idempotent: gone flag blocks double pickup
  }
  hurt(e, dm, by, now) { if (now < this.startAt + C.GRACE_MS) return; let d = dm; if (e.shield > 0) { const a = Math.min(e.shield, d); e.shield -= a; d -= a; } e.hp -= d; e.hitAt = now; if (by) { e.dl = e.dl.filter((x) => now - x.t <= 5000); e.dl.push({ by, t: now, d: dm }); const at = this.players.get(by); if (at) { if (!at.dmgTo) at.dmgTo = new Map(); at.dmgTo.set(e.id, (at.dmgTo.get(e.id) || 0) + dm); } } if (e.hp <= 0 && !e.killer) e.killer = by; }
  addXp(p, n) {
    if (p.bot || n <= 0) return; p.xp += n | 0;
    while (p.lvl < 10 && p.xp >= C.XP_LV[p.lvl]) { p.lvl++; p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2); p.lq++; }
    if (!p.pend && p.lq > 0) this.offer(p);
  }
  offer(p) { // server generates 3 random boosts (stack cap 3), server validates the pick
    const ok = []; for (let i = 0; i < 8; i++) if (p.b[i] < 3) ok.push(i);
    if (!ok.length) { p.lq = 0; return; }
    for (let i = ok.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ok[i], ok[j]] = [ok[j], ok[i]]; }
    p.pend = ok.slice(0, 3); this.send(p.ws, [5, p.lvl, p.pend]);
  }
  choose(p, ws, a) {
    if (a[0] !== 9 || !p.pend || !Number.isInteger(a[1]) || a[1] < 0 || a[1] >= p.pend.length) return this.strike(p, ws, 'choice');
    p.b[p.pend[a[1]]]++; p.pend = null; p.lq--;
    const mh = C.HP * (1 + 0.15 * p.b[1]); p.hp += mh - p.maxHp; p.maxHp = mh; p.maxSh = C.SHIELD_BASE * (1 + 0.1 * p.b[4]);
    if (p.lq > 0) this.offer(p);
  }
  humans() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  connected() { let n = 0; for (const p of this.players.values()) if (!p.bot && p.ws) n++; return n; }
  send(ws, arr) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(arr)); } catch {} }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/stats') return J(this.stats());
    if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
    const gid = req.headers.get('x-u'), nonce = req.headers.get('x-nonce'), exp = +req.headers.get('x-exp'), md = req.headers.get('x-md'), mid = req.headers.get('x-m'), pid = req.headers.get('x-pid') || null, pt = req.headers.get('x-pt') || '', ipc = req.headers.get('x-ipc') || '', cs = req.headers.get('x-cs') || '';
    if (!gid || !nonce || !mid || !K.TEAM[md] || this.nonces.has(nonce) || this.closed) return new Response(null, { status: 403 }); // replay protection
    if (this.mid && this.mid !== mid) return new Response(null, { status: 403 });
    if (!this.mid) { this.mid = mid; this.mode = md; }
    const now = Date.now(); this.nonces.set(nonce, exp);
    for (const [k, v] of this.nonces) if (v < now) this.nonces.delete(k);
    const pair = new WebSocketPair(); const [cl, sv] = Object.values(pair);
    sv.accept(); this.onOpen(sv, gid, pid, pt, ipc, cs);
    return new Response(null, { status: 101, webSocket: cl });
  }

  onOpen(ws, gid, pid, pt, ipc, cs) {
    const now = Date.now(); ws._t0 = now; ws._win = 0; ws._cnt = 0;
    let p = this.byGid.get(gid);
    if (p && !p.bot) { if (p.ws && p.ws !== ws) { try { p.ws.close(1000, 'dup'); } catch {} } p.ws = ws; p.dcAt = 0; }
    else if (this.state === 'lobby' && this.humans() < C.MAX_PLAYERS) { p = this.mk(false, gid, ws); p.pid = pid; p.party = pt; p.ipc = String(ipc).slice(0, 10); p.cs = parseCos(cs); this.byGid.set(gid, p); if (!this.lobbyAt) this.lobbyAt = now; }
    else { this.send(ws, [3, 'busy']); try { ws.close(1000, 'busy'); } catch {} return; }
    ws._p = p;
    this.send(ws, [0, p.id, this.seed, this.bl.map((b) => [b.x, b.y, b.w, b.h, b.s]), this.rh, this.rv, this.dist, C.XP_LV, this.ob.map((o) => [o.x, o.y, o.r, o.t, o.v])]);
    if (this.rosterMsg) this.send(ws, this.rosterMsg); // reconnect after the match started
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
    if (p.strikes >= C.MAX_STRIKES) { try { ws.close(1008, 'policy'); } catch {} } // disconnect only: never an automatic ban
  }

  onMsg(p, ws, d) {
    this.msgsIn++; this.msgsMatch++;
    const now = Date.now(), sec = Math.floor(now / 1000);
    if (ws._win !== sec) { ws._win = sec; ws._cnt = 0; }
    if (++ws._cnt > C.MAX_MSG_S) { this.strike(p, ws, 'flood'); try { ws.close(1008, 'rate'); } catch {} return; }
    if (typeof d !== 'string' || d.length > 40) return this.strike(p, ws, 'size');
    let a; try { a = JSON.parse(d); } catch { return this.strike(p, ws, 'json'); }
    if (Array.isArray(a) && a.length === 2) { if (a[0] === 8 && Number.isInteger(a[1])) { this.send(ws, [7, a[1]]); return; } return this.choose(p, ws, a); }
    if (!Array.isArray(a) || a.length !== 6 || !a.every(Number.isInteger)) return this.strike(p, ws, 'shape');
    const [seq, mx, my, aim, fire, auto] = a;
    if (seq <= p.seq || seq > p.seq + 1000 || Math.abs(mx) > 100 || Math.abs(my) > 100 || aim < 0 || aim > 359 || (fire !== 0 && fire !== 1) || (auto !== 0 && auto !== 1)) return this.strike(p, ws, 'range');
    p.seq = seq; p.ack = seq;
    if (p.alive) {
      if (!auto && fire && p.lastIn && now - p.lastIn < 150) { let d = Math.abs(aim - p.maim); if (d > 180) d = 360 - d; if (d > 120) p.snaps++; } // instant large aim swing right before firing (aimbot signal)
      p.lastIn = now; p.mx = mx; p.my = my; p.aim = aim; p.fire = fire; p.maim = aim; p.mfire = fire; p.auto = auto;
    }
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
    // teams: party members together first, solo humans fill free slots, bots fill the rest (duo = 2, squad = 4, solo = 1)
    const T = K.TEAM[this.mode] || 1, all = [...this.players.values()], hum = all.filter((p) => !p.bot), teams = [], parties = new Map();
    const place = (p) => { let t = teams.find((x) => x.length < T); if (!t) { t = []; teams.push(t); } t.push(p); };
    for (const p of hum) if (p.party) { if (!parties.has(p.party)) parties.set(p.party, []); parties.get(p.party).push(p); }
    for (const g of parties.values()) { let t = null; for (const p of g) { if (!t || t.length >= T) { t = []; teams.push(t); } t.push(p); } }
    for (const p of hum) if (!p.party) place(p);
    for (const p of all) if (p.bot) place(p);
    teams.forEach((t, i) => t.forEach((p) => { p.team = i + 1; }));
    for (const t of teams) for (let i = 1; i < t.length; i++) for (let n = 0; n < 20; n++) { const x = t[0].x + (Math.random() - 0.5) * 300, y = t[0].y + (Math.random() - 0.5) * 300; if (x > 50 && y > 50 && x < 7950 && y < 7950 && !this.hit(x, y, C.R + 10)) { t[i].x = x; t[i].y = y; break; } }
    this.tl = teams; this.teams = teams.length;
    for (const p of all) if (p.bot) for (const t of ['skin', 'trail', 'fx']) if (Math.random() < 0.4) p.cs[t] = C.BOT_COS[t][Math.floor(Math.random() * C.BOT_COS[t].length)]; // bots wear common items so they look like players
    this.rosterMsg = [6, all.map((p) => [p.id, p.cs.skin || '', p.cs.trail || '', p.cs.fx || ''])]; // cosmetic ids only (no positions): visual info, validated server-side
    for (const p of hum) this.send(p.ws, this.rosterMsg);
    this.mm('/started', { m: this.mid, md: this.mode });
    this.state = 'running'; this.startAt = now; this.msgsMatch = 0;
    console.log(JSON.stringify({ ev: 'start', seed: this.seed, humans: this.humans(), bots: fill }));
  }

  steer(b, dx, dy) { // obstacle avoidance: sweep 3 points along a 72u probe (not just the end point), rotate away from walls/rocks/trunks
    const m = Math.hypot(dx, dy); if (m < 1) return [0, 0];
    const base = Math.atan2(dy, dx);
    for (const k of [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1]) {
      const a = base + k * b.ssd, c = Math.cos(a), s = Math.sin(a);
      if (!this.hit(b.x + c * 24, b.y + s * 24, C.R + 2) && !this.hit(b.x + c * 48, b.y + s * 48, C.R + 2) && !this.hit(b.x + c * 72, b.y + s * 72, C.R + 2)) return [Math.round(c * 100), Math.round(s * 100)];
    }
    return [Math.round(-Math.sin(base) * b.ssd * 100), Math.round(Math.cos(base) * b.ssd * 100)]; // boxed in: slide sideways instead of reversing (reversing causes wiggling)
  }

  // Bot states: flee zone > fight (react delay, strafe, retreat when hurt) > loot (shields/repair/weapons) > roam. Bots never fight each other in the first BOT_PEACE_S seconds.
  think(b, now) {
    const z = this.z, el = (now - this.startAt) / 1000, rg = Math.min(C.MAX_RANGE, C.WEAPONS[b.w].rg);
    if (b.want && Math.hypot(b.x - b.lx, b.y - b.ly) < 6) b.stuckN++; else b.stuckN = 0; // asked to move but did not
    let stuck = b.stuckN >= 4;
    if (now >= b.chkAt) { if (b.chkAt && b.want && Math.hypot(b.x - b.cx, b.y - b.cy) < 60) stuck = true; b.cx = b.x; b.cy = b.y; b.chkAt = now + 3000; } // wiggling in place for 3 s also counts as stuck
    if (stuck) { // recovery: flip steering side, forget the loot it could not reach, walk to a random point for 4 s
      const a = Math.random() * 6.2832; b.ssd = -b.ssd; b.skip = b.cur; b.skipUntil = now + 20000; b.tgt = 0; b.forceRoam = now + 4000; b.stuckN = 0;
      b.tx = Math.max(100, Math.min(7900, b.x + Math.cos(a) * 900)); b.ty = Math.max(100, Math.min(7900, b.y + Math.sin(a) * 900));
    }
    const free = now >= b.forceRoam;
    let en = null, best = 1e9, it0 = null;
    this.q(this.gP, b.x, b.y, C.BOT_SEE, (e) => {
      if (e === b || e.team === b.team || (e.bot && el < C.BOT_PEACE_S)) return;
      const d = Math.hypot(e.x - b.x, e.y - b.y); if (d < best) { best = d; en = e; }
    });
    const out = Math.hypot(b.x - z.cx, b.y - z.cy) > z.r - 250 || Math.hypot(b.x - z.tcx, b.y - z.tcy) > z.tr - 250;
    if (now >= b.sideAt) { b.side = Math.random() < 0.5 ? 1 : -1; b.sideAt = now + 1000 + Math.random() * 1500; }
    b.fire = 0; let dx = 0, dy = 0, face = null;
    const hurt = b.hp < b.maxHp * (0.25 + 0.2 * b.aggr);
    if (out && free) { dx = z.tcx - b.x; dy = z.tcy - b.y; }
    else if (en && free) {
      const ex = en.x - b.x, ey = en.y - b.y;
      if (b.tgt !== en.id) { b.tgt = en.id; b.tgtAt = now + 350 + Math.random() * 550; } // human-like reaction delay
      face = Math.atan2(ey, ex) * 57.2958 + (Math.random() * 2 - 1) * C.BOT_AIM_ERR * (1.6 - b.skill);
      if (hurt && best < rg * 1.5) { dx = -ex; dy = -ey; } else if (best > rg * 0.8) { dx = ex; dy = ey; } else { dx = -ey * b.side; dy = ex * b.side; }
      if (now >= b.tgtAt && best <= rg && Math.random() < C.BOT_FIRE_P * (0.5 + b.skill * 0.7) * (hurt ? 0.6 : 1)) b.fire = 1;
    } else {
      b.tgt = 0; let bd = 1e9;
      if (free) this.q(this.lg, b.x, b.y, C.BOT_LOOT_R, (it) => {
        const t = it.t; if (it.gone || !(t === 3 || t === 4 || t === 5 || t >= 7)) return; // shields, repair kits, weapons (not XP items)
        if (it.id === b.skip && now < b.skipUntil) return; // unreachable loot is ignored for 20 s
        if (t === 5 && b.hp >= b.maxHp) return; if ((t === 3 || t === 4) && b.shield >= b.maxSh) return; if (t >= 7 && b.w === t - 6 && b.wr >= it.v) return;
        const d = Math.hypot(it.x - b.x, it.y - b.y); if (d < bd) { bd = d; it0 = it; }
      });
      if (it0) { if (bd <= C.PICK_R * 0.8) { this.take(b, it0); b.idleUntil = now + 400 + Math.random() * 800; it0 = null; } else { dx = it0.x - b.x; dy = it0.y - b.y; } }
      else if (now >= b.idleUntil) {
        if (!b.tx || Math.hypot(b.tx - b.x, b.ty - b.y) < 80) { b.tx = Math.max(100, Math.min(7900, b.x + (Math.random() - 0.5) * 1800)); b.ty = Math.max(100, Math.min(7900, b.y + (Math.random() - 0.5) * 1800)); }
        dx = b.tx - b.x; dy = b.ty - b.y;
      }
    }
    b.lx = b.x; b.ly = b.y; b.want = dx || dy ? 1 : 0; b.cur = it0 ? it0.id : 0;
    const v = this.steer(b, dx, dy); b.mx = v[0]; b.my = v[1];
    b.aim = nrm(face !== null ? face : (dx || dy ? Math.atan2(dy, dx) * 57.2958 : b.aim));
  }

  kill(p, now) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.fire = 0; p.mx = 0; p.my = 0;
    p.dieAt = now; const at = new Set(); for (const o of this.players.values()) if (o.alive) at.add(o.team);
    p.place = at.size + 1; // team placement: set for the whole team once its last member dies
    if (!at.has(p.team)) for (const o of this.players.values()) if (o.team === p.team) o.place = at.size + 1;
    const k = this.players.get(p.killer); if (k && k !== p) {
      k.kills++;
      if (!k.bot) { let xp; if (p.bot) xp = C.BOT_KILL_XP; else { xp = 80 + 25 * p.lvl; if (k.lvl - p.lvl >= 3) xp *= 0.6; else if (p.lvl - k.lvl >= 2) xp *= 1.5; } this.addXp(k, Math.round(xp)); }
    }
    this.addLoot(6, p.x, p.y, 60); // death crate (+60 XP)
    { // assist: >=25% of victim max HP dealt by someone else within the last 5s -> 40% of base kill XP
      const kx = p.bot ? C.BOT_KILL_XP : 80 + 25 * p.lvl, tot = new Map();
      for (const x of p.dl) if (now - x.t <= 5000) tot.set(x.by, (tot.get(x.by) || 0) + x.d);
      for (const [id, d] of tot) { const a = this.players.get(id); if (a && a !== k && a !== p && d >= 0.25 * p.maxHp) { this.addXp(a, Math.round(0.4 * kx)); a.assists = (a.assists || 0) + 1; } }
    }
    this.send(p.ws, [2, p.place, p.kills]);
  }

  tick() {
    const now = Date.now(), dt = Math.min(0.1, Math.max(0.01, (now - (this.lastTk || now - 50)) / 1000)); this.lastTk = now; this.tickN++;
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
      if (now - this.endAt > 5000) { for (const p of this.players.values()) { try { p.ws && p.ws.close(1000, 'end'); } catch {} } this.closed = true; if (this.timer) { clearInterval(this.timer); this.timer = null; } } // one DO per match: no reuse after the end
      return;
    }
    // running
    const el = (now - this.startAt) / 1000; const z = this.z = this.zoneAt(el);
    const dps = el > C.HARD_CAP_S ? 200 : z.dps;
    if (z.ph !== this.lastPh) { if (this.lastPh) for (const p of this.players.values()) if (p.alive) this.addXp(p, C.PHASE_XP); this.lastPh = z.ph; }
    if (this.connected() === 0) { if (!this.emptyAt) this.emptyAt = now; else if (now - this.emptyAt > 20000) { this.finish(now, 'empty'); return; } } else this.emptyAt = 0;
    this.gP = this.grid(false); this.rm = [];
    if (now - this.lastNear >= 1000) { this.lastNear = now; this.nearCheck(); }
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!p.bot && !p.ws && p.dcAt && now - p.dcAt > C.DC_GRACE_MS) { p.hp = 0; p.dcOut = 1; this.kill(p, now); continue; }
      if (p.bot && now >= p.thinkAt) { p.thinkAt = now + 200; this.think(p, now); }
      if (!p.bot && p.auto) { // server-side auto-aim/auto-fire: nearest visible enemy in AUTO_RANGE, same rules for everyone
        let tg = null, bd = 1e9;
        this.q(this.gP, p.x, p.y, C.AUTO_RANGE, (e) => { if (e === p || e.team === p.team) return; const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd && d <= C.AUTO_RANGE) { bd = d; tg = e; } });
        if (now >= p.noiseAt) { p.noiseAt = now + 250; p.noise = (Math.random() * 2 - 1) * C.AUTO_ERR; }
        if (tg) { p.aim = nrm(Math.atan2(tg.y - p.y, tg.x - p.x) * 57.2958 + p.noise); p.fire = bd <= C.WEAPONS[p.w].rg ? 1 : p.mfire; } else { p.aim = p.maim; p.fire = p.mfire; }
      }
      if (p.b[6] && now - p.hitAt > 5000 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.b[6] * dt);
      if (!p.bot) { const pr = C.PICK_R * (1 + 0.2 * p.b[7]); this.q(this.lg, p.x, p.y, pr, (it) => { if (!it.gone && Math.hypot(it.x - p.x, it.y - p.y) <= pr) this.take(p, it); }); } // server-side pickup range check
      let mx = p.mx, my = p.my; const m = Math.hypot(mx, my);
      if (m > 0) {
        const f = Math.min(m, 100) / m, sp = C.SPEED * (1 + 0.1 * p.b[2]) * (p.bot ? C.BOT_SPEED : 1) * (Math.min(m, 100) / 100);
        const nx = p.x + (mx / m) * sp * dt, ny = p.y + (my / m) * sp * dt;
        if (!this.hit(nx, p.y, C.R)) p.x = nx;
        if (!this.hit(p.x, ny, C.R)) p.y = ny;
        p.x = Math.max(C.R, Math.min(C.WORLD - C.R, p.x)); p.y = Math.max(C.R, Math.min(C.WORLD - C.R, p.y));
      }
      if (p.fire && now >= p.cd) {
        const W0 = C.WEAPONS[p.w], rar = C.RAR[p.wr], man = !p.bot && !p.auto && W0.n === 1; if (man) p.shots++; /* only manual single-bullet shots count for accuracy */ p.cd = now + (W0.cd * (p.bot ? C.BOT_CD : 1)) / (1 + 0.15 * p.b[3]);
        for (let n = 0; n < W0.n; n++) {
          const r = (p.aim + (W0.n > 1 ? (n - (W0.n - 1) / 2) * W0.spread : 0)) * 0.0174533, c = Math.cos(r), s = Math.sin(r);
          this.bullets.push({ id: this.nextB++, blt: 1, o: p.id, tm: p.team, man: man ? 1 : 0, x: p.x + c * 30, y: p.y + s * 30, vx: c * W0.sp, vy: s * W0.sp, sp: W0.sp, dm: W0.dmg * rar, dist: 0, rg: Math.min(C.MAX_RANGE, W0.rg * (1 + 0.12 * p.b[5])) });
        }
      }
      if (Math.hypot(p.x - z.cx, p.y - z.cy) > z.r) { p.hp -= dps * dt; if (p.hp <= 0) p.killer = 0; }
    }
    for (const it of this.rm) this.removeLoot(it);
    // bullets (3 substeps, vs walls and players)
    const keep = [];
    for (const b of this.bullets) {
      let dead = false;
      for (let s = 0; s < 4 && !dead; s++) {
        b.x += (b.vx * dt) / 4; b.y += (b.vy * dt) / 4;
        if (b.x < 0 || b.y < 0 || b.x > C.WORLD || b.y > C.WORLD || this.hit(b.x, b.y, 0)) { dead = true; break; }
        this.q(this.gP, b.x, b.y, 30, (e) => {
          if (dead || e.id === b.o || !e.alive || e.team === b.tm) return; // friendly fire off
          if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < (C.R + 4) ** 2) {
            dead = true; const o = this.players.get(b.o), dm = b.dm * (o ? (1 + 0.12 * o.b[0]) * (o.bot ? C.BOT_DMG * (e.bot ? C.BOT_VS_BOT : 1) : 1) : 1); /* bots hit softer, and softer still against other bots */ if (o) { o.dmg += dm; if (b.man) o.hits++; } this.hurt(e, dm, b.o, now);
          }
        });
      }
      b.dist += b.sp * dt; if (b.dist >= b.rg) dead = true;
      if (!dead) keep.push(b);
    }
    this.bullets = keep;
    for (const p of this.players.values()) if (p.alive && p.hp <= 0) this.kill(p, now);
    let alive = 0; const ta = new Set(); for (const p of this.players.values()) if (p.alive) { alive++; ta.add(p.team); }
    if (ta.size <= 1 || el > C.HARD_CAP_S + 15) { for (const p of this.players.values()) if (p.alive) p.place = 1; this.finish(now, ta.size <= 1 ? 'last' : 'cap'); return; }
    if (this.tickN % C.SNAP_EVERY === 0) {
      const gAll = this.grid(true), zArr = [z.cx | 0, z.cy | 0, z.r | 0, z.tcx | 0, z.tcy | 0, z.tr | 0, Math.ceil(z.left), z.ph, z.dps, z.shrink];
      for (const h of this.players.values()) if (!h.bot && h.ws) this.snap(h, gAll, zArr, alive, el);
    }
  }

  snap(h, g, zArr, alive, el) {
    const known = h.known, seen = new Set(), P = [], B = [], L = [];
    const x0 = h.x - C.VIEW_HX, x1 = h.x + C.VIEW_HX, y0 = h.y - C.VIEW_HY, y1 = h.y + C.VIEW_HY; // fixed server-side window
    for (let cx = cell(x0); cx <= cell(x1); cx++) for (let cy = cell(y0); cy <= cell(y1); cy++) {
      const a0 = g.get(cx * 100 + cy), l0 = this.lg.get(cx * 100 + cy), a = a0 && l0 ? a0.concat(l0) : (a0 || l0); if (!a) continue;
      for (const e of a) {
        if (e === h || e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) continue;
        seen.add(e.id);
        if (e.blt) { if (!known.has(e.id)) { known.set(e.id, 1); B.push([e.id, e.x | 0, e.y | 0, e.vx | 0, e.vy | 0, e.o]); } }
        else if (e.l) { if (!known.has(e.id)) { known.set(e.id, 1); L.push([e.id, e.t, e.x | 0, e.y | 0, e.v | 0]); } }
        else { const s = (e.x | 0) + ',' + (e.y | 0) + ',' + e.aim + ',' + Math.ceil(e.hp); if (known.get(e.id) !== s) { known.set(e.id, s); P.push([e.id, e.x | 0, e.y | 0, e.aim, Math.ceil(e.hp)]); } }
      }
    }
    const G = []; for (const id of known.keys()) if (!seen.has(id)) { G.push(id); known.delete(id); }
    this.send(h.ws, [1, this.tickN, h.ack, [h.x | 0, h.y | 0, Math.ceil(Math.max(0, h.hp)), h.alive ? 1 : 0, h.kills, h.aim, Math.round(h.shield), h.maxHp | 0, h.xp, h.lvl, h.w * 3 + h.wr], P, B, G, zArr, alive, el | 0, L, this.tm(h)]);
  }

  finish(now, reason) {
    this.state = 'ended'; this.endAt = now;
    const s = this.stats();
    for (const p of this.players.values()) { if (p.ws) this.sockMs += now - p.ws._t0; if (!p.bot) this.send(p.ws, [3, reason, p.place || 1, p.kills, Math.round(p.dmg)]); }
    for (const p of this.players.values()) if (p.ws) p.ws._t0 = now;
    console.log(JSON.stringify({ ev: 'end', reason, ...s, suspicious: this.susp.length }));
    const hum = [...this.players.values()].filter((p) => !p.bot);
    this.mm('/ended', { m: this.mid, us: hum.map((p) => p.gid) });
    this.persist(now, hum).catch((e) => console.log('persist_fatal', String(e && e.message)));
  }

  nearCheck() { // once per second: humans from different teams standing close together without ever damaging each other
    const hs = []; for (const p of this.players.values()) if (!p.bot && p.alive) hs.push(p);
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i], b = hs[j]; if (a.team === b.team || Math.abs(a.x - b.x) > 300 || Math.abs(a.y - b.y) > 300) continue;
      if ((a.dmgTo && a.dmgTo.get(b.id)) || (b.dmgTo && b.dmgTo.get(a.id))) continue;
      const k = a.id + '-' + b.id; this.near.set(k, (this.near.get(k) || 0) + 1);
    }
  }
  flags(now, hum) {
    const out = [], byId = new Map(hum.map((p) => [p.id, p])), add = (p, kind, detail) => { if (p && p.pid && out.length < 300) out.push({ player_id: p.pid, kind, detail }); };
    const sc = new Map(); for (const s of this.susp) { const k = s.p + '|' + s.k; sc.set(k, (sc.get(k) || 0) + 1); }
    for (const [k, n] of sc) { const [id, kind] = k.split('|'); add(byId.get(+id), 'msg_' + kind, { count: n }); }
    for (const p of hum) {
      if (p.shots >= C.AC.MIN_SHOTS && p.hits / p.shots >= C.AC.ACC) add(p, 'high_accuracy', { shots: p.shots, hits: p.hits, rate: +(p.hits / p.shots).toFixed(2) });
      if (p.snaps >= C.AC.SNAPS) add(p, 'aim_snap', { snaps: p.snaps });
      if (p.dcOut) add(p, 'dc_timeout', { at_s: Math.round(((p.dieAt || now) - this.startAt) / 1000) });
    }
    for (const [k, secs] of this.near) if (secs >= C.AC.NEAR_S) { const [a, b] = k.split('-').map(Number), pa = byId.get(a), pb = byId.get(b); add(pa, 'soft_team', { secs, with: pb ? pb.pid : null }); add(pb, 'soft_team', { secs, with: pa ? pa.pid : null }); }
    const g = new Map(); for (const p of hum) if (p.ipc) { if (!g.has(p.ipc)) g.set(p.ipc, []); g.get(p.ipc).push(p); }
    for (const l of g.values()) if (l.length > 1) for (const p of l) add(p, 'same_ip', { n: l.length });
    return out;
  }
  mm(path, body) { try { return this.env.MM.get(this.env.MM.idFromName('mm')).fetch('https://mm' + path, { method: 'POST', body: JSON.stringify(body) }).catch(() => {}); } catch {} }
  tm(h) { const o = []; for (const m of (this.tl && this.tl[h.team - 1]) || []) if (m !== h) o.push([m.id, m.x | 0, m.y | 0, m.alive ? 1 : 0]); return o; } // teammates only (minimap + markers)
  async persist(now, hum) { // ONE atomic, idempotent RPC at match end (zero writes during the match)
    const byId = new Map(hum.map((p) => [p.id, p]));
    const mp = hum.filter((p) => p.pid).map((p) => ({ player_id: p.pid, placement: p.place || 1, kills: p.kills, assists: p.assists || 0, damage: Math.round(p.dmg), xp_in_match: Math.min(p.xp, 3200), max_level: p.lvl, survived_s: Math.round(((p.dieAt || now) - this.startAt) / 1000), reward_soft: reward(p.place || 1, p.kills) }));
    if (!mp.length) return; // guests are never persisted
    const sl = this.flags(now, hum); // evidence rows for suspicion_logs (flag + log only: no automatic bans from statistics)
    const iso = (t) => new Date(t).toISOString();
    const body = JSON.stringify({ p: { m: { id: this.mid, mode: this.mode, seed: this.seed, started_at: iso(this.startAt), ended_at: iso(now), humans: hum.length, bots: this.players.size - hum.length, duration_s: Math.round((now - this.startAt) / 1000) }, mp, sl } });
    for (let i = 0; i < 3; i++) {
      try { const r = await sb(this.env, 'rpc/finish_match', { method: 'POST', body }); if (r.ok) return; console.log('persist_http', r.status); } catch (e) { console.log('persist_err', String(e && e.message)); }
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
    try { await this.env.RL.put('rbr:pend:' + this.mid, body, { expirationTtl: 604800 }); } catch {} // cron flushes it later
  }

  stats() {
    const secs = this.startAt ? ((this.endAt || Date.now()) - this.startAt) / 1000 : 0;
    const reqs = this.msgsMatch / 20 + this.humans();
    const gbs = C.DO_MEM_GB * secs;
    const cost = (reqs * C.PRICE_REQ_PER_M) / 1e6 + (gbs * C.PRICE_GBS_PER_M) / 1e6;
    return { mid: this.mid, mode: this.mode, teams: this.teams, state: this.state, humans: this.humans(), players: this.players.size, msgsInMatch: this.msgsMatch, msgsInTotal: this.msgsIn, matchSecs: Math.round(secs), billedReqEst: Math.round(reqs), socketSecs: Math.round(this.sockMs / 1000), costUsdEst: +cost.toFixed(5) };
  }
}
