/**
 * worker.js — Cloudflare Worker: auth + arcade/wallet/tournaments backend
 * for a game competitions app. Data layer: Supabase (Postgres via
 * PostgREST, accessed with the service_role key — RLS on every table
 * denies anon/authenticated entirely; see schema.sql + schema_arcade.sql).
 *
 * Bindings expected (see wrangler.toml):
 *   RATE_LIMIT   - KV namespace used for rate limiting
 * Secrets expected (set via `wrangler secret put`):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI
 *   SESSION_SECRET              - pepper mixed into the session token hash
 *   SUPABASE_SERVICE_ROLE_KEY   - full-privilege key, server-side ONLY
 *   TURNSTILE_SECRET_KEY        - server-side verification key (never the site key)
 * Vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN
 *   SUPABASE_URL                - not secret, but keep out of frontend anyway
 *   TURNSTILE_SITE_KEY          - public by design, safe in frontend/vars
 *   SESSION_DURATION_SECONDS (optional, defaults below)
 */

import { createClient } from "@supabase/supabase-js";
export { MatchmakingQueue, ThinkRushMatch } from "./think-rush.js";

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const DEFAULT_SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_TTL_SECONDS = 5 * 60; // 5 minutes
const SESSION_TOUCH_THRESHOLD_SECONDS = 5 * 60; // only rewrite last_used_at if stale by this much
const MAX_REQUEST_BODY_BYTES = 10 * 1024; // 10 KB — this API doesn't need large bodies

// [تخمين] لا توجد طريقة حالية لكسب LIM (الإعلانات غير مفعّلة بعد)، فبدون
// رصيد ترحيبي لن يستطيع أي مستخدم تجربة الانضمام لأي بطولة. غيّرها لـ 0
// إن كنت لا تريد رصيدًا ترحيبيًا. تُمنح مرة واحدة فقط عند أول تسجيل دخول.
const WELCOME_BONUS_LIM = 10;

// ---------------------------------------------------------------------
// مكافأة الإعلان (RichAds) — لا يوجد تحقق من طرف الخادم (SSV) من مزوّد
// الإعلانات، لذا هذه الأرقام هي الدفاع الوحيد ضد استدعاء هذه النقطة
// مباشرة بدون مشاهدة إعلان فعلي. أبقِ القيمة منخفضة عمدًا.
// ---------------------------------------------------------------------
const AD_REWARD_LIM_AMOUNT = 1;
const AD_REWARD_DAILY_CAP = 5;
const AD_REWARD_COOLDOWN_MINUTES = 15;

// [تخمين] القيمة الحرفية لـ event التي ترسلها RichAds/uniqpaid عند اكتمال
// مشاهدة الإعلان الفعلية (وليس click/impression فقط) غير مؤكدة — يجب
// تأكيدها من جهة الاتصال في RichAds قبل الاعتماد عليها في الإنتاج. أي
// قيمة أخرى لـ event تُستقبل وتُؤكَّد (200 OK) لكن لا تُمنح عنها مكافأة.
const AD_POSTBACK_REWARD_EVENT_NAME = "reward";

// أسرار جديدة مطلوبة لهذا الجزء (wrangler secret put):
//   TELEGRAM_BOT_TOKEN       - توكن البوت من BotFather، للتحقق من HMAC لـ initData
//   RICHADS_POSTBACK_SECRET  - سر عشوائي تولّده أنت وتُضمّنه في رابط الـ Postback
//                              الذي تُرسله لجهة الاتصال في RichAds (وليس شيئًا يعطونه لك)

