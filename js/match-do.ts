// js/match-do.ts
//
// خادم المباراة الحقيقي (Durable Object). واحد لكل match.
// Phase 0 فقط: اتصال آمن، لا حركة. راجع PHASE0_SETUP.md.

import { parseClientPacket } from "./packet-schema";
import { verifyGameToken } from "./game-token";
import { RateLimiter, PHASE0_RATE_LIMITS } from "./rate-limiter";

export interface Env {
  GAME_TOKEN_SECRET: string;
}

interface ConnectionAttachment {
  userId: string;
  matchId: string;
  connectedAtMs: number;
}

const rateLimiters = new WeakMap<WebSocket, RateLimiter>();

export class MatchDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const verified = await verifyGameToken(token, this.env.GAME_TOKEN_SECRET);
    if (!verified.ok) {
      return new Response(`unauthorized: ${verified.reason}`, { status: 401 });
    }

    const MAX_PLAYERS_PER_MATCH = 10;
    if (this.state.getWebSockets().length >= MAX_PLAYERS_PER_MATCH) {
      return new Response("match full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    const attachment: ConnectionAttachment = {
      userId: verified.payload.sub,
      matchId: verified.payload.matchId,
      connectedAtMs: Date.now(),
    };
    server.serializeAttachment(attachment);
    rateLimiters.set(server, new RateLimiter(PHASE0_RATE_LIMITS));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      ws.send(JSON.stringify({ type: "ERROR", reason: "BINARY_NOT_SUPPORTED_YET" }));
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "ERROR", reason: "INVALID_JSON" }));
      return;
    }

    const parsed = parseClientPacket(raw);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ type: "ERROR", reason: parsed.reason }));
      return;
    }

    const limiter = rateLimiters.get(ws) ?? new RateLimiter(PHASE0_RATE_LIMITS);
    rateLimiters.set(ws, limiter);
    if (!limiter.consume(parsed.packet.type)) {
      ws.send(JSON.stringify({ type: "ERROR", reason: "RATE_LIMITED" }));
      return;
    }

    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;

    switch (parsed.packet.type) {
      case "HELLO":
        ws.send(
          JSON.stringify({
            type: "WELCOME",
            userId: attachment?.userId ?? null,
            matchId: attachment?.matchId ?? null,
            serverTimeMs: Date.now(),
          })
        );
        break;
      case "PING":
        ws.send(JSON.stringify({ type: "PONG", serverTimeMs: Date.now() }));
        break;
      default:
        ws.send(JSON.stringify({ type: "ERROR", reason: "NOT_IMPLEMENTED_YET" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    rateLimiters.delete(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error in MatchDO:", error);
    rateLimiters.delete(ws);
  }
}
