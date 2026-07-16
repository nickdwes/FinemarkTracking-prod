/**
 * Microsoft Graph Mail Service
 * Reads and sends email from Office 365 mailboxes using app-only (client credentials) auth.
 *
 * Azure AD App requirements:
 *   - Application permissions: Mail.Read, Mail.Send
 *   - Grant admin consent in the tenant
 *
 * .env keys: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
 *            GRAPH_SUPPORT_MAILBOX, GRAPH_NOTIFICATION_MAILBOX, GRAPH_CUSTOMER_MAILBOX
 */

import "isomorphic-fetch";
import { ConfidentialClientApplication, Configuration } from "@azure/msal-node";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let _msalApp: ConfidentialClientApplication | null = null;

function getMsalApp(): ConfidentialClientApplication {
  if (_msalApp) return _msalApp;
  const config: Configuration = {
    auth: {
      clientId: process.env.GRAPH_CLIENT_ID || "",
      authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || ""}`,
      clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
    },
  };
  _msalApp = new ConfidentialClientApplication(config);
  return _msalApp;
}

async function getToken(): Promise<string> {
  const app = getMsalApp();
  const result = await app.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) throw new Error("Graph: Failed to acquire access token");
  return result.accessToken;
}

async function graphFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((options.headers as any) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403) {
      // Decode token roles to give a precise diagnosis
      let roles: string[] = [];
      try {
        roles = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).roles ?? [];
      } catch { /* ignore */ }
      const hasMail = roles.some(r => r.startsWith("Mail."));
      const hint = hasMail
        ? ""
        : " — Mail.Read / Mail.ReadWrite / Mail.Send application permissions are missing or not admin-consented in Azure Portal (App ID: " +
          (process.env.GRAPH_CLIENT_ID ?? "?") + "). Current roles: [" + roles.join(", ") + "]";
      throw new Error(`Graph API error 403: ${body}${hint}`);
    }
    throw new Error(`Graph API error ${res.status}: ${body}`);
  }
  if (res.status === 204 || res.status === 202) return null;

  const bodyText = await res.text().catch(() => "");
  if (!bodyText || !bodyText.trim()) return null;

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

/**
 * Log current token roles at startup for diagnostics.
 */
export async function logGraphPermissions(): Promise<void> {
  try {
    const token = await getToken();
    const roles: string[] = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).roles ?? [];
    const hasMail = roles.some(r => r.startsWith("Mail."));
    if (hasMail) {
      console.log("[graphMail] Permissions OK — roles:", roles.join(", "));
    } else {
      console.warn(
        "[graphMail] ⚠ Mail permissions NOT granted. Add Mail.Read, Mail.ReadWrite, Mail.Send " +
        "as Application permissions in Azure Portal and grant admin consent. " +
        "Current roles: [" + roles.join(", ") + "]"
      );
    }
  } catch (e: any) {
    console.error("[graphMail] Could not check permissions:", e.message);
  }
}

export interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { content: string; contentType: string };
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  isRead: boolean;
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
}

/**
 * Returns the configured mailbox aliases.
 */
export const MAILBOXES = {
  support: process.env.GRAPH_SUPPORT_MAILBOX || "support@finemarktracking.co.ke",
  notification: process.env.GRAPH_NOTIFICATION_MAILBOX || "notification@finemarktracking.co.ke",
  customer: process.env.GRAPH_CUSTOMER_MAILBOX || "customer@finemarktracking.co.ke",
} as const;

export type MailboxKey = keyof typeof MAILBOXES;

/**
 * Fetch unread messages from a mailbox inbox, optionally using a delta link for incremental sync.
 */
export async function fetchUnreadEmails(
  mailbox: string,
  deltaLink?: string | null
): Promise<{ messages: GraphMessage[]; nextDeltaLink: string | null }> {
  const path = deltaLink
    ? deltaLink.replace(GRAPH_BASE, "")
    : `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?$top=50&$select=id,subject,bodyPreview,body,from,receivedDateTime,isRead,toRecipients`;

  const data = await graphFetch(path);
  // $filter is not supported on delta — filter unread client-side
  const messages: GraphMessage[] = (data?.value ?? []).filter(
    (m: any) => !m["@removed"] && m.isRead === false
  );
  const nextDeltaLink: string | null =
    data?.["@odata.deltaLink"] ?? data?.["@odata.nextLink"] ?? null;

  return { messages, nextDeltaLink };
}

/**
 * Mark a message as read.
 */
export async function markAsRead(mailbox: string, messageId: string): Promise<void> {
  await graphFetch(`/users/${encodeURIComponent(mailbox)}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ isRead: true }),
  });
}