// ---------------------------------------------------------------------
// جدول التوجيه — كل مسار: تعبير نمطي + طريقة HTTP + معالج + حد معدّل خاص به.
// اختيار regex بدل switch بسيط لأن /tournaments/:id ديناميكي.
// ---------------------------------------------------------------------
const ROUTES = [
  { name: "health", method: "GET", pattern: /^\/health$/, handler: handleHealth, rate: { limit: 120, windowSeconds: 60 } },
  { name: "auth_google_start", method: "GET", pattern: /^\/auth\/google$/, handler: startGoogleOAuth, rate: { limit: 15, windowSeconds: 60 } },
  { name: "auth_google_callback", method: "GET", pattern: /^\/auth\/google\/callback$/, handler: handleGoogleCallback, rate: { limit: 15, windowSeconds: 60 } },
  { name: "auth_me", method: "GET", pattern: /^\/auth\/me$/, handler: handleMe, rate: { limit: 90, windowSeconds: 60 } },
  { name: "auth_logout", method: "POST", pattern: /^\/auth\/logout$/, handler: handleLogout, rate: { limit: 30, windowSeconds: 60 } },
  { name: "games_list", method: "GET", pattern: /^\/games$/, handler: handleListGames, rate: { limit: 60, windowSeconds: 60 } },
  { name: "tournaments_list", method: "GET", pattern: /^\/tournaments$/, handler: handleListTournaments, rate: { limit: 60, windowSeconds: 60 } },
  { name: "tournament_detail", method: "GET", pattern: /^\/tournaments\/([0-9a-fA-F-]{36})$/, handler: handleGetTournament, rate: { limit: 60, windowSeconds: 60 } },
  { name: "tournament_join", method: "POST", pattern: /^\/tournaments\/([0-9a-fA-F-]{36})\/join$/, handler: handleJoinTournament, rate: { limit: 8, windowSeconds: 60 } },
  { name: "tournament_winners", method: "GET", pattern: /^\/tournaments\/([0-9a-fA-F-]{36})\/winners$/, handler: handleTournamentWinners, rate: { limit: 60, windowSeconds: 60 } },
  { name: "wallet_transactions", method: "GET", pattern: /^\/wallet\/transactions$/, handler: handleWalletTransactions, rate: { limit: 60, windowSeconds: 60 } },
  { name: "my_tournaments", method: "GET", pattern: /^\/me\/tournaments$/, handler: handleMyTournaments, rate: { limit: 60, windowSeconds: 60 } },
  { name: "telegram_link", method: "POST", pattern: /^\/auth\/telegram\/link$/, handler: handleTelegramLink, rate: { limit: 10, windowSeconds: 60 } },
  // GET, لا جلسة — تُستدعى من خوادم RichAds/uniqpaid مباشرة، وليس من المتصفح.
  { name: "ad_postback", method: "GET", pattern: /^\/rewards\/ad-postback$/, handler: handleAdPostback, rate: { limit: 120, windowSeconds: 60 } },
];

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("unhandled_error", err && err.message ? err.message : "unknown");
      return withSecurityAndCors(errorResponse("INTERNAL_ERROR", "Something went wrong. Please try again.", 500), request, env);
    }
  },

  // Runs on the configured cron schedule (see wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredSessions(env));
  },
};

function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Think Rush's live matches are WebSocket, not JSON REST — handled
  // entirely separately, before the normal route table / CORS wrapping,
  // since a 101 Switching Protocols response must never be re-wrapped.
  if (path === "/think-rush/connect") {
    return handleThinkRushConnect(request, env);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    return withSecurityAndCors(errorResponse("PAYLOAD_TOO_LARGE", "Request body too large.", 413), request, env);
  }

  const matchedByPath = ROUTES.filter((r) => r.pattern.test(path));
  if (matchedByPath.length === 0) {
    return withSecurityAndCors(errorResponse("NOT_FOUND", "Not found.", 404), request, env);
  }

  const route = matchedByPath.find((r) => r.method === request.method);
  if (!route) {
    return withSecurityAndCors(errorResponse("METHOD_NOT_ALLOWED", "This method is not allowed on this route.", 405), request, env);
  }

  const rateLimited = await isRateLimited(request, env, route.name, route.rate);
  if (rateLimited) {
    return withSecurityAndCors(errorResponse("RATE_LIMITED", "Too many requests. Please slow down.", 429), request, env);
  }

  const match = path.match(route.pattern);
  let response;
  try {
    response = await route.handler(request, env, match);
  } catch (err) {
    console.error("route_handler_error", route.name, err && err.message);
    response = errorResponse("INTERNAL_ERROR", "Something went wrong. Please try again.", 500);
  }

  return withSecurityAndCors(response, request, env);
}

// =====================================================================
// /health
// =====================================================================
async function handleHealth() {
  return jsonResponse({ success: true, status: "ok" }, 200);
}

