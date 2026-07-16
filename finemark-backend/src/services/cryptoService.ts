/**
 * AES-256-GCM encryption/decryption for PII fields.
 * Key is sourced from CRM_ENCRYPTION_KEY env (32-byte hex, 64 hex chars).
 * Falls back to a deterministic dev key if not set (NOT for production).
 *
 * Stored format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
import crypto from "crypto";

const KEY_HEX = process.env.CRM_ENCRYPTION_KEY || "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV recommended for GCM

let KEY_BUF: Buffer;
try {
  KEY_BUF = Buffer.from(KEY_HEX, "hex");
  if (KEY_BUF.length !== 32) throw new Error("Key must be 32 bytes (64 hex chars)");
} catch (e) {
  console.error("[cryptoService] Invalid CRM_ENCRYPTION_KEY, using insecure dev key:", e);
  KEY_BUF = Buffer.alloc(32, 0);
}

/**
 * Encrypt a plaintext string → "<iv>:<authTag>:<ciphertext>" all hex.
 * Returns null if input is null/undefined/empty.
 */
export function encryptField(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUF, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a "<iv>:<authTag>:<ciphertext>" string → plaintext.
 * Returns null if input is null/empty/malformed.
 */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  try {
    const parts = stored.split(":");
    if (parts.length !== 3) return null;
    const [ivHex, authTagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(cipherHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUF, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Encrypt multiple fields in an object at once.
 * Usage: encryptFields({ phone: "07xx", national_id: "12345" })
 * → { phone_enc: "...", national_id_enc: "..." }
 */
export function encryptFields<T extends Record<string, string | null | undefined>>(
  fields: T
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, val] of Object.entries(fields)) {
    result[key] = encryptField(val);
  }
  return result;
}

/**
 * Mask a plaintext value for display (show first 3 and last 3 chars, replace middle with ***).
 * e.g. "0712345678" → "071***678"
 */
export function maskValue(plain: string | null | undefined): string {
  if (!plain) return "—";
  if (plain.length <= 6) return "•".repeat(plain.length);
  return plain.slice(0, 3) + "***" + plain.slice(-3);
}
