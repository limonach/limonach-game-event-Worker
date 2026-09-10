// js/packet-schema.ts
//
// مصدر واحد للحقيقة لشكل الـpackets الواردة من العميل.
// Phase 0: فقط HELLO وPING مفعّلان. الباقي (MOVE/SHOOT) معرّف لكن يُرفض عمدًا.

import { z } from "zod";

const baseEnvelope = z.object({
  seq: z.number().int().nonnegative().finite(),
});

export const HelloPacket = baseEnvelope.extend({
  type: z.literal("HELLO"),
  clientVersion: z.string().max(32),
});

export const PingPacket = baseEnvelope.extend({
  type: z.literal("PING"),
});

// معرّفة لـPhase 1+ فقط — لن تُعالج في Phase 0
export const MovePacket = baseEnvelope.extend({
  type: z.literal("MOVE"),
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
});

export const ShootPacket = baseEnvelope.extend({
  type: z.literal("SHOOT"),
  direction: z.number().min(-Math.PI).max(Math.PI),
  weaponId: z.string().max(32),
});

export const ClientPacket = z.discriminatedUnion("type", [
  HelloPacket,
  PingPacket,
  MovePacket,
  ShootPacket,
]);

export type ClientPacket = z.infer<typeof ClientPacket>;

export const PHASE0_ALLOWED_TYPES = new Set(["HELLO", "PING"]);

export function parseClientPacket(raw: unknown):
  | { ok: true; packet: ClientPacket }
  | { ok: false; reason: string } {
  const result = ClientPacket.safeParse(raw);
  if (!result.success) return { ok: false, reason: "SCHEMA_INVALID" };
  if (!PHASE0_ALLOWED_TYPES.has(result.data.type)) {
    return { ok: false, reason: "NOT_IMPLEMENTED_YET" };
  }
  return { ok: true, packet: result.data };
}