// =====================================================================
// /auth/google — start the OAuth flow (Turnstile-gated)
// =====================================================================
async function startGoogleOAuth(request, env) {
  const url = new URL(request.url);
  const turnstileToken = url.searchParams.get("cf-turnstile-response");
  const ip = request.headers.get("cf-connecting-ip") || "";
  const captchaOk = await verifyTurnstile(turnstileToken, ip, env);
  if (!captchaOk) {
    const headers = new Headers({ Location: `${env.ALLOWED_ORIGIN}?error=captcha_failed` });
    return new Response(null, { status: 302, headers });
  }

  const state = randomHex(32);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");

  const headers = new Headers({ Location: authUrl.toString() });
  appendSetCookie(headers, "oauth_state", state, {
    maxAge: OAUTH_STATE_TTL_SECONDS,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/auth/google",
  });

  return new Response(null, { status: 302, headers });
}

// =====================================================================
// /auth/google/callback
// =====================================================================
async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const cookieState = getCookie(request, "oauth_state");

  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return errorResponse("INVALID_STATE", "Login request could not be verified.", 400);
  }

  let tokenData;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) throw new Error("token_exchange_failed");
    tokenData = await tokenRes.json();
  } catch (err) {
    console.error("oauth_token_exchange_error");
    return errorResponse("OAUTH_FAILED", "Google sign-in failed. Please try again.", 502);
  }

  if (!tokenData.id_token) {
    return errorResponse("OAUTH_FAILED", "Google sign-in failed. Please try again.", 502);
  }

  let claims;
  try {
    claims = await verifyGoogleIdToken(tokenData.id_token, env);
  } catch (err) {
    console.error("id_token_verification_failed", err && err.message);
    return errorResponse("INVALID_TOKEN", "Google sign-in could not be verified.", 401);
  }

  if (!claims.email_verified) {
    return errorResponse("EMAIL_NOT_VERIFIED", "Your Google email is not verified.", 403);
  }

  const googleId = claims.sub;
  const email = claims.email;
  const name = claims.name || email.split("@")[0];
  const avatarUrl = claims.picture || null;
  const nowIso = new Date().toISOString();

  const supabase = getSupabase(env);

  const { data: user, error: upsertError } = await supabase
    .from("users")
    .upsert(
      { google_id: googleId, email, name, avatar_url: avatarUrl, last_login_at: nowIso },
      { onConflict: "google_id" }
    )
    .select("id, email, name, avatar_url, status")
    .single();

  if (upsertError || !user) {
    console.error("user_upsert_failed");
    return errorResponse("ACCOUNT_CONFLICT", "This email is already associated with another account.", 409);
  }

  if (user.status !== "active") {
    return errorResponse("ACCOUNT_DISABLED", "This account is not active.", 403);
  }

  // Wallet: created once, with a welcome bonus. ignoreDuplicates means a
  // returning user's balance is NEVER touched by this login-time upsert.
  const { error: walletError } = await supabase
    .from("wallets")
    .upsert({ user_id: user.id, balance: WELCOME_BONUS_LIM }, { onConflict: "user_id", ignoreDuplicates: true });

  if (walletError) {
    console.error("wallet_upsert_failed");
    // Not fatal to login — the user can still sign in even if this
    // particular write failed; /auth/me will just show balance 0.
  }

  const sessionDuration = Number(env.SESSION_DURATION_SECONDS) || DEFAULT_SESSION_DURATION_SECONDS;
  const rawToken = randomHex(32);
  const tokenHash = await sha256Hex(rawToken + env.SESSION_SECRET);
  const expiresAtIso = new Date(Date.now() + sessionDuration * 1000).toISOString();

  const { error: sessionError } = await supabase.from("sessions").insert({
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: expiresAtIso,
    last_used_at: nowIso,
  });

  if (sessionError) {
    console.error("session_insert_failed");
    return errorResponse("OAUTH_FAILED", "Google sign-in failed. Please try again.", 502);
  }

  const headers = new Headers({ Location: env.ALLOWED_ORIGIN });
  appendSetCookie(headers, "session", rawToken, {
    maxAge: sessionDuration,
    httpOnly: true,
    secure: true,
    sameSite: "Lax", // safe now that /auth/* is proxied same-origin from pages.dev — see _worker.js
    path: "/",
  });
  appendSetCookie(headers, "oauth_state", "", {
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/auth/google",
  });

  return new Response(null, { status: 302, headers });
}

