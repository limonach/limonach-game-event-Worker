// ROBOT BATTLE ROYALE - restore.js - restore from the daily R2 backup made by backup.js. Owner only: called from worker.js at POST /admin/restore (dashboard: Backup tab). Needs stage25.sql.
// Nothing here runs by itself: no cron, no automatic restore. Every write goes through ONE Postgres function (admin_restore_rows, whitelisted tables, per-row sub-transactions) or INSERT OR IGNORE into D1.
// Order (foreign keys): shared tables (cosmetics, seasons, season_rewards, box_*) -> D1 ledger -> players -> the 15 player tables.
// A full restore is a loop of small steps (state in KV key rbr:rs:state); each step stays under the subrequest budget (BK_SUBREQ, default 30 = free plan; 900 on the paid plan).
const DAY = /^\d{4}-\d{2}-\d{2}$/, PID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, REF = /^[sg][0-9a-f]{24}$/, COL = /^[a-z_][a-z0-9_]{0,40}$/;
const KEY = 'rbr:rs:state', TTL = { expirationTtl: 604800 };
export const GLOBAL = ['cosmetics', 'seasons', 'season_rewards', 'box_tiers', 'box_state', 'box_wins', 'box_owed', 'box_jackpots']; // same list as backup.js
export const KIDS = ['player_cosmetics', 'pass_progress', 'pass_claims', 'pass_orders', 'player_boxes', 'pass_dbl_last', 'pass_doubles', 'daily_claims', 'ad_gem_claims', 'ranked_progress', 'season_progress', 'season_claims', 'royale_state', 'withdrawals', 'gem_orders']; // nested tables of a player file, FK-safe order
export const D1T = ['orders', 'star_orders', 'star_ledger'];
const UNITS = GLOBAL.map((t) => ({ k: 's', t, f: 'global/' + t + '.json' })).concat(D1T.map((t) => ({ k: 'd', t, f: 'global/d1_' + t + '.json' })));
const FIELDS = { days: [], check: [], player: ['day', 'pid', 'mode', 'dry', 'confirm'], recon: ['dry', 'days', 'pid', 'confirm'], full_start: ['day', 'mode', 'confirm'], full_step: [], full_status: [], full_cancel: [] };
const limOf = (env) => (Number(env.BK_SUBREQ) > 0 ? Number(env.BK_SUBREQ) : 30);
const MODE = (m) => m === 'missing' || m === 'overwrite';
const NESTED = new Set(KIDS);

