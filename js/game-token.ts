// js/game-token.ts
//
// توكن موقّع (HMAC) قصير الأجل يصدره الـWorker بعد نجاح تحقق Telegram.
// الـDurable Object لا يثق بأي Telegram ID مباشر، فقط بهذا التوكن.

const TOKEN_TTL_SECONDS = 60;

export interface GameTokenPayload {
  sub: string;
  matchId: string;
  exp: number;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const str = atob(padded);
  return Uint8Array.from(str, (c) => c.charCodeAt(0));
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64Url(sig);
}

export async function issueGameToken(
  userId: string,
  matchId: string,
  secret: string
): Promise<string> {
  const payload: GameTokenPayload = {
    sub: userId,
    matchId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function verifyGameToken(
  token: string | null,
  secret: string
): Promise<{ ok: true; payload: GameTokenPayload } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "MISSING_TOKEN" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED_TOKEN" };
  const [payloadB64, sig] = parts;

  const expectedSig = await sign(payloadB64, secret);
  if (expectedSig !== sig) return { ok: false, reason: "BAD_SIGNATURE" };

  let payload: GameTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return { ok: false, reason: "MALFORMED_PAYLOAD" };
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "TOKEN_EXPIRED" };
  }

  return { ok: true, payload };
}
