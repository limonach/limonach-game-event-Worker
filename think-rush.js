/**
 * think-rush.js — Durable Objects powering Think Rush's real-time matches.
 *
 * Two classes, both exported and declared in wrangler.toml:
 *   MatchmakingQueue — a single global instance. Its only job: pair a new
 *     "find match" request with an existing waiting match, or register a
 *     new one. No WebSockets here, just a tiny HTTP endpoint called
 *     internally by the Worker.
 *   ThinkRushMatch — one instance per match_id. Owns the entire match's
 *     live state (budgets, current round, bids, timers) and both players'
 *     WebSocket connections. This is the ONLY place bids are compared —
 *     a bid is never revealed to the opponent until both sides have
 *     committed (or the decision deadline passes), which is the whole
 *     point of running this in a Durable Object instead of stateless REST.
 *
 * Game rule (confirmed): each player starts the match with a single
 * budget of 10 points, spent across 5 rounds. Each round both players
 * secretly commit a bid (0..remaining budget). Higher bid wins the round.
 * The bid amount is deducted from the bidder's budget regardless of the
 * round's outcome — spending is permanent, which is what makes
 * "concede a round to save budget for a cheaper one" a real strategy.
 */

import { createClient } from "@supabase/supabase-js";

const STARTING_BUDGET = 10;
const TOTAL_ROUNDS = 5;
const DECISION_SECONDS = 10; // time to submit a bid each round
const GAP_SECONDS = 10; // pause between rounds, after results are revealed
const AI_FALLBACK_SECONDS = 8; // how long we search for a real opponent

function jsonRes(obj) {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
}

// =====================================================================
// MatchmakingQueue — singleton
// =====================================================================
export class MatchmakingQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/claim" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return new Response("bad request", { status: 400 });
    }
    const userId = body.userId;
    if (!userId) return new Response("bad request", { status: 400 });

    const now = Date.now();
    const waiting = (await this.state.storage.get("waiting")) || null;

    // A waiting slot older than 12s is treated as stale — by then the
    // Match DO's own AI-fallback alarm (8s) has already fired for it,
    // so it's no longer a real opponent to offer.
    if (waiting && waiting.userId !== userId && now - waiting.createdAt < 12000) {
      await this.state.storage.delete("waiting");
      return jsonRes({ matchId: waiting.matchId, role: "player2" });
    }

    const matchId = crypto.randomUUID();
    await this.state.storage.put("waiting", { matchId, userId, createdAt: now });
    return jsonRes({ matchId, role: "player1" });
  }
}

