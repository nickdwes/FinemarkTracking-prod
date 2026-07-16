import "isomorphic-fetch";
import { ConfidentialClientApplication, Configuration } from "@azure/msal-node";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let _msalApp: ConfidentialClientApplication | null = null;

function getMsalApp(): ConfidentialClientApplication {
  if (_msalApp) return _msalApp;
  const config: Configuration = {
    auth: {
      clientId:     process.env.GRAPH_CLIENT_ID     || "",
      authority:    `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || ""}`,
      clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
    },
  };
  _msalApp = new ConfidentialClientApplication(config);
  return _msalApp;
}

async function getToken(): Promise<string> {
  const result = await getMsalApp().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) throw new Error("Graph: failed to acquire token");
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
    throw new Error(`Graph API error ${res.status}: ${body}`);
  }
  if (res.status === 204 || res.status === 202) return null;
  return res.json().catch(() => null);
}

export function isMailConfigured(): boolean {
  return !!(
    process.env.GRAPH_CLIENT_ID &&
    process.env.GRAPH_TENANT_ID &&
    process.env.GRAPH_CLIENT_SECRET
  );
}

export interface SendOTPEmailOptions {
  to:      string;
  otp:     string;
  name?:   string;
}

export async function sendOTPEmail({ to, otp, name }: SendOTPEmailOptions): Promise<void> {
  const fromMailbox = process.env.GRAPH_OTP_MAILBOX || process.env.GRAPH_CUSTOMER_MAILBOX || "customer@finemarktracking.co.ke";
  const firstName = name ? name.split(" ")[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";
  const year = new Date().getFullYear();

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Your Finemark sign-in code</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;">

        <!-- ── Logo header ── -->
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding-right:10px;vertical-align:middle;">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="44" height="44" style="display:block;">
                    <path d="M44 60c40-36 128-36 168 0" fill="none" stroke="#2f3c93" stroke-width="12" stroke-linecap="round"/>
                    <path d="M56 84c32-28 112-28 144 0" fill="none" stroke="#2fa9df" stroke-width="16" stroke-linecap="round"/>
                    <text x="28" y="190" font-family="Arial,sans-serif" font-size="120" font-weight="700" fill="#2f3c93">F</text>
                    <text x="118" y="190" font-family="Arial,sans-serif" font-size="120" font-weight="700" fill="#2fa9df">M</text>
                    <path fill="#2f3c93" d="M168 104c0-22.1-17.9-40-40-40s-40 17.9-40 40c0 30 40 78 40 78s40-48 40-78z"/>
                    <circle fill="#2fa9df" cx="128" cy="104" r="18"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;">
                  <span style="font-size:20px;font-weight:700;color:#2f3c93;letter-spacing:-0.3px;">Finemark</span><br/>
                  <span style="font-size:11px;color:#64748b;font-weight:500;letter-spacing:0.5px;text-transform:uppercase;">Customer Portal</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── Main card ── -->
        <tr>
          <td style="background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;
                     box-shadow:0 4px 24px rgba(47,60,147,0.08);overflow:hidden;">

            <!-- Blue accent bar -->
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="background:linear-gradient(90deg,#2f3c93 0%,#2fa9df 100%);height:5px;font-size:0;line-height:0;">&nbsp;</td>
              </tr>
            </table>

            <!-- Body -->
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:36px 40px 32px;">

                  <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#1e293b;">Your sign-in code</p>
                  <p style="margin:0 0 4px;font-size:15px;color:#334155;">${greeting}</p>
                  <p style="margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.6;">
                    Use the verification code below to sign in to the
                    <strong style="color:#2f3c93;">Finemark Customer Portal</strong>.
                    This code is valid for <strong>10&nbsp;minutes</strong> and can only be used once.
                  </p>

                  <!-- OTP box -->
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td align="center" style="background:#eef2ff;border:2px solid #c7d2fe;border-radius:12px;padding:28px 16px;">
                        <span style="font-size:48px;font-weight:700;letter-spacing:14px;color:#2f3c93;
                                     font-family:'Courier New',Courier,monospace;">${otp}</span>
                      </td>
                    </tr>
                  </table>

                  <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;text-align:center;">
                    Do not share this code with anyone. Finemark staff will never ask for your OTP.
                  </p>

                </td>
              </tr>
            </table>

            <!-- ── Caution banner ── -->
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="background:#fffbeb;border-top:1px solid #fde68a;padding:18px 40px;">
                  <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#92400e;">
                    &#9888;&nbsp; Did not request this code?
                  </p>
                  <p style="margin:0;font-size:13px;color:#78350f;line-height:1.55;">
                    If you did <strong>not</strong> initiate this sign-in, your account may be at risk.
                    Please report this immediately to&nbsp;
                    <a href="mailto:admin@finemarktracking.co.ke"
                       style="color:#b45309;font-weight:600;text-decoration:underline;">admin@finemarktracking.co.ke</a>
                    so we can secure your account.
                  </p>
                </td>
              </tr>
            </table>

            <!-- ── Authorised-use notice ── -->
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 40px 28px;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;">
                    Authorised Use Only
                  </p>
                  <p style="margin:0;font-size:12px;color:#64748b;line-height:1.6;">
                    Access to the Finemark Customer Portal is granted solely to authorised customers and
                    their nominated representatives. All sessions are monitored and logged. Unauthorised
                    access or misuse of this system is prohibited and may result in account suspension and
                    legal action. By signing in you accept full responsibility for all activity conducted
                    under your account.
                  </p>
                </td>
              </tr>
            </table>

          </td>
        </tr>

        <!-- ── Footer ── -->
        <tr>
          <td style="padding:24px 0 8px;text-align:center;">
            <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;">
              &copy; ${year}&nbsp;Finemark Tracking Ltd &middot; Nairobi, Kenya
            </p>
            <p style="margin:0;font-size:11px;color:#cbd5e1;">
              This is an automated message &mdash; please do not reply directly to this email.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();

  await graphFetch(`/users/${encodeURIComponent(fromMailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: "Your Finemark Customer Portal verification code",
        body: { contentType: "HTML", content: htmlBody },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
}
