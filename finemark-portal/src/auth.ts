import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

// ── OTP store (in-process memory, per-pod) ────────────────────────────────────
interface OTPEntry {
  hash:         string;   // SHA-256(otp) — never store plaintext
  expiresAt:    number;   // Unix ms
  userId:       string;
  customerId:   string;
  role:         string;
  customerType: string;
  userName:     string;
  lastSentAt:   number;   // rate-limit: one OTP per 60 s
}
const otpStore = new Map<string, OTPEntry>();

// Purge expired entries every 15 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of otpStore) {
    if (now > entry.expiresAt + 60_000) otpStore.delete(key);
  }
}, 15 * 60 * 1000);

export function generateOTP(): string {
  return String(crypto.randomInt(100_000, 999_999));
}
export function hashOTP(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}
export function storeOTP(email: string, entry: OTPEntry): void {
  otpStore.set(email, entry);
}
export function getOTP(email: string): OTPEntry | undefined {
  return otpStore.get(email);
}
export function consumeOTP(email: string): void {
  otpStore.delete(email);
}

// ── Portal JWT ─────────────────────────────────────────────────────────────────
const PORTAL_SECRET = process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET || "portal_change_me_in_production";
const PORTAL_EXPIRES = "8h";

export interface PortalPayload {
  sub:          string;   // crm_customer_users.id
  customerId:   string;
  role:         string;
  email:        string;
}

export function signPortalToken(payload: PortalPayload): string {
  return jwt.sign(payload, PORTAL_SECRET, { expiresIn: PORTAL_EXPIRES as any });
}

export function verifyPortalToken(token: string): PortalPayload {
  return jwt.verify(token, PORTAL_SECRET) as PortalPayload;
}

// ── Auth middleware ────────────────────────────────────────────────────────────
export interface PortalRequest extends Request {
  portalUser?: PortalPayload;
}

export function requirePortalAuth(req: PortalRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "Portal authentication required." });
    return;
  }
  try {
    req.portalUser = verifyPortalToken(auth.slice(7));
    next();
  } catch {
    res.status(401).json({ ok: false, code: "TOKEN_INVALID", message: "Invalid or expired portal token." });
  }
}