export function split(f) { // one player file -> { base: players row, kids: { table: [rows] } }. One-to-one embeds (player_boxes, pass_dbl_last) arrive as an object, the others as arrays.
  const d = f && f.data; if (!d || typeof d !== 'object' || !PID.test(String(d.id))) return null;
  const base = {}, kids = {};
  for (const k of Object.keys(d)) { if (NESTED.has(k)) { const v = d[k]; kids[k] = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []; } else base[k] = d[k]; }
  return { base, kids };
}
async function rows(env, sb, t, mode, arr) { // restore rows of one table through the SQL function, 500 per call
  const tot = { n: 0, ins: 0, err: 0, errs: [] };
  for (let i = 0; i < arr.length; i += 500) {
    const ch = arr.slice(i, i + 500); let j = null, r = null;
    try { r = await sb(env, 'rpc/admin_restore_rows', { method: 'POST', body: JSON.stringify({ p: { t, mode, rows: ch } }) }); j = await r.json(); } catch {}
    if (!r || !r.ok || !j || !j.ok) { tot.err += ch.length; if (tot.errs.length < 5) tot.errs.push(t + ': ' + String((j && (j.e || j.message)) || (r && r.status) || 'net').slice(0, 80)); continue; }
    tot.n += j.n | 0; tot.ins += j.ins | 0; tot.err += j.err | 0; for (const e of j.errs || []) if (tot.errs.length < 5) tot.errs.push(t + ': ' + e);
  }
  return tot;
}
async function d1ins(env, t, ch) { // D1 is only ever INSERT OR IGNORE: an existing ledger row is never changed
  const tot = { n: ch.length, ins: 0, err: 0, errs: [] };
  try {
    const st = ch.map((r) => { const ks = Object.keys(r).filter((k) => COL.test(k)); return env.DB.prepare('INSERT OR IGNORE INTO ' + t + ' (' + ks.join(',') + ') VALUES (' + ks.map((_, i) => '?' + (i + 1)).join(',') + ')').bind(...ks.map((k) => { const v = r[k]; return v === undefined ? null : v !== null && typeof v === 'object' ? JSON.stringify(v) : v; })); });
    for (const x of await env.DB.batch(st)) tot.ins += (x && x.meta && x.meta.changes) | 0;
  } catch (e) { tot.err = ch.length; tot.errs.push('d1 ' + t + ': ' + String(e && e.message).slice(0, 80)); }
  return tot;
}
function acc(st, name, r) { const a = st.tab[name] || (st.tab[name] = { n: 0, ins: 0, err: 0 }); a.n += r.n; a.ins += r.ins; a.err += r.err; for (const e of r.errs || []) if (st.errs.length < 10) st.errs.push(e); }
const sum = (st) => ({ day: st.day, mode: st.mode, phase: st.phase, users: st.users, expect: st.expect, bad_files: st.bad || 0, unit: st.gi, units: UNITS.length, tab: st.tab, errs: st.errs, notes: st.notes, plain: !!st.plain });
async function manifest(env, day) { try { const o = await env.BACKUP.get(day + '/manifest.json'); return o ? await o.json() : null; } catch { return null; } }

async function days(env) {
  const l = await env.BACKUP.list({ delimiter: '/', limit: 200 });
  const ds = (l.delimitedPrefixes || []).map((x) => x.replace(/\/$/, '')).filter((x) => DAY.test(x)).sort().reverse(), out = [];
  for (const day of ds.slice(0, 10)) { const m = await manifest(env, day); out.push({ day, complete: !!m, users: m ? m.users : null, errors: m ? m.errors : null, player_data: m ? m.player_data : null, finished_at: m ? m.finished_at : null, truncated: m && Array.isArray(m.global) ? m.global.filter((g) => g.truncated).map((g) => g.name) : [] }); }
  return { ok: 1, days: out, total: ds.length };
}

async function playerOp(env, d, b) { // one player: PREVIEW (dry) or restore
  if (!DAY.test(b.day) || !PID.test(b.pid) || !MODE(b.mode) || typeof b.dry !== 'boolean') return { e: 'bad' };
  if (!b.dry && b.confirm !== 'RESTORE') return { e: 'confirm' };
  const o = await env.BACKUP.get(b.day + '/users/' + b.pid + '.json'); if (!o) return { e: 'nofile' };
  let f = null; try { f = await o.json(); } catch {}
  const s = split(f); if (!s || s.base.id !== b.pid) return { e: 'badfile' };
  const man = await manifest(env, b.day), lr = await d.sb(env, 'players?id=eq.' + b.pid + '&select=name,level,total_xp,soft_currency,premium_currency,banned'), live = lr.ok ? (await lr.json())[0] || null : null;
  const pick = (x) => (x ? { name: x.name, level: x.level, xp: x.total_xp, coins: x.soft_currency, gems: x.premium_currency, banned: x.banned } : null), counts = {};
  for (const t of KIDS) counts[t] = (s.kids[t] || []).length;
  const t0 = man && Date.parse(man.started_at) || 0; let after = [];
  if (env.DB && t0) { // purchases paid after the backup started: they are NOT in the backup file (rebuild them with the RECONCILE button)
    const a = (await env.DB.prepare("SELECT order_id AS ref, gems, pack, paid_at FROM star_orders WHERE pid = ?1 AND paid_at > ?2 AND status IN ('PAID','DELIVERED') ORDER BY paid_at LIMIT 20").bind(b.pid, t0).all()).results || [];
    const x = (await env.DB.prepare("SELECT ref, gems, 0 AS pack, paid_at FROM orders WHERE pid = ?1 AND paid_at > ?2 AND status = 'paid' ORDER BY paid_at LIMIT 20").bind(b.pid, t0).all()).results || [];
    after = a.concat(x);
  }
  const info = { backup: pick(s.base), live: pick(live), counts, purchases_after_backup: after, complete: !!man, players_row_only: man ? man.player_data !== 'full' : null, note: 'Match history (matches, match_players) is not in the backup: wins/kills in PROFILE are not restored. Rows created after the backup are kept, never deleted.' };
  if (b.dry) return { ok: 1, dry: true, ...info };
  const result = { players: await rows(env, d.sb, 'players', b.mode, [s.base]) };
  for (const t of KIDS) if (counts[t]) result[t] = await rows(env, d.sb, t, b.mode, s.kids[t]);
  await d.audit(env, 'restore_player', { pid: b.pid, day: b.day, mode: b.mode, players: result.players.ins });
  return { ok: 1, dry: false, ...info, result };
}

