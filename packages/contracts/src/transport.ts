import { z } from "zod";

import { DataModeSchema, Rfc3339TimestampSchema } from "./primitives.js";

export const PaginationQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().min(1).max(512).nullable(),
      hasMore: z.boolean(),
    })
    .strict();
}

export interface PaginatedResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export const WsEventTypeSchema = z.enum([
  "MARKET_SNAPSHOT",
  "CANDLE_STATE",
  "SIGNAL",
  "SIGNAL_OUTCOME",
  "HEALTH",
  "HEARTBEAT",
]);
export type WsEventType = z.infer<typeof WsEventTypeSchema>;

export function createWsEnvelopeSchema<T extends z.ZodTypeAny>(payloadSchema: T) {
  return z
    .object({
      id: z.string().min(1).max(128),
      schemaVersion: z.literal("1"),
      sequence: z.number().int().nonnegative(),
      type: WsEventTypeSchema,
      sentAt: Rfc3339TimestampSchema,
      dataMode: DataModeSchema,
      payload: payloadSchema,
    })
    .strict();
}

export const WsEnvelopeSchema = createWsEnvelopeSchema(z.unknown());
export type WsEnvelope<T = unknown> = Omit<
  z.infer<typeof WsEnvelopeSchema>,
  "payload"
> & {
  readonly payload: T;
};