// =====================================================================
// /auth/me — user + wallet balance (two small queries; kept separate
// rather than a nested PostgREST embed for predictability/debuggability)
// =====================================================================
async function handleMe(request, env) {
  const session = await resolveSession(request, env);
  if (!session) {
    return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);
  }

  const supabase = getSupabase(env);
  const { data: wallet } = await supabase
    .from("wallets")
    .select("balance, balance_usd, balance_gem")
    .eq("user_id", session.user_id)
    .maybeSingle();

  return jsonResponse(
    {
      success: true,
      user: {
        id: session.user_id,
        email: session.email,
        name: session.name,
        avatar_url: session.avatar_url,
      },
      wallet: {
        balance: wallet ? wallet.balance : 0,
        balance_usd: wallet ? wallet.balance_usd : 0,
        balance_gem: wallet ? wallet.balance_gem : 0,
      },
    },
    200
  );
}

// =====================================================================
// /auth/logout
// =====================================================================
async function handleLogout(request, env) {
  const rawToken = getCookie(request, "session");
  if (rawToken) {
    const tokenHash = await sha256Hex(rawToken + env.SESSION_SECRET);
    const supabase = getSupabase(env);
    await supabase.from("sessions").delete().eq("token_hash", tokenHash);
  }

  const response = jsonResponse({ success: true }, 200);
  appendSetCookie(response.headers, "session", "", {
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
  return response;
}

// =====================================================================
// Think Rush — WebSocket handshake: auth, origin check, rate limit,
// claim a match slot from MatchmakingQueue, then proxy the upgrade
// straight through to that match's Durable Object.
// =====================================================================
async function handleThinkRushConnect(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return withSecurityAndCors(errorResponse("BAD_REQUEST", "Expected a WebSocket upgrade.", 400), request, env);
  }

  // WebSocket upgrades aren't subject to browser CORS enforcement, so we
  // check Origin ourselves — otherwise any site could open a game socket
  // on behalf of a logged-in user using their browser's session cookie.
  const origin = request.headers.get("Origin");
  if (origin !== env.ALLOWED_ORIGIN) {
    return withSecurityAndCors(errorResponse("FORBIDDEN", "Origin not allowed.", 403), request, env);
  }

  const session = await resolveSession(request, env);
  if (!session) {
    return withSecurityAndCors(errorResponse("UNAUTHENTICATED", "Not signed in.", 401), request, env);
  }

  const rateLimited = await isRateLimited(request, env, "think_rush_connect", { limit: 10, windowSeconds: 60 });
  if (rateLimited) {
    return withSecurityAndCors(errorResponse("RATE_LIMITED", "Too many requests. Please slow down.", 429), request, env);
  }

  let matchId, role;
  try {
    const queueStub = env.MATCHMAKING_QUEUE.get(env.MATCHMAKING_QUEUE.idFromName("global"));
    const claimRes = await queueStub.fetch("https://internal/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: session.user_id }),
    });
    ({ matchId, role } = await claimRes.json());
  } catch (err) {
    console.error("think_rush_matchmaking_failed", err && err.message);
    return withSecurityAndCors(errorResponse("INTERNAL_ERROR", "Could not start matchmaking.", 500), request, env);
  }

  const matchStub = env.THINK_RUSH_MATCH.get(env.THINK_RUSH_MATCH.idFromName(matchId));

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set("X-User-Id", session.user_id);
  forwardHeaders.set("X-Player-Role", role);

  // Returned AS-IS: this is the 101 Switching Protocols response carrying
  // the live WebSocket. It must not be touched by withSecurityAndCors.
  return matchStub.fetch(new Request(request.url, { headers: forwardHeaders }));
}

// =====================================================================
// /games — catalog (Free Fire active, others coming_soon/inactive)
// =====================================================================
async function handleListGames(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from("games")
    .select("id, name, status, icon_emoji, sort_order")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("games_list_failed");
    return errorResponse("INTERNAL_ERROR", "Could not load games.", 500);
  }

  return jsonResponse({ success: true, games: data }, 200);
}