async function fullStart(env, d, b) {
  if (b.confirm !== 'RESTORE') return { e: 'confirm' };
  if (!DAY.test(b.day) || !MODE(b.mode)) return { e: 'bad' };
  const old = await env.RL.get(KEY, 'json'); if (old && old.phase === 'units' || old && old.phase === 'users') { if (Date.now() - old.at < 86400000) return { e: 'running', st: sum(old) }; }
  const man = await manifest(env, b.day); if (!man) return { e: 'nomanifest' };
  const st = { day: b.day, mode: b.mode, phase: 'units', gi: 0, off: 0, last: '', users: 0, bad: 0, fail: 0, tab: {}, errs: [], notes: [], at: Date.now(), busy: 0, expect: man.users | 0, plain: man.player_data !== 'full' };
  if (Array.isArray(man.global)) for (const g of man.global) if (g.truncated) st.notes.push(g.name + ' was truncated at 1000 rows in the backup');
  if (st.plain) st.notes.push('this day has the players row only (nested query failed): player tables are not restorable from it');
  await env.RL.put(KEY, JSON.stringify(st), TTL); await d.audit(env, 'restore_full_start', { day: b.day, mode: b.mode });
  return { ok: 1, st: sum(st) };
}
async function fullStep(env, d, lim) { // one bounded step; call again until phase is done/stopped
  let st = await env.RL.get(KEY, 'json'), sub = 1;
  if (!st) return { e: 'none' };
  if (st.phase === 'done' || st.phase === 'stopped') return { ok: 1, st: sum(st) };
  if (st.busy && Date.now() - st.busy < 60000) return { e: 'busy' };
  st.busy = Date.now(); st.at = Date.now(); await env.RL.put(KEY, JSON.stringify(st), TTL); sub++; // soft lock (a double tap is harmless anyway: every write is idempotent)
  try {
    if (st.phase === 'units') {
      while (st.gi < UNITS.length && sub < lim - 4) {
        const u = UNITS[st.gi];
        if (u.k === 'd' && !env.DB) { st.notes.push('D1 is not bound: ' + u.t + ' skipped'); st.gi++; st.off = 0; continue; }
        const o = await env.BACKUP.get(st.day + '/' + u.f); sub++; let rs = null; if (o) { try { rs = await o.json(); } catch {} }
        if (!Array.isArray(rs)) { st.notes.push(u.f + ': missing or unreadable'); st.gi++; st.off = 0; continue; }
        const size = u.k === 's' ? 500 : 50;
        while (st.off < rs.length && sub < lim - 2) { const ch = rs.slice(st.off, st.off + size); acc(st, u.k === 's' ? u.t : 'd1_' + u.t, u.k === 's' ? await rows(env, d.sb, u.t, st.mode, ch) : await d1ins(env, u.t, ch)); sub++; st.off += ch.length; }
        if (st.off >= rs.length) { st.gi++; st.off = 0; }
      }
      if (st.gi >= UNITS.length) st.phase = 'users';
    } else if (st.phase === 'users') {
      const n = Math.max(1, Math.min(100, lim - 20)), l = await env.BACKUP.list({ prefix: st.day + '/users/', limit: n, startAfter: st.last || undefined }), objs = l.objects || [];
      const files = await Promise.all(objs.map(async (o) => { try { const x = await env.BACKUP.get(o.key); return x ? await x.json() : null; } catch { return null; } }));
      const base = [], kids = {}; let bad = 0;
      for (const f of files) { const s = split(f); if (!s) { bad++; continue; } base.push(s.base); for (const t of KIDS) if (s.kids[t] && s.kids[t].length) (kids[t] = kids[t] || []).push(...s.kids[t]); }
      if (base.length) { const r = await rows(env, d.sb, 'players', st.mode, base); acc(st, 'players', r); st.fail = r.err > 0 && r.ins === 0 ? (st.fail || 0) + 1 : 0; if (st.fail >= 3) { st.phase = 'stopped'; st.notes.push('stopped: the players table failed 3 steps in a row (is stage25.sql installed?)'); } }
      if (st.phase === 'users') for (const t of KIDS) if (kids[t]) acc(st, t, await rows(env, d.sb, t, st.mode, kids[t]));
      st.users += base.length; st.bad += bad; if (objs.length) st.last = objs[objs.length - 1].key;
      if (st.phase === 'users' && (!objs.length || (objs.length < n && !l.truncated))) st.phase = 'done';
    }
  } catch (e) { st.errs.push('step: ' + String(e && e.message).slice(0, 100)); }
  st.busy = 0; await env.RL.put(KEY, JSON.stringify(st), TTL);
  if (st.phase === 'done') await d.audit(env, 'restore_full_done', { day: st.day, mode: st.mode, users: st.users });
  return { ok: 1, st: sum(st) };
}