/**
 * Send an email from a mailbox via Microsoft Graph.
 */
export async function sendEmailViaGraph(opts: {
  fromMailbox: string;
  to: string | string[];
  cc?: string | string[];
  subject: string;
  htmlBody: string;
  textBody?: string;
  replyToMessageId?: string;
}): Promise<void> {
  const toAddresses = (Array.isArray(opts.to) ? opts.to : [opts.to]).map((a) => ({
    emailAddress: { address: a },
  }));
  const ccAddresses = opts.cc
    ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]).map((a) => ({ emailAddress: { address: a } }))
    : undefined;

  const message: any = {
    subject: opts.subject,
    body: {
      contentType: opts.textBody && !opts.htmlBody ? "Text" : "HTML",
      content: opts.htmlBody || opts.textBody || "",
    },
    toRecipients: toAddresses,
    ...(ccAddresses?.length ? { ccRecipients: ccAddresses } : {}),
  };

  await graphFetch(`/users/${encodeURIComponent(opts.fromMailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
}

/**
 * Reply to an existing message thread.
 */
export async function replyToEmail(opts: {
  fromMailbox: string;
  messageId: string;
  htmlBody: string;
}): Promise<void> {
  await graphFetch(
    `/users/${encodeURIComponent(opts.fromMailbox)}/messages/${opts.messageId}/reply`,
    {
      method: "POST",
      body: JSON.stringify({
        message: { body: { contentType: "HTML", content: opts.htmlBody } },
      }),
    }
  );
}

/**
 * Create a calendar event on a user's Office 365 calendar.
 * Requires Calendars.ReadWrite application permission.
 */
export async function createCalendarEvent(opts: {
  userEmail: string;          // whose calendar to create the event on
  subject: string;
  body?: string;
  startDateTime: string;      // ISO 8601 e.g. "2026-06-10T09:00:00"
  endDateTime: string;        // ISO 8601
  timeZone?: string;          // e.g. "Africa/Nairobi" — defaults to UTC
  attendees?: string[];       // additional attendee email addresses
  reminderMinutes?: number;
}): Promise<{ id: string } | null> {
  const tz = opts.timeZone || "UTC";
  const event: any = {
    subject: opts.subject,
    body: {
      contentType: "HTML",
      content: opts.body || opts.subject,
    },
    start: { dateTime: opts.startDateTime, timeZone: tz },
    end: { dateTime: opts.endDateTime, timeZone: tz },
    isReminderOn: (opts.reminderMinutes ?? 0) > 0,
    reminderMinutesBeforeStart: opts.reminderMinutes ?? 15,
    attendees: (opts.attendees || []).map(email => ({
      emailAddress: { address: email },
      type: "optional",
    })),
  };
  return await graphFetch(`/users/${encodeURIComponent(opts.userEmail)}/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });
}

/**
 * Is Graph configured? Returns false if tenant/client IDs are placeholder values.
 */
export function isGraphConfigured(): boolean {
  return (
    !!process.env.GRAPH_TENANT_ID &&
    process.env.GRAPH_TENANT_ID !== "YOUR_AZURE_TENANT_ID" &&
    !!process.env.GRAPH_CLIENT_ID &&
    process.env.GRAPH_CLIENT_ID !== "YOUR_AZURE_APP_CLIENT_ID" &&
    !!process.env.GRAPH_CLIENT_SECRET &&
    process.env.GRAPH_CLIENT_SECRET !== "YOUR_AZURE_APP_CLIENT_SECRET"
  );
}
