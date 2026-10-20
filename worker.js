// ROBOT BATTLE ROYALE - Stage 3 - worker.js
// Role: API gateway (/auth /join /party/* /leave /stats /ws), Matchmaker DO (queues + parties), MatchRoom DO (one match per DO), Supabase writes at match end.
import { ADMIN_HTML } from './admin.js';
import { backupTick, backupStatus } from './backup.js';
// Commit as worker.js next to wrangler.toml (together with admin.js and backup.js). Secrets: JOIN_SECRET, ADMIN_KEY, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN.

const C = {
  TICK_HZ: 20, SNAP_EVERY: 2,                 // TUNE: 20Hz sim, 10Hz snapshots
  MAX_PLAYERS: 52, START_HUMANS: 10, LOBBY_MS: 30000, // TUNE: start when 10 humans or 30s with >=1
  WORLD: 8000, CELL: 200, VIEW_HX: 740, VIEW_HY: 460,
  R: 24, HP: 100, SPEED: 220, DMG: 12, COOLDOWN_MS: 250, BSPEED: 1400, RANGE: 240, MAX_RANGE: 300, // TUNE: reach = range+58 must stay < 360 (half of 720 view height)
  WEAPONS: [{ dmg: 12, cd: 250, sp: 1400, rg: 240, n: 1, spread: 0 }, { dmg: 9, cd: 800, sp: 1200, rg: 170, n: 5, spread: 7 }, { dmg: 26, cd: 520, sp: 2400, rg: 300, n: 1, spread: 0 }], RAR: [1, 1.2, 1.45], // TUNE: blaster, shotgun, laser; rarity dmg multipliers
  BOT_DMG: 0.5, BOT_CD: 1.8, BOT_RANGE: 260, BOT_SEE: 330, BOT_PEACE_S: 75, BOT_VS_BOT: 0.5, BOT_LOOT_R: 450, BOT_AIM_ERR: 18, BOT_FIRE_P: 0.35, BOT_SPEED: 0.8, GRACE_MS: 6000, BOT_COS: { hull: ['hull_red', 'hull_green', 'hull_blue', 'hull_orange', 'hull_purple', 'hull_pink'], cannon: ['cannon_white', 'cannon_red'], track: ['track_white', 'track_blue'], detail: ['detail_yellow', 'detail_white'], glow: ['glow_blue', 'glow_green', 'glow_pink'], bullet: ['bullet_red', 'bullet_blue', 'bullet_green', 'bullet_pink'], blast: ['blast_red', 'blast_blue', 'blast_purple'], smoke: ['smoke_white', 'smoke_orange'], flag: ['flag_ma', 'flag_sa', 'flag_eg', 'flag_iq', 'flag_dz'] },
  AC: { MIN_SHOTS: 50, ACC: 0.9, SNAPS: 30, NEAR_S: 120 }, // TUNE anti-cheat flags: manual-aim hit rate >=90% over 50+ shots, 30+ instant 120deg aim snaps while firing, 120s next to another human without any damage between them // TUNE: bots were too aggressive; 6s spawn grace
  AUTO_RANGE: 280, AUTO_ERR: 6, // TUNE: auto-aim range (< weapon range) and random aim error in degrees
  DC_GRACE_MS: 0, /* 0 = a disconnected player stays until he returns or the zone kills him; e.g. 120000 would eliminate him after 120 s */ MAX_MSG_S: 30, MAX_STRIKES: 8, HARD_CAP_S: 600, OUT_MS: 15000, /* room ends this long after the last LIVING human is out */
  ZONE_R0: 4000, ZONE_OFFSET: 300,
  PHASES: [[150, 45, 2800, 2], [80, 40, 1800, 4], [70, 35, 1000, 8], [60, 30, 450, 14], [50, 25, 0, 22]], // wait,shrink,endR,dps. TUNE: spec waits were 120/60/50/40/30; pure-bot sims then ended ~7:00, these end ~8:30
  BUILDINGS: 56, ROCKS: 160, TREES: 240, LOOT_IN: 4, LOOT_OUT: 160, PICK_R: 60, SHIELD_BASE: 50, PHASE_XP: 15, BOT_KILL_XP: 30, // TUNE
  XP_LV: [0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200], XP_ITEM: [10, 25, 60],
  TOKEN_TTL_MS: 30000, JOIN_PER_MIN: 10,
  PRICE_REQ_PER_M: 0.15, PRICE_GBS_PER_M: 12.5, DO_MEM_GB: 0.128 // TUNE: check current Cloudflare pricing
};

const K = { SESSION_MS: 4 * 3600 * 1000, TG_MAX_AGE_S: 86400, JOIN_MS: 30000, OPEN_MS: 35000, PARTY_MAX: 4, PARTY_TTL_MS: 1800000, TEAM: { solo: 1, duo: 2, squad: 4 }, RL: { auth: 20, join: 15, party: 40, stats: 30, shop: 30, pass: 90 } }; // TUNE
const COS_ID = /^(hull|cannon|track|detail|glow|bullet|trail|blast|smoke|flag)_[a-z0-9]{2,12}$/;
const GEM_PACKS = [[100, 99], [310, 299], [520, 499], [1060, 999], [2180, 1999], [5600, 4999]]; /* gems, price in USD cents (display + audit; real payments are not built yet) */
const pickCos = (rows) => { const got = {}; for (const r of Array.isArray(rows) ? rows : []) { const m = r && typeof r.cosmetic_id === 'string' ? COS_ID.exec(r.cosmetic_id) : null; if (m && !got[m[1]]) got[m[1]] = r.cosmetic_id; } return Object.values(got).join(','); }; // one equipped id per type, validated
const parseCos = (s) => { const o = {}; for (const id of String(s).split(',')) { const m = COS_ID.exec(id); if (m && !o[m[1]]) o[m[1]] = id; } return o; };

// ---------- WEAPONS: chosen in the lobby (GUNS), no weapon loot in the match ----------
// Every weapon is free and "normal": the budget is roughly 45-60 damage per second, the trade-off is rate / damage / range / pellets. cd is a multiple of 50 ms (one server tick).
// Reach rule: spawn 30 + range + 28 must stay < 360 (half of the 720 view height), so no range goes above 290. Magazines/reloading are NOT simulated. TUNE every number here.
// fields: id, c (ar|smg|sn|sg), dmg per bullet, cd ms between triggers, sp bullet speed, rg range, n pellets, spr spread degrees between pellets, bu bullets per burst, gp ms between burst bullets
// POINT BUDGET: every weapon has the SAME total of W_T points spread over DAMAGE (D), FIRE RATE (F) and RANGE (R); each point is worth the same power.
//   damage per trigger = 1.5 x 1.15^D   |   triggers per second = 0.5 x 1.15^F   |   range = 150 x 1.1135^R (R max 6 = 286, below the 290 view limit)
//   POWER = DPS x (range/150)^1.3 = 0.75 x 1.15^(D+F+R)  => equal total points = equal power. cd is rounded to 50 ms (one tick) and damage is compensated so DPS stays exact.
//   To rebalance: change the points below (they MUST still add up to W_T), or W_EXP (how much one extra % of range is worth). Pellets, bursts and bullet speed are part of the weapon type, not of the budget.
const W_G = 1.15, W_H = Math.pow(1.15, 1 / 1.3), W_T = 34, W_EXP = 1.3;
const WDEF = [ // id, category, [D, F, R], bullet speed, pellets, spread deg, bullets per burst, ms between burst bullets
  ['ar01','ar',[15,15,4],1400,1,0,1,0],
  ['ak47','ar',[17,12,5],1400,1,0,1,0],
  ['m4a1','ar',[13,16,5],1450,1,0,1,0],
  ['scar','ar',[15,14,5],1400,1,0,1,0],
  ['famas','ar',[20,10,4],1450,1,0,3,50],
  ['aug','ar',[14,14,6],1500,1,0,1,0],
  ['groza','ar',[17,14,3],1400,1,0,1,0],
  ['xm8','ar',[13,15,6],1500,1,0,1,0],
  ['mp40','smg',[10,22,2],1350,1,0,1,0],
  ['mp5','smg',[12,19,3],1350,1,0,1,0],
  ['ump','smg',[13,16,5],1350,1,0,1,0],
  ['vector','smg',[5,27,2],1350,1,0,1,0],
  ['p90','smg',[9,22,3],1350,1,0,1,0],
  ['mac10','smg',[11,22,1],1350,1,0,1,0],
  ['awm','sn',[26,2,6],2600,1,0,1,0],
  ['kar98','sn',[24,4,6],2600,1,0,1,0],
  ['m24','sn',[23,5,6],2600,1,0,1,0],
  ['svd','sn',[20,8,6],2500,1,0,1,0],
  ['sks','sn',[18,10,6],2300,1,0,1,0],
  ['dragunov','sn',[21,7,6],2600,1,0,1,0],
  ['m1887','sg',[28,5,1],1200,5,8,2,150],
  ['m1014','sg',[23,9,2],1200,5,8,1,0],
  ['spas12','sg',[27,5,2],1200,6,9,1,0],
  ['s1897','sg',[25,7,2],1200,5,7,1,0],
  ['dbs','sg',[25,8,1],1200,4,9,2,50]];
const mkWpn = ([id, c, pts, sp, n, spr, bu, gp]) => { const rate = 0.5 * Math.pow(W_G, pts[1]), craw = 1000 / rate, cd = Math.max(50, Math.round(craw / 50 + 1e-9) * 50), dpt = 1.5 * Math.pow(W_G, pts[0]) * cd / craw; return { id, c, dmg: Math.round(dpt / (n * bu) * 100) / 100, cd, sp, rg: Math.round(150 * Math.pow(W_H, pts[2])), n, spr, bu, gp, pts }; };
const WPN = WDEF.map(mkWpn);
const wpPower = (x) => Math.round((x.dmg * x.n * x.bu * 1000 / x.cd) * Math.pow(x.rg / 150, W_EXP));
const WPN_IDX = Object.fromEntries(WPN.map((x, i) => [x.id, i]));
const wpnRow = (x) => [x.id, x.c, x.dmg, x.cd, x.sp, x.rg, x.n, x.spr, x.bu, x.gp, x.pts, wpPower(x)];

// ---------- SKILLS: up to 4 per player, ONE per category, chosen in the lobby, used in the match with a cooldown ----------
// c = category, cd = cooldown seconds, d = effect seconds. All numbers are TUNE values; sizes/distances are in the SK_* constants below.
const SKCAT = [['sh', 'cv', 'rc'], ['ds', 'sp', 'vb'], ['sc', 'rd', 'ls'], ['sm', 'sf', 'ss']]; /* defense, movement, recon, tactical */
const SK = { sh: { cd: 45, d: 5 }, cv: { cd: 60, d: 10 }, rc: { cd: 50, d: 5 }, ds: { cd: 25, d: 0 }, sp: { cd: 40, d: 6 }, vb: { cd: 40, d: 6 }, sc: { cd: 50, d: 4 }, rd: { cd: 45, d: 6 }, ls: { cd: 30, d: 8 }, sm: { cd: 35, d: 8 }, sf: { cd: 45, d: 5 }, ss: { cd: 45, d: 10 } };
const SK_C = { SHIELD_HP: 75, HEAL: 50, HEAL_PER_S: 10, DASH: 260, DASH_T: 0.2, SPRINT: 1.2, BOOST: 1.25, SCAN_R: 900, RADAR_R: 3000, LOOT_R: 1000, SMOKE_R: 140, SMOKE_AHEAD: 0, SLOW_R: 220, SLOW: 0.75, SILENT_SEE: 0.3, COVER_LONG: 110, COVER_THICK: 20, COVER_AHEAD: 70 };
const parseSk = (s) => { if (typeof s !== 'string' || !/^[a-z]{0,2}(,[a-z]{0,2}){3}$/.test(s)) return null; const a = s.split(','); for (let i = 0; i < 4; i++) if (a[i] && !SKCAT[i].includes(a[i])) return null; return a; };
const skRow = (code, i) => [code, i, SK[code].cd, SK[code].d];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hkey = (secret, use) => crypto.subtle.importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
const sign = async (secret, data) => b64u(await crypto.subtle.sign('HMAC', await hkey(secret, 'sign'), enc.encode(data)));
const verify = async (secret, data, sig) => { try { return await crypto.subtle.verify('HMAC', await hkey(secret, 'verify'), unb64u(sig), enc.encode(data)); } catch { return false; } };
const hmacHex = async (secret, data) => [...new Uint8Array(await crypto.subtle.sign('HMAC', await hkey(secret, 'sign'), enc.encode(data)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const passMonth = () => { const d = new Date(); return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1; };
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const J = (o, s, h) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...(h || {}) } });
const PCOINS = [150, 125, 110, 100, 90, 80, 70, 65, 60, 55, 50, 45, 40, 35]; /* coins by team placement 1..14, then 15-20: 30, 21-30: 20, 31-40: 15, 41-52: 10 */
const reward = (place, kills, score) => (place <= 14 ? PCOINS[Math.max(1, place) - 1] : place <= 20 ? 30 : place <= 30 ? 20 : place <= 40 ? 15 : 10) + Math.min(kills, 10) * 5 + (score >= 80 ? 50 : 0); // TUNE: coins per match = placement table + 5 per kill (max 10 kills count) + 50 if MATCH SCORE >= 80 (server-side only; SQL also caps it at 1000)

// Signed tokens: base64url(json) + '.' + HMAC(domain + payload). Domains separate session tokens (S1.) from match-join tokens (J1.).
async function mkTok(env, dom, obj) { const p = b64u(enc.encode(JSON.stringify(obj))); return p + '.' + (await sign(env.JOIN_SECRET, dom + p)); }
async function rdTok(env, dom, t) {
  if (typeof t !== 'string' || t.length > 1200) return null; const a = t.split('.'); if (a.length !== 2 || !a[0] || !a[1]) return null;
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
async function rl(env, key, max) { // per-key counter in a tiny Durable Object: atomic, no KV write limits (KV allows 1 write/sec/key and 1,000 writes/day on the free plan)
  if (env.LOADTEST === '1') max *= 30; // TEMPORARY load-test switch: remove the LOADTEST variable after testing
  try { const r = await env.RLIM.get(env.RLIM.idFromName(key)).fetch('https://rl', { method: 'POST', body: JSON.stringify({ max }) }); return (await r.json()).ok !== false; }
  catch (e) { console.log('rl_err', String(e && e.message)); return true; } // fail open (availability); per-user throttles in the Matchmaker and in-room limits still apply
}
export class RateLimiter { // one instance per key (e.g. "join:<ip>"); fixed 60 s window, memory only
  constructor() { this.n = 0; this.t = 0; }
  async fetch(req) { let b; try { b = await req.json(); } catch { return J({ ok: true }); } const now = Date.now(); if (now - this.t >= 60000) { this.t = now; this.n = 0; } this.n++; return J({ ok: this.n <= (b.max | 0) }); }
}
async function flushPending(env) { // retry end-of-match writes that failed (idempotent RPC)
  const l = await env.RL.list({ prefix: 'rbr:pend:', limit: 20 });
  for (const k of l.keys) { const v = await env.RL.get(k.name); if (!v) continue; try { const r = await sb(env, 'rpc/finish_match', { method: 'POST', body: v }); if (r.ok) await env.RL.delete(k.name); } catch {} }
}
const RK = { MIN_ACC: 8, MIN_NET: 6, LITE: 1, FIELD_MIN: 5, FULL_TH: 6, /* LITE: TEMPORARY - 1 = a match with even ONE real account still counts for RANK (placement only, among all teams); set 0 to require the full 8-player quorum for rank again. Season points now count in EVERY ranked match (quorum rule removed by the owner). */ /* TUNE: ranked needs 8+ real accounts from 6+ different networks; placement is measured among HUMAN teams only */
  KNOTS: [[0, 35], [0.0196, 30], [0.039, 27], [0.059, 24], [0.078, 21], [0.098, 15], [0.176, 5], [0.196, 0], [0.372, -10], [0.392, -15], [0.569, -15], [0.588, -20], [0.765, -20], [0.784, -25], [1, -25]] }; /* placement points by percentile (your solo table, stretched to any number of teams) */
function rankDelta(o) { /* RP change of ONE human for ONE match. o = { ranked, th (human teams), ph (human-team place), kills (HUMAN kills only), score, engaged, mode } */
  if (!o.ranked) return 0;
  const x = o.th > 1 ? Math.min(1, (o.ph - 1) / Math.max(o.th - 1, RK.FIELD_MIN)) : 0; let pp = 0;
  for (let i = 1; i < RK.KNOTS.length; i++) { const a = RK.KNOTS[i - 1], b = RK.KNOTS[i]; if (x <= b[0]) { pp = a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0])); break; } }
  if (pp > 0) { pp *= Math.min(1, o.th / RK.FULL_TH); if (o.mode !== 'solo') pp *= Math.min(1, Math.max(0.5, o.score / 60)); } /* small fields pay less; in duo/squad a carried teammate gets less */
  const kp = Math.min(10, 2 * o.kills), bonus = o.engaged ? (o.score >= 81 ? 30 : o.score >= 60 ? 20 : 0) : 0; /* score bonus only if you actually fought a human */
  return Math.max(-30, Math.min(80, Math.round(pp + kp + bonus)));
}
function liteDelta(lp, teams) { /* TEMPORARY ranked-with-few-players: RP from overall placement only (bots count as opponents), gains halved, no kill / score bonus */
  const x = teams > 1 ? Math.min(1, (lp - 1) / (teams - 1)) : 0; let pp = 0;
  for (let i = 1; i < RK.KNOTS.length; i++) { const a = RK.KNOTS[i - 1], b = RK.KNOTS[i]; if (x <= b[0]) { pp = a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0])); break; } }
  if (pp > 0) pp *= 0.5;
  return Math.max(-30, Math.min(80, Math.round(pp)));
}
async function keepAlive(env) { /* one tiny read per day so the free Supabase project never counts as inactive (it pauses after ~7 idle days) */
  try { const r = await sb(env, 'seasons?select=id&limit=1'); console.log('keepalive', r.status); } catch (e) { console.log('keepalive_err', String(e && e.message)); }
}