// D1 -> Supabase: every PAID order in D1 must have its credit in Supabase (gem_orders.ref / pass_orders.ref). Re-crediting is idempotent (credit_gem_order / grant_pass_stars dedupe on the ref).
const monthOf = (ms) => { const x = new Date(ms); return x.getUTCFullYear() * 100 + x.getUTCMonth() + 1; };
async function recon(env, d, b, lim) {
  if (!env.DB) return { e: 'nodb' };
  if (typeof b.dry !== 'boolean' || !Number.isInteger(b.days) || b.days < 1 || b.days > 60 || (b.pid !== undefined && !PID.test(b.pid))) return { e: 'bad' };
  if (!b.dry && b.confirm !== 'RESTORE') return { e: 'confirm' };
  const since = Date.now() - b.days * 86400000, pf = b.pid ? ' AND pid = ?2' : '', args = b.pid ? [since, b.pid] : [since];
  const st = (await env.DB.prepare("SELECT order_id AS ref, pid, pack, gems, usd_cents, paid_at FROM star_orders WHERE status IN ('PAID','DELIVERED') AND paid_at > ?1" + pf + ' ORDER BY paid_at LIMIT 300').bind(...args).all()).results || [];
  const xr = (await env.DB.prepare("SELECT ref, pid, 0 AS pack, gems, usd_cents, paid_at FROM orders WHERE status = 'paid' AND paid_at > ?1" + pf + ' ORDER BY paid_at LIMIT 300').bind(...args).all()).results || [];
  const cand = st.map((x) => ({ ...x, src: 'stars', pass: x.pack === 100 })).concat(xr.map((x) => ({ ...x, src: 'xrocket', pass: false }))).filter((x) => REF.test(String(x.ref)) && PID.test(String(x.pid)));
  const have = new Set(); let okq = true;
  const look = async (table, refs) => { for (let i = 0; i < refs.length && okq; i += 100) { const r = await d.sb(env, table + '?ref=in.(' + refs.slice(i, i + 100).join(',') + ')&select=ref'); if (!r.ok) { okq = false; return; } for (const x of await r.json()) have.add(x.ref); } };
  await look('gem_orders', cand.filter((x) => !x.pass).map((x) => x.ref)); await look('pass_orders', cand.filter((x) => x.pass).map((x) => x.ref));
  if (!okq) return { e: 'db' };
  const cm = monthOf(Date.now()), skipped = [], miss = [];
  for (const x of cand) { if (have.has(x.ref)) continue; if (x.pass && monthOf(x.paid_at) !== cm) { skipped.push({ ref: x.ref, why: 'pass paid in an older month' }); continue; } miss.push(x); }
  const view = (x) => ({ ref: x.ref, pid: x.pid, src: x.src, what: x.pass ? 'season pass premium' : x.gems + ' GEM', paid_at: x.paid_at });
  if (b.dry) return { ok: 1, dry: true, checked: cand.length, missing: miss.length, rows: miss.slice(0, 50).map(view), skipped };
  const cap = Math.max(1, Math.min(25, lim - 12)), todo = miss.slice(0, cap), done = [];
  for (const x of todo) {
    let j = null; try { const r = await d.sb(env, 'rpc/' + (x.pass ? 'grant_pass_stars' : 'credit_gem_order'), { method: 'POST', body: JSON.stringify({ p: x.pass ? { ref: x.ref, pid: x.pid } : { ref: x.ref, pid: x.pid, gems: x.gems, usd: x.usd_cents, src: x.src } }) }); j = await r.json(); } catch {}
    done.push({ ref: x.ref, r: j && (j.ok ? 'credited' : j.dup ? 'already' : j.e) || 'err' });
  }
  const credited = done.filter((x) => x.r === 'credited').length;
  await d.audit(env, 'restore_recon', { credited, tried: done.length, left: miss.length - todo.length });
  return { ok: 1, dry: false, checked: cand.length, credited, left: miss.length - todo.length, done, skipped };
}

