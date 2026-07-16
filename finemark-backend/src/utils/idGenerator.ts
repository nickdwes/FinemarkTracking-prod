/**
 * IdGenerator — non-sequential, HMAC-obfuscated ID generator
 *
 * Format: PREFIX-ENCODEDRANDM
 *   PREFIX  — 2-3 uppercase letters (entity type)
 *   ENCODED — 8 chars base36-encoded HMAC of current timestamp
 *   RANDM   — 6 chars cryptographically secure random alphanumeric (no confusables)
 *
 * Example: CST-8F3K9Z2M4HVT3E
 *
 * Secret key read from env var: ID_SECRET
 */

import { createHmac, randomBytes } from "crypto";

// Unambiguous character set — excludes 0/O/1/I/L confusables
// A B C D E F G H   J K   M N   P Q R S T U V W X Y Z + 2..9 = 31 chars
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BASE   = BigInt(CHARS.length); // 31

/**
 * Encode a BigInt value using the unambiguous CHARS alphabet (base-32).
 * Always produces exactly `len` characters (zero-padded on the left).
 */
function encodeBase32Unambiguous(value: bigint, len: number): string {
  let result = "";
  let v = value < 0n ? -value : value; // absolute value
  for (let i = 0; i < len; i++) {
    result = CHARS[Number(v % BASE)] + result;
    v = v / BASE;
  }
  return result;
}

const ENTITY_PREFIXES: Record<string, string> = {
  customer:         "CST",
  lead:             "LED",
  quote:            "QTE",
  po:               "PO",
  vehicle:          "VEH",
  proforma:         "PRF",
  invoice:          "INV",
  retail_lead:      "BDR",
  retail_ticket:    "RTL",
  crpt:             "CRPT",
  supplier_return:  "SRT",
};

function secret(): string {
  const s = process.env.ID_SECRET;
  if (!s) {
    // Warn in development but don't crash; production must set ID_SECRET
    console.warn(
      "[IdGenerator] ID_SECRET env var not set — using insecure default. Set ID_SECRET in production!"
    );
    return "finemark-default-id-secret-DO-NOT-USE-IN-PROD";
  }
  return s;
}

function randomSuffix(len: number): string {
  const bytes = randomBytes(len);
  return Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join("");
}

export class IdGenerator {
  /**
   * Generate a non-guessable, non-sequential ID for the given entity type.
   *
   * @param entityType  One of: customer, lead, quote, vehicle, proforma, invoice (case-insensitive)
   * @param randomLen   Length of the random suffix (default: 6)
   * @returns           e.g. "CST-8F3K9Z2M4HVT3E"
   */
  static generateId(entityType: string, randomLen = 6): string {
    const prefix = ENTITY_PREFIXES[entityType.toLowerCase()];
    if (!prefix) {
      throw new Error(
        `[IdGenerator] Unknown entityType: "${entityType}". Valid types: ${Object.keys(ENTITY_PREFIXES).join(", ")}`
      );
    }

    // HMAC-SHA256( timestamp_ms ) → first 8 bytes → BigInt → encode in unambiguous base-32 → 8 chars
    const ts = Date.now().toString();
    const hmac = createHmac("sha256", secret())
      .update(ts)
      .digest();

    const encoded = encodeBase32Unambiguous(
      BigInt("0x" + hmac.subarray(0, 8).toString("hex")),
      8
    );

    const suffix = randomSuffix(randomLen);

    return `${prefix}-${encoded}${suffix}`;
  }

  /**
   * Validate that a string matches the expected ID format.
   * Does NOT verify the HMAC — just checks structural shape.
   */
  static validateFormat(id: string): boolean {
    // PREFIX-{8 HMAC chars}{4-8 random chars} — all chars from unambiguous alphabet
    return /^(CST|LED|QTE|VEH|PRF|INV)-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12,16}$/.test(id);
  }

  /** List of supported entity types */
  static readonly ENTITY_TYPES = Object.keys(ENTITY_PREFIXES);
}