// ---------- xRocket Pay: gem purchases (invoice -> signed webhook) and automatic USDT payouts ----------
// Money rules: balances live ONLY in Supabase (atomic RPCs). D1 keeps the financial ledger: orders (gem invoices), payouts (state of every USDT payout) and the daily payout cap.
// Gems are credited ONLY by the signed webhook (credit_gem_order is idempotent by order ref). Payouts use clientPayoutId = "wd-<withdrawal id>", so a retry can never pay twice.
const XR = { INVOICE_MS: 3600000, MAX_PENDING: 5, MAX_PAYOUT_USD: 50, DAILY_CAP_USD: 300, HOLD_SCORE: 10, MAX_TRIES: 6 }; // TUNE: payouts above MAX_PAYOUT_USD, players with suspect score >= HOLD_SCORE, and anything over the daily cap wait for manual review
const xr = async (env, method, path, body) => { // returns { s, j }; s = 0 means network failure / not configured
  if (!env.XROCKET_TOKEN) return { s: 0, j: {} };
  try {
    const r = await fetch((env.XROCKET_BASE || 'https://pay.api.xrocket.exchange') + path, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + env.XROCKET_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j };
  } catch (e) { console.log('xr_net', path); return { s: 0, j: {} }; }
};
const xrType = (j) => String((j && j.type) || '').replace('/api/problems/', '').slice(0, 60);
async function buyGems(env, ses, pack, cors) {
  if (!env.DB || !env.XROCKET_TOKEN || !Number.isSafeInteger(ses.tid)) return J({ e: 'pay' }, 503, cors);
  const now = Date.now(), pk = packsOf(env)[pack]; if (!pk) return J({ e: 'bad' }, 400, cors);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE pid = ?1 AND status = 'pending' AND created_at > ?2").bind(ses.pid, now - 3600000).first();
  if (n && n.n >= XR.MAX_PENDING) return J({ e: 'slow' }, 429, cors); /* abuse: invoice spam */
  const ref = 'g' + hex(12);
  await env.DB.prepare('INSERT INTO orders (ref, pid, tid, pack, gems, usd_cents, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(ref, ses.pid, ses.tid, pack, pk[0], pk[1], 'pending', now).run();
  const r = await xr(env, 'POST', '/api/v1/invoices', { clientInvoiceId: ref, priceAmount: (pk[1] / 100).toFixed(2), priceCurrency: 'USDT', description: pk[0] + ' GEM', expiresIn: XR.INVOICE_MS });
  const inv = r.j && r.j.data && r.j.data.id ? r.j.data : r.j;
  if (!(r.s >= 200 && r.s < 300) || !inv || typeof inv.id !== 'string') { console.log('xr_inv_fail', r.s, xrType(r.j)); await env.DB.prepare("UPDATE orders SET status = 'failed' WHERE ref = ?1").bind(ref).run(); return J({ e: 'err' }, 502, cors); }
  await env.DB.prepare('UPDATE orders SET xr_id = ?2 WHERE ref = ?1').bind(ref, inv.id).run();
  const lk = inv.links && typeof inv.links.telegramBotLink === 'string' && inv.links.telegramBotLink.startsWith('https://t.me/') ? inv.links.telegramBotLink : 'https://t.me/xRocket?start=' + encodeURIComponent(inv.id);
  return J({ ok: 1, url: lk, gems: pk[0] }, 200, cors);
}
async function xrHook(req, env, ip) { // server-to-server webhook from xRocket: signature + freshness are verified BEFORE anything is parsed
  if (!env.XROCKET_WEBHOOK_SECRET || !env.DB) return new Response(null, { status: 503 });
  if (!(await rl(env, 'xrh:' + ip, 120))) return new Response(null, { status: 429 });
  const sig = (req.headers.get('Signature') || '').toLowerCase(), ver = req.headers.get('Signature-Version'), ts = req.headers.get('Signature-Timestamp') || '';
  if (!/^[a-f0-9]{64}$/.test(sig) || ver !== 'v1' || !/^[0-9]{10,16}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 300000) return new Response(null, { status: 401 });
  const raw = await req.text(); if (raw.length > 20000) return new Response(null, { status: 413 });
  if (!teq(await hmacHex(env.XROCKET_WEBHOOK_SECRET, ts + '.' + raw), sig)) { console.log('xr_hook_badsig'); return new Response(null, { status: 401 }); }
  let e; try { e = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  const d = e && e.data, inv = d && d.invoice;
  if (!e || e.type !== 'invoice' || !d || !inv || typeof inv.id !== 'string') return J({ ok: 1 }); /* other event types: acknowledge and ignore */
  const paid = (d.event === 'payment_status_changed' && d.payment && d.payment.status === 'paid' && d.payment.finalizedAt) || (d.event === 'invoice_status_changed' && inv.status === 'paid');
  if (!paid) return J({ ok: 1 });
  const ref = typeof inv.clientInvoiceId === 'string' ? inv.clientInvoiceId : '';
  const o = await env.DB.prepare('SELECT ref, pid, gems, usd_cents FROM orders WHERE ref = ?1 OR xr_id = ?2 LIMIT 1').bind(ref, inv.id).first();
  if (!o) { console.log('xr_hook_noorder', ref ? 'known_ref' : 'no_ref'); return ref ? J({ ok: 1 }) : new Response(null, { status: 500 }); } /* no ref and no match yet: xr_id may not be saved yet, so ask xRocket to retry */
  if ((inv.priceAmount !== undefined && Math.round(Number(inv.priceAmount) * 100) !== o.usd_cents) || (inv.priceCurrency !== undefined && inv.priceCurrency !== 'USDT')) { console.log('xr_hook_mismatch'); return J({ ok: 1 }); } /* never credit on a mismatch */
  const r = await sb(env, 'rpc/credit_gem_order', { method: 'POST', body: JSON.stringify({ p: { ref: o.ref, pid: o.pid, gems: o.gems, usd: o.usd_cents } }) });
  if (!r.ok) { console.log('xr_hook_db', r.status); return new Response(null, { status: 500 }); } /* xRocket retries; the RPC is idempotent */
  const j = await r.json(); if (!j || (!j.ok && !j.dup)) { console.log('xr_hook_rej', j && j.e); return J({ ok: 1 }); }
  await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?2 WHERE ref = ?1 AND status <> 'paid'").bind(o.ref, Date.now()).run();
  return J({ ok: 1 });
}

// ---------- USDT withdrawals to a TON wallet ----------
const crc16 = (u) => { let c = 0; for (const b of u) { c ^= b << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; };
function tonAddr(s, testnet) { /* friendly TON address (48 chars, EQ.../UQ...): decoded and its CRC16 checked, so a typo can never reach the payout. Returns { key } (canonical, the same wallet always gives the same key) or null. */
  if (typeof s !== 'string' || s.length !== 48 || !/^[A-Za-z0-9_-]{48}$/.test(s)) return null;
  let u; try { u = unb64u(s); } catch { return null; } if (u.length !== 36) return null;
  const tag = u[0], tn = (tag & 0x80) !== 0, t2 = tag & 0x7f, wc = u[1]; if (t2 !== 0x11 && t2 !== 0x51) return null; if (tn !== !!testnet) return null; if (wc !== 0 && wc !== 0xff) return null;
  if (crc16(u.subarray(0, 34)) !== ((u[34] << 8) | u[35])) return null;
  return { key: (wc === 0xff ? '-1' : '0') + ':' + [...u.subarray(2, 34)].map((b) => b.toString(16).padStart(2, '0')).join('') };
}
const isTestnet = (env) => String(env.XROCKET_BASE || '').includes('testnet');
async function autoRotate(env) { try { const r = await sb(env, 'rpc/auto_rotate_season', { method: 'POST', body: '{}' }); if (!r.ok) console.log('rotate_db', r.status); } catch (e) { console.log('rotate_err'); } }

// ---------- Telegram Stars (XTR): digital goods paid inside Telegram ----------
// Flow: client sends only { pack } -> Worker reads the price HERE -> createInvoiceLink -> Mini App openInvoice -> Telegram webhook (pre_checkout_query, successful_payment, secret-token protected)
// -> D1 star_orders (PENDING -> PAID -> DELIVERED) -> Supabase credit_gem_order (idempotent by order id). Refunds only through the official refundStarPayment method; they are RECORDED, nothing is reserved.
const STAR_PRICES = [99, 299, 499, 999, 1999, 4999];
const packsOf = () => GEM_PACKS; // TUNE: Stars per pack, same index as GEM_PACKS (100 Stars = 1 USD of in-game value). The ONLY place prices exist; the client never sends a price.
const SO_ID = /^s[0-9a-f]{24}$/;
const TERMS_TEXT = 'Robot BR - Terms of Service and Refund Policy\n\n1. GEM is a virtual in-game currency sold as a digital product. It has no cash value and cannot be withdrawn, sold or transferred.\n2. Payment is made in Telegram Stars (or in USDT through xRocket where offered). The purchase is delivered automatically after the payment is confirmed.\n3. Refunds: send /paysupport with your Order ID. Mistaken or undelivered purchases are refunded. If the purchased GEM were already spent, the refund may be declined.\n4. Telegram support cannot help with purchases made in this game.\n5. Telegram Stars terms: https://telegram.org/tos/stars';
const tgApi = async (env, method, body) => { // never logs the URL (it contains the bot token)
  if (!env.TELEGRAM_BOT_TOKEN) return { s: 0, j: {} };
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j };
  } catch (e) { console.log('tg_net', method); return { s: 0, j: {} }; }
};
async function buyStars(env, ses, pack, cors) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || !Number.isSafeInteger(ses.tid)) return J({ e: 'pay' }, 503, cors);
  const now = Date.now(), pk = packsOf(env)[pack], stars = STAR_PRICES[pack];
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM star_orders WHERE pid = ?1 AND status = 'PENDING' AND created_at > ?2").bind(ses.pid, now - 3600000).first();
  if (n && n.n >= XR.MAX_PENDING) return J({ e: 'slow' }, 429, cors); /* abuse: invoice spam */
  const oid = 's' + hex(12);
  await env.DB.prepare("INSERT INTO star_orders (order_id, tid, pid, pack, gems, stars, usd_cents, currency, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'XTR', 'PENDING', ?8, ?8)").bind(oid, ses.tid, ses.pid, pack, pk[0], stars, pk[1], now).run();
  const r = await tgApi(env, 'createInvoiceLink', { title: pk[0] + ' GEM', description: 'In-game digital currency: ' + pk[0] + ' GEM', payload: oid, currency: 'XTR', prices: [{ label: pk[0] + ' GEM', amount: stars }] }); /* no provider_token for Stars */
  if (!(r.j && r.j.ok === true && typeof r.j.result === 'string' && r.j.result.startsWith('https://t.me/'))) { console.log('tg_invoice_fail', r.s, String((r.j && r.j.description) || '').slice(0, 80)); await env.DB.prepare("UPDATE star_orders SET status = 'CANCELLED', updated_at = ?2 WHERE order_id = ?1").bind(oid, Date.now()).run(); return J({ e: 'err' }, 502, cors); }
  return J({ ok: 1, url: r.j.result, stars }, 200, cors);
}
async function tgPre(env, q) { // must answer within 10 s: one D1 read + one Supabase read
  const deny = (m) => tgApi(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: false, error_message: m });
  try {
    const o = typeof q.invoice_payload === 'string' && SO_ID.test(q.invoice_payload) ? await env.DB.prepare('SELECT * FROM star_orders WHERE order_id = ?1').bind(q.invoice_payload).first() : null;
    if (!o || o.status !== 'PENDING' || !q.from || o.tid !== q.from.id || q.currency !== 'XTR' || q.total_amount !== o.stars || Date.now() - o.created_at > 86400000) return deny('This order is not valid any more. Please open the shop again.');
    const r = await sb(env, 'players?id=eq.' + o.pid + '&select=banned'); if (!r.ok) return deny('Temporary error, please try again.'); /* fail closed */
    const p = (await r.json())[0]; if (!p || p.banned) return deny('This account cannot make purchases.');
    return tgApi(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: true });
  } catch (e) { console.log('tg_pre_err', String(e && e.message)); return deny('Temporary error, please try again.'); }
}
async function tgDeliver(env, o) { /* idempotent: credit_gem_order dedupes on the order id */
  const r = o.pack === PASS_PACK ? await sb(env, 'rpc/grant_pass_stars', { method: 'POST', body: JSON.stringify({ p: { ref: o.order_id, pid: o.pid } }) }) : await sb(env, 'rpc/credit_gem_order', { method: 'POST', body: JSON.stringify({ p: { ref: o.order_id, pid: o.pid, gems: o.gems, usd: o.usd_cents, src: 'stars' } }) });
  if (!r.ok) { console.log('tg_deliver_db', r.status); return false; }
  const j = await r.json(); if (!j || (!j.ok && !j.dup)) { console.log('tg_deliver_rej', j && j.e); return false; }
  await env.DB.prepare("UPDATE star_orders SET status = 'DELIVERED', delivered_at = ?2, updated_at = ?2 WHERE order_id = ?1 AND status = 'PAID'").bind(o.order_id, Date.now()).run();
  return true;
}
async function tgPaid(env, m) {
  const sp = m.successful_payment, f = m.from || {}, oid = sp.invoice_payload, ch = sp.telegram_payment_charge_id, db = env.DB, now = Date.now();
  if (typeof oid !== 'string' || !SO_ID.test(oid) || typeof ch !== 'string' || !ch || ch.length > 200) { console.log('tg_paid_badpayload'); return J({ ok: 1 }); }
  const led = (type, stars, note) => db.prepare('INSERT OR IGNORE INTO star_ledger (order_id, tid, type, stars, charge_id, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(oid, Number(f.id) || 0, type, stars, ch, note || null, now).run();
  const o = await db.prepare('SELECT * FROM star_orders WHERE order_id = ?1').bind(oid).first();
  if (!o || o.tid !== f.id || sp.currency !== 'XTR' || sp.total_amount !== o.stars) { console.log('tg_paid_mismatch'); await led('PAYMENT', Number(sp.total_amount) || 0, 'UNMATCHED'); return J({ ok: 1 }); } /* money arrived but nothing is delivered: handle by hand with the charge id in star_ledger */
  const c = await db.prepare("UPDATE star_orders SET status = 'PAID', charge_id = ?2, paid_at = ?3, updated_at = ?3, username = ?4, first_name = ?5, last_name = ?6 WHERE order_id = ?1 AND status = 'PENDING'").bind(oid, ch, now, f.username ? String(f.username).slice(0, 64) : null, f.first_name ? String(f.first_name).slice(0, 64) : null, f.last_name ? String(f.last_name).slice(0, 64) : null).run();
  let cur = o;
  if (!c.meta || !c.meta.changes) {
    cur = await db.prepare('SELECT * FROM star_orders WHERE order_id = ?1').bind(oid).first();
    if (!cur || cur.charge_id !== ch) { /* a SECOND, different charge for an already paid order (double tap): give the extra money back */
      await led('PAYMENT', o.stars, 'DUPLICATE_CHARGE');
      const r = await tgApi(env, 'refundStarPayment', { user_id: f.id, telegram_payment_charge_id: ch });
      if (r.j && r.j.ok === true) await db.prepare("INSERT OR IGNORE INTO star_ledger (order_id, tid, type, stars, charge_id, note, created_at) VALUES (?1, ?2, 'REFUND', ?3, ?4, 'DUPLICATE_CHARGE', ?5)").bind(oid, f.id, -o.stars, ch, Date.now()).run(); else console.log('tg_dup_refund_fail', r.s);
      return J({ ok: 1 });
    }
    if (cur.status === 'DELIVERED' || cur.status === 'REFUNDED' || cur.refund_status) return J({ ok: 1 }); /* Telegram sent the same payment again: nothing to do */
  }
  await led('PAYMENT', o.stars);
  return (await tgDeliver(env, cur)) ? J({ ok: 1 }) : new Response(null, { status: 500 }); /* 500 = Telegram retries; delivery is idempotent */
}
async function tgCmd(env, m) {
  const t = String(m.text).trim().split(/[\s@]/)[0].toLowerCase(), f = m.from || {}; let text;
  if (t === '/terms') text = TERMS_TEXT;
  else if (t === '/paysupport') {
    const rows = Number.isSafeInteger(f.id) ? (await env.DB.prepare('SELECT order_id, charge_id, status FROM star_orders WHERE tid = ?1 AND charge_id IS NOT NULL ORDER BY created_at DESC LIMIT 3').bind(f.id).all()).results || [] : [];
    text = 'Payment support\n\nYour Telegram ID: ' + f.id + '\nSend your Telegram ID, Order ID and Charge ID to: ' + (env.SUPPORT_CONTACT || 'the game owner') + '\nTelegram support cannot help with purchases made in this game.' + (rows.length ? '\n\nYour last payments:\n' + rows.map((r) => 'Order ' + r.order_id + '\nCharge ' + r.charge_id + '\nStatus ' + r.status).join('\n\n') : '');
  } else return;
  await tgApi(env, 'sendMessage', { chat_id: m.chat.id, text, disable_web_page_preview: true });
}
async function tgHook(req, env) { // authenticated ONLY by Telegram's secret-token header (set through setWebhook)
  if (!env.TG_WEBHOOK_SECRET || !env.DB || !env.TELEGRAM_BOT_TOKEN) return new Response(null, { status: 503 });
  if (!teq(req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', env.TG_WEBHOOK_SECRET)) { console.log('tg_hook_badsecret'); return new Response(null, { status: 401 }); }
  const raw = await req.text(); if (raw.length > 30000) return new Response(null, { status: 413 });
  let u; try { u = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  if (u && u.pre_checkout_query) { await tgPre(env, u.pre_checkout_query); return J({ ok: 1 }); }
  const m = u && u.message;
  if (m && m.successful_payment) return tgPaid(env, m);
  if (m && typeof m.text === 'string' && m.chat && m.chat.type === 'private') await tgCmd(env, m);
  return J({ ok: 1 });
}
async function refundOrder(env, oid, reason) { // official refund only; the result is RECORDED (no reserve, no balance)
  const db = env.DB; if (typeof oid !== 'string' || !SO_ID.test(oid)) return { e: 'bad' };
  const o = await db.prepare('SELECT * FROM star_orders WHERE order_id = ?1').bind(oid).first(); if (!o || !o.charge_id) return { e: 'none' };
  if (o.refund_status === 'REFUNDED') return { e: 'dup' }; /* never refund the same charge twice */
  const rs = String(reason || '').slice(0, 120);
  const c = await db.prepare("UPDATE star_orders SET refund_status = 'PENDING', refund_reason = ?3, updated_at = ?2 WHERE order_id = ?1 AND charge_id IS NOT NULL AND (refund_status IS NULL OR refund_status = 'FAILED')").bind(oid, Date.now(), rs).run();
  if (!c.meta || !c.meta.changes) return { e: 'busy' };
  const r = await tgApi(env, 'refundStarPayment', { user_id: o.tid, telegram_payment_charge_id: o.charge_id });
  const d = String((r.j && r.j.description) || ''), already = /ALREADY_REFUNDED/i.test(d);
  if (!(r.j && r.j.ok === true) && !already) { await db.prepare("UPDATE star_orders SET refund_status = 'FAILED', updated_at = ?2 WHERE order_id = ?1").bind(oid, Date.now()).run(); return { e: 'tg', d: d.slice(0, 100) || String(r.s) }; }
  let removed = 0, note = rs;
  if (o.status === 'DELIVERED') { /* take back the GEM that are still in the account; spent GEM are only recorded (game policy) */
    const g = o.pack === PASS_PACK ? await sb(env, 'rpc/revoke_pass', { method: 'POST', body: JSON.stringify({ p: { ref: oid } }) }) : await sb(env, 'rpc/revoke_gem_order', { method: 'POST', body: JSON.stringify({ p: { ref: oid, pid: o.pid, gems: o.gems } }) });
    if (g.ok) { const j = await g.json(); removed = Number(j && j.removed) || 0; if (j && j.short > 0) note += ' [' + j.short + ' GEM already spent]'; } else note += ' [gems not removed: db error]';
  }
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE star_orders SET status = 'REFUNDED', refund_status = 'REFUNDED', refund_date = ?2, refund_reason = ?3, refund_stars = stars, gems_removed = ?4, updated_at = ?2 WHERE order_id = ?1").bind(oid, now, note.slice(0, 160), removed),
    db.prepare("INSERT OR IGNORE INTO star_ledger (order_id, tid, type, stars, charge_id, note, created_at) VALUES (?1, ?2, 'REFUND', ?3, ?4, ?5, ?6)").bind(oid, o.tid, -o.stars, o.charge_id, note.slice(0, 160) || null, now)
  ]);
  return { ok: 1, removed };
}
async function tgMaintain(env) { // cron: cancel stale orders, make sure Telegram points at this Worker (setWebhook is idempotent; remembered in KV for a day)
  if (!env.DB) return;
  await env.DB.prepare("UPDATE star_orders SET status = 'CANCELLED', updated_at = ?1 WHERE status = 'PENDING' AND created_at < ?2").bind(Date.now(), Date.now() - 86400000).run();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TG_WEBHOOK_SECRET) return;
  const url = String(env.PUBLIC_URL || '').replace(/\/+$/, '') + '/tg/webhook'; if (!/^https:\/\//.test(url)) return;
  const key = 'rbr:tgwh:' + (await sign(env.JOIN_SECRET, 'wh|' + url + '|' + env.TG_WEBHOOK_SECRET)).slice(0, 12);
  if (await env.RL.get(key)) return;
  const r = await tgApi(env, 'setWebhook', { url, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query'] });
  if (r.j && r.j.ok === true) await env.RL.put(key, '1', { expirationTtl: 86400 }); else console.log('tg_setwebhook_fail', r.s, String((r.j && r.j.description) || '').slice(0, 80));
}
const esc = (q) => q.replace(/[\\%_]/g, '\\$&');
const ADMIN_X = new Set(['/admin/overview', '/admin/wdl', '/admin/stars', '/admin/xr', '/admin/paytot', '/admin/player', '/admin/pdetail', '/admin/suspects', '/admin/sp', '/admin/sp/top', '/admin/sp/trend', '/admin/sp/set', '/admin/audit', '/admin/backup']);
const NAME_OK = /^[\p{L}\p{N} _-]{1,24}$/u;
const PAGE = 25; // rows per page on every dashboard list (the query asks for PAGE + 1 to know whether a next page exists)
const pgOf = (url) => { const n = Number(url.searchParams.get('pg') || 0); return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : 0; };
const SORTS = new Map([['xp', 'total_xp.desc'], ['new', 'created_at.desc'], ['coins', 'soft_currency.desc'], ['gems', 'premium_currency.desc']]);
const admRpc = async (env, fn, p) => { const r = await sb(env, 'rpc/' + fn, { method: 'POST', body: JSON.stringify({ p }) }); if (!r.ok) { console.log('adm_rpc', fn, r.status); return null; } return r.json(); };
const audit = (env, a, d) => admRpc(env, 'admin_log', { a, d }).catch(() => null); /* every owner action leaves a row in admin_audit */
const SP_FIELDS = { value: ['sid', 'value', 'dry'], pool: ['sid', 'pool', 'exclude_banned', 'dry'], dates: ['sid', 'ends_at', 'claim_days', 'dry'], endnow: ['sid'], minmatches: ['sid', 'min'], reset: ['dry', 'confirm'] };
async function admExtra(req, env, url, P) { // dashboard endpoints (already authenticated + rate-limited by admPay)
  if (!ADMIN_X.has(P)) return null;
  const get = async (path) => { const r = await sb(env, path); return r.ok ? r.json() : null; };
  const sid = () => { const n = Number(url.searchParams.get('sid')); return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : null; };
  const off = pgOf(url) * PAGE;
  if (P === '/admin/overview') {
    const j = await admRpc(env, 'admin_overview', {}); if (!j) return J({ e: 'db' }, 502);
    return J({ o: j, li: (await get('season_liability?select=season,name,value,players,sp_total,sp_open,max_open_usd&order=season.desc&limit=3')) || [] });
  }
  if (P === '/admin/wdl') { /* withdrawal requests, 25 per page; the pending queue puts Season Pass Premium owners first */
    const st = url.searchParams.get('st'), j = await admRpc(env, 'admin_withdrawals', { st: st === 'done' || st === 'all' ? st : 'pending', lim: PAGE, off });
    return j ? J(j) : J({ e: 'db' }, 502);
  }
  if (P === '/admin/stars') { /* Telegram Stars purchases (paid / delivered / refunded only), newest first; a search also finds pending and cancelled orders */
    const q = (url.searchParams.get('q') || '').trim().slice(0, 64), cols = 'order_id, tid, username, first_name, pack, gems, stars, charge_id, status, refund_status, refund_reason, created_at, paid_at'; let rs;
    if (q) rs = await env.DB.prepare('SELECT ' + cols + " FROM star_orders WHERE order_id = ?1 OR charge_id = ?1 OR tid = ?2 OR username LIKE ?3 ESCAPE '\\' ORDER BY created_at DESC LIMIT 26 OFFSET ?4").bind(q, /^[0-9]{1,15}$/.test(q) ? Number(q) : -1, esc(q) + '%', off).all();
    else rs = await env.DB.prepare('SELECT ' + cols + " FROM star_orders WHERE status IN ('PAID','DELIVERED','REFUNDED') ORDER BY created_at DESC LIMIT 26 OFFSET ?1").bind(off).all();
    const rows = (rs && rs.results) || []; return J({ rows: rows.slice(0, PAGE), more: rows.length > PAGE });
  }
  if (P === '/admin/xr') { /* xRocket (USDT) purchases, paid only, newest first */
    const rs = await env.DB.prepare("SELECT ref, pid, tid, gems, usd_cents, status, created_at, paid_at FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT 26 OFFSET ?1").bind(off).all();
    const all = (rs && rs.results) || [], rows = all.slice(0, PAGE), ids = [...new Set(rows.map((x) => x.pid).filter((x) => typeof x === 'string' && UUID.test(x)))], nm = {};
    if (ids.length) { const pl = await get('players?id=in.(' + ids.join(',') + ')&select=id,name'); if (pl) for (const x of pl) nm[x.id] = x.name; }
    return J({ rows: rows.map((x) => ({ ...x, name: nm[x.pid] || null })), more: all.length > PAGE });
  }
  if (P === '/admin/paytot') {
    const db = env.DB, t = await db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status IN ('PAID','DELIVERED')),0) AS ok, COALESCE(SUM(status = 'PENDING'),0) AS pending, COALESCE(SUM(status = 'CANCELLED'),0) AS cancelled, COALESCE(SUM(status = 'REFUNDED'),0) AS refunded, COALESCE(SUM(CASE WHEN charge_id IS NOT NULL THEN stars ELSE 0 END),0) AS stars_in, COALESCE(SUM(CASE WHEN status = 'REFUNDED' THEN refund_stars ELSE 0 END),0) AS stars_refunded, COALESCE(SUM(CASE WHEN charge_id IS NOT NULL THEN gems ELSE 0 END),0) AS gems_sold, COALESCE(SUM(CASE WHEN pack = 100 AND status IN ('PAID','DELIVERED') THEN 1 ELSE 0 END),0) AS pass_sold FROM star_orders").first();
    const x = await db.prepare("SELECT COUNT(*) AS paid, COALESCE(SUM(usd_cents),0) AS cents, COALESCE(SUM(gems),0) AS gems FROM orders WHERE status = 'paid'").first();
    return J({ stars: t, xrocket: x });
  }
  if (P === '/admin/suspects') { const j = await admRpc(env, 'admin_suspects', { lim: PAGE, off }); return j ? J(j) : J({ e: 'db' }, 502); }
  if (P === '/admin/audit') { const r = await get('admin_audit?select=id,action,detail,created_at&order=id.desc&limit=' + (PAGE + 1) + '&offset=' + off); if (!r) return J({ e: 'db', hint: 'run stage23.sql' }, 502); return J({ rows: r.slice(0, PAGE), more: r.length > PAGE }); }
  if (P === '/admin/backup') { if (req.method === 'POST') { const s = await backupTick(env, sb, 'force'); await audit(env, 'backup_force', { day: s && s.day }); return J(s); } return J(await backupStatus(env)); }
  if (P === '/admin/sp') { const j = await admRpc(env, 'admin_sp_seasons', {}); return j ? J({ seasons: j, now: Date.now() }) : J({ e: 'db', hint: 'run stage23.sql' }, 502); }
  if (P === '/admin/sp/top') { const s = sid(); if (!s) return J({ e: 'bad' }, 400); const j = await admRpc(env, 'admin_sp_top', { sid: s, lim: PAGE, off }); return j ? J(j) : J({ e: 'db' }, 502); }
  if (P === '/admin/sp/trend') { const s = sid(); if (!s) return J({ e: 'bad' }, 400); const j = await admRpc(env, 'admin_sp_trend', { sid: s }); return j ? J(j) : J({ e: 'db' }, 502); }
  if (P === '/admin/sp/set') { /* the ONLY way the dashboard changes a Season Points price or date; strict body, then the SQL function validates again and writes admin_audit */
    if (req.method !== 'POST') return J({ e: 'bad' }, 405);
    let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400); }
    const A = b && typeof b === 'object' && typeof b.action === 'string' && Object.prototype.hasOwnProperty.call(SP_FIELDS, b.action) ? SP_FIELDS[b.action] : null;
    if (!A || Object.keys(b).some((k) => k !== 'action' && !A.includes(k))) return J({ e: 'bad' }, 400);
    const isReset = b.action === 'reset';
    if ((!isReset && (!Number.isInteger(b.sid) || b.sid < 1 || b.sid > 100000)) || (b.dry !== undefined && typeof b.dry !== 'boolean') || (b.exclude_banned !== undefined && typeof b.exclude_banned !== 'boolean')) return J({ e: 'bad' }, 400);
    let fn, p = isReset ? {} : { sid: b.sid };
    if (b.dry !== undefined) p.dry = b.dry;
    if (b.action === 'value') { if (typeof b.value !== 'number' || !Number.isFinite(b.value) || b.value <= 0 || b.value > 0.1) return J({ e: 'range' }, 400); fn = 'admin_sp_set_value'; p.value = b.value; }
    else if (b.action === 'pool') { if (typeof b.pool !== 'number' || !Number.isFinite(b.pool) || b.pool <= 0 || b.pool > 1000000) return J({ e: 'range' }, 400); fn = 'admin_sp_set_pool'; p.pool = b.pool; if (b.exclude_banned !== undefined) p.exclude_banned = b.exclude_banned; }
    else if (b.action === 'endnow') { fn = 'admin_sp_set_dates'; p.ends_at = new Date().toISOString(); p.end_now = true; }
    else if (b.action === 'minmatches') { if (!Number.isInteger(b.min) || b.min < 0 || b.min > 500) return J({ e: 'range' }, 400); fn = 'admin_sp_set_min'; p.min = b.min; }
    else if (b.action === 'reset') { if (b.dry !== true && b.confirm !== 'RESET') return J({ e: 'confirm' }, 400); fn = 'admin_sp_reset'; } /* destructive: the server insists on the typed word, the SQL function refuses if a withdrawal was already paid */
    else {
      fn = 'admin_sp_set_dates';
      if (b.ends_at !== undefined) { if (typeof b.ends_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(b.ends_at) || !Number.isFinite(Date.parse(b.ends_at))) return J({ e: 'date' }, 400); const y = new Date(b.ends_at).getUTCFullYear(); if (y < 2020 || y > 2100) return J({ e: 'date' }, 400); p.ends_at = new Date(b.ends_at).toISOString(); }
      if (b.claim_days !== undefined) { if (!Number.isInteger(b.claim_days) || b.claim_days < 1 || b.claim_days > 365) return J({ e: 'claim_days' }, 400); p.claim_days = b.claim_days; }
      if (p.ends_at === undefined && p.claim_days === undefined) return J({ e: 'nothing' }, 400);
    }
    const j = await admRpc(env, fn, p); if (!j) return J({ e: 'db', hint: 'run stage23.sql' }, 502);
    if (j.ok && !p.dry) console.log('admin_sp', b.action, b.sid);
    return J(j, j.ok ? 200 : 409);
  }
  if (P === '/admin/pdetail') {
    const id = url.searchParams.get('id') || ''; if (!UUID.test(id)) return J({ e: 'bad' }, 400);
    const j = await admRpc(env, 'admin_player_detail', { pid: id }); if (!j) return J({ e: 'db' }, 502); if (!j.ok) return J(j, 404);
    const db = env.DB, so = (await db.prepare('SELECT order_id, pack, gems, stars, status, refund_status, charge_id, created_at FROM star_orders WHERE pid = ?1 ORDER BY created_at DESC LIMIT 10').bind(id).all()).results || [];
    const xo = (await db.prepare('SELECT ref, gems, usd_cents, status, created_at FROM orders WHERE pid = ?1 ORDER BY created_at DESC LIMIT 10').bind(id).all()).results || [];
    const bk = await backupStatus(env).catch(() => ({}));
    return J({ ...j, stars_orders: so, xr_orders: xo, backup_day: bk && bk.day ? bk.day : null });
  }
  if (P === '/admin/player') {
    if (req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400); }
      if (!b || typeof b.id !== 'string' || !UUID.test(b.id) || typeof b.banned !== 'boolean' || Object.keys(b).length !== 2) return J({ e: 'bad' }, 400);
      const r = await sb(env, 'players?id=eq.' + b.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ banned: b.banned }) });
      console.log('admin_ban', b.id, b.banned, r.status); if (!r.ok) return J({ e: 'db' }, 502);
      await audit(env, b.banned ? 'ban' : 'unban', { player_id: b.id }); return J({ ok: 1 });
    }
    const q = (url.searchParams.get('q') || '').trim().slice(0, 40), srt = SORTS.get(url.searchParams.get('sort')) || SORTS.get('xp'); let f = '';
    if (/^[0-9]{1,15}$/.test(q)) f = '&telegram_id=eq.' + q; else if (UUID.test(q)) f = '&id=eq.' + q; else if (NAME_OK.test(q)) f = '&name=ilike.' + encodeURIComponent('*' + q + '*'); else if (q) return J({ rows: [], more: false });
    const r = (await get('players?select=id,telegram_id,name,level,total_xp,soft_currency,premium_currency,banned,created_at' + f + '&order=' + srt + ',id.asc&limit=' + (PAGE + 1) + '&offset=' + off)) || [];
    return J({ rows: r.slice(0, PAGE), more: r.length > PAGE });
  }
  return null;
}
async function admPay(req, env, url, ip, P) { // owner-only dashboard data (x-admin header = ADMIN_KEY)
  if (!(await rl(env, 'adm:' + ip, 60))) return J({ e: 'slow' }, 429);
  if (!env.ADMIN_KEY || !teq(req.headers.get('x-admin'), env.ADMIN_KEY)) return new Response(null, { status: 404 });
  if (!env.DB) return J({ e: 'nodb' }, 503);
  { const ex = await admExtra(req, env, url, P); if (ex) return ex; }
  if (P === '/admin/wd') { /* pending USDT withdrawal requests: the owner pays them by hand, then marks them paid (or rejects = the Season Points come back) */
    if (req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400); }
      if (!b || !Number.isInteger(b.id) || (b.action !== 'paid' && b.action !== 'reject')) return J({ e: 'bad' }, 400);
      const note = String(b.note || '').slice(0, 100); console.log('admin_wd', b.id, b.action);
      const r = await sb(env, 'rpc/' + (b.action === 'paid' ? 'finish_withdrawal' : 'refund_withdrawal'), { method: 'POST', body: JSON.stringify({ p: { wid: b.id, note: (b.action === 'paid' ? 'manual:' : 'rejected:') + note } }) });
      if (!r.ok) return J({ e: 'db' }, 502); const wj = await r.json(); if (wj && wj.ok) await audit(env, b.action === 'paid' ? 'wd_paid' : 'wd_reject', { wid: b.id, note }); return J(wj);
    }
    const r = await sb(env, 'withdrawals?status=eq.pending&select=id,player_id,sp,usd,addr,created_at,players(name,telegram_id)&order=id.asc&limit=50'); if (!r.ok) return J({ e: 'db' }, 502);
    const rows = await r.json(), ids = [...new Set(rows.map((x) => x.player_id))], sc = {};
    if (ids.length) { const s = await sb(env, 'suspect_summary?player_id=in.(' + ids.join(',') + ')&select=player_id,score,kinds'); if (s.ok) for (const x of await s.json()) sc[x.player_id] = x; }
    return J({ rows: rows.map((x) => ({ id: x.id, name: x.players && x.players.name, telegram_id: x.players && x.players.telegram_id, sp: x.sp, usd: Number(x.usd), addr: x.addr, created_at: Date.parse(x.created_at), score: sc[x.player_id] ? Number(sc[x.player_id].score) : 0, kinds: sc[x.player_id] ? sc[x.player_id].kinds : null })) });
  }
  if (P === '/admin/refund') {
    let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400); }
    if (req.method !== 'POST' || !b || typeof b.order_id !== 'string') return J({ e: 'bad' }, 400);
    console.log('admin_refund', b.order_id); const rf = await refundOrder(env, b.order_id, b.reason); if (rf && rf.ok) await audit(env, 'stars_refund', { order_id: b.order_id, reason: String(b.reason || '').slice(0, 80) }); return J(rf);
  }
  const q = (url.searchParams.get('q') || '').trim().slice(0, 64), db = env.DB;
  const t = await db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status IN ('PAID','DELIVERED')),0) AS ok, COALESCE(SUM(status = 'PENDING'),0) AS pending, COALESCE(SUM(status = 'CANCELLED'),0) AS cancelled, COALESCE(SUM(status = 'REFUNDED'),0) AS refunded, COALESCE(SUM(CASE WHEN charge_id IS NOT NULL THEN stars ELSE 0 END),0) AS stars_in, COALESCE(SUM(CASE WHEN status = 'REFUNDED' THEN refund_stars ELSE 0 END),0) AS stars_refunded, COALESCE(SUM(CASE WHEN charge_id IS NOT NULL THEN gems ELSE 0 END),0) AS gems_sold, COALESCE(SUM(CASE WHEN status = 'REFUNDED' THEN gems_removed ELSE 0 END),0) AS gems_refunded FROM star_orders").first();
  const x = await db.prepare("SELECT COUNT(*) AS paid, COALESCE(SUM(usd_cents),0) AS cents, COALESCE(SUM(gems),0) AS gems FROM orders WHERE status = 'paid'").first();
  const rows = q ? (await db.prepare("SELECT order_id, tid, username, first_name, gems, stars, charge_id, status, refund_status, refund_reason, created_at, paid_at FROM star_orders WHERE order_id = ?1 OR charge_id = ?1 OR tid = ?2 OR username LIKE ?3 ESCAPE '\\' ORDER BY created_at DESC LIMIT 20").bind(q, /^[0-9]{1,15}$/.test(q) ? Number(q) : -1, esc(q) + '%').all()).results
    : (await db.prepare('SELECT order_id, tid, username, first_name, gems, stars, charge_id, status, refund_status, refund_reason, created_at, paid_at FROM star_orders ORDER BY created_at DESC LIMIT 20').all()).results;
  return J({ stars: t, xrocket: x, rows });
}
async function myPayments(env, ses, cors) {
  if (!env.DB) return J({ items: [] }, 200, cors);
  const a = (await env.DB.prepare("SELECT order_id, pack, gems, stars, charge_id, status, refund_status, created_at FROM star_orders WHERE pid = ?1 AND status IN ('PAID','DELIVERED','REFUNDED') ORDER BY created_at DESC LIMIT 10").bind(ses.pid).all()).results || [];
  const b = (await env.DB.prepare("SELECT ref, gems, usd_cents, created_at FROM orders WHERE pid = ?1 AND status = 'paid' ORDER BY created_at DESC LIMIT 10").bind(ses.pid).all()).results || [];
  const items = a.map((o) => ({ id: o.order_id, m: 'stars', pass: o.pack === PASS_PACK ? 1 : 0, gems: o.gems, price: o.stars, ch: o.charge_id || '', st: o.status === 'DELIVERED' || o.status === 'PAID' ? 'Paid' : o.status === 'REFUNDED' ? 'Refunded' : 'Pending', rf: o.refund_status || '', at: o.created_at }))
    .concat(b.map((o) => ({ id: o.ref, m: 'xrocket', gems: o.gems, price: o.usd_cents, ch: '', st: 'Paid', rf: '', at: o.created_at }))).sort((x, y) => y.at - x.at).slice(0, 10);
  return J({ items }, 200, cors);
}

