import { z } from "zod";

// The 8 timeframes the whole system understands, matching MT5's naming.
// Keeping this as a closed enum (rather than a free-form string) means a
// typo or unsupported period is rejected at the API boundary with a clear
// 400 error instead of silently creating an orphaned timeframe bucket.
export const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);

// HeartbeatSchema supports two modes:
//   1. Legacy (single-symbol EA):  { pc_id, symbol: "XAUUSD", ... }
//   2. Multi-symbol EA:            { pc_id, symbols: ["XAUUSD","USDCHF"], ... }
// Both are valid. The route normalises them into a single string[].
export const HeartbeatSchema = z
  .object({
    pc_id: z.string().min(1).max(64),
    // Legacy single-symbol field kept for backward compatibility.
    symbol: z.string().min(1).max(32).optional(),
    // New multi-symbol array (preferred, can be empty on fresh startup).
    symbols: z.array(z.string().min(1).max(32)).max(200).optional(),
    mt5_connected: z.boolean().optional().default(true),
    version: z.string().max(32).optional(),
  })
  .refine((v) => v.symbol !== undefined || v.symbols !== undefined, {
    message: "Either 'symbol' (legacy) or 'symbols' (array) must be provided",
  });
export type HeartbeatBody = z.infer<typeof HeartbeatSchema>;

/** Normalise HeartbeatBody into a deduplicated, non-empty array of symbols. */
export function resolveSymbols(body: HeartbeatBody): string[] {
  const raw = body.symbols && body.symbols.length > 0 ? body.symbols : body.symbol ? [body.symbol] : [];
  // Deduplicate while preserving insertion order.
  return [...new Set(raw)];
}

export const LevelActionSchema = z.object({
  level_id: z.string().uuid(),
  timeframe: TimeframeSchema,
  price: z.number().finite(),
  object_name: z.string().max(128).optional(),
  action: z.enum(["upsert", "delete"]),
});

export const LevelsSyncSchema = z.object({
  pc_id: z.string().min(1).max(64),
  symbol: z.string().min(1).max(32),
  levels: z.array(LevelActionSchema).max(500),
});
export type LevelsSyncBody = z.infer<typeof LevelsSyncSchema>;

export const NotifyTriggerSchema = z.object({
  pc_id: z.string().min(1).max(64),
  lease_id: z.string().min(1).max(64),
  level_id: z.string().uuid(),
  event_type: z.enum(["APPROACH", "TOUCH", "CROSS", "RESET"]),
  price: z.number().finite(),
});
export type NotifyTriggerBody = z.infer<typeof NotifyTriggerSchema>;
