// ROBOT BATTLE ROYALE - backup.js - daily full backup of Supabase + D1 into R2 (bucket save-supabase-limonachgame, binding BACKUP)
// Layout in the bucket:  <YYYY-MM-DD>/_README.md | manifest.json | global/<table>.json | users/<player uuid>.json  (one file per player, everything about that player inside)
// It starts with the first 10-minute cron after 00:00 UTC and continues on each following run until finished (Workers limit the number of subrequests per run: BK_SUBREQ, default 30 = free plan; set 900 on the paid plan).
// Progress lives in KV (key rbr:bk:state). Files are overwritten, never appended, so a repeated run is harmless.
const KEY = 'rbr:bk:state';
const GLOBAL = ['seasons', 'season_rewards', 'cosmetics', 'box_tiers', 'box_state', 'box_wins', 'box_owed', 'box_jackpots'];
const D1T = [['orders', 'created_at'], ['star_orders', 'created_at'], ['star_ledger', 'id']]; // Cloudflare D1 ledger (gem invoices, Stars orders, Stars ledger)
const EMB = '*,player_cosmetics(*),pass_progress(*),pass_claims(*),pass_orders(*),player_boxes(*),pass_dbl_last(*),pass_doubles(*),daily_claims(*),ad_gem_claims(*),ranked_progress(*),season_progress(*),season_claims(*),royale_state(*),withdrawals(*),gem_orders(*)';
const README = [
  '# Robot BR - daily backup', '',
  'users/<player uuid>.json  : { backup_day, player_id, data } - data = the players row (id, telegram_id, name, level, total_xp, soft_currency = coins, premium_currency = gems, banned, weapon, skills)',
  '                            plus nested arrays/objects: player_cosmetics, pass_progress, pass_claims, pass_orders, player_boxes, pass_dbl_last, pass_doubles, daily_claims, ad_gem_claims, ranked_progress, season_progress, season_claims, royale_state, withdrawals, gem_orders.',
  'global/<table>.json       : seasons, season_rewards, cosmetics, box_tiers, box_state, box_wins, box_owed, box_jackpots (Supabase) and d1_orders, d1_star_orders, d1_star_ledger (Cloudflare D1 payment ledger).',
  'manifest.json             : counts and errors of this run. A day without manifest.json is incomplete.', '',
  'NOT included (history/logs, large): matches, match_players, suspicion_logs, royale_log, box_log. Balances and purchases do not depend on them.',
  'Restore: dashboard Backup tab (restore.js). Order: shared tables first (cosmetics, seasons, season_rewards, box_*: foreign keys), then D1, then players, then the player tables. Schema comes from the SQL files (schema.sql ... stage25.sql), not from this backup.'
].join('\n');
const put = (env, k, s, ct) => env.BACKUP.put(k, s, { httpMetadata: { contentType: ct || 'application/json' } });
export async function backupStatus(env) { const s = await env.RL.get(KEY, 'json'); return s ? { ...s, bucket: !!env.BACKUP } : { none: 1, bucket: !!env.BACKUP }; }
export async function backupTick(env, sb, mode) { // mode: 'run' (cron) | 'force' (admin button: restart today's backup)
  if (!env.BACKUP) return { e: 'no_bucket' };
  const lim = Number(env.BK_SUBREQ) > 0 ? Number(env.BK_SUBREQ) : 30; let sub = 0;
  const day = new Date().toISOString().slice(0, 10), log = (...a) => console.log('backup', ...a);
  let st = await env.RL.get(KEY, 'json'); sub++;
  if (!st || st.day !== day || mode === 'force') {
    if (st && st.day !== day && !st.fin) log('previous_day_unfinished', st.day);
    st = { day, gi: 0, cur: '', n: 0, fin: 0, t0: Date.now(), tr: [], err: 0, plain: 0 };
    await put(env, day + '/_README.md', README, 'text/markdown'); sub++;
  } else if (st.fin) return st;
  try {
    const nG = GLOBAL.length + D1T.length;
    while (st.gi < nG && sub <= lim - 6) { // shared tables, one file each
      const i = st.gi; let name, rows = null;
      if (i < GLOBAL.length) { name = GLOBAL[i]; const r = await sb(env, name + '?select=*&limit=1000'); sub++; if (r.ok) rows = await r.json(); else log('global_fail', name, r.status); }
      else { const t = D1T[i - GLOBAL.length]; name = 'd1_' + t[0]; if (env.DB) { const q = await env.DB.prepare('SELECT * FROM ' + t[0] + ' ORDER BY ' + t[1] + ' LIMIT 20000').all(); sub++; rows = q.results || []; } }
      if (rows) { await put(env, day + '/global/' + name + '.json', JSON.stringify(rows, null, 1)); sub++; } else st.err++;
      st.tr.push({ name, rows: rows ? rows.length : -1, truncated: !!rows && i < GLOBAL.length && rows.length >= 1000 });
      st.gi++;
    }
    while (st.gi >= nG && !st.fin) { // players: keyset pages, one file per player
      const n = Math.min(25, lim - sub - 4); if (n < 1) break;
      const r = await sb(env, 'players?select=' + (st.plain ? '*' : EMB) + '&order=id.asc&limit=' + n + (st.cur ? '&id=gt.' + st.cur : '')); sub++;
      if (r.status === 400 && !st.plain) { st.plain = 1; st.err++; log('embed_fail', String(await r.text().catch(() => '')).slice(0, 200)); continue; } // fall back to the players row alone rather than no backup
      if (!r.ok) { st.err++; log('users_fail', r.status); break; }
      const rows = await r.json();
      for (const u of rows) { await put(env, day + '/users/' + u.id + '.json', JSON.stringify({ backup_day: day, player_id: u.id, data: u }, null, 1)); sub++; st.cur = u.id; st.n++; }
      if (rows.length < n) st.fin = 1;
    }
    if (st.fin && !st.doneAt) {
      st.doneAt = Date.now();
      await put(env, day + '/manifest.json', JSON.stringify({ day, started_at: new Date(st.t0).toISOString(), finished_at: new Date(st.doneAt).toISOString(), users: st.n, global: st.tr, errors: st.err, player_data: st.plain ? 'PLAYERS ROW ONLY (nested query failed, see logs)' : 'full', not_included: ['matches', 'match_players', 'suspicion_logs', 'royale_log', 'box_log'] }, null, 1));
    }
  } catch (e) { st.err++; st.last = String(e && e.message).slice(0, 120); log('tick_err', st.last); }
  await env.RL.put(KEY, JSON.stringify(st), { expirationTtl: 172800 });
  return st;
}