// =====================================================================
// /tournaments?game=slug — list, with participant_count + joined flag
// computed in one extra batched query (no N+1).
// =====================================================================
async function handleListTournaments(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const url = new URL(request.url);
  const gameId = url.searchParams.get("game");

  const supabase = getSupabase(env);
  let query = supabase
    .from("tournaments")
    .select("id, game_id, title, description, entry_fee_lim, max_participants, status, starts_at, ends_at")
    .order("starts_at", { ascending: true });

  if (gameId) query = query.eq("game_id", gameId);

  const { data: tournaments, error } = await query;
  if (error) {
    console.error("tournaments_list_failed");
    return errorResponse("INTERNAL_ERROR", "Could not load tournaments.", 500);
  }

  const ids = tournaments.map((t) => t.id);
  const entryCounts = {};
  const joinedSet = new Set();

  if (ids.length > 0) {
    const { data: entries } = await supabase
      .from("tournament_entries")
      .select("tournament_id, user_id")
      .in("tournament_id", ids);

    (entries || []).forEach((e) => {
      entryCounts[e.tournament_id] = (entryCounts[e.tournament_id] || 0) + 1;
      if (e.user_id === session.user_id) joinedSet.add(e.tournament_id);
    });
  }

  const result = tournaments.map((t) => ({
    ...t,
    participant_count: entryCounts[t.id] || 0,
    joined: joinedSet.has(t.id),
  }));

  return jsonResponse({ success: true, tournaments: result }, 200);
}

// =====================================================================
// /tournaments/:id
// =====================================================================
async function handleGetTournament(request, env, match) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const tournamentId = match[1];
  const supabase = getSupabase(env);

  const { data: tournament, error } = await supabase
    .from("tournaments")
    .select("id, game_id, title, description, rules, cover_image_url, entry_fee_lim, max_participants, status, starts_at, ends_at")
    .eq("id", tournamentId)
    .maybeSingle();

  if (error || !tournament) return errorResponse("NOT_FOUND", "Tournament not found.", 404);

  const { count } = await supabase
    .from("tournament_entries")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tournamentId);

  const { data: myEntry } = await supabase
    .from("tournament_entries")
    .select("id, group_number")
    .eq("tournament_id", tournamentId)
    .eq("user_id", session.user_id)
    .maybeSingle();

  const { data: prizes } = await supabase
    .from("tournament_prizes")
    .select("placement, prize_description, prize_value_lim")
    .eq("tournament_id", tournamentId)
    .order("placement", { ascending: true });

  return jsonResponse(
    {
      success: true,
      tournament: {
        ...tournament,
        participant_count: count || 0,
        joined: !!myEntry,
        my_group: myEntry ? myEntry.group_number : null,
        prizes: prizes || [],
      },
    },
    200
  );
}

// =====================================================================
// POST /tournaments/:id/join — the only mutating, money-adjacent route.
// All the actual atomicity lives in the join_tournament() SQL function;
// this handler just validates input and translates DB errors to codes.
// =====================================================================
async function handleJoinTournament(request, env, match) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const tournamentId = match[1];

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return errorResponse("INVALID_INPUT", "Request body must be valid JSON.", 400);
  }

  const gameUsername = typeof body.game_username === "string" ? body.game_username.trim() : "";
  const gameUid = typeof body.game_uid === "string" ? body.game_uid.trim() : "";

  if (!gameUsername || gameUsername.length > 60) {
    return errorResponse("INVALID_INPUT", "A valid game username is required.", 400);
  }
  if (!gameUid || gameUid.length > 60) {
    return errorResponse("INVALID_INPUT", "A valid game ID is required.", 400);
  }

  const supabase = getSupabase(env);
  const { data, error } = await supabase.rpc("join_tournament", {
    p_user_id: session.user_id,
    p_tournament_id: tournamentId,
    p_game_username: gameUsername,
    p_game_uid: gameUid,
  });

  if (error) {
    const msg = error.message || "";
    if (msg.includes("INSUFFICIENT_BALANCE")) return errorResponse("INSUFFICIENT_BALANCE", "Not enough LIM to join this tournament.", 402);
    if (msg.includes("ALREADY_JOINED")) return errorResponse("ALREADY_JOINED", "You already joined this tournament.", 409);
    if (msg.includes("TOURNAMENT_FULL")) return errorResponse("TOURNAMENT_FULL", "This tournament is full.", 409);
    if (msg.includes("TOURNAMENT_NOT_ACTIVE")) return errorResponse("TOURNAMENT_NOT_ACTIVE", "This tournament is not open for entries.", 409);
    if (msg.includes("TOURNAMENT_NOT_FOUND")) return errorResponse("NOT_FOUND", "Tournament not found.", 404);
    console.error("join_tournament_failed", msg);
    return errorResponse("INTERNAL_ERROR", "Could not join tournament.", 500);
  }

  const newBalance = Array.isArray(data) && data[0] ? data[0].new_balance : null;
  return jsonResponse({ success: true, balance: newBalance }, 200);
}

