/**
 * worker.js — Cloudflare Worker: Google OAuth authentication backend
 * for a game competitions app. Data layer: Supabase (Postgres via
 * PostgREST, accessed with the service_role key — RLS on both tables
 * denies anon/authenticated entirely; see schema.sql).
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
 *   TURNSTILE_SITE_KEY           - public by design, safe in frontend/vars
 *   SESSION_DURATION_SECONDS (optional, defaults below)
 */

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const DEFAULT_SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_TTL_SECONDS = 5 * 60; // 5 minutes
const SESSION_TOUCH_THRESHOLD_SECONDS = 5 * 60; // only rewrite last_used_at if stale by this much
const MAX_REQUEST_BODY_BYTES = 10 * 1024; // 10 KB — this API doesn't need large bodies

const RATE_LIMITS = {
  "/auth/google": { limit: 15, windowSeconds: 60 },
  "/auth/google/callback": { limit: 15, windowSeconds: 60 },
  "/auth/logout": { limit: 30, windowSeconds: 60 },
  "/auth/me": { limit: 90, windowSeconds: 60 },
  default: { limit: 60, windowSeconds: 60 },
};

const ALLOWED_METHODS_BY_ROUTE = {
  "/auth/google": ["GET"],
  "/auth/google/callback": ["GET"],
  "/auth/me": ["GET"],
  "/auth/logout": ["POST"],
  "/health": ["GET"],
};

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("unhandled_error", err && err.message ? err.message : "unknown");
      return errorResponse("INTERNAL_ERROR", "Something went wrong. Please try again.", 500, request, env);
    }
  },

  // Runs on the configured cron schedule (see wrangler.toml [triggers]).
  // Expired-session cleanup happens HERE, not on the request path.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredSessions(env));
  },
};

// One client per request. supabase-js is fetch-based (no persistent
// socket to reuse across isolates anyway), so this is cheap.
function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // --- Reject disallowed HTTP methods per route -----------------------
  const allowedMethods = ALLOWED_METHODS_BY_ROUTE[path];
  if (allowedMethods && !allowedMethods.includes(request.method) && request.method !== "OPTIONS") {
    return errorResponse("METHOD_NOT_ALLOWED", "This method is not allowed on this route.", 405, request, env);
  }

  // --- CORS preflight ---------------------------------------------------
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
  }

  // --- Body size guard ----------------------------------------------------
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    return errorResponse("PAYLOAD_TOO_LARGE", "Request body too large.", 413, request, env);
  }

  // --- Rate limiting (per-IP, per-route) --------------------------------
  const rateLimited = await isRateLimited(request, env, path);
  if (rateLimited) {
    return errorResponse("RATE_LIMITED", "Too many requests. Please slow down.", 429, request, env);
  }

  let response;
  switch (path) {
    case "/health":
      response = jsonResponse({ success: true, status: "ok" }, 200);
      break;
    case "/auth/google":
      response = await startGoogleOAuth(request, env);
      break;
    case "/auth/google/callback":
      response = await handleGoogleCallback(request, env);
      break;
    case "/auth/me":
      response = await handleMe(request, env);
      break;
    case "/auth/logout":
      response = await handleLogout(request, env);
      break;
    default:
      response = errorResponse("NOT_FOUND", "Not found.", 404, request, env);
  }

  return withSecurityAndCors(response, request, env);
}

