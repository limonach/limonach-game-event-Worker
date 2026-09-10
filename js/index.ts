// js/index.ts
//
// نقطة الدخول الرئيسية للـWorker. هذا هو "main" في wrangler.jsonc.
// Endpoints:
//   POST /auth/telegram          { initData } -> { gameToken, matchId }
//   GET  /match/connect?token=.. -> WebSocket upgrade إلى MatchDO

import { verifyTelegramInitData } from "./telegram-auth";
import { issueGameToken } from "./game-token";
import { MatchDO } from "./match-do";

// إلزامي: Cloudflare يبحث عن class باسم مطابق لـ class_name في wrangler.jsonc
export { MatchDO };

export interface Env {
  MATCH_DO: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
  GAME_TOKEN_SECRET: string;
  ENVIRONMENT: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

const PHASE0_TEST_MATCH_ID = "test-lobby";

async function upsertSupabaseUser(env: Env, telegramUserId: number, firstName: string) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.warn("SUPABASE not configured — skipping user upsert (Phase 0 dev mode)");
    return;
  }
  await fetch(`${env.SUPABASE_URL}/rest/v1/users?on_conflict=telegram_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ telegram_id: telegramUserId, first_name: firstName }]),
  }).catch((err) => console.error("Supabase upsert failed:", err));
}

function jsonError(reason: string, status: number): Response {
  return Response.json({ error: reason }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/auth/telegram") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return jsonError("SERVER_MISCONFIGURED: TELEGRAM_BOT_TOKEN missing", 500);
      }
      const body = await request.json().catch(() => null);
      if (!body || typeof (body as any).initData !== "string") {
        return jsonError("MISSING_INIT_DATA", 400);
      }

      const verified = await verifyTelegramInitData((body as any).initData, env.TELEGRAM_BOT_TOKEN);
      if (!verified.ok) {
        return jsonError(`TELEGRAM_AUTH_FAILED: ${verified.reason}`, 401);
      }

      await upsertSupabaseUser(env, verified.user.id, verified.user.first_name);

      const gameToken = await issueGameToken(
        String(verified.user.id),
        PHASE0_TEST_MATCH_ID,
        env.GAME_TOKEN_SECRET
      );

      return Response.json({ gameToken, matchId: PHASE0_TEST_MATCH_ID });
    }

    if (url.pathname === "/match/connect") {
      const matchId = url.searchParams.get("matchId") ?? PHASE0_TEST_MATCH_ID;
      const id = env.MATCH_DO.idFromName(matchId);
      const stub = env.MATCH_DO.get(id);
      return stub.fetch(request);
    }

    return jsonError("NOT_FOUND", 404);
  },
};