// =====================================================================
// ThinkRushMatch — one per match_id
// =====================================================================
export class ThinkRushMatch {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = {}; // { player1?: WebSocket, player2?: WebSocket } — live only, never persisted
  }

  // ---------------------------------------------------------------
  // WebSocket handshake
  // ---------------------------------------------------------------
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    const userId = request.headers.get("X-User-Id");
    const role = request.headers.get("X-Player-Role");
    if (!userId || (role !== "player1" && role !== "player2")) {
      return new Response("bad request", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets[role] = server;

    server.addEventListener("message", (evt) => this.handleMessage(role, evt.data));
    server.addEventListener("close", () => this.handleDisconnect(role));
    server.addEventListener("error", () => this.handleDisconnect(role));

    await this.onPlayerAttached(role, userId);

    return new Response(null, { status: 101, webSocket: client });
  }

  async onPlayerAttached(role, userId) {
    let match = await this.state.storage.get("match");

    if (role === "player1") {
      if (!match) {
        match = {
          status: "waiting_for_opponent",
          mode: null,
          round: 0,
          roundPhase: null,
          bids: { player1: null, player2: null },
          roundWins: { player1: 0, player2: 0 },
          roundHistory: [],
          players: { player1: { userId, budget: STARTING_BUDGET }, player2: null },
        };
        await this.state.storage.put("match", match);
        await this.state.storage.setAlarm(Date.now() + AI_FALLBACK_SECONDS * 1000);
        this.send("player1", { type: "waiting_for_opponent" });
      } else if (match.status === "finished") {
        this.send("player1", { type: "error", code: "MATCH_FINISHED", message: "This match already ended." });
      } else {
        // Deliberately not supported yet — see README note.
        this.send("player1", {
          type: "error",
          code: "RECONNECT_NOT_SUPPORTED",
          message: "Reconnecting mid-match isn't supported yet.",
        });
      }
      return;
    }

    // role === "player2" — only reached for a real human opponent; the
    // AI never opens a WebSocket, it's just computed inline.
    if (!match || match.status !== "waiting_for_opponent") {
      this.send("player2", { type: "error", code: "MATCH_UNAVAILABLE", message: "This match is no longer available." });
      const ws = this.sockets.player2;
      if (ws) ws.close();
      return;
    }

    match.players.player2 = { userId, budget: STARTING_BUDGET };
    match.mode = "pvp";
    match.status = "active";
    await this.state.storage.put("match", match);
    await this.state.storage.deleteAlarm();

    this.broadcast({ type: "opponent_found", opponent: "human" });
    await this.startRound(1);
  }

  // ---------------------------------------------------------------
  // Alarms drive every time-based transition (round deadlines, the
  // gap between rounds, and the AI-fallback timeout). Alarms — not
  // setTimeout — because they're the only mechanism that survives a
  // Durable Object being evicted and reloaded between events.
  // ---------------------------------------------------------------
  async alarm() {
    const match = await this.state.storage.get("match");
    if (!match) return;

    if (match.status === "waiting_for_opponent") {
      match.mode = "ai";
      match.status = "active";
      match.players.player2 = { userId: "ai", budget: STARTING_BUDGET };
      await this.state.storage.put("match", match);
      this.send("player1", { type: "opponent_found", opponent: "ai" });
      await this.startRound(1);
      return;
    }

    if (match.status === "active" && match.roundPhase === "deciding") {
      await this.resolveRound();
      return;
    }

    if (match.status === "active" && match.roundPhase === "gap") {
      await this.startRound(match.round + 1);
      return;
    }
  }

  // ---------------------------------------------------------------
  // Round lifecycle
  // ---------------------------------------------------------------
  async startRound(n) {
    const match = await this.state.storage.get("match");
    match.round = n;
    match.roundPhase = "deciding";
    match.bids = { player1: null, player2: null };
    const deadline = Date.now() + DECISION_SECONDS * 1000;
    await this.state.storage.put("match", match);
    await this.state.storage.setAlarm(deadline);

    this.broadcast({
      type: "round_start",
      round: n,
      deadline_ts: deadline,
      player1_budget: match.players.player1.budget,
      player2_budget: match.players.player2.budget,
    });
  }

  handleMessage(role, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (msg.type === "bid") this.submitBid(role, msg.amount);
  }

  async submitBid(role, amount) {
    const match = await this.state.storage.get("match");
    if (!match || match.status !== "active" || match.roundPhase !== "deciding") return;
    if (match.bids[role] !== null) return; // one bid per round, no take-backs

    const player = match.players[role];
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0 || n > player.budget) {
      this.send(role, { type: "error", code: "INVALID_BID", message: "Bid must be between 0 and your remaining budget." });
      return;
    }

    match.bids[role] = n;
    await this.state.storage.put("match", match);

    if (match.mode === "ai" && role === "player1" && match.bids.player2 === null) {
      const aiBid = await this.decideAiBid(match);
      const latest = await this.state.storage.get("match");
      latest.bids.player2 = aiBid;
      await this.state.storage.put("match", latest);
    }

    const updated = await this.state.storage.get("match");
    if (updated.bids.player1 !== null && updated.bids.player2 !== null) {
      await this.resolveRound();
    }
  }

  async resolveRound() {
    const match = await this.state.storage.get("match");
    if (!match || match.roundPhase !== "deciding") return;

    const b1 = match.bids.player1 ?? 0;
    const b2 = match.bids.player2 ?? 0;

    match.players.player1.budget -= b1;
    match.players.player2.budget -= b2;

    let roundWinner = "draw";
    if (b1 > b2) {
      roundWinner = "player1";
      match.roundWins.player1 += 1;
    } else if (b2 > b1) {
      roundWinner = "player2";
      match.roundWins.player2 += 1;
    }

    match.roundHistory.push({ round: match.round, player1: b1, player2: b2, winner: roundWinner });
    match.roundPhase = "revealed";
    await this.state.storage.put("match", match);

    this.broadcast({
      type: "round_result",
      round: match.round,
      player1_bid: b1,
      player2_bid: b2,
      round_winner: roundWinner,
      player1_budget: match.players.player1.budget,
      player2_budget: match.players.player2.budget,
      round_wins: match.roundWins,
    });

    if (match.round >= TOTAL_ROUNDS) {
      await this.endMatch(match);
      return;
    }

    match.roundPhase = "gap";
    await this.state.storage.put("match", match);
    await this.state.storage.setAlarm(Date.now() + GAP_SECONDS * 1000);
  }

  async endMatch(match) {
    match.status = "finished";
    await this.state.storage.put("match", match);

    let winner = "draw";
    if (match.roundWins.player1 > match.roundWins.player2) winner = "player1";
    else if (match.roundWins.player2 > match.roundWins.player1) winner = "player2";

    const gemFor = (role) => (winner === role ? 1 : 0.5);

    this.send("player1", { type: "match_end", winner, round_wins: match.roundWins, gem_earned: gemFor("player1") });
    if (match.mode === "pvp") {
      this.send("player2", { type: "match_end", winner, round_wins: match.roundWins, gem_earned: gemFor("player2") });
    }

    await this.persistMatchResult(match, winner);
  }

  // ---------------------------------------------------------------
  // Disconnect handling — deliberately simple for this first version:
  // a mid-match disconnect forfeits the match to whoever is still
  // connected. No reconnect/resume support yet (see README).
  // ---------------------------------------------------------------
  async handleDisconnect(role) {
    delete this.sockets[role];
    const match = await this.state.storage.get("match");
    if (!match || match.status !== "active") return;

    const otherRole = role === "player1" ? "player2" : "player1";
    if (match.mode === "pvp" && this.sockets[otherRole]) {
      match.status = "finished";
      await this.state.storage.put("match", match);
      this.send(otherRole, { type: "opponent_disconnected" });
      await this.persistMatchResult(match, otherRole);
    }
  }

  // ---------------------------------------------------------------
  // AI decision logic. Three tiers, all rule-based heuristics — not
  // machine learning. "Pattern detection" here means a simple average
  // of the player's past bids by round position, used only to bias
  // how aggressively the hard tier reserves budget for later rounds.
  // ---------------------------------------------------------------
  async decideAiBid(match) {
    const playerBid = match.bids.player1;
    const aiBudget = match.players.player2.budget;
    const remainingRoundsAfter = TOTAL_ROUNDS - match.round;

    const matchesPlayed = await this.getPlayerMatchesPlayed(match.players.player1.userId);
    const tier = this.getDifficultyTier(matchesPlayed);

    if (tier.type === "easy") return this.randomBid(aiBudget);

    const hard = this.hardBid(playerBid, aiBudget, remainingRoundsAfter);
    if (tier.type === "hard") return hard;

    // gradient tier: probabilistic blend between easy and hard behavior
    return Math.random() < tier.weight ? hard : this.randomBid(aiBudget);
  }

  getDifficultyTier(matchesPlayed) {
    if (matchesPlayed < 3) return { type: "easy" };
    if (matchesPlayed < 9) return { type: "gradient", weight: (matchesPlayed - 2) / 7 };
    return { type: "hard" };
  }

  randomBid(budget) {
    return Math.floor(Math.random() * (budget + 1));
  }

  hardBid(playerBid, aiBudget, remainingRoundsAfter) {
    const desired = playerBid + 1;

    if (remainingRoundsAfter === 0) {
      // Last round — nothing left to save for, take the win if affordable.
      return desired <= aiBudget ? desired : 0;
    }

    const reserveNeeded = remainingRoundsAfter; // keep at least 1 pt per remaining round
    if (desired <= aiBudget && aiBudget - desired >= reserveNeeded) {
      return desired; // win this round as cheaply as possible
    }

    return 0; // concede — this round isn't worth the budget it'd cost
  }

  async getPlayerMatchesPlayed(userId) {
    try {
      const supabase = this.getSupabase();
      const { data } = await supabase.from("users").select("think_rush_matches_played").eq("id", userId).maybeSingle();
      return data ? data.think_rush_matches_played : 0;
    } catch (err) {
      return 0;
    }
  }

  // ---------------------------------------------------------------
  // Persistence — written once, at match end, using service_role
  // (same trust model as the Worker's own REST endpoints).
  // ---------------------------------------------------------------
  getSupabase() {
    return createClient(this.env.SUPABASE_URL, this.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async persistMatchResult(match, winner) {
    try {
      const supabase = this.getSupabase();
      const player2UserId = match.mode === "pvp" ? match.players.player2.userId : null;

      const { data: row, error } = await supabase
        .from("think_rush_matches")
        .insert({
          player1_user_id: match.players.player1.userId,
          player2_user_id: player2UserId,
          mode: match.mode,
          winner,
          player1_round_wins: match.roundWins.player1,
          player2_round_wins: match.roundWins.player2,
        })
        .select("id")
        .single();

      if (!error && row) {
        const bidRows = [];
        match.roundHistory.forEach((r) => {
          bidRows.push({ match_id: row.id, user_id: match.players.player1.userId, round: r.round, bid: r.player1 });
          if (player2UserId) {
            bidRows.push({ match_id: row.id, user_id: player2UserId, round: r.round, bid: r.player2 });
          }
        });
        if (bidRows.length) await supabase.from("think_rush_bids").insert(bidRows);
      }

      const realUserIds = [match.players.player1.userId, player2UserId].filter(Boolean);
      for (const uid of realUserIds) {
        await supabase.rpc("increment_think_rush_matches", { p_user_id: uid });
      }

      // GEM reward: winner gets 1, loser and draw each get 0.5. Only
      // real users earn GEM — the AI opponent obviously doesn't have a wallet.
      const GEM_WIN = 1;
      const GEM_LOSS_OR_DRAW = 0.5;
      for (const uid of realUserIds) {
        const role = uid === match.players.player1.userId ? "player1" : "player2";
        const earned = winner === role ? GEM_WIN : GEM_LOSS_OR_DRAW;
        const newBalance = await supabase.rpc("credit_gem", { p_user_id: uid, p_amount: earned });
        await supabase.from("wallet_transactions").insert({
          user_id: uid,
          amount: earned,
          type: "think_rush_reward",
          currency: "GEM",
          reference_id: row ? row.id : null,
        });
      }
    } catch (err) {
      console.error("think_rush_persist_failed", err && err.message);
    }
  }

  // ---------------------------------------------------------------
  send(role, obj) {
    const ws = this.sockets[role];
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ ...obj, role }));
      } catch (err) {
        // socket died between the check and the send — ignore, close/error events will follow
      }
    }
  }

  broadcast(obj) {
    this.send("player1", obj);
    this.send("player2", obj);
  }
}