// =====================================================================
// /tournaments/:id/winners — admin-populated (see README)
// =====================================================================
async function handleTournamentWinners(request, env, match) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const tournamentId = match[1];
  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from("tournament_winners")
    .select("placement, display_name, photo_url, note")
    .eq("tournament_id", tournamentId)
    .order("placement", { ascending: true });

  if (error) {
    console.error("winners_list_failed");
    return errorResponse("INTERNAL_ERROR", "Could not load winners.", 500);
  }

  return jsonResponse({ success: true, winners: data }, 200);
}

// =====================================================================
// /wallet/transactions — the current user's own ledger only (user_id
// comes from the session, never from a query param — no way to read
// someone else's transactions by guessing an ID).
// =====================================================================
async function handleWalletTransactions(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from("wallet_transactions")
    .select("id, amount, type, currency, reference_id, created_at")
    .eq("user_id", session.user_id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("wallet_tx_list_failed");
    return errorResponse("INTERNAL_ERROR", "Could not load transactions.", 500);
  }

  return jsonResponse({ success: true, transactions: data }, 200);
}

// =====================================================================
// /me/tournaments — every tournament the CURRENT user has joined, with
// their own entry details. user_id comes from the session, same as
// every other protected route — no way to list someone else's entries.
// =====================================================================
async function handleMyTournaments(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from("tournament_entries")
    .select("id, game_username, game_uid, group_number, joined_at, tournaments(id, title, game_id, status, starts_at, ends_at, entry_fee_lim)")
    .eq("user_id", session.user_id)
    .order("joined_at", { ascending: false });

  if (error) {
    console.error("my_tournaments_failed");
    return errorResponse("INTERNAL_ERROR", "Could not load your tournaments.", 500);
  }

  const entries = (data || []).map((row) => ({
    entry_id: row.id,
    game_username: row.game_username,
    game_uid: row.game_uid,
    group_number: row.group_number,
    joined_at: row.joined_at,
    tournament: row.tournaments,
  }));

  return jsonResponse({ success: true, entries }, 200);
}

// =====================================================================
// POST /auth/telegram/link — links the CURRENT (Google-authenticated)
// session's account to a Telegram numeric ID, verified via Telegram's
// documented Mini App initData HMAC scheme (bot-token based — this is
// NOT the OIDC/Login-Widget flow, much simpler, no Client Secret/
// Redirect URIs involved). Needed so /rewards/ad-postback (which only
// knows the Telegram ID, not our internal user id) can find the right
// wallet to credit.
//
// Safe to call on every Mini App page load — idempotent. Rejects if
// this Telegram ID is already linked to a DIFFERENT account (prevents
// one Telegram identity from being attached to multiple Google
// accounts, which would otherwise let someone farm multiple welcome
// bonuses / ad rewards under one real Telegram identity).
// =====================================================================
async function handleTelegramLink(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in.", 401);

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("telegram_bot_token_missing");
    return errorResponse("INTERNAL_ERROR", "Telegram linking is not configured.", 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return errorResponse("INVALID_INPUT", "Request body must be valid JSON.", 400);
  }

  const initData = typeof body.init_data === "string" ? body.init_data : "";
  if (!initData) return errorResponse("INVALID_INPUT", "Missing init_data.", 400);

  let verified;
  try {
    verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    console.error("telegram_init_data_invalid", err && err.message);
    return errorResponse("INVALID_TELEGRAM_DATA", "Could not verify Telegram data.", 401);
  }

  const telegramId = String(verified.user.id);
  const supabase = getSupabase(env);

  const { data: existing } = await supabase.from("users").select("id").eq("telegram_id", telegramId).maybeSingle();
  if (existing && existing.id !== session.user_id) {
    return errorResponse("TELEGRAM_ALREADY_LINKED", "This Telegram account is already linked to another user.", 409);
  }

  const { error } = await supabase.from("users").update({ telegram_id: telegramId }).eq("id", session.user_id);
  if (error) {
    console.error("telegram_link_failed", error.message);
    return errorResponse("INTERNAL_ERROR", "Could not link Telegram account.", 500);
  }

  return jsonResponse({ success: true, telegram_id: telegramId }, 200);
}