// ---------- SEASON PASS (monthly) ----------
// Pass XP per match = placement points below (from the owner's tables). 250 XP per tier, 30 tiers. Computed HERE and sent to the DB; the client never sends XP.
const PASS_PACK = 100, PASS_STARS = 299; // TUNE: star_orders.pack = 100 marks a Season Pass order; premium costs 300 GEM (fixed inside the buy_pass_gems SQL function) or PASS_STARS stars
const SXP = {
  solo: [[1, 100], [2, 90], [3, 85], [4, 80], [5, 75], [10, 65], [15, 55], [20, 45], [25, 40], [30, 35], [35, 30], [40, 25], [45, 20], [50, 15], [52, 10]],
  duo: [[1, 100], [2, 90], [3, 85], [4, 80], [5, 75], [6, 65], [7, 60], [8, 55], [9, 50], [10, 45], [12, 40], [14, 35], [16, 30], [18, 25], [20, 22], [22, 18], [24, 15], [26, 12], [28, 10]],
  squad: [[1, 100], [2, 90], [3, 85], [4, 80], [5, 75], [6, 65], [7, 60], [8, 55], [9, 50], [10, 45], [11, 35], [12, 25], [13, 15], [14, 10]] };
const seasonXp = (mode, place) => { const t = SXP[mode] || SXP.solo; for (const r of t) if (place <= r[0]) return r[1]; return t[t.length - 1][1]; };
async function buyPassStars(env, ses, cors) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || !Number.isSafeInteger(ses.tid)) return J({ e: 'pay' }, 503, cors);
  const g = await sb(env, 'rpc/get_pass', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) }); if (!g.ok) return J({ e: 'err' }, 502, cors);
  const gj = await g.json(); if (!gj || !gj.ok) return J({ e: 'err' }, 404, cors); if (gj.premium) return J({ e: 'owned' }, 409, cors);
  const now = Date.now(), n = await env.DB.prepare("SELECT COUNT(*) AS n FROM star_orders WHERE pid = ?1 AND status = 'PENDING' AND created_at > ?2").bind(ses.pid, now - 3600000).first();
  if (n && n.n >= XR.MAX_PENDING) return J({ e: 'slow' }, 429, cors);
  const oid = 's' + hex(12);
  await env.DB.prepare("INSERT INTO star_orders (order_id, tid, pid, pack, gems, stars, usd_cents, currency, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 'XTR', 'PENDING', ?7, ?7)").bind(oid, ses.tid, ses.pid, PASS_PACK, PASS_STARS, PASS_STARS, now).run();
  const r = await tgApi(env, 'createInvoiceLink', { title: 'Season Pass Premium', description: 'Premium track of the current monthly Season Pass (digital good)', payload: oid, currency: 'XTR', prices: [{ label: 'Premium Season Pass', amount: PASS_STARS }] });
  if (!(r.j && r.j.ok === true && typeof r.j.result === 'string' && r.j.result.startsWith('https://t.me/'))) { console.log('tg_pass_invoice_fail', r.s); await env.DB.prepare("UPDATE star_orders SET status = 'CANCELLED', updated_at = ?2 WHERE order_id = ?1").bind(oid, Date.now()).run(); return J({ e: 'err' }, 502, cors); }
  return J({ ok: 1, url: r.j.result, stars: PASS_STARS }, 200, cors);
}
async function passApi(env, ses, req, P, cors) { // /pass (GET), /pass/claim, /pass/buy, /box/open
  if (!(await rl(env, 'pass:' + ses.u, K.RL.pass))) return J({ e: 'slow' }, 429, cors); /* its own counter: pass screen + boxes no longer share the 30/min shop counter */
  if (!ses.pid) return J({ e: 'guest' }, 403, cors);
  const call = async (fn, p) => { const r = await sb(env, 'rpc/' + fn, { method: 'POST', body: JSON.stringify({ p }) }); if (!r.ok) { console.log('pass_db', fn, r.status); return J({ e: 'err' }, 502, cors); } const j = await r.json(); if (j && j.ok) return J(j, 200, cors); const e = (j && j.e) || 'err'; return J(e === 'cool' ? { e, wait: Number(j.wait) | 0 } : { e }, e === 'bad' ? 400 : e === 'player' ? 404 : 409, cors); };
  if (P === '/pass' && req.method === 'GET') { const r = await sb(env, 'rpc/get_pass', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) }); if (!r.ok) { console.log('pass_db', r.status); return J({ e: 'err' }, 502, cors); } const j = await r.json(); if (!j || !j.ok) return J({ e: 'err' }, 404, cors); j.price_stars = PASS_STARS; return J(j, 200, cors); }
  if (req.method !== 'POST' || P === '/pass') return new Response(null, { status: 405 });
  let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
  if (!b || typeof b !== 'object') return J({ e: 'bad' }, 400, cors);
  if (P === '/pass/claim') {
    if (Object.keys(b).some((k) => k !== 'tier' && k !== 'track' && k !== 'dbl') || !Number.isInteger(b.tier) || b.tier < 1 || b.tier > 30 || (b.track !== 'free' && b.track !== 'premium') || (b.dbl !== undefined && typeof b.dbl !== 'boolean')) return J({ e: 'bad' }, 400, cors);
    if (b.dbl && !Number.isSafeInteger(ses.tid)) return J({ e: 'auth' }, 401, cors);
    return call('claim_pass_tier', { pid: ses.pid, tid: ses.tid || 0, tier: b.tier, track: b.track, dbl: !!b.dbl });
  }
  if (P === '/box/open') {
    if (Object.keys(b).some((k) => k !== 'n') || !Number.isInteger(b.n) || b.n < 1 || b.n > 100) return J({ e: 'bad' }, 400, cors);
    return call('open_box', { pid: ses.pid, n: b.n });
  }
  if (P === '/pass/buy') {
    if (Object.keys(b).some((k) => k !== 'method') || (b.method !== 'gems' && b.method !== 'stars')) return J({ e: 'bad' }, 400, cors);
    return b.method === 'gems' ? call('buy_pass_gems', { pid: ses.pid }) : buyPassStars(env, ses, cors);
  }
  return new Response(null, { status: 404 });
}
const mmStub = (env) => env.MM.get(env.MM.idFromName('mm'));
const mmCall = async (env, path, body) => { const r = await mmStub(env).fetch('https://mm' + path, { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(Promise.all([flushPending(env), autoRotate(env), tgMaintain(env).catch((e) => console.log('tgm_err', String(e && e.message))), event.cron === '*/10 * * * *' ? backupTick(env, sb, 'run').catch((e) => console.log('backup_err', String(e && e.message))) : keepAlive(env)])); }, /* the 10-minute job retries failed writes; the daily job pings Supabase */
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean), okOrigin = allowed.includes(origin);
    const cors = okOrigin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const ip = req.headers.get('CF-Connecting-IP') || 'x', P = url.pathname;
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-admin' } });
      if (P === '/admin/stats') { // admin only: matchmaker + (optional) one match room
        if (!env.ADMIN_KEY || !teq(req.headers.get('x-admin'), env.ADMIN_KEY)) return new Response(null, { status: 404 });
        const m = url.searchParams.get('m'), out = { mm: await (await mmStub(env).fetch('https://mm/stats', { method: 'POST', body: '{}' })).json() };
        if (m && UUID.test(m)) out.room = await (await env.MATCH.get(env.MATCH.idFromName(m)).fetch('https://do/stats')).json();
        return J(out, 200, cors);
      }
      if (P === '/adsgram/reward' && req.method === 'GET') { /* server-to-server postback from AdsGram (no Origin header): records "this Telegram user finished a reward ad". Clients can never create this record. */
        const uid = url.searchParams.get('userid') || '', kk = url.searchParams.get('k') || '';
        if (!env.ADSGRAM_SECRET) { console.log('adr_reject: ADSGRAM_SECRET is not set on the Worker'); return J({ e: 'secret_not_set' }, 503); } /* tells YOU the secret is missing; reveals nothing about its value */
        if (!teq(kk, env.ADSGRAM_SECRET)) { console.log('adr_reject: wrong or missing k'); return new Response(null, { status: 404 }); }
        if (!/^[0-9]{1,15}$/.test(uid)) { console.log('adr_reject: userid is not a number'); return J({ e: 'bad' }, 400); }
        const kind = url.searchParams.get('b') || 'daily'; /* which AdsGram block was watched: daily | x2 | gem (no b = the old daily URL) */
        if (kind !== 'daily' && kind !== 'x2' && kind !== 'gem' && kind !== 'pf' && kind !== 'pp') { console.log('adr_reject: unknown b=' + kind.slice(0, 12)); return J({ e: 'bad' }, 400); }
        if (!(await rl(env, 'adr:' + uid, 10))) return J({ e: 'slow' }, 429);
        const r = await sb(env, 'rpc/add_ad_credit', { method: 'POST', body: JSON.stringify({ p: { tid: Number(uid), kind } }) });
        if (!r.ok) { console.log('adr_db', r.status); return J({ e: 'err' }, 502); }
        const j = await r.json(); console.log('adr', kind, j && j.ok ? 'credit_created' : 'no_credit:' + (j && j.e)); /* the answer now says what REALLY happened: ok only if a credit exists */
        return J(j && j.ok ? { ok: 1, b: kind } : { ok: 0, e: (j && j.e) || 'err' });
      }
      if (P === '/tg/webhook' && req.method === 'POST') return tgHook(req, env); /* Telegram bot webhook, authenticated by the secret-token header */
      if (P === '/admin/ui' && req.method === 'GET') return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" } });
      if (P === '/admin/pay' || P === '/admin/refund' || P === '/admin/wd' || ADMIN_X.has(P)) return admPay(req, env, url, ip, P);
      if (P === '/xrocket/webhook' && req.method === 'POST') return xrHook(req, env, ip); /* server-to-server, no Origin header, authenticated by HMAC signature */
      if (!okOrigin) return new Response(null, { status: 403 });

      if (P === '/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
        const t = await rdTok(env, 'J1.', url.searchParams.get('t'));
        if (!t || !/^[pg]:[0-9a-f-]{8,36}$/.test(t.u) || !(t.pid === null || UUID.test(t.pid)) || !UUID.test(t.m) || !K.TEAM[t.md] || !/^([A-Z2-9]{6})?$/.test(t.pt) || !/^[a-f0-9]{16}$/.test(t.n) || !/^[a-z0-9_,]{0,220}$/.test(t.cs || '') || !/^[\p{L}\p{N} _-]{0,24}$/u.test(t.nm || '') || (t.pm !== undefined && t.pm !== 0 && t.pm !== 1) || (t.wp !== undefined && WPN_IDX[t.wp] === undefined) || (t.sk !== undefined && !parseSk(t.sk))) return new Response(null, { status: 401 });
        const ipc = (await sign(env.JOIN_SECRET, 'ip|' + ip + '|' + t.m)).slice(0, 10); // salted per match: same-network detection inside one match, no raw IP stored anywhere
        const r2 = new Request(req);
        for (const [k, v] of [['x-u', t.u], ['x-pid', t.pid || ''], ['x-m', t.m], ['x-md', t.md], ['x-pt', t.pt], ['x-nonce', t.n], ['x-exp', String(t.exp)], ['x-ipc', ipc], ['x-cs', t.cs || ''], ['x-nm', encodeURIComponent(t.nm || '')], ['x-pm', t.pm ? '1' : ''], ['x-wp', t.wp || 'ar01'], ['x-sk', t.sk || ',,,']]) r2.headers.set(k, v);
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
          return J({ s: await mkTok(env, 'S1.', { u: 'p:' + row.id, pid: row.id, tid: tg.id, exp: Date.now() + K.SESSION_MS }), lvl: row.level, xp: row.total_xp, soft: row.soft_currency, gems: row.premium_currency }, 200, cors);
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
      if (P === '/season' || P === '/season/claim') { // free track works now; the premium track is locked until a payment method exists
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/season' && req.method === 'GET') {
          const nowIso = encodeURIComponent(new Date().toISOString());
          const sr = await sb(env, 'seasons?select=id,name,ends_at,xp_per_tier,tiers&starts_at=lte.' + nowIso + '&ends_at=gte.' + nowIso + '&order=id.desc&limit=1'); const se = sr.ok ? (await sr.json())[0] : null;
          if (!sr.ok) return J({ e: 'err' }, 502, cors); if (!se) return J({ season: null }, 200, cors);
          if (!Number.isInteger(se.id)) return J({ e: 'err' }, 502, cors);
          let rew = await env.RL.get('rbr:rew:' + se.id);
          if (!rew) { const r = await sb(env, 'season_rewards?season_id=eq.' + se.id + '&select=tier,track,rtype,rsoft,rcos&order=tier.asc'); if (!r.ok) return J({ e: 'err' }, 502, cors); rew = JSON.stringify(await r.json()); await env.RL.put('rbr:rew:' + se.id, rew, { expirationTtl: 300 }); }
          const [pr, cl] = await Promise.all([sb(env, 'season_progress?season_id=eq.' + se.id + '&player_id=eq.' + ses.pid + '&select=xp,premium'), sb(env, 'season_claims?season_id=eq.' + se.id + '&player_id=eq.' + ses.pid + '&select=tier,track')]);
          if (!pr.ok || !cl.ok) return J({ e: 'err' }, 502, cors); const prog = (await pr.json())[0] || { xp: 0, premium: false };
          return J({ season: se, xp: prog.xp, premium: prog.premium, rewards: JSON.parse(rew), claimed: await cl.json() }, 200, cors);
        }
        if (P !== '/season/claim' || req.method !== 'POST') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'tier' && k !== 'track') || !Number.isInteger(b.tier) || b.tier < 1 || b.tier > 100 || (b.track !== 'free' && b.track !== 'premium')) return J({ e: 'bad' }, 400, cors);
        const r = await sb(env, 'rpc/claim_season_tier', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid, tier: b.tier, track: b.track } }) });
        if (!r.ok) { console.log('season_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json(); if (j.ok) return J(j, 200, cors);
        return J({ e: j.e || 'err' }, j.e === 'dup' || j.e === 'locked' || j.e === 'premium' ? 409 : 404, cors);
      }
      if (P === '/daily' || P === '/daily/claim') { /* DAILY CHECK: 100 coins a day, 400 on day 7; each claim needs a fresh server-verified AdsGram ad */
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/daily' && req.method === 'GET') {
          const r = await sb(env, 'rpc/get_daily', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) });
          if (!r.ok) { console.log('daily_db', r.status); return J({ e: 'err' }, 502, cors); }
          const j = await r.json(); return j && j.ok ? J(j, 200, cors) : J({ e: 'err' }, 404, cors);
        }
        if (P !== '/daily/claim' || req.method !== 'POST') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || Object.keys(b).length) return J({ e: 'bad' }, 400, cors);
        if (!Number.isSafeInteger(ses.tid)) return J({ e: 'auth' }, 401, cors);
        const r = await sb(env, 'rpc/claim_daily', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid, tid: ses.tid } }) });
        if (!r.ok) { console.log('daily_claim_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json(); if (j.ok) return J(j, 200, cors);
        return J({ e: j.e || 'err' }, j.e === 'dup' || j.e === 'noad' ? 409 : 404, cors);
      }
      if (P === '/ranked' || P === '/sp/gems' || P === '/sp/withdraw') { /* season rank + season points store (no money moves here: withdrawals are only REQUESTS reviewed by the owner) */
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/ranked' && req.method === 'GET') {
          const r = await sb(env, 'rpc/get_ranked', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) });
          if (!r.ok) { console.log('ranked_db', r.status); return J({ e: 'err' }, 502, cors); }
          const j = await r.json(); if (!j || !j.ok) return J({ e: 'err' }, 404, cors);
          const tot = async (sid) => { /* total Season Points of ALL players for a season, cached 60 s (one DB read per minute, not one per player) */
            if (!Number.isInteger(sid)) return null; const k = 'rbr:sptot:' + sid; let v = await env.RL.get(k);
            if (v === null) { const q = await sb(env, 'rpc/sp_total', { method: 'POST', body: JSON.stringify({ p: { sid } }) }); if (!q.ok) return null; const qj = await q.json(); v = JSON.stringify({ t: Number(qj && qj.total) || 0, n: Number(qj && qj.players) || 0 }); await env.RL.put(k, v, { expirationTtl: 60 }); }
            try { return JSON.parse(v); } catch { return null; }
          };
          const cur = await tot(j.season && j.season.id); if (cur) { j.total_sp = cur.t; j.sp_players = cur.n; }
          if (j.store && Number.isInteger(j.store.season)) { const st = await tot(j.store.season); if (st) j.store.total = st.t; }
          j.now = Date.now(); return J(j, 200, cors);
        }
        if (req.method !== 'POST' || P === '/ranked') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'sp' && !(k === 'addr' && P === '/sp/withdraw')) || !Number.isInteger(b.sp) || b.sp < 1 || b.sp > 10000000) return J({ e: 'bad' }, 400, cors);
        let ak = null; if (P === '/sp/withdraw') { ak = tonAddr(typeof b.addr === 'string' ? b.addr.trim() : '', isTestnet(env)); if (!ak) return J({ e: 'addr' }, 400, cors); b.addr = b.addr.trim(); } /* strict: wrong checksum / network / format never reaches the database */
        const r = await sb(env, 'rpc/' + (P === '/sp/gems' ? 'sp_buy_gems' : 'sp_withdraw'), { method: 'POST', body: JSON.stringify({ p: P === '/sp/gems' ? { pid: ses.pid, sp: b.sp } : { pid: ses.pid, sp: b.sp, addr: b.addr, key: ak.key } }) });
        if (!r.ok) { console.log('sp_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json();
        if (j.ok) {
          if (P === '/sp/withdraw') console.log('withdrawal_request', j.wid); /* nothing is paid here: the owner reviews it in /admin/ui and pays by hand */
          return J(j, 200, cors);
        }
        return J({ e: j.e || 'err' }, j.e === 'bad' || j.e === 'addr' ? 400 : j.e === 'player' ? 404 : 409, cors);
      }
      if (P === '/gemad' || P === '/gemad/claim' || P === '/match/double') { /* free-gem ad in the shop (1 GEM, 5/day, 5 min cooldown) and DOUBLE COINS after a match: both need a server-verified AdsGram credit of their own kind */
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/gemad' && req.method === 'GET') {
          const r = await sb(env, 'rpc/get_gemad', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) });
          if (!r.ok) { console.log('gemad_db', r.status); return J({ e: 'err' }, 502, cors); }
          const j = await r.json(); return j && j.ok ? J(j, 200, cors) : J({ e: 'err' }, 404, cors);
        }
        if (req.method !== 'POST' || P === '/gemad') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || !Number.isSafeInteger(ses.tid)) return J({ e: Number.isSafeInteger(ses.tid) ? 'bad' : 'auth' }, Number.isSafeInteger(ses.tid) ? 400 : 401, cors);
        let call;
        if (P === '/gemad/claim') { if (Object.keys(b).length) return J({ e: 'bad' }, 400, cors); call = ['claim_gem_ad', { pid: ses.pid, tid: ses.tid }]; }
        else { if (Object.keys(b).some((k) => k !== 'm') || typeof b.m !== 'string' || !UUID.test(b.m)) return J({ e: 'bad' }, 400, cors); call = ['double_match', { pid: ses.pid, tid: ses.tid, m: b.m }]; }
        const r = await sb(env, 'rpc/' + call[0], { method: 'POST', body: JSON.stringify({ p: call[1] }) });
        if (!r.ok) { console.log('ad_claim_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json(); if (j.ok) return J(j, 200, cors);
        return J(j.e === 'cool' ? { e: 'cool', wait: j.wait | 0 } : { e: j.e || 'err' }, j.e === 'bad' ? 400 : j.e === 'player' ? 404 : 409, cors);
      }
      if (P === '/resume' && req.method === 'GET') { // returning after a page reload: is the player still inside a live match?
        if (!(await rl(env, 'stats:' + ses.u, K.RL.stats))) return J({ e: 'slow' }, 429, cors);
        const [st, j] = await mmCall(env, '/active', { u: ses.u }); if (st !== 200 || !j.m || !UUID.test(j.m) || !K.TEAM[j.md]) return J({ r: 0 }, 200, cors);
        let r = 0; try { const x = await (await env.MATCH.get(env.MATCH.idFromName(j.m)).fetch('https://do/has?u=' + encodeURIComponent(ses.u))).json(); r = x && x.r ? 1 : 0; } catch (e) { console.log('resume_err'); }
        return J({ r, md: j.md }, 200, cors);
      }
      if (P === '/invite' && req.method === 'GET') { // bot username for the share link, cached 24 h (the token never leaves the Worker and is never logged)
        if (!(await rl(env, 'stats:' + ses.u, K.RL.stats))) return J({ e: 'slow' }, 429, cors);
        let un = await env.RL.get('rbr:botun');
        if (!un) { try { const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/getMe'), j = r.ok ? await r.json() : null, n = j && j.result && j.result.username; if (typeof n === 'string' && /^[A-Za-z0-9_]{4,32}$/.test(n)) { un = n; await env.RL.put('rbr:botun', un, { expirationTtl: 86400 }); } } catch (e) { console.log('invite_err'); } }
        return J({ u: un || null }, 200, cors);
      }
      if (P === '/profile' || P === '/leaderboard') { // read-only screens
        if (req.method !== 'GET') return new Response(null, { status: 405 });
        if (!(await rl(env, 'stats:' + ses.u, K.RL.stats))) return J({ e: 'slow' }, 429, cors);
        if (P === '/leaderboard') { // top 50 by total XP, cached 2 min in KV (one DB read per 2 min no matter how many players ask)
          let lb = await env.RL.get('rbr:lb2');
          if (!lb) { const r = await sb(env, 'rpc/get_top', { method: 'POST', body: JSON.stringify({ p: {} }) }); if (!r.ok) return J({ e: 'err' }, 502, cors); const j = await r.json(); lb = JSON.stringify(Array.isArray(j) ? j.map((x) => [String(x[0]).slice(0, 24), Number(x[1]) || 0]) : []); await env.RL.put('rbr:lb2', lb, { expirationTtl: 120 }); }
          return J({ top: JSON.parse(lb) }, 200, cors);
        }
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        const r = await sb(env, 'rpc/get_profile', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) });
        if (!r.ok) { console.log('profile_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json(); return j && j.ok ? J(j, 200, cors) : J({ e: 'err' }, 404, cors);
      }
      if (P === '/pass' || P === '/pass/claim' || P === '/pass/buy' || P === '/box/open') return passApi(env, ses, req, P, cors);
      if (P === '/skills' || P === '/skills/equip') { /* SKILLS vault: one skill per category, up to 4; used from the NEXT match */
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/skills' && req.method === 'GET') {
          let cur = ['', '', '', '']; const r = await sb(env, 'players?id=eq.' + ses.pid + '&select=skills'); if (r.ok) { const row = (await r.json())[0]; const a = row && parseSk(row.skills); if (a) cur = a; }
          return J({ cur, list: SKCAT.flatMap((cat, i) => cat.map((code) => skRow(code, i))) }, 200, cors);
        }
        if (req.method !== 'POST' || P === '/skills') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'sel') || !Array.isArray(b.sel) || b.sel.length !== 4 || b.sel.some((x) => typeof x !== 'string')) return J({ e: 'bad' }, 400, cors);
        const s = b.sel.join(','); if (!parseSk(s)) return J({ e: 'bad' }, 400, cors);
        const r = await sb(env, 'players?id=eq.' + ses.pid, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ skills: s }) });
        if (!r.ok) { console.log('skills_db', r.status); return J({ e: 'err' }, 502, cors); }
        return J({ ok: 1, cur: b.sel }, 200, cors);
      }
      if (P === '/guns' || P === '/gun/equip') { /* GUNS vault: pick one of the free weapons; it is used from the NEXT match */
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/guns' && req.method === 'GET') {
          let cur = 'ar01'; const r = await sb(env, 'players?id=eq.' + ses.pid + '&select=weapon'); if (r.ok) { const row = (await r.json())[0]; if (row && typeof row.weapon === 'string' && WPN_IDX[row.weapon] !== undefined) cur = row.weapon; }
          return J({ cur, list: WPN.map(wpnRow) }, 200, cors);
        }
        if (req.method !== 'POST' || P === '/guns') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'id') || typeof b.id !== 'string' || WPN_IDX[b.id] === undefined) return J({ e: 'bad' }, 400, cors);
        const r = await sb(env, 'players?id=eq.' + ses.pid, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ weapon: b.id }) });
        if (!r.ok) { console.log('gun_db', r.status); return J({ e: 'err' }, 502, cors); }
        return J({ ok: 1, id: b.id }, 200, cors);
      }
      if (P === '/payments' && req.method === 'GET') {
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        return myPayments(env, ses, cors);
      }
      if (P === '/shop' || P === '/shop/buy' || P === '/shop/equip' || P === '/vault' || P === '/royale') { /* GEM shop, vault (owned colours), lucky royale. Cosmetics only: no stat advantages are for sale. */
        if (!(await rl(env, 'shop:' + ses.u, K.RL.shop))) return J({ e: 'slow' }, 429, cors);
        if (!ses.pid) return J({ e: 'guest' }, 403, cors);
        if (P === '/shop' && req.method === 'GET') return J({ packs: packsOf(env), test: String(env.XROCKET_BASE || '').includes('testnet') ? 1 : 0, xr: env.XROCKET_BUY === '0' ? 0 : 1, stars: env.TG_WEBHOOK_SECRET ? STAR_PRICES.slice(0, packsOf(env).length) : 0 }, 200, cors);
        if (P === '/vault' && req.method === 'GET') {
          const r = await sb(env, 'players?id=eq.' + ses.pid + '&select=soft_currency,premium_currency,player_cosmetics(cosmetic_id,equipped)'); const row = r.ok ? (await r.json())[0] : null;
          if (!row) return J({ e: 'err' }, 502, cors);
          return J({ soft: row.soft_currency, gems: row.premium_currency, own: row.player_cosmetics }, 200, cors);
        }
        if (P === '/royale' && req.method === 'GET') {
          const r = await sb(env, 'rpc/get_royale', { method: 'POST', body: JSON.stringify({ p: { pid: ses.pid } }) });
          if (!r.ok) { console.log('royale_db', r.status); return J({ e: 'err' }, 502, cors); }
          const j = await r.json(); return j && j.ok ? J(j, 200, cors) : J({ e: 'err' }, 404, cors);
        }
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        let b; try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); }
        if (!b || typeof b !== 'object') return J({ e: 'bad' }, 400, cors);
        let call;
        if (P === '/shop/buy') {
          if (Object.keys(b).some((k) => k !== 'pack' && k !== 'method') || (b.method !== undefined && b.method !== 'stars' && b.method !== 'xrocket') || !Number.isInteger(b.pack) || b.pack < 0 || b.pack >= packsOf(env).length) return J({ e: 'bad' }, 400, cors);
          if (b.method === 'stars') return await buyStars(env, ses, b.pack, cors);
          if (env.XROCKET_BUY === '0') return J({ e: 'pay' }, 403, cors);
          return await buyGems(env, ses, b.pack, cors); /* creates an xRocket invoice; gems arrive only through the signed webhook */
        } else if (P === '/royale') {
          if (Object.keys(b).some((k) => k !== 'kind' && k !== 'mode') || (b.kind !== 'free' && b.kind !== 'pro' && b.kind !== 'flag') || (b.mode !== 'one' && b.mode !== 'ten')) return J({ e: 'bad' }, 400, cors);
          call = ['spin_royale', { pid: ses.pid, kind: b.kind, mode: b.mode }];
        } else {
          if (Object.keys(b).some((k) => k !== 'id' && k !== 'type') || !(b.id === null || (typeof b.id === 'string' && COS_ID.test(b.id))) || (b.id === null && !['hull', 'cannon', 'track', 'detail', 'glow', 'bullet', 'trail', 'blast', 'smoke', 'flag'].includes(b.type))) return J({ e: 'bad' }, 400, cors);
          call = ['equip_cosmetic', { pid: ses.pid, cid: b.id, type: b.type || null }];
        }
        const r = await sb(env, 'rpc/' + call[0], { method: 'POST', body: JSON.stringify({ p: call[1] }) });
        if (!r.ok) { console.log('shop_db', r.status); return J({ e: 'err' }, 502, cors); }
        const j = await r.json();
        if (j.ok) return J(j, 200, cors);
        return J({ e: j.e || 'err' }, j.e === 'funds' ? 409 : j.e === 'bad' ? 400 : 404, cors);
      }
      if (P.startsWith('/party/') || P === '/leave' || P === '/join') {
        if (!(await rl(env, (P === '/join' ? 'join:' : 'party:') + ip, P === '/join' ? K.RL.join : K.RL.party))) return J({ e: 'slow' }, 429, cors);
        let b = {}; if (req.method === 'POST') { try { b = await req.json(); } catch { return J({ e: 'bad' }, 400, cors); } }
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'mode' && k !== 'code' && !(k === 'cap' && env.LOADTEST === '1'))) return J({ e: 'bad' }, 400, cors); /* cap = players per match, accepted ONLY while the temporary LOADTEST variable is set */
        if (P === '/join') {
          if (!K.TEAM[b.mode] || typeof b.mode !== 'string') return J({ e: 'bad' }, 400, cors);
          let cs = '', nm = '', pm = 0, wp = 'ar01', sk = ',,,';
          if (ses.pid) { const q = (cols) => sb(env, 'players?id=eq.' + ses.pid + '&select=' + cols + 'player_cosmetics(cosmetic_id),pass_progress(premium)&player_cosmetics.equipped=eq.true&pass_progress.month=eq.' + passMonth()); let r = await q('name,banned,weapon,skills,'); if (!r.ok) r = await q('name,banned,weapon,'); if (!r.ok) r = await q('name,banned,'); /* the weapon column may not exist yet: join without it instead of failing */ const row = r.ok ? (await r.json())[0] : null; if (!row) return J({ e: 'err' }, 503, cors); if (row.banned) return J({ e: 'banned' }, 403, cors); cs = pickCos(row.player_cosmetics); nm = String(row.name || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 24); pm = Array.isArray(row.pass_progress) && row.pass_progress.some((x) => x && x.premium === true) ? 1 : 0; if (typeof row.weapon === 'string' && WPN_IDX[row.weapon] !== undefined) wp = row.weapon; if (parseSk(row.skills)) sk = row.skills; } // fail closed
          const [st, j] = await mmCall(env, '/join', { u: ses.u, md: b.mode, cap: env.LOADTEST === '1' && Number.isInteger(b.cap) ? b.cap : 0 });
          if (st !== 200) return J({ e: j.e || 'err' }, st, cors);
          const t = await mkTok(env, 'J1.', { u: ses.u, pid: ses.pid, m: j.m, md: j.md, pt: j.pt, cs, nm, pm, wp, sk, exp: Date.now() + K.JOIN_MS, n: hex(8) });
          return J({ t, md: j.md, m: j.m }, 200, cors);
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
  slot(md, n, now, cap) {
    let o = this.open[md];
    if (!o || o.n + n > (cap || C.MAX_PLAYERS) || now - o.since > K.OPEN_MS) o = this.open[md] = { m: crypto.randomUUID(), since: now, n: 0 };
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
    if (P === '/out') { /* a team was eliminated: release its humans so they can queue again (and never re-enter their own corpse) */
      if (!UUID.test(b.m) || !Array.isArray(b.us) || b.us.length > 8) return J({ e: 'bad' }, 400);
      for (const x of b.us) { const e = this.um.get(x); if (e && e.m === b.m) this.um.delete(x); }
      for (const p of this.parties.values()) if (p.match && p.match.m === b.m && ![...p.members].some((x) => { const e = this.um.get(x); return e && e.m === b.m; })) delete p.match;
      return J({ ok: 1 });
    }
    const u = typeof b.u === 'string' && /^[pg]:[0-9a-f-]{8,36}$/.test(b.u) ? b.u : null; if (!u) return J({ e: 'bad' }, 400);
    if (P === '/busy') { /* the room refused this user (match already started): forget the assignment so the next /join picks a fresh match */
      const e = this.um.get(u);
      if (e && e.m === b.m) { this.um.delete(u); const pc = this.up.get(u), pp = pc && this.parties.get(pc); if (pp && pp.match && pp.match.m === b.m && pp.leader === u) delete pp.match; }
      return J({ ok: 1 });
    }
    if (P === '/active') { const e = this.um.get(u); return J(e ? { m: e.m, md: e.md } : { m: null }); }
    const lk = P + u; if (now - (this.last.get(lk) || 0) < (P === '/join' ? 1500 : 800)) return J({ e: 'slow' }, 429); this.last.set(lk, now);
    const code = this.up.get(u), pa = code && this.parties.get(code);
    if (P === '/join') {
      const md = b.md, cur = this.um.get(u), cap = (b.cap | 0) > 0 ? Math.min(b.cap | 0, C.MAX_PLAYERS) : 0;
      if (!K.TEAM[md]) return J({ e: 'bad' }, 400);
      if (cur) return J({ m: cur.m, md: cur.md, pt: cur.pt }); // one active match per user: re-issue a token for the same match
      if (pa) {
        if (!pa.match) {
          if (pa.leader !== u) return J({ e: 'leader' }, 409);
          pa.match = { m: this.slot(md, pa.members.size, now, cap), md };
        }
        this.um.set(u, { m: pa.match.m, md: pa.match.md, pt: code, t: now });
        return J({ m: pa.match.m, md: pa.match.md, pt: code });
      }
      const m = this.slot(md, 1, now, cap); this.um.set(u, { m, md, pt: '', t: now }); return J({ m, md, pt: '' });
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
    this.players = new Map(); this.byGid = new Map(); this.bullets = []; this.born = []; this.zones = []; this.covers = []; this.nextC = 1; this.nextId = 1; this.nextB = 1000;
    this.tickN = 0; this.lobbyAt = 0; this.startAt = 0; this.endAt = 0; this.emptyAt = 0;
    this.susp = []; this.sockMs = 0; this.msgsMatch = 0; this.lastZone = null; this.lastLobbyMsg = 0;
    this.lastPh = 0; this.lastTk = 0; this.lastZp = 0; this.pAw = 0; this.ranked = false; this.full = false; this.outAt = 0; this.th = 1; this.tl = []; this.teams = 0; this.lastNear = 0; this.near = new Map(); this.rosterMsg = null; this.lagN = 0; this.lagSum = 0; this.lagMax = 0; this.late = 0; this.bytesOut = 0; this.rm = []; this.genMap(); this.genZone(); this.genLoot();
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

  name() { const N = ['Shadow', 'Falcon', 'Zeus', 'Viper', 'Nova', 'Ghost', 'Titan', 'Blaze', 'Storm', 'Raven', 'Phoenix', 'Wolf', 'Ace', 'Rex', 'Orion', 'Hunter', 'Jet', 'Sniper', 'Cobra', 'Tiger', 'Atlas', 'Drift', 'Echo', 'Fury', 'Hawk', 'Ninja', 'Pixel', 'Rogue', 'Spark', 'Turbo']; return N[Math.floor(Math.random() * N.length)] + (Math.random() < 0.6 ? Math.floor(Math.random() * 99) : ''); }

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
    const p = { id: this.nextId++, name: this.name(), bot, gid, ws, x, y, mx: 0, my: 0, aim: 0, fire: 0, cd: 0, hp: C.HP, alive: true, kills: 0, dmg: 0, place: 0, dcAt: 0, seq: 0, ack: 0, known: new Map(), strikes: 0, win: 0, cnt: 0, tx: 0, ty: 0, lx: x, ly: y, thinkAt: 0, killer: 0, auto: 0, maim: 0, mfire: 0, noise: 0, noiseAt: 0, dl: [], w: 0, wr: 0, burstLeft: 0, burstAt: 0, sk: ['', '', '', ''], skt: [0, 0, 0, 0], skAct: [0, 0, 0, 0], sks: null, heal: 0, spd: null, scanUntil: 0, radarUntil: 0, lootUntil: 0, silentUntil: 0, xp: 0, lvl: 1, lq: 0, pend: null, b: [0, 0, 0, 0, 0, 0, 0, 0], maxHp: C.HP, shield: 0, maxSh: C.SHIELD_BASE, hitAt: 0, shots: 0, hits: 0, snaps: 0, lastIn: 0, dcOut: 0, ipc: '', cs: {}, skill: 0.6 + Math.random() * 0.4, aggr: Math.random(), tgt: 0, tgtAt: 0, side: 1, sideAt: 0, idleUntil: 0, ssd: 1, forceRoam: 0, skip: 0, skipUntil: 0, stuckN: 0, want: 0, cur: 0, chkAt: 0, cx: 0, cy: 0, pid: null, party: '', team: 0, assists: 0, dieAt: 0, zs: 0, ksc: 0, asc: 0, ps: 0, dmgS: 0, hk: 0, dmgHum: 0, hplace: 0, f: null };
    this.players.set(p.id, p); return p;
  }

  genLoot() { // server-only loot: 0 scrap,1 part,2 chip,3 small shield,4 large shield,5 repair,6 crate
    this.loot = new Map(); this.lg = new Map(); this.nextL = 10000000; const R = this.R;
    const roll = () => { const r = R(); return r < 0.4 ? 0 : r < 0.64 ? 1 : r < 0.72 ? 2 : r < 0.8 ? 3 : r < 0.84 ? 4 : r < 0.89 ? 5 : r < 0.94 ? 6 : 0; }; /* weapons are chosen in the lobby now: the old weapon loot became scrap */
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
  hurt(e, dm, by, now) { if (now < this.startAt + C.GRACE_MS) return; let d = dm; if (e.sks && now < e.sks.until && e.sks.hp > 0) { const a = Math.min(e.sks.hp, d); e.sks.hp -= a; d -= a; } if (e.shield > 0) { const a = Math.min(e.shield, d); e.shield -= a; d -= a; } e.hp -= d; e.hitAt = now; if (by) { e.dl = e.dl.filter((x) => now - x.t <= 5000); e.dl.push({ by, t: now, d: dm }); const at = this.players.get(by); if (at) { if (!at.dmgTo) at.dmgTo = new Map(); at.dmgTo.set(e.id, (at.dmgTo.get(e.id) || 0) + dm); } } if (e.hp <= 0 && !e.killer) e.killer = by; }
  addXp(p, n) {
    if (p.bot || n <= 0) return; p.xp += n | 0;
    while (p.lvl < 10 && p.xp >= C.XP_LV[p.lvl]) { p.lvl++; p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2); p.lq++; }
    if (!p.pend && p.lq > 0) this.offer(p);
  }
  offer(p) { // server generates 3 random boosts (stack cap 3), server validates the pick
    const ok = []; for (const i of [1, 2, 4, 5, 6, 7]) if (p.b[i] < 3) ok.push(i); /* ids 0 (damage) and 3 (fire rate) are not offered any more */
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
  shoot(p, man) { /* one trigger pull (or one burst bullet): n pellets spread around the aim */
    const W0 = WPN[p.w]; p.lastShot = Date.now();
    for (let n = 0; n < W0.n; n++) {
      const r = (p.aim + (W0.n > 1 ? (n - (W0.n - 1) / 2) * W0.spr : 0)) * 0.0174533, c = Math.cos(r), s = Math.sin(r);
      this.bullets.push({ id: this.nextB++, blt: 1, o: p.id, tm: p.team, man: man ? 1 : 0, x: p.x + c * 30, y: p.y + s * 30, vx: c * W0.sp, vy: s * W0.sp, sp: W0.sp, dm: W0.dmg, dist: 0, rg: Math.min(C.MAX_RANGE, W0.rg * (1 + 0.12 * p.b[5])) });
      const nb = this.bullets[this.bullets.length - 1]; nb.sx = nb.x; nb.sy = nb.y; this.born.push(nb); /* remembered until the next snapshot so even a bullet that dies within 100 ms is still shown to the clients */
    }
  }
  inSlow(p, now) { for (const z of this.zones) if (z.k === 1 && now < z.until && z.team !== p.team && Math.hypot(p.x - z.x, p.y - z.y) < z.r) return true; return false; }
  spdMul(p, now) { if (this.zones.length && this.inSlow(p, now)) return SK_C.SLOW; /* inside an enemy Slow Field Sprint/Boost are cancelled: only the slow applies */ let m = 1; if (p.spd && now < p.spd.until) m *= p.spd.mul; return m; }
  faceOf(p, now) { /* the direction the player SEES his tank facing: the aim while aiming/firing, otherwise the way he moves (or last moved) - same rule as the client turret */
    const m = Math.hypot(p.mx, p.my); if (p.fire || now - (p.aimAt || 0) < 700 || now - (p.lastShot || 0) < 700 || (m === 0 && p.hd === undefined)) return p.aim * 0.0174533;
    return m > 0 ? Math.atan2(p.my, p.mx) : p.hd;
  }
  smokeHides(e, v, now) { /* an enemy standing in a smoke cloud is invisible from outside; from inside you only see 160 units */
    if (e.team === v.team) return false;
    for (const z of this.zones) if (z.k === 0 && now < z.until) { const ein = Math.hypot(e.x - z.x, e.y - z.y) < z.r, vin = Math.hypot(v.x - z.x, v.y - z.y) < z.r; if (ein && !vin) return true; if (vin && !ein && Math.hypot(e.x - v.x, e.y - v.y) > 160) return true; }
    return false;
  }
  addCol(b) { for (let cx = cell(b.x); cx <= cell(b.x + b.w); cx++) for (let cy = cell(b.y); cy <= cell(b.y + b.h); cy++) { const k = cx * 100 + cy, a = this.cg.get(k); if (a) a.push(b); else this.cg.set(k, [b]); } }
  delCol(b) { for (let cx = cell(b.x); cx <= cell(b.x + b.w); cx++) for (let cy = cell(b.y); cy <= cell(b.y + b.h); cy++) { const a = this.cg.get(cx * 100 + cy); if (a) { const i = a.indexOf(b); if (i >= 0) a.splice(i, 1); } } }
  addCover(p, now, c, s) { /* a temporary wall in front of the player; it blocks tanks AND bullets (it joins the collision grid) */
    const cx = p.x + c * SK_C.COVER_AHEAD, cy = p.y + s * SK_C.COVER_AHEAD, horiz = Math.abs(s) > Math.abs(c);
    const ww = horiz ? SK_C.COVER_LONG : SK_C.COVER_THICK, hh = horiz ? SK_C.COVER_THICK : SK_C.COVER_LONG, x = cx - ww / 2, y = cy - hh / 2;
    if (x < 0 || y < 0 || x + ww > C.WORLD || y + hh > C.WORLD) return false;
    for (const o of this.players.values()) if (o.alive && circRect({ x, y, w: ww, h: hh }, o.x, o.y, C.R + 4)) return false; /* never trap a tank inside it */
    const b = { x, y, w: ww, h: hh, walls: [{ x, y, w: ww, h: hh }], tmp: 1, id: this.nextC++, until: now + SK.cv.d * 1000 };
    this.addCol(b); this.covers.push(b); return true;
  }
  useSkill(p, slot, now) { /* server-authoritative: alive, running match, equipped, off cooldown */
    if (!p.alive || this.state !== 'running' || !Number.isInteger(slot) || slot < 0 || slot > 3) return false;
    const code = p.sk[slot], S = SK[code]; if (!S || now < p.skt[slot]) return false;
    const fr = this.faceOf(p, now), c = Math.cos(fr), s = Math.sin(fr);
    if ((code === 'sp' || code === 'vb' || code === 'ds') && this.inSlow(p, now)) return false; /* movement skills cannot be used inside an enemy Slow Field */
    switch (code) {
      case 'sh': p.sks = { hp: SK_C.SHIELD_HP, until: now + S.d * 1000 }; break;
      case 'cv': if (!this.addCover(p, now, c, s)) return false; break;
      case 'rc': p.heal += SK_C.HEAL; break;
      case 'ds': { const m = Math.hypot(p.mx, p.my), ux = m > 0 ? p.mx / m : c, uy = m > 0 ? p.my / m : s; p.dsh = { ux, uy, left: SK_C.DASH, sp: SK_C.DASH / SK_C.DASH_T }; break; } /* a fast visible glide (0.2 s), not a teleport */
      case 'sp': p.spd = { mul: SK_C.SPRINT, until: now + S.d * 1000 }; break;
      case 'vb': p.spd = { mul: SK_C.BOOST, until: now + S.d * 1000 }; break;
      case 'sc': p.scanUntil = now + S.d * 1000; break;
      case 'rd': p.radarUntil = now + S.d * 1000; break;
      case 'ls': p.lootUntil = now + S.d * 1000; break;
      case 'sm': this.zones.push({ k: 0, x: p.x + c * SK_C.SMOKE_AHEAD, y: p.y + s * SK_C.SMOKE_AHEAD, r: SK_C.SMOKE_R, until: now + S.d * 1000, team: p.team }); break;
      case 'sf': this.zones.push({ k: 1, x: p.x, y: p.y, r: SK_C.SLOW_R, until: now + S.d * 1000, team: p.team }); break;
      case 'ss': p.silentUntil = now + S.d * 1000; break;
      default: return false;
    }
    p.skt[slot] = now + S.cd * 1000; p.skAct[slot] = S.d ? now + S.d * 1000 : 0; return true;
  }
  skillExtra(h, f, now, x0, x1, y0, y1) { /* [cooldown s per slot (-1 = empty), active s per slot, scanner [[x,y]] | null, radar angle | -1, loot scan [[type,x,y]] | null, zones in view, covers in view] */
    const cd = h.sk.map((cc, i) => (cc ? Math.max(0, Math.ceil((h.skt[i] - now) / 1000)) : -1)), act = h.sk.map((cc, i) => (cc ? Math.max(0, Math.ceil((h.skAct[i] - now) / 1000)) : 0));
    let sc = null, rd = -1, ls = null;
    if (h.alive) {
      if (now < h.scanUntil) { sc = []; for (const o of this.players.values()) if (o.alive && o.team !== h.team && !(o.silentUntil > now) && sc.length < 14 && Math.hypot(o.x - h.x, o.y - h.y) < SK_C.SCAN_R) sc.push([o.x | 0, o.y | 0]); }
      if (now < h.radarUntil) { let best = SK_C.RADAR_R, tg = null; for (const o of this.players.values()) if (o.alive && o.team !== h.team && !(o.silentUntil > now)) { const d = Math.hypot(o.x - h.x, o.y - h.y); if (d < best) { best = d; tg = o; } } if (tg) rd = nrm(Math.atan2(tg.y - h.y, tg.x - h.x) * 57.2958); }
      if (now < h.lootUntil) { ls = []; for (const it of this.loot.values()) if (!it.gone && (it.t === 2 || it.t === 4 || it.t === 5 || it.t === 6) && ls.length < 16 && Math.hypot(it.x - h.x, it.y - h.y) < SK_C.LOOT_R) ls.push([it.t, it.x | 0, it.y | 0]); }
    }
    const zn = [], cv = [];
    for (const z of this.zones) if (z.x > x0 - z.r && z.x < x1 + z.r && z.y > y0 - z.r && z.y < y1 + z.r) zn.push([z.k, z.x | 0, z.y | 0, z.r, Math.max(0, z.until - now), z.team === h.team ? 1 : 0]);
    for (const b of this.covers) if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) cv.push([b.x | 0, b.y | 0, b.w, b.h, Math.max(0, b.until - now)]);
    return h.sk.some(Boolean) || zn.length || cv.length ? [cd, act, sc, rd, ls, zn, cv] : null;
  }
  humans() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  aliveHumans() { let n = 0; for (const p of this.players.values()) if (!p.bot && p.alive) n++; return n; }
  connected() { let n = 0; for (const p of this.players.values()) if (!p.bot && p.ws) n++; return n; }
  send(ws, arr) { try { if (ws && ws.readyState === 1) { const m = JSON.stringify(arr); this.bytesOut += m.length; ws.send(m); } } catch {} }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/stats') return J(this.stats());
    if (u.pathname === '/has') { const p = this.byGid.get(u.searchParams.get('u') || ''); return J({ r: p && !p.bot && this.state !== 'ended' && !this.closed ? 1 : 0 }); } /* is this user still a member of this running match? (own session only: asked by the gateway) */
    if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
    const gid = req.headers.get('x-u'), nonce = req.headers.get('x-nonce'), exp = +req.headers.get('x-exp'), md = req.headers.get('x-md'), mid = req.headers.get('x-m'), pid = req.headers.get('x-pid') || null, pt = req.headers.get('x-pt') || '', ipc = req.headers.get('x-ipc') || '', cs = req.headers.get('x-cs') || '';
    if (!gid || !nonce || !mid || !K.TEAM[md] || this.nonces.has(nonce) || this.closed) return new Response(null, { status: 403 }); // replay protection
    if (this.mid && this.mid !== mid) return new Response(null, { status: 403 });
    if (!this.mid) { this.mid = mid; this.mode = md; }
    const now = Date.now(); this.nonces.set(nonce, exp);
    for (const [k, v] of this.nonces) if (v < now) this.nonces.delete(k);
    const pair = new WebSocketPair(); const [cl, sv] = Object.values(pair);
    let nm = ''; try { nm = decodeURIComponent(req.headers.get('x-nm') || ''); } catch {} nm = nm.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 24);
    sv.accept(); this.onOpen(sv, gid, pid, pt, ipc, cs, nm, req.headers.get('x-pm') === '1' ? 1 : 0, req.headers.get('x-wp') || 'ar01', req.headers.get('x-sk') || ',,,');
    return new Response(null, { status: 101, webSocket: cl });
  }

  onOpen(ws, gid, pid, pt, ipc, cs, nm, pm, wp, sk) {
    const now = Date.now(); ws._t0 = now; ws._win = 0; ws._cnt = 0;
    let p = this.byGid.get(gid);
    if (p && !p.bot) { if (p.ws && p.ws !== ws) { try { p.ws.close(1000, 'dup'); } catch {} } p.ws = ws; p.dcAt = 0; p.known = new Map(); p.seq = 0; p.ack = 0; p.lastIn = 0; } /* reconnect: the new client knows nothing yet, so full state is resent and the input counter restarts */
    else if (this.state === 'lobby' && this.humans() < C.MAX_PLAYERS) { p = this.mk(false, gid, ws); p.pid = pid; p.party = pt; p.ipc = String(ipc).slice(0, 10); p.cs = parseCos(cs); p.name = nm || 'Player'; p.prem = !!pm; p.w = WPN_IDX[wp] !== undefined ? WPN_IDX[wp] : 0; p.sk = parseSk(sk) || ['', '', '', '']; this.byGid.set(gid, p); if (!this.lobbyAt) this.lobbyAt = now; }
    else { this.mm('/busy', { m: this.mid, u: gid }); this.send(ws, [3, 'busy']); try { ws.close(1000, 'busy'); } catch {} return; }
    ws._p = p;
    this.send(ws, [0, p.id, this.seed, this.bl.map((b) => [b.x, b.y, b.w, b.h, b.s]), this.rh, this.rv, this.dist, C.XP_LV, this.ob.map((o) => [o.x, o.y, o.r, o.t, o.v]), WPN.map((x) => [x.id, x.dmg, x.cd, x.sp, x.rg, x.n, x.spr, x.bu, x.gp]), p.sk]);
    if (this.rosterMsg) this.send(ws, this.rosterMsg); // reconnect after the match started
    if (p.pend) this.send(ws, [5, p.lvl, p.pend]);
    ws.addEventListener('message', (e) => this.onMsg(p, ws, e.data));
    ws.addEventListener('close', () => this.onClose(p, ws));
    ws.addEventListener('error', () => this.onClose(p, ws));
    if (!this.timer) this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.log('tick_err', String(e && e.stack)); } }, 1000 / C.TICK_HZ);
  }

  onClose(p, ws) {
    if (p.ws !== ws) return;
    this.sockMs += Date.now() - ws._t0; p.ws = null; p.dcAt = Date.now(); p.mx = 0; p.my = 0; p.fire = 0;
    if (this.state === 'lobby') { this.players.delete(p.id); this.byGid.delete(p.gid); if (!this.humans()) this.lobbyAt = 0; } /* nobody leaves a standing robot behind in the lobby */
  }

  strike(p, ws, kind) {
    p.strikes++; if (this.susp.length < 200) this.susp.push({ p: p.id, k: kind, t: Date.now() });
    if (p.strikes >= C.MAX_STRIKES) { try { ws.close(1008, 'policy'); } catch {} } // disconnect only: never an automatic ban
  }

  onMsg(p, ws, d) {
    if (p.ws !== ws) return; /* ignore a replaced socket */ this.msgsIn++; this.msgsMatch++;
    const now = Date.now(), sec = Math.floor(now / 1000);
    if (ws._win !== sec) { ws._win = sec; ws._cnt = 0; }
    if (++ws._cnt > C.MAX_MSG_S) { this.strike(p, ws, 'flood'); try { ws.close(1008, 'rate'); } catch {} return; }
    if (typeof d !== 'string' || d.length > 40) return this.strike(p, ws, 'size');
    let a; try { a = JSON.parse(d); } catch { return this.strike(p, ws, 'json'); }
    if (Array.isArray(a) && a.length === 2) { if (a[0] === 8 && Number.isInteger(a[1])) { this.send(ws, [7, a[1]]); return; } if (a[0] === 10 && a[1] === 0) { if (!p.alive) p.specNext = 1; return; } if (a[0] === 11) { this.useSkill(p, a[1], now); return; } return this.choose(p, ws, a); }
    if (!Array.isArray(a) || a.length !== 6 || !a.every(Number.isInteger)) return this.strike(p, ws, 'shape');
    const [seq, mx, my, aim, fire, auto] = a;
    if (seq <= p.seq || seq > p.seq + 1000 || Math.abs(mx) > 100 || Math.abs(my) > 100 || aim < 0 || aim > 359 || (fire !== 0 && fire !== 1) || (auto !== 0 && auto !== 1)) return this.strike(p, ws, 'range');
    p.seq = seq; p.ack = seq;
    if (p.alive) {
      if (!auto && fire && p.lastIn && now - p.lastIn < 150) { let d = Math.abs(aim - p.maim); if (d > 180) d = 360 - d; if (d > 120) p.snaps++; } // instant large aim swing right before firing (aimbot signal)
      if (aim !== p.maim) p.aimAt = now;
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
    this.th = teams.filter((t) => t.some((p) => !p.bot)).length; { const acc = hum.filter((p) => p.pid); this.full = acc.length >= RK.MIN_ACC && new Set(acc.map((p) => p.ipc)).size >= RK.MIN_NET; this.ranked = this.full || (RK.LITE > 0 && acc.length >= 1); } /* full quorum = real rank + season points; lite = rank only (temporary) */
    for (const p of all) if (p.bot) for (const t of Object.keys(C.BOT_COS)) if (Math.random() < (t === 'flag' || t === 'smoke' ? 0.15 : 0.4)) p.cs[t] = C.BOT_COS[t][Math.floor(Math.random() * C.BOT_COS[t].length)]; // bots wear common items so they look like players
    for (const p of all) if (p.bot) p.w = Math.floor(Math.random() * WPN.length); /* bots carry random weapons */
    this.rosterMsg = [6, all.map((p) => [p.id, p.cs.hull || '', p.cs.cannon || '', p.cs.track || '', p.cs.detail || '', p.cs.glow || '', p.cs.bullet || '', p.cs.trail || '', p.cs.blast || '', p.cs.smoke || '', p.cs.flag || '', p.name || '', p.prem ? 1 : 0, p.w | 0])]; // cosmetic ids + display name + premium flag (no positions): visual info, validated server-side
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
    const z = this.z, el = (now - this.startAt) / 1000, rg = Math.min(C.MAX_RANGE, WPN[b.w].rg);
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
      const d = Math.hypot(e.x - b.x, e.y - b.y); if (this.zones.length && this.smokeHides(e, b, now)) return; if (d < best) { best = d; en = e; }
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
    p.dieAt = now; if (!p.bot) this.humanOut(p.team, now); const at = new Set(); for (const o of this.players.values()) if (o.alive) at.add(o.team);
    p.place = at.size + 1; // team placement: set for the whole team once its last member dies
    const teamOut = !at.has(p.team);
    if (teamOut) { const us = []; for (const o of this.players.values()) if (o.team === p.team) { o.place = at.size + 1; if (!o.bot) { us.push(o.gid); if (o !== p) this.send(o.ws, this.res(o, 1, now)); } } if (us.length) this.mm('/out', { m: this.mid, us }); }
    const k = this.players.get(p.killer); if (k && k !== p) {
      k.kills++; k.ksc += p.bot ? 2 : 4; if (!p.bot) k.hk++; /* match score: human kill +4, bot kill +2 */
      if (!k.bot) { let xp; if (p.bot) xp = C.BOT_KILL_XP; else { xp = 80 + 25 * p.lvl; if (k.lvl - p.lvl >= 3) xp *= 0.6; else if (p.lvl - k.lvl >= 2) xp *= 1.5; } this.addXp(k, Math.round(xp)); }
    }
    this.addLoot(6, p.x, p.y, 60); // death crate (+60 XP)
    { // assist: >=25% of victim max HP dealt by someone else within the last 5s -> 40% of base kill XP
      const kx = p.bot ? C.BOT_KILL_XP : 80 + 25 * p.lvl, tot = new Map();
      for (const x of p.dl) if (now - x.t <= 5000) tot.set(x.by, (tot.get(x.by) || 0) + x.d);
      for (const [id, d] of tot) { const a = this.players.get(id); if (a && a !== k && a !== p && d >= 0.25 * p.maxHp) { this.addXp(a, Math.round(0.4 * kx)); a.assists = (a.assists || 0) + 1; a.asc += 2; } }
    }
    this.send(p.ws, this.res(p, teamOut ? 1 : 0, now));
  }

  tick() {
    const now = Date.now(), gap = now - (this.lastTk || now - 1000 / C.TICK_HZ), dt = Math.min(0.1, Math.max(0.01, gap / 1000)); this.lastTk = now; this.tickN++;
    if (this.state === 'running') { const lag = gap - 1000 / C.TICK_HZ; this.lagN++; this.lagSum += lag; if (lag > this.lagMax) this.lagMax = lag; if (lag > 50) this.late++; } // event-loop lateness: the CPU-saturation signal (Workers clocks do not advance during CPU work)
    if (this.state === 'lobby') {
      if (!this.humans()) { if (this.timer) { clearInterval(this.timer); this.timer = null; } return; }
      const hum = this.humans();
      if (hum >= (this.env.LOADTEST === '1' ? C.MAX_PLAYERS : C.START_HUMANS) || now - this.lobbyAt >= C.LOBBY_MS) this.startMatch(now);
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
    const el = (now - this.startAt) / 1000; const z = this.z = this.zoneAt(el); const zp = this.zoneProg(el), dzp = Math.max(0, zp - this.lastZp); this.lastZp = zp;
    const dps = el > C.HARD_CAP_S ? 200 : z.dps;
    if (z.ph !== this.lastPh) { if (this.lastPh) for (const p of this.players.values()) if (p.alive) this.addXp(p, C.PHASE_XP); this.lastPh = z.ph; }
    if (this.aliveHumans() === 0) { if (!this.outAt) this.outAt = now; else if (now - this.outAt > C.OUT_MS) { this.finish(now, 'out'); return; } } else this.outAt = 0; /* nobody alive to play: stop paying for the room 15 s later */
    if (this.connected() === 0) { if (!this.emptyAt) this.emptyAt = now; else if (now - this.emptyAt > 20000) { this.finish(now, 'empty'); return; } } else this.emptyAt = 0;
    this.gP = this.grid(false); this.rm = [];
    if (this.covers.length) { const keepC = []; for (const c of this.covers) { if (now >= c.until) this.delCol(c); else keepC.push(c); } this.covers = keepC; }
    if (this.zones.length) this.zones = this.zones.filter((z) => now < z.until);
    if (now - this.lastNear >= 1000) { this.lastNear = now; this.nearCheck(); }
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!p.bot && !p.ws && p.dcAt && C.DC_GRACE_MS && now - p.dcAt > C.DC_GRACE_MS) { p.hp = 0; p.dcOut = 1; this.kill(p, now); continue; }
      if (p.bot && now >= p.thinkAt) { p.thinkAt = now + 200; this.think(p, now); }
      if (!p.bot && p.auto) { // server-side auto-aim/auto-fire: nearest visible enemy in AUTO_RANGE, same rules for everyone
        let tg = null, bd = 1e9;
        this.q(this.gP, p.x, p.y, C.AUTO_RANGE, (e) => { if (e === p || e.team === p.team) return; const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd && d <= C.AUTO_RANGE) { bd = d; tg = e; } });
        if (now >= p.noiseAt) { p.noiseAt = now + 250; p.noise = (Math.random() * 2 - 1) * C.AUTO_ERR; }
        if (tg) { p.aim = nrm(Math.atan2(tg.y - p.y, tg.x - p.x) * 57.2958 + p.noise); p.fire = bd <= WPN[p.w].rg ? 1 : p.mfire; } else { p.aim = p.maim; p.fire = p.mfire; }
      }
      if (p.b[6] && now - p.hitAt > 5000 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.b[6] * dt);
      if (p.heal > 0) { const hh = Math.min(p.heal, SK_C.HEAL_PER_S * dt); p.hp = Math.min(p.maxHp, p.hp + hh); p.heal -= hh; } /* Recovery skill */
      if (!p.bot) { const pr = C.PICK_R * (1 + 0.2 * p.b[7]); this.q(this.lg, p.x, p.y, pr, (it) => { if (!it.gone && Math.hypot(it.x - p.x, it.y - p.y) <= pr) this.take(p, it); }); } // server-side pickup range check
      let mx = p.mx, my = p.my; const m = Math.hypot(mx, my);
      if (m > 0) p.hd = Math.atan2(my, mx);
      if (this.zones.length && (p.spd || p.dsh) && this.inSlow(p, now)) { p.spd = null; p.dsh = null; for (let i = 0; i < 4; i++) if (p.sk[i] === 'sp' || p.sk[i] === 'vb' || p.sk[i] === 'ds') p.skAct[i] = 0; } /* Slow Field cancels active movement skills */
      if (p.dsh) { let rem = Math.min(p.dsh.left, p.dsh.sp * dt); p.dsh.left -= rem; while (rem > 0.01) { const st = Math.min(20, rem), nx = p.x + p.dsh.ux * st, ny = p.y + p.dsh.uy * st; if (nx < C.R || ny < C.R || nx > C.WORLD - C.R || ny > C.WORLD - C.R || this.hit(nx, ny, C.R)) { p.dsh = null; break; } p.x = nx; p.y = ny; rem -= st; } if (p.dsh && p.dsh.left <= 0.01) p.dsh = null; }
      if (m > 0 && !p.dsh) {
        const f = Math.min(m, 100) / m, sp = C.SPEED * (1 + 0.1 * p.b[2]) * (p.bot ? C.BOT_SPEED : 1) * this.spdMul(p, now) * (Math.min(m, 100) / 100);
        const nx = p.x + (mx / m) * sp * dt, ny = p.y + (my / m) * sp * dt;
        if (!this.hit(nx, p.y, C.R)) p.x = nx;
        if (!this.hit(p.x, ny, C.R)) p.y = ny;
        p.x = Math.max(C.R, Math.min(C.WORLD - C.R, p.x)); p.y = Math.max(C.R, Math.min(C.WORLD - C.R, p.y));
      }
      if (p.burstLeft > 0 && now >= p.burstAt) { this.shoot(p, false); p.burstLeft--; p.burstAt = now + WPN[p.w].gp; } /* the next bullet of a burst (FAMAS, M1887, DB shotgun) */
      if (p.fire && now >= p.cd) {
        const W0 = WPN[p.w], man = !p.bot && !p.auto && W0.n === 1 && W0.bu === 1; if (man) p.shots++; /* only manual single-bullet shots count for accuracy */
        p.cd = now + (W0.cd * (p.bot ? C.BOT_CD : 1)) / (1 + 0.15 * p.b[3]);
        this.shoot(p, man); if (W0.bu > 1) { p.burstLeft = W0.bu - 1; p.burstAt = now + W0.gp; }
      }
      if (Math.hypot(p.x - z.cx, p.y - z.cy) > z.r) { p.hp -= dps * dt; if (p.hp <= 0) p.killer = 0; } else if (!p.bot) p.zs += 5 * dzp; /* match score: zone points grow gradually, only while alive INSIDE the safe zone */
    }
    for (const it of this.rm) this.removeLoot(it);
    // bullets (3 substeps, vs walls and players)
    const keep = [];
    for (const b of this.bullets) {
      let dead = false;
      for (let s = 0; s < 4 && !dead; s++) {
        b.x += (b.vx * dt) / 4; b.y += (b.vy * dt) / 4;
        if (b.x < 0 || b.y < 0 || b.x > C.WORLD || b.y > C.WORLD || this.hit(b.x, b.y, 1)) { dead = true; break; } /* radius 1, not 0: circRect needs distance < radius, so with 0 bullets flew straight through every wall, rock and tree trunk */
        this.q(this.gP, b.x, b.y, 30, (e) => {
          if (dead || e.id === b.o || !e.alive || e.team === b.tm) return; // friendly fire off
          if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < (C.R + 4) ** 2) {
            dead = true; const o = this.players.get(b.o), dm = b.dm * (o ? (1 + 0.12 * o.b[0]) * (o.bot ? C.BOT_DMG * (e.bot ? C.BOT_VS_BOT : 1) : 1) : 1); /* bots hit softer, and softer still against other bots */ if (o) { o.dmg += dm; o.dmgS += e.bot ? dm * 0.5 : dm; if (!e.bot) o.dmgHum += dm; if (b.man) o.hits++; } this.hurt(e, dm, b.o, now);
          }
        });
      }
      b.dist += b.sp * dt; if (b.dist >= b.rg) dead = true;
      if (!dead) keep.push(b); else b.dead = 1;
    }
    this.bullets = keep;
    for (const p of this.players.values()) if (p.alive && p.hp <= 0) this.kill(p, now);
    let alive = 0; const ta = new Set(); for (const p of this.players.values()) if (p.alive) { alive++; ta.add(p.team); }
    { const T = this.teams, thr = [Math.ceil(T * 0.4), Math.ceil(T * 0.2), Math.ceil(T * 0.1)], val = [3, 4, 5]; /* placement points when the number of living teams falls to 40% / 20% / 10% of the start */
      while (this.pAw < 3 && ta.size <= thr[this.pAw]) { const v = val[this.pAw]; for (const p of this.players.values()) if (!p.bot && p.alive) p.ps += v; this.pAw++; } }
    if (ta.size <= 1 || el > C.HARD_CAP_S + 15) { for (const p of this.players.values()) if (ta.has(p.team)) p.place = 1; this.finish(now, ta.size <= 1 ? 'last' : 'cap'); return; }
    if (this.tickN % C.SNAP_EVERY === 0) {
      const gAll = this.grid(true), zArr = [z.cx | 0, z.cy | 0, z.r | 0, z.tcx | 0, z.tcy | 0, z.tr | 0, Math.ceil(z.left), z.ph, z.dps, z.shrink];
      for (const h of this.players.values()) if (!h.bot && h.ws) this.snap(h, gAll, zArr, alive, el);
      this.born = [];
    }
  }

  humanOut(team, now) { /* the last living human of a team died: the human-team placement is fixed now and the ranked result is frozen */
    const alive = new Set(); for (const o of this.players.values()) if (!o.bot && o.alive) alive.add(o.team);
    if (alive.has(team)) return; const at = new Set(); for (const o of this.players.values()) if (o.alive) at.add(o.team); const lp = at.size + (at.has(team) ? 0 : 1); /* overall placement right now (lite rank) */
    for (const o of this.players.values()) if (!o.bot && o.team === team && !o.f) { o.hplace = alive.size + 1; o.lp = lp; this.finalize(o); }
  }
  xpOut(p) { return Math.round(Math.min(p.xp, 3200) * (p.prem ? 1.2 : 1)); } /* Premium: +20% account XP */
  rwOut(p, sc) { return Math.round(reward(p.place || 1, p.kills, sc) * (p.prem ? 1.2 : 1)); } /* Premium: +20% coins */
  pxpOut(p) { return Math.min(130, Math.round(seasonXp(this.mode, p.place || 1) * (p.prem ? 1.2 : 1))); } /* Premium: +20% Pass XP */
  finalize(o) { /* RP: every team in the match counts as an opponent (bots included), every kill counts, the MATCH SCORE bonus always applies, no halving */
    const sc = Math.round(this.score(o)), rk = !!(this.ranked && o.pid), sp = rk; let rp = 0, spg = 0;
    if (rk) { rp = rankDelta({ ranked: true, th: this.teams, ph: o.lp || o.place || 1, kills: o.kills, score: sc, engaged: true, mode: this.mode }); spg = Math.min(150, Math.round((Math.max(0, rp) + 2.5 * (o.lvl - 1)) * (o.prem ? 1.2 : 1))); } /* Premium: +20% Season Points */
    o.f = { sc, rk, sp, hp: o.hplace || 1, rp, spg };
  }
  zoneProg(el) { /* 0..5: how far the zone sequence has progressed (each phase counts 1, fractions inside a phase) */ let t = el; for (let i = 0; i < C.PHASES.length; i++) { const d = C.PHASES[i][0] + C.PHASES[i][1]; if (t < d) return i + t / d; t -= d; } return C.PHASES.length; }
  score(p) { /* MATCH SCORE: starts at 30; every source is capped (zone 25, kills 10, damage 8, assists 6, placement 17 => max 96) */ return Math.min(100, 30 + Math.min(25, p.zs) + Math.min(10, p.ksc) + Math.min(8, p.dmgS / 125) + Math.min(6, p.asc) + Math.min(17, p.ps) + Math.min(22.5, 2.5 * (p.lvl - 1))); }
  res(o, fin, now) { /* death message: [2, place, kills, final, damage, xp, reward coins, survived s, teams]; same numbers persist() writes at match end */ return [2, o.place, o.kills, fin, Math.round(o.dmg), this.xpOut(o), this.rwOut(o, o.f ? o.f.sc : Math.round(this.score(o))), Math.round(((o.dieAt || now) - this.startAt) / 1000), this.teams, o.f ? o.f.sc : Math.round(this.score(o)), o.f ? o.f.rp : 0, o.f && o.f.rk ? 1 : 0, o.f && o.f.sp ? 1 : 0, this.pxpOut(o)]; }
  specOf(h) { /* dead player in duo/squad: follow a living teammate (shows exactly what that teammate already sees) */
    const l = []; for (const m of (this.tl && this.tl[h.team - 1]) || []) if (m !== h && m.alive) l.push(m);
    if (!l.length) return null;
    let i = l.findIndex((m) => m.id === h.spec);
    if (h.specNext) { h.specNext = 0; i = i < 0 ? 0 : (i + 1) % l.length; } else if (i < 0) i = 0;
    h.spec = l[i].id; return l[i];
  }
  snap(h, g, zArr, alive, el) {
    const known = h.known, seen = new Set(), P = [], B = [], L = [];
    const f = h.alive ? h : (this.specOf(h) || h), x0 = f.x - C.VIEW_HX, x1 = f.x + C.VIEW_HX, y0 = f.y - C.VIEW_HY, y1 = f.y + C.VIEW_HY; // fixed server-side window
    for (let cx = cell(x0); cx <= cell(x1); cx++) for (let cy = cell(y0); cy <= cell(y1); cy++) {
      const a0 = g.get(cx * 100 + cy), l0 = this.lg.get(cx * 100 + cy), a = a0 && l0 ? a0.concat(l0) : (a0 || l0); if (!a) continue;
      for (const e of a) {
        if (e === h || e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) continue;
        if (this.zones.length && e.team !== undefined && !e.blt && !e.l && this.smokeHides(e, f, Date.now())) continue; /* hidden entities simply leave the snapshot */
        seen.add(e.id);
        if (e.blt) { if (!known.has(e.id)) { known.set(e.id, 1); B.push([e.id, e.x | 0, e.y | 0, e.vx | 0, e.vy | 0, e.o, Math.max(0, e.rg - Math.hypot(e.x - e.sx, e.y - e.sy)) | 0]); } }
        else if (e.l) { if (!known.has(e.id)) { known.set(e.id, 1); L.push([e.id, e.t, e.x | 0, e.y | 0, e.v | 0]); } }
        else { const s = (e.x | 0) + ',' + (e.y | 0) + ',' + e.aim + ',' + Math.ceil(e.hp); if (known.get(e.id) !== s) { known.set(e.id, s); P.push([e.id, e.x | 0, e.y | 0, e.aim, Math.ceil(e.hp)]); } }
      }
    }
    for (const e of this.born) { /* bullets born AND dead between two snapshots: send them once (spawn point, travelled distance) so every shot is visible */
      if (!e.dead || known.has(e.id) || e.sx < x0 || e.sx > x1 || e.sy < y0 || e.sy > y1) continue;
      known.set(e.id, 1); B.push([e.id, e.sx | 0, e.sy | 0, e.vx | 0, e.vy | 0, e.o, Math.hypot(e.x - e.sx, e.y - e.sy) | 0]);
    }
    const G = []; for (const id of known.keys()) if (!seen.has(id)) { G.push(id); known.delete(id); }
    this.send(h.ws, [1, this.tickN, h.ack, [f.x | 0, f.y | 0, Math.ceil(Math.max(0, h.hp)), h.alive ? 1 : 0, h.kills, h.aim, Math.round(h.shield), h.maxHp | 0, h.xp, h.lvl, h.w, Math.round(this.score(h))], P, B, G, zArr, alive, el | 0, L, this.tm(h), this.skillExtra(h, f, Date.now(), x0, x1, y0, y1)]);
  }

  finish(now, reason) {
    this.state = 'ended'; this.endAt = now; if (reason === 'last') for (const p of this.players.values()) if (!p.bot && p.place === 1) p.ps += 5; /* winner bonus */
    if (reason === 'empty' || reason === 'out') { /* the room was abandoned: nobody WINS by leaving. A human still alive at that moment gets the worst placement. */
      const at = new Set(); for (const o of this.players.values()) if (o.alive) at.add(o.team);
      for (const p of this.players.values()) if (!p.bot) { if (p.alive) { p.place = this.teams; p.hplace = this.th; p.lp = this.teams; } else if (at.has(p.team)) { p.place = at.size; p.lp = at.size; } }
    }
    for (const p of this.players.values()) if (!p.bot && !p.f) { if (!p.hplace) p.hplace = 1; if (!p.lp) p.lp = p.place || 1; this.finalize(p); } /* survivors and winners get their ranked result now */
    const s = this.stats();
    for (const p of this.players.values()) { if (p.ws) this.sockMs += now - p.ws._t0; if (!p.bot) this.send(p.ws, [3, reason, p.place || 1, p.kills, Math.round(p.dmg), this.xpOut(p), this.rwOut(p, p.f ? p.f.sc : Math.round(this.score(p))), Math.round(((p.dieAt || now) - this.startAt) / 1000), this.teams, p.f ? p.f.sc : Math.round(this.score(p)), p.f ? p.f.rp : 0, p.f && p.f.rk ? 1 : 0, p.f && p.f.sp ? 1 : 0, this.pxpOut(p)]); }
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
    const mp = hum.filter((p) => p.pid).map((p) => ({ player_id: p.pid, placement: p.place || 1, kills: p.kills, assists: p.assists || 0, damage: Math.round(p.dmg), xp_in_match: this.xpOut(p), max_level: p.lvl, survived_s: Math.round(((p.dieAt || now) - this.startAt) / 1000), reward_soft: this.rwOut(p, p.f ? p.f.sc : Math.round(this.score(p))), match_score: p.f ? p.f.sc : null, rp_delta: p.f ? p.f.rp : 0, ranked: !!(p.f && p.f.rk), sp_ok: !!(p.f && p.f.sp), hplace: p.f ? p.f.hp : null, season_xp: this.pxpOut(p), sp_gain: p.f ? p.f.spg : 0 }));
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
    return { lagAvgMs: this.lagN ? +(this.lagSum / this.lagN).toFixed(2) : 0, lagMaxMs: Math.round(this.lagMax), lateTicks: this.late, ticks: this.lagN, outKB: Math.round(this.bytesOut / 1024), mid: this.mid, mode: this.mode, teams: this.teams, state: this.state, humans: this.humans(), players: this.players.size, msgsInMatch: this.msgsMatch, msgsInTotal: this.msgsIn, matchSecs: Math.round(secs), billedReqEst: Math.round(reqs), socketSecs: Math.round(this.sockMs / 1000), costUsdEst: +cost.toFixed(5) };
  }
}
