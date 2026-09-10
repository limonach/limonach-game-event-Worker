// js/telegram-auth.ts
//
// تحقق HMAC من Telegram WebApp initData. يعمل فقط داخل الـWorker.
// BOT_TOKEN لا يصل أبدًا لجافاسكريبت العميل.

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function bufferToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyTelegramInitData(
  initData: string,
  botToken: string
): Promise<{ ok: true; user: TelegramUser } | { ok: false; reason: string }> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "MISSING_HASH" };
  params.delete("hash");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Number.isNaN(authDate)) {
    return { ok: false, reason: "MISSING_AUTH_DATE" };
  }
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -60) {
    return { ok: false, reason: "AUTH_DATE_EXPIRED" };
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computedHash = bufferToHex(await hmacSha256(secretKey, dataCheckString));

  if (computedHash !== hash) return { ok: false, reason: "HASH_MISMATCH" };

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "MISSING_USER" };

  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "MALFORMED_USER" };
  }
  if (typeof user.id !== "number") return { ok: false, reason: "MALFORMED_USER" };

  return { ok: true, user };
}