// =====================================================================
// GET /rewards/ad-postback — called SERVER-TO-SERVER by RichAds/
// uniqpaid, NOT by the browser. No session cookie exists on this
// request — auth is the `token` query param (RICHADS_POSTBACK_SECRET,
// generated by us, embedded as a literal/non-macro part of the URL we
// hand to our RichAds contact), plus `event` must match the confirmed
// "fully watched" event name.
//
// [مؤكد] STILL UNCONFIRMED — do not treat as production-ready until
// verified with the RichAds contact:
//   - The exact literal value of `event` that means "reward earned"
//     (AD_POSTBACK_REWARD_EVENT_NAME below is a guess: "reward").
//   - Whether RichAds expects a specific response body/status to
//     acknowledge the postback (currently returns plain "OK" / 200).
//   - Whether they can restrict calls to a known IP range for a second
//     layer of defense beyond the token.
//
// Always returns 200 (even on unknown telegram_id / cap reached) to
// avoid the ad network retrying indefinitely — failures are logged
// server-side instead, visible via `wrangler tail`.
// =====================================================================
async function handleAdPostback(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!env.RICHADS_POSTBACK_SECRET || token !== env.RICHADS_POSTBACK_SECRET) {
    console.error("ad_postback_bad_token");
    return new Response("forbidden", { status: 403 });
  }

  const telegramId = url.searchParams.get("user_id");
  const event = url.searchParams.get("event");
  if (!telegramId) return new Response("missing user_id", { status: 400 });

  if (event !== AD_POSTBACK_REWARD_EVENT_NAME) {
    // Non-reward event (e.g. click/impression) — acknowledge, no credit.
    return new Response("OK", { status: 200 });
  }

  const supabase = getSupabase(env);
  const { data: user } = await supabase.from("users").select("id").eq("telegram_id", telegramId).maybeSingle();
  if (!user) {
    console.error("ad_postback_unknown_telegram_id", telegramId);
    return new Response("OK", { status: 200 });
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: lookupError } = await supabase
    .from("wallet_transactions")
    .select("created_at")
    .eq("user_id", user.id)
    .eq("type", "ad_reward")
    .gte("created_at", since24h)
    .order("created_at", { ascending: false });

  if (lookupError) {
    console.error("ad_postback_lookup_failed");
    return new Response("error", { status: 500 });
  }

  if (recent && recent.length >= AD_REWARD_DAILY_CAP) {
    return new Response("OK", { status: 200 }); // acknowledged, daily cap reached
  }
  if (recent && recent.length > 0) {
    const lastMs = new Date(recent[0].created_at).getTime();
    if (Date.now() - lastMs < AD_REWARD_COOLDOWN_MINUTES * 60 * 1000) {
      return new Response("OK", { status: 200 }); // acknowledged, cooldown active
    }
  }

  const { data: newBalance, error: creditError } = await supabase.rpc("credit_lim", {
    p_user_id: user.id,
    p_amount: AD_REWARD_LIM_AMOUNT,
  });

  if (creditError) {
    console.error("ad_postback_credit_failed", creditError.message);
    return new Response("error", { status: 500 });
  }

  const { error: txError } = await supabase.from("wallet_transactions").insert({
    user_id: user.id,
    amount: AD_REWARD_LIM_AMOUNT,
    type: "ad_reward",
    currency: "LIM",
  });
  if (txError) console.error("ad_postback_tx_log_failed", txError.message);

  console.log("ad_postback_credited", telegramId, newBalance);
  return new Response("OK", { status: 200 });
}

// =====================================================================
// Telegram Mini App initData verification (bot-token HMAC scheme —
// see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
// Distinct from, and much simpler than, Telegram OIDC/Login Widget.
// =====================================================================
async function hmacSha256Bytes(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

async function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing_hash");
  params.delete("hash");

  const sortedKeys = Array.from(params.keys()).sort();
  const dataCheckString = sortedKeys.map((key) => `${key}=${params.get(key)}`).join("\n");

  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const secretKeyBytes = await hmacSha256Bytes(new TextEncoder().encode("WebAppData"), botToken);
  // computed_hash = HEX(HMAC_SHA256(key=secret_key, message=dataCheckString))
  const computedBytes = await hmacSha256Bytes(secretKeyBytes, dataCheckString);
  const computedHex = Array.from(computedBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computedHex !== hash) throw new Error("bad_signature");

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) throw new Error("stale_init_data");

  const userJson = params.get("user");
  if (!userJson) throw new Error("missing_user");
  const user = JSON.parse(userJson);
  if (!user || !user.id) throw new Error("missing_user_id");

  return { user, authDate };
}