// =====================================================================
// /auth/google — start the OAuth flow
// =====================================================================
async function startGoogleOAuth(request, env) {
  // Bot protection gate: the frontend renders a Turnstile widget and appends
  // its token as ?cf-turnstile-response=... on the "Continue with Google"
  // link. Verified server-side here, BEFORE we ever redirect to Google.
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
// /auth/google/callback — exchange code, verify identity, create session
// =====================================================================
async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const cookieState = getCookie(request, "oauth_state");

  // 1) CSRF protection: state must exist, match, and come from our own cookie.
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return errorResponse("INVALID_STATE", "Login request could not be verified.", 400, request, env);
  }

  // 2) Exchange the authorization code for tokens.
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
    return errorResponse("OAUTH_FAILED", "Google sign-in failed. Please try again.", 502, request, env);
  }

  if (!tokenData.id_token) {
    return errorResponse("OAUTH_FAILED", "Google sign-in failed. Please try again.", 502, request, env);
  }

  // 3) Verify the ID token's SIGNATURE (not just decode it) + claims.
  let claims;
  try {
    claims = await verifyGoogleIdToken(tokenData.id_token, env);
  } catch (err) {
    console.error("id_token_verification_failed", err && err.message);
    return errorResponse("INVALID_TOKEN", "Google sign-in could not be verified.", 401, request, env);
  }

  if (!claims.email_verified) {
    return errorResponse("EMAIL_NOT_VERIFIED", "Your Google email is not verified.", 403, request, env);
  }

  const googleId = claims.sub;
  const email = claims.email;
  const name = claims.name || email.split("@")[0];
  const avatarUrl = claims.picture || null;
  const nowIso = new Date().toISOString();

  const supabase = getSupabase(env);

  // 4) Atomic upsert. Only google_id/email/name/avatar_url/last_login_at
  //    are in the payload — id, created_at and status are deliberately
  //    left out so an existing user's id/join-date/account status are
  //    never overwritten by this login-time upsert.
  const { data: user, error: upsertError } = await supabase
    .from("users")
    .upsert(
      { google_id: googleId, email, name, avatar_url: avatarUrl, last_login_at: nowIso },
      { onConflict: "google_id" }
    )
    .select("id, email, name, avatar_url, status")
    .single();

  if (upsertError || !user) {
    // Most likely cause: email already registered under a different google_id
    // (separate UNIQUE constraint, not covered by the google_id conflict target).
    console.error("user_upsert_failed");
    return errorResponse("ACCOUNT_CONFLICT", "This email is already associated with another account.", 409, request, env);
  }

  if (user.status !== "active") {
    return errorResponse("ACCOUNT_DISABLED", "This account is not active.", 403, request, env);
  }

  // 5) Create a session. Store only a hash of the token.
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
    return errorResponse("OAUTH_FAILED", "Google sign-in failed. Please try again.", 502, request, env);
  }

  // 6) Set the session cookie and clear the now-used state cookie.
  const headers = new Headers({ Location: env.ALLOWED_ORIGIN });
  appendSetCookie(headers, "session", rawToken, {
    maxAge: sessionDuration,
    httpOnly: true,
    secure: true,
    sameSite: "None", // frontend (pages.dev) and worker (workers.dev) are different sites
    partitioned: true, // CHIPS — survives third-party cookie restrictions in modern browsers
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
// /auth/me
// =====================================================================
async function handleMe(request, env) {
  const session = await resolveSession(request, env);
  if (!session) {
    return errorResponse("UNAUTHENTICATED", "Not signed in.", 401, request, env);
  }

  return jsonResponse(
    {
      success: true,
      user: {
        id: session.user_id,
        email: session.email,
        name: session.name,
        avatar_url: session.avatar_url,
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
    sameSite: "None",
    partitioned: true,
    path: "/",
  });
  return response;
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

  // Throttled write: only touch last_used_at if it's meaningfully stale.
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
// Cloudflare Turnstile verification
// Fails closed: any error, missing secret, or missing token = rejected.
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
// Rate limiting (KV based, per IP + route) — unaffected by the DB swap.
// =====================================================================
async function isRateLimited(request, env, path) {
  if (!env.RATE_LIMIT) return false;

  const rule = RATE_LIMITS[path] || RATE_LIMITS.default;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bucket = Math.floor(Date.now() / 1000 / rule.windowSeconds);
  const key = `rl:${path}:${ip}:${bucket}`;

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

function errorResponse(code, message, status, request, env) {
  const res = jsonResponse({ success: false, error: code, message }, status);
  return request && env ? withSecurityAndCors(res, request, env) : res;
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
