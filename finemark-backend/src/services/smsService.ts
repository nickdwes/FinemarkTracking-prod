/**
 * Telkosh SMS Gateway Service
 *
 * .env keys:
 *   SMS_GATEWAY_URL   – http://login.telkosh.com/sendurlcomma.aspx  (bulk)
 *   SMS_GATEWAY_OTP_URL – http://login.telkosh.com/sendurl.aspx     (OTP/transactional)
 *   SMS_USERNAME      – Telkosh account username (FineMark)
 *   SMS_PASSWORD      – Telkosh account password
 *   SMS_SENDER_ID     – Approved sender ID (FineMarkLTD)
 *   SMS_COUNTRY_CODE  – Default country code without + (254)
 *   SMS_TYPE          – SMS type for bulk/promotional (4)
 *   SMS_OTP_TYPE      – SMS type for transactional/OTP (13)
 */

export interface SmsSendResult {
  messageId: string;
  recipient: string;
  statusCode: string;
  status: string;
  cost: string;
}

/**
 * Normalise a phone number to full international format (no + prefix).
 * Accepts: 07XXXXXXXX, 01XXXXXXXX, 254XXXXXXXXX, +254XXXXXXXXX
 */
function normalisePhone(phone: string, countryCode: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith(countryCode)) return digits;
  if (digits.startsWith("0")) return countryCode + digits.slice(1);
  return countryCode + digits;
}

/**
 * Send SMS to one or more recipients via Telkosh.
 * @param recipients - Phone numbers (any common Kenyan format)
 * @param message    - Plain text message (≤160 chars for single SMS)
 * @param opts       - Optional override for smstype (default = SMS_TYPE env or "4")
 */
export async function sendSms(
  recipients: string[],
  message: string,
  opts: { smstype?: string } = {}
): Promise<SmsSendResult[]> {
  const gatewayUrl  = process.env.SMS_GATEWAY_URL   || "http://login.telkosh.com/sendurlcomma.aspx";
  const user        = process.env.SMS_USERNAME       || "";
  const pwd         = process.env.SMS_PASSWORD       || "";
  const senderId    = process.env.SMS_SENDER_ID      || "FINEMARK";
  const countryCode = process.env.SMS_COUNTRY_CODE   || "254";
  const smstype     = opts.smstype ?? (process.env.SMS_TYPE || "4");

  // Normalise all numbers and join with comma for bulk delivery in one request
  const numbers = recipients.map(p => normalisePhone(p, countryCode));
  const mobileno = numbers.join(",");

  const params = new URLSearchParams({
    user,
    pwd,
    senderid: senderId,
    CountryCode: countryCode,
    mobileno,
    msgtext: message,
    smstype,
  });

  try {
    const res = await fetch(`${gatewayUrl}?${params.toString()}`);
    const body = await res.text();
    const success = res.ok && body.trim().toLowerCase().startsWith("send successful");
    return recipients.map((phone) => ({
      messageId:  body.trim() || "unknown",
      recipient:  phone,
      statusCode: String(res.status),
      status:     success ? "Success" : "Failed",
      cost:       "0",
    }));
  } catch (err: any) {
    return recipients.map((phone) => ({
      messageId:  "",
      recipient:  phone,
      statusCode: "0",
      status:     "Failed",
      cost:       "0",
    }));
  }
}

/**
 * Send a transactional / OTP SMS (uses smstype 13 by default).
 */
export async function sendOtpSms(
  recipients: string[],
  message: string
): Promise<SmsSendResult[]> {
  const otpType = process.env.SMS_OTP_TYPE || "13";
  // OTP endpoint may differ
  const originalUrl = process.env.SMS_GATEWAY_URL;
  process.env.SMS_GATEWAY_URL = process.env.SMS_GATEWAY_OTP_URL || originalUrl;
  const result = await sendSms(recipients, message, { smstype: otpType });
  if (originalUrl !== undefined) process.env.SMS_GATEWAY_URL = originalUrl;
  return result;
}

/**
 * Is the Telkosh SMS gateway configured?
 */
export function isSmsConfigured(): boolean {
  return (
    !!process.env.SMS_USERNAME &&
    process.env.SMS_USERNAME !== "YOUR_SMS_USERNAME" &&
    !!process.env.SMS_PASSWORD &&
    process.env.SMS_PASSWORD !== "YOUR_SMS_PASSWORD"
  );
}

/** @deprecated Use isSmsConfigured() */
export const isAtConfigured = isSmsConfigured;
