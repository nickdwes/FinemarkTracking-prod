/**
 * Finemark branded HTML email templates
 * Brand: blue #2f3c93 | cyan #2fa9df
 */

const LOGO_URL = (process.env.WEBHOOK_BASE_URL || "https://portalbuild.finemarktracking.co.ke") + "/public/finemark-logo.png";
const LOGO_SVG = `<img src="${LOGO_URL}" width="52" height="52" alt="Finemark" style="display:block;border:0"/>`;

const fmt = (n: number) =>
  `KES ${Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function baseLayout(opts: {
  preheader: string;
  headerLabel: string;
  headerColor: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${opts.headerLabel} — Fine Mark Tracking Limited</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">

<!-- Preheader -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${opts.preheader}&nbsp;‌&zwnj;&nbsp;‌&zwnj;&nbsp;‌&zwnj;</div>

<!-- Wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f4f8;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">

      <!-- Header card -->
      <tr>
        <td style="background:linear-gradient(135deg,#2f3c93 0%,#1d2a6e 55%,#2fa9df 100%);border-radius:16px 16px 0 0;padding:32px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;padding-right:20px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="background:white;border-radius:12px;padding:8px 10px;display:inline-block">
                      ${LOGO_SVG}
                    </td>
                    <td style="padding-left:14px;vertical-align:middle">
                      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.2px;line-height:1.2">Fine Mark Tracking Limited</div>
                      <div style="color:#a5c8f0;font-size:12px;margin-top:2px">customer@finemarktracking.co.ke</div>
                    </td>
                  </tr>
                </table>
              </td>
              <td align="right" style="vertical-align:middle">
                <span style="display:inline-block;background:rgba(255,255,255,0.18);border:1.5px solid rgba(255,255,255,0.35);border-radius:20px;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1.2px;padding:5px 14px;text-transform:uppercase">${opts.headerLabel}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Cyan accent bar -->
      <tr>
        <td style="background:linear-gradient(90deg,#2fa9df,#2f3c93);height:4px;line-height:4px;font-size:0">&nbsp;</td>
      </tr>

      <!-- Body card -->
      <tr>
        <td style="background:#ffffff;border-radius:0 0 16px 16px;padding:36px 40px">
          ${opts.body}
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding:24px 0 8px 0;text-align:center">
          <p style="margin:0 0 6px 0;color:#64748b;font-size:12px">Fine Mark Tracking Limited &bull; Titan Impex Complex, 1s floor Rm 101, Alpha Road, Eastern Bypass, Nairobi</p>
          <p style="margin:0;color:#94a3b8;font-size:11px">P.O. Box 716-00618 &bull; <a href="mailto:admin@finemarktracking.co.ke" style="color:#2fa9df;text-decoration:none">admin@finemarktracking.co.ke</a> &bull; <a href="https://www.finemarktracking.co.ke" style="color:#2fa9df;text-decoration:none">www.finemarktracking.co.ke</a></p>
          <p style="margin:8px 0 0 0;color:#cbd5e1;font-size:10px">This email and any attachments are confidential and intended solely for the named recipient.</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   QUOTE EMAIL
───────────────────────────────────────────────────────────────────────────── */
export function buildQuoteEmail(params: {
  customerName: string;
  quoteNo: string;
  grandTotal: number;
  expiryDate?: string | null;
  salesRep?: string | null;
  serviceType?: string | null;
  notes?: string | null;
}): string {
  const expiry = params.expiryDate ? String(params.expiryDate).slice(0, 10) : "N/A";
  const preheader = `Quotation ${params.quoteNo} — ${fmt(params.grandTotal)} — Valid until ${expiry}`;

  const body = `
    <h2 style="margin:0 0 6px 0;font-size:22px;color:#1e293b">Dear ${escHtml(params.customerName)},</h2>
    <p style="margin:0 0 20px 0;color:#475569;font-size:15px;line-height:1.6">
      Thank you for your interest in <strong style="color:#2f3c93">Fine Mark Tracking Limited</strong>.<br/>
      Please find your quotation details below and the formal quote attached as a PDF.
    </p>

    <!-- Summary box -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8faff;border:1.5px solid #dde9ff;border-radius:12px;margin-bottom:24px">
      <tr>
        <td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="33%" style="text-align:center;padding:12px 8px;border-right:1px solid #dde9ff">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Quote No.</div>
                <div style="color:#2f3c93;font-size:16px;font-weight:700">${escHtml(params.quoteNo)}</div>
              </td>
              <td width="33%" style="text-align:center;padding:12px 8px;border-right:1px solid #dde9ff">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Total Amount</div>
                <div style="color:#059669;font-size:16px;font-weight:700">${fmt(params.grandTotal)}</div>
              </td>
              <td width="33%" style="text-align:center;padding:12px 8px">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Valid Until</div>
                <div style="color:#dc2626;font-size:16px;font-weight:700">${escHtml(expiry)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${params.serviceType ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px">
      <tr>
        <td style="padding:10px 16px;background:#f0f9ff;border-left:4px solid #2fa9df;border-radius:0 8px 8px 0">
          <span style="color:#0369a1;font-size:13px"><strong>Service Type:</strong> ${escHtml(params.serviceType)}</span>
        </td>
      </tr>
    </table>` : ""}

    ${params.notes ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px">
      <tr>
        <td style="padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
          <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5"><strong>Notes:</strong> ${escHtml(params.notes)}</p>
        </td>
      </tr>
    </table>` : ""}

    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px 0">
      Please review the attached PDF quotation. If you have any questions or would like to proceed, 
      do not hesitate to contact us.
    </p>

    <!-- CTA -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px">
      <tr>
        <td style="background:linear-gradient(135deg,#2f3c93,#2fa9df);border-radius:8px;padding:1px">
          <a href="mailto:customer@finemarktracking.co.ke" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#2f3c93,#2fa9df);border-radius:7px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.3px">Reply to Accept or Enquire →</a>
        </td>
      </tr>
    </table>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
    <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
      Warm regards,<br/>
      <strong style="color:#2f3c93">${escHtml(params.salesRep || "Finemark Sales Team")}</strong><br/>
      <span style="color:#2fa9df">Fine Mark Tracking Limited</span>
    </p>`;

  return baseLayout({ preheader, headerLabel: "Quotation", headerColor: "#2f3c93", body });
}

/* ─────────────────────────────────────────────────────────────────────────────
   INVOICE EMAIL
───────────────────────────────────────────────────────────────────────────── */
export function buildInvoiceEmail(params: {
  customerName: string;
  invoiceNo: string;
  total: number;
  dueOn?: string | null;
  message?: string | null;
}): string {
  const due = params.dueOn ? String(params.dueOn).slice(0, 10) : "N/A";
  const preheader = `Invoice ${params.invoiceNo} — ${fmt(params.total)} — Due ${due}`;

  const body = `
    <h2 style="margin:0 0 6px 0;font-size:22px;color:#1e293b">Dear ${escHtml(params.customerName)},</h2>
    <p style="margin:0 0 20px 0;color:#475569;font-size:15px;line-height:1.6">
      Please find your invoice from <strong style="color:#2f3c93">Fine Mark Tracking Limited</strong> attached to this email.
    </p>

    <!-- Summary box -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8faff;border:1.5px solid #dde9ff;border-radius:12px;margin-bottom:24px">
      <tr>
        <td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" style="text-align:center;padding:12px 8px;border-right:1px solid #dde9ff">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Invoice No.</div>
                <div style="color:#2f3c93;font-size:18px;font-weight:700">${escHtml(params.invoiceNo)}</div>
              </td>
              <td width="50%" style="text-align:center;padding:12px 8px">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Amount Due</div>
                <div style="color:#dc2626;font-size:18px;font-weight:700">${fmt(params.total)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Due date banner -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
      <tr>
        <td style="padding:12px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;text-align:center">
          <span style="color:#c2410c;font-size:14px;font-weight:600">⏰ Payment due by: ${escHtml(due)}</span>
        </td>
      </tr>
    </table>

    <!-- Payment info -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8faff;border:1.5px solid #dde9ff;border-radius:12px;margin-bottom:24px">
      <tr><td style="padding:16px 20px">
        <p style="margin:0 0 10px 0;color:#2f3c93;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px">Payment Options</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="48%" style="vertical-align:top;padding-right:12px">
              <p style="margin:0 0 4px 0;color:#475569;font-size:12px;font-weight:600">MPESA Paybill</p>
              <p style="margin:0;color:#1e293b;font-size:14px;font-weight:700">4048569</p>
              <p style="margin:2px 0 0 0;color:#64748b;font-size:12px">Account: Vehicle Registration</p>
            </td>
            <td width="4%" style="border-right:1px solid #dde9ff">&nbsp;</td>
            <td width="48%" style="vertical-align:top;padding-left:12px">
              <p style="margin:0 0 4px 0;color:#475569;font-size:12px;font-weight:600">Bank Transfer</p>
              <p style="margin:0;color:#1e293b;font-size:14px;font-weight:700">COOP BANK</p>
              <p style="margin:2px 0 0 0;color:#64748b;font-size:12px">Acc: 01101172442001</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    ${params.message ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px 0">${escHtml(params.message)}</p>` : ""}

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
    <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
      Warm regards,<br/>
      <strong style="color:#2f3c93">Fine Mark Tracking Limited — Finance Team</strong><br/>
      <span style="color:#2fa9df">customer@finemarktracking.co.ke</span>
    </p>`;

  return baseLayout({ preheader, headerLabel: "Invoice", headerColor: "#2f3c93", body });
}

/* ─────────────────────────────────────────────────────────────────────────────
   INVOICE REMINDER EMAIL
───────────────────────────────────────────────────────────────────────────── */
export function buildInvoiceReminderEmail(params: {
  customerName: string;
  invoiceNo: string;
  total: number;
  dueOn?: string | null;
  message?: string | null;
}): string {
  const due = params.dueOn ? String(params.dueOn).slice(0, 10) : "N/A";
  const preheader = `Payment reminder: Invoice ${params.invoiceNo} — ${fmt(params.total)}`;

  const body = `
    <h2 style="margin:0 0 6px 0;font-size:22px;color:#1e293b">Dear ${escHtml(params.customerName)},</h2>
    <p style="margin:0 0 20px 0;color:#475569;font-size:15px;line-height:1.6">
      This is a payment reminder for your invoice from <strong style="color:#2f3c93">Fine Mark Tracking Limited</strong>.
    </p>

    <!-- Summary box with alert styling -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;margin-bottom:24px">
      <tr>
        <td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" style="text-align:center;padding:12px 8px;border-right:1px solid #fecaca">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Invoice No.</div>
                <div style="color:#dc2626;font-size:18px;font-weight:700">${escHtml(params.invoiceNo)}</div>
              </td>
              <td width="50%" style="text-align:center;padding:12px 8px">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Amount Due</div>
                <div style="color:#dc2626;font-size:18px;font-weight:700">${fmt(params.total)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Due date banner -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
      <tr>
        <td style="padding:12px 16px;background:#fef08a;border:1px solid #fcd34d;border-radius:8px;text-align:center">
          <span style="color:#b45309;font-size:14px;font-weight:600">⏰ Payment due by: ${escHtml(due)}</span>
        </td>
      </tr>
    </table>

    <!-- Custom message -->
    ${params.message ? `<div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:16px;margin-bottom:24px">
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.6;white-space:pre-wrap">${escHtml(params.message)}</p>
    </div>` : ""}

    <!-- Payment instructions -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8faff;border:1.5px solid #dde9ff;border-radius:12px;margin-bottom:24px">
      <tr><td style="padding:16px 20px">
        <p style="margin:0 0 10px 0;color:#2f3c93;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px">Payment Options</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="48%" style="vertical-align:top;padding-right:12px">
              <p style="margin:0 0 4px 0;color:#475569;font-size:12px;font-weight:600">MPESA Paybill</p>
              <p style="margin:0;color:#1e293b;font-size:14px;font-weight:700">4048569</p>
              <p style="margin:2px 0 0 0;color:#64748b;font-size:12px">Account: Vehicle Registration</p>
            </td>
            <td width="4%" style="border-right:1px solid #dde9ff">&nbsp;</td>
            <td width="48%" style="vertical-align:top;padding-left:12px">
              <p style="margin:0 0 4px 0;color:#475569;font-size:12px;font-weight:600">Bank Transfer</p>
              <p style="margin:0;color:#1e293b;font-size:14px;font-weight:700">COOP BANK</p>
              <p style="margin:2px 0 0 0;color:#64748b;font-size:12px">Acc: 01101172442001</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
    <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
      For payment inquiries or assistance, please contact us.<br/>
      <strong style="color:#2f3c93">Fine Mark Tracking Limited — Finance Team</strong><br/>
      <span style="color:#2fa9df">customer@finemarktracking.co.ke</span>
    </p>`;

  return baseLayout({ preheader, headerLabel: "Payment Reminder", headerColor: "#dc2626", body });
}

/* ─────────────────────────────────────────────────────────────────────────────
   CERTIFICATE EMAIL
───────────────────────────────────────────────────────────────────────────── */
export function buildCertificateEmail(params: {
  vehicleReg?: string | null;
  serialNo?: string | null;
  message?: string | null;
}): string {
  const vehicle = params.vehicleReg || params.serialNo || "your vehicle";
  const preheader = `Certificate of Installation — ${vehicle} — Fine Mark Tracking Limited`;

  const body = `
    <h2 style="margin:0 0 6px 0;font-size:22px;color:#1e293b">Certificate of Installation</h2>
    <p style="margin:0 0 20px 0;color:#475569;font-size:15px;line-height:1.6">
      Your GPS tracking device has been successfully installed by 
      <strong style="color:#2f3c93">Fine Mark Tracking Limited</strong>. 
      Please find the Certificate of Installation attached to this email.
    </p>

    <!-- Vehicle card -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border:1.5px solid #bae6fd;border-radius:12px;margin-bottom:24px">
      <tr>
        <td style="padding:20px 24px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🚗</div>
          <div style="color:#0369a1;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px">Vehicle Registration</div>
          <div style="color:#2f3c93;font-size:24px;font-weight:700;letter-spacing:2px">${escHtml(vehicle.toUpperCase())}</div>
        </td>
      </tr>
    </table>

    <!-- Checkmarks -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
      ${["GPS Tracker Installed & Configured","Device Serial Number Recorded","Vehicle Registration Confirmed","System Connectivity Verified"].map(item => `
      <tr><td style="padding:6px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="width:24px;vertical-align:top">
            <span style="display:inline-block;width:20px;height:20px;background:#dcfce7;border-radius:50%;text-align:center;line-height:20px;font-size:11px;color:#16a34a;font-weight:700">✓</span>
          </td>
          <td style="padding-left:10px;vertical-align:middle;color:#374151;font-size:14px">${item}</td>
        </tr></table>
      </td></tr>`).join("")}
    </table>

    ${params.message ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px 0">${escHtml(params.message)}</p>` : ""}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
      <tr>
        <td style="padding:12px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
          <p style="margin:0;color:#166534;font-size:13px;line-height:1.5">
            📞 For technical support or queries, contact us at 
            <a href="mailto:admin@finemarktracking.co.ke" style="color:#2fa9df;text-decoration:none">admin@finemarktracking.co.ke</a>
          </p>
        </td>
      </tr>
    </table>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
    <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
      Warm regards,<br/>
      <strong style="color:#2f3c93">Fine Mark Tracking Limited — Technical Team</strong><br/>
      <span style="color:#2fa9df">admin@finemarktracking.co.ke</span>
    </p>`;

  return baseLayout({ preheader, headerLabel: "Certificate", headerColor: "#2f3c93", body });
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROFORMA INVOICE EMAIL
───────────────────────────────────────────────────────────────────────────── */
export function buildProformaEmail(params: {
  customerName: string;
  proformaNo: string;
  totalAmount: number;
  installationCost?: number;
  subscriptionFee?: number;
  taxRate?: number;
  discountAmount?: number;
  status?: string;
  salesRep?: string | null;
  notes?: string | null;
  approvalUrl?: string | null;
  items?: Array<{ deviceModel: string; deviceType?: string; quantity: number; unitPrice: number; totalPrice: number }>;
}): string {
  const preheader = `Proforma Invoice ${params.proformaNo} — ${fmt(params.totalAmount)} — Fine Mark Tracking Limited`;

  const itemRows = (params.items || []).map(it => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#1e293b;font-size:13px">${escHtml(it.deviceModel)}${it.deviceType ? ` <span style="color:#64748b;font-size:11px">(${escHtml(it.deviceType)})</span>` : ""}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;color:#475569;font-size:13px">${it.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;color:#475569;font-size:13px">${fmt(it.unitPrice)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;color:#1e293b;font-size:13px">${fmt(it.totalPrice)}</td>
    </tr>`).join("");

  const body = `
    <h2 style="margin:0 0 6px 0;font-size:22px;color:#1e293b">Dear ${escHtml(params.customerName)},</h2>
    <p style="margin:0 0 20px 0;color:#475569;font-size:15px;line-height:1.6">
      Thank you for choosing <strong style="color:#2f3c93">Fine Mark Tracking Limited</strong>.<br/>
      Please find your Proforma Invoice below for your review and records.
    </p>

    <!-- Summary bar -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8faff;border:1.5px solid #dde9ff;border-radius:12px;margin-bottom:24px">
      <tr>
        <td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" style="text-align:center;padding:12px 8px;border-right:1px solid #dde9ff">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Proforma No.</div>
                <div style="color:#2f3c93;font-size:18px;font-weight:700">${escHtml(params.proformaNo)}</div>
              </td>
              <td width="50%" style="text-align:center;padding:12px 8px">
                <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Total Amount</div>
                <div style="color:#059669;font-size:18px;font-weight:700">${fmt(params.totalAmount)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${itemRows ? `
    <!-- Line items table -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px">
      <thead>
        <tr style="background:#f8faff">
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;font-weight:600">Device</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;font-weight:600">Qty</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;font-weight:600">Unit Price</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;font-weight:600">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>` : ""}

    <!-- Cost breakdown -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
      <tr><td align="right">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="min-width:260px">
          ${params.installationCost != null ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px">Installation Cost</td><td style="padding:4px 0 4px 24px;text-align:right;color:#1e293b;font-size:13px">${fmt(params.installationCost)}</td></tr>` : ""}
          ${params.subscriptionFee != null ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px">Subscription / mo</td><td style="padding:4px 0 4px 24px;text-align:right;color:#1e293b;font-size:13px">${fmt(params.subscriptionFee)}</td></tr>` : ""}
          ${params.taxRate != null ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px">Tax (${params.taxRate}%)</td><td style="padding:4px 0 4px 24px;text-align:right;color:#1e293b;font-size:13px"></td></tr>` : ""}
          ${params.discountAmount ? `<tr><td style="padding:4px 0;color:#16a34a;font-size:13px">Discount</td><td style="padding:4px 0 4px 24px;text-align:right;color:#16a34a;font-size:13px">- ${fmt(params.discountAmount)}</td></tr>` : ""}
          <tr><td colspan="2" style="padding:6px 0"><hr style="border:none;border-top:2px solid #e2e8f0"/></td></tr>
          <tr><td style="padding:4px 0;font-weight:700;color:#1e293b;font-size:15px">Grand Total</td><td style="padding:4px 0 4px 24px;text-align:right;font-weight:700;color:#059669;font-size:15px">${fmt(params.totalAmount)}</td></tr>
        </table>
      </td></tr>
    </table>

    ${params.notes ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
      <tr><td style="padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
        <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5"><strong>Notes:</strong> ${escHtml(params.notes)}</p>
      </td></tr>
    </table>` : ""}

    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px 0">
      To proceed or for any queries, please reply to this email or contact us directly.
    </p>

    ${params.approvalUrl ? `
    <!-- One-time approval CTA -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;margin-bottom:24px">
      <tr>
        <td style="padding:20px 24px;text-align:center">
          <p style="margin:0 0 6px 0;color:#15803d;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px">✅ Ready to proceed?</p>
          <p style="margin:0 0 16px 0;color:#166534;font-size:14px;line-height:1.5">Click the button below to digitally confirm your approval of this proforma invoice. This is a secure, one-time link valid for 30 days.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
            <tr>
              <td bgcolor="#15803d" style="background-color:#15803d;border-radius:8px;mso-padding-alt:0">
                <a href="${params.approvalUrl}" target="_blank" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:.3px">Approve Proforma →</a>
              </td>
            </tr>
          </table>
          <p style="margin:12px 0 0 0;color:#6b7280;font-size:11px">If the button does not work, copy and paste this link into your browser:<br/><span style="color:#2f3c93;word-break:break-all">${params.approvalUrl}</span></p>
        </td>
      </tr>
    </table>
    <p style="color:#94a3b8;font-size:11px;text-align:center;margin:-16px 0 20px 0">This link can only be used once and expires in 30 days. If it has expired, please contact your sales representative.</p>
    ` : `
    <!-- Fallback CTA when no token (e.g. resend without new token) -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px">
      <tr>
        <td bgcolor="#2f3c93" style="background-color:#2f3c93;border-radius:8px;mso-padding-alt:0">
          <a href="mailto:customer@finemarktracking.co.ke" target="_blank" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.3px">Reply to Accept or Enquire →</a>
        </td>
      </tr>
    </table>`}

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
    <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
      Warm regards,<br/>
      <strong style="color:#2f3c93">${escHtml(params.salesRep || "Finemark Sales Team")}</strong><br/>
      <span style="color:#2fa9df">Fine Mark Tracking Limited</span>
    </p>`;

  return baseLayout({ preheader, headerLabel: "Proforma Invoice", headerColor: "#2f3c93", body });
}

function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