// =====================================================================
// Session resolution — ONE PostgREST call (embedded join sessions→users).
// user_id is NEVER accepted from the client; it always comes from this
// server-side lookup keyed by the hashed cookie token.
// =====================================================================
async function resolveSession(request, env) {
  const rawToken = getCookie(request, "session");
  if (!rawToken) return null;

  const tokenHash = await sha256Hex(rawToken + env.SESSION_SECRET);
  const nowIso = new Date().toISOString();
  const supabase = getSupabase(env);

  const { data: row, error } = await supabase
    .from("sessions")
    .select("id, last_used_at, users(id, email, name, avatar_url, status)")
    .eq("token_hash", tokenHash)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (error || !row || !row.users || row.users.status !== "active") return null;

  const staleSeconds = (Date.now() - new Date(row.last_used_at).getTime()) / 1000;
  if (staleSeconds > SESSION_TOUCH_THRESHOLD_SECONDS) {
    await supabase.from("sessions").update({ last_used_at: nowIso }).eq("id", row.id);
  }

  return {
    user_id: row.users.id,
    email: row.users.email,
    name: row.users.name,
    avatar_url: row.users.avatar_url,
    status: row.users.status,
  };
}

// =====================================================================
// Cloudflare Turnstile verification — fails closed.
// =====================================================================
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY || !token) return false;

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("turnstile_verify_error");
    return false;
  }
}

// =====================================================================
// Google ID token verification (real RS256 signature check via JWKS)
// =====================================================================
async function verifyGoogleIdToken(idToken, env) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed_jwt");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecodeToString(headerB64));
  const payload = JSON.parse(base64UrlDecodeToString(payloadB64));

  if (header.alg !== "RS256") throw new Error("unexpected_alg");

  const jwksRes = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!jwksRes.ok) throw new Error("jwks_fetch_failed");
  const jwks = await jwksRes.json();

  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("no_matching_key");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecodeToBytes(signatureB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedData);
  if (!valid) throw new Error("bad_signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("expired");
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("bad_issuer");
  }
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("bad_audience");

  return payload;
}

// =====================================================================
// Rate limiting (KV based, per IP + route name) — approximate, not
// strictly atomic across edge locations. See README for caveats.
// =====================================================================
async function isRateLimited(request, env, routeName, rule) {
  if (!env.RATE_LIMIT) return false;

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bucket = Math.floor(Date.now() / 1000 / rule.windowSeconds);
  const key = `rl:${routeName}:${ip}:${bucket}`;

  const current = await env.RATE_LIMIT.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= rule.limit) return true;

  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: rule.windowSeconds + 5 });
  return false;
}

// =====================================================================
// Expired session cleanup — runs on cron, NOT on the request path.
// =====================================================================
async function cleanupExpiredSessions(env) {
  const nowIso = new Date().toISOString();
  try {
    const supabase = getSupabase(env);
    await supabase.from("sessions").delete().lt("expires_at", nowIso);
  } catch (err) {
    console.error("session_cleanup_failed");
  }
}

// =====================================================================
// CORS + security headers
// =====================================================================
function buildCorsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const headers = new Headers();
  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Vary", "Origin");
  }
  return headers;
}

function withSecurityAndCors(response, request, env) {
  const headers = new Headers(response.headers);

  const cors = buildCorsHeaders(request, env);
  cors.forEach((value, key) => headers.set(key, value));

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  headers.set("Cache-Control", "no-store");

  return new Response(response.body, { status: response.status, headers });
}

// =====================================================================
// Small utilities
// =====================================================================
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(code, message, status) {
  return jsonResponse({ success: false, error: code, message }, status);
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function appendSetCookie(headers, name, value, opts) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${opts.path || "/"}; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly) cookie += "; HttpOnly";
  if (opts.secure) cookie += "; Secure";
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  if (opts.partitioned) cookie += "; Partitioned";
  headers.append("Set-Cookie", cookie);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlDecodeToBytes(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeToString(input) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}
