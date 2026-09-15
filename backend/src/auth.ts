import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { AppDb } from "./db";
import { logger } from "./logger";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateDeviceToken(): string {
  // 32 random bytes -> 64 hex chars. Plenty of entropy for a bearer token
  // that never leaves the local network / a TLS connection.
  return crypto.randomBytes(32).toString("hex");
}

export interface AuthedRequest extends Request {
  device?: { pc_id: string; priority: number };
}

/**
 * Devices are provisioned OFFLINE by the owner via `npm run register-device`
 * (see scripts/register-device.ts). There is intentionally NO public HTTP
 * endpoint to register a new PC_ID/token pair - otherwise anyone who finds
 * the backend URL could register themselves as a 4th "device" and either
 * hijack the ACTIVE role or spam our Telegram bot.
 */
export function requireDeviceAuth(db: AppDb) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.header("authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: "missing_bearer_token" });
    }
    const token = match[1]!.trim();
    const bodyPcId = (req.body && req.body.pc_id) as string | undefined;
    if (!bodyPcId) {
      return res.status(400).json({ error: "pc_id_required" });
    }

    const row = db
      .prepare(`SELECT pc_id, token_hash, priority FROM devices WHERE pc_id = ?`)
      .get(bodyPcId) as { pc_id: string; token_hash: string; priority: number } | undefined;

    if (!row) {
      logger.warn("Auth failed: unknown pc_id", { pc_id: bodyPcId });
      return res.status(401).json({ error: "unknown_device" });
    }

    const tokenHash = hashToken(token);
    // Constant-time comparison to avoid timing side-channels.
    const a = Buffer.from(tokenHash);
    const b = Buffer.from(row.token_hash);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!valid) {
      logger.warn("Auth failed: bad token", { pc_id: bodyPcId });
      return res.status(401).json({ error: "invalid_token" });
    }

    req.device = { pc_id: row.pc_id, priority: row.priority };
    next();
  };
}