export async function restoreApi(req, env, d) { // d = { sb, audit, admRpc, J } from worker.js
  if (req.method !== 'POST') return d.J({ e: 'bad' }, 405);
  if (!env.BACKUP) return d.J({ e: 'no_bucket' }, 503);
  let b; try { b = await req.json(); } catch { return d.J({ e: 'bad' }, 400); }
  if (!b || typeof b !== 'object' || typeof b.action !== 'string' || !Object.prototype.hasOwnProperty.call(FIELDS, b.action) || Object.keys(b).some((k) => k !== 'action' && !FIELDS[b.action].includes(k))) return d.J({ e: 'bad' }, 400);
  const lim = limOf(env); let r;
  try {
    if (b.action === 'days') r = await days(env);
    else if (b.action === 'check') r = (await d.admRpc(env, 'admin_restore_check', {})) || { e: 'db', hint: 'run stage25.sql' };
    else if (b.action === 'player') r = await playerOp(env, d, b);
    else if (b.action === 'recon') r = await recon(env, d, b, lim);
    else if (b.action === 'full_start') r = await fullStart(env, d, b);
    else if (b.action === 'full_step') r = await fullStep(env, d, lim);
    else if (b.action === 'full_status') { const st = await env.RL.get(KEY, 'json'); r = st ? { ok: 1, st: sum(st) } : { none: 1 }; }
    else { await env.RL.delete(KEY); await d.audit(env, 'restore_cancel', {}); r = { ok: 1, cancelled: 1 }; }
  } catch (e) { console.log('restore_err', b.action, String(e && e.message)); return d.J({ e: 'err' }, 500); }
  return d.J(r, r && r.e ? (r.e === 'db' || r.e === 'err' ? 502 : 409) : 200);
}
