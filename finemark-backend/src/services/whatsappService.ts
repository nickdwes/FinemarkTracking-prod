/**
 * Twilio WhatsApp (and SMS fallback) Service
 *
 * .env keys:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM  (e.g. whatsapp:+14155238886 for sandbox / your prod number)
 *   TWILIO_SMS_FROM       (e.g. +254XXXXXXXXX  — your Twilio SMS number)
 */

import twilio from "twilio";

let _client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> {
  if (_client) return _client;
  _client = twilio(
    process.env.TWILIO_ACCOUNT_SID || "",
    process.env.TWILIO_AUTH_TOKEN || ""
  );
  return _client;
}

export interface WhatsAppSendResult {
  sid: string;
  to: string;
  status: string;
}

/**
 * Send a WhatsApp message to a single recipient.
 * @param to - Recipient in E.164 format: +254712345678 (no "whatsapp:" prefix needed)
 * @param body - Message text (supports WhatsApp formatting)
 * @param mediaUrl - Optional public URL for image/video/document attachment
 */
export async function sendWhatsApp(
  to: string,
  body: string,
  mediaUrl?: string
): Promise<WhatsAppSendResult> {
  const client = getClient();
  const from = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
  const toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  const params: any = { from, to: toAddr, body };
  if (mediaUrl) params.mediaUrl = [mediaUrl];

  const msg = await client.messages.create(params);
  return { sid: msg.sid, to: msg.to, status: msg.status };
}

/**
 * Send a batch of WhatsApp messages (sequential, respects rate limits).
 * Returns per-recipient results (including any errors).
 */
export async function sendWhatsAppBatch(
  recipients: string[],
  body: string,
  mediaUrl?: string
): Promise<Array<WhatsAppSendResult & { error?: string }>> {
  const results: Array<WhatsAppSendResult & { error?: string }> = [];
  for (const to of recipients) {
    try {
      const r = await sendWhatsApp(to, body, mediaUrl);
      results.push(r);
    } catch (err: any) {
      results.push({ sid: "", to, status: "failed", error: err?.message ?? String(err) });
    }
    // ~4 msg/sec is well within Twilio's WhatsApp rate limit
    await new Promise((r) => setTimeout(r, 250));
  }
  return results;
}

/**
 * Send an SMS via Twilio (fallback when Africa's Talking isn't available).
 */
export async function sendTwilioSms(
  to: string,
  body: string
): Promise<WhatsAppSendResult> {
  const client = getClient();
  const from = process.env.TWILIO_SMS_FROM || "";
  const msg = await client.messages.create({ from, to, body });
  return { sid: msg.sid, to: msg.to, status: msg.status };
}

/**
 * Parse a Twilio inbound webhook body into a normalised message object.
 */
export function parseTwilioInbound(body: Record<string, string>) {
  return {
    messageSid: body.MessageSid,
    from: body.From?.replace(/^whatsapp:/, ""),
    to: body.To?.replace(/^whatsapp:/, ""),
    body: body.Body,
    mediaUrl: body.MediaUrl0 || null,
    numMedia: parseInt(body.NumMedia || "0", 10),
    channel: (body.From || "").startsWith("whatsapp:") ? "WhatsApp" : "SMS",
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Is Twilio configured?
 */
export function isTwilioConfigured(): boolean {
  return (
    !!process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_ACCOUNT_SID !== "YOUR_TWILIO_ACCOUNT_SID" &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_AUTH_TOKEN !== "YOUR_TWILIO_AUTH_TOKEN"
  );
}
