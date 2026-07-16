import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { pgGet, pgAll, pgRun, pgExec } from "../db.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { renderInvoicePdf } from "./invoices.js";
import { isGraphConfigured, sendEmailViaGraph } from "../services/graphMailService.js";
import { partnerAuthLimiter } from "../middleware/rateLimit.js";

const router = Router();

const SESSION_DAYS = 7;
const OTP_MINUTES = 10;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
const RESET_TOKEN_MINUTES = 60;

// Lightweight route-owned migrations for partner portal settings and password reset.
setTimeout(async () => {
  await pgExec(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS portal_logo_url TEXT`).catch(() => {});
  await pgExec(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS portal_primary_color TEXT`).catch(() => {});
  await pgExec(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS portal_theme_json TEXT`).catch(() => {});
  await pgExec(`
    CREATE TABLE IF NOT EXISTS partner_password_reset_tokens (
      id TEXT PRIMARY KEY,
      partner_user_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )
  `).catch(() => {});
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_partner_prt_user ON partner_password_reset_tokens(partner_user_id)`).catch(() => {});
}, 1200);

// ─── Auth utilities ───────────────────────────────────────────────────────────

const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateResetToken = () => crypto.randomBytes(40).toString("base64url");
const maskEmail = (email: string) => {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

function portalBaseUrl(req: any): string {
  const envBase = process.env.FRONTEND_URL || "";
  if (envBase.trim()) return envBase.replace(/\/$/, "");
  const host = req.headers.host || "localhost:5500";
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

async function requirePartnerAuth(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return errorResponse(res, 401, "UNAUTHORIZED", "No token provided");
  }

  const token = auth.slice(7);
  const hash = hashToken(token);

  const session = await pgGet(
    `SELECT ps.*, pu.id AS user_id, pu.email, pu.full_name, pu.role,
            pu.partner_id, pu.status AS user_status, pu.notify_email, pu.notify_sms
     FROM partner_sessions ps
     JOIN partner_users pu ON pu.id = ps.partner_user_id
     WHERE ps.token_hash = ? AND ps.expires_at > now()`,
    [hash]
  );

  if (!session) return errorResponse(res, 401, "UNAUTHORIZED", "Invalid or expired session");
  if (session.user_status !== "Active") return errorResponse(res, 403, "FORBIDDEN", "Account is disabled");

  await pgRun(`UPDATE partner_sessions SET last_active_at = now() WHERE token_hash = ?`, [hash]).catch(() => {});

  req.partnerUser = {
    id: session.user_id,
    email: session.email,
    fullName: session.full_name,
    role: session.role,
    partnerId: session.partner_id,
  };
  next();
}

async function portalAudit(opts: {
  eventType: string; userId: string; partnerId: string | null; action: string; req: any;
}) {
  try {
    await pgRun(
      `INSERT INTO partner_audit_logs (id, event_id, event_type, timestamp, user_id, user_role, partner_id, source_ip, device_agent, module, action)
       VALUES (?, ?, ?, now(), ?, 'PartnerUser', ?, ?, ?, 'PartnerPortal', ?)`,
      [uuidv4(), uuidv4(), opts.eventType, opts.userId, opts.partnerId,
       opts.req.ip || null, opts.req.headers?.["user-agent"] || null, opts.action]
    );
  } catch (_) {}
}

// ─── Login — step 1 (password) ────────────────────────────────────────────────

router.post("/auth/login", partnerAuthLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return errorResponse(res, 400, "VALIDATION_ERROR", "Email and password required");

  const user = await pgGet(
    `SELECT * FROM partner_users WHERE email = ?`,
    [email.toLowerCase().trim()]
  );

  if (!user || user.status !== "Active") {
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid credentials");
  }

  // Check lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return errorResponse(res, 429, "ACCOUNT_LOCKED", "Account temporarily locked. Please try again later.");
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    const attempts = (user.login_attempts || 0) + 1;
    const locked_until = attempts >= MAX_LOGIN_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString()
      : null;
    await pgRun(
      `UPDATE partner_users SET login_attempts = ?, locked_until = ?, updated_at = now() WHERE id = ?`,
      [attempts, locked_until, user.id]
    );
    await portalAudit({ eventType: "LOGIN_FAILURE", userId: user.id, partnerId: user.partner_id, action: "LOGIN_FAILED", req });
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid credentials");
  }

  // Reset failed attempts
  await pgRun(`UPDATE partner_users SET login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = ?`, [user.id]);

  // Generate OTP
  const otp = generateOtp();
  const otpHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + OTP_MINUTES * 60000).toISOString();

  // Invalidate previous unused OTPs
  await pgRun(`UPDATE partner_otp SET used = true WHERE partner_user_id = ? AND NOT used`, [user.id]);

  await pgRun(
    `INSERT INTO partner_otp (id, partner_user_id, otp_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [uuidv4(), user.id, otpHash, expiresAt]
  );

  // Send OTP via email (Microsoft Graph). Falls back to a console log only when Graph isn't configured.
  const otpMailbox = process.env.GRAPH_OTP_MAILBOX;
  if (isGraphConfigured() && otpMailbox) {
    await sendEmailViaGraph({
      fromMailbox: otpMailbox,
      to: user.email,
      subject: "Your Finemark Partner Portal sign-in code",
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#0f766e;padding:24px 32px;border-radius:12px 12px 0 0">
            <h1 style="color:#fff;font-size:20px;margin:0">Partner Portal Sign-In Code</h1>
          </div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 12px 12px">
            <p style="color:#334155;font-size:15px">Hi ${user.full_name || user.email},</p>
            <p style="color:#334155;font-size:15px">Use the code below to sign in to the Finemark Partner Portal. This code expires in <strong>${OTP_MINUTES} minutes</strong>.</p>
            <div style="text-align:center;margin:32px 0">
              <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 40px;font-size:36px;font-weight:700;letter-spacing:10px;color:#0f172a;font-family:monospace">${otp}</span>
            </div>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:12px">If you didn't request this code, you can safely ignore this email.</p>
          </div>
        </div>`,
    }).catch(e => console.error("[partner-portal] Failed to send OTP email:", e.message));
  } else {
    console.log(`[PARTNER-OTP] Graph not configured — OTP for ${user.email}: ${otp}`);
  }
  await portalAudit({ eventType: "OTP_SENT", userId: user.id, partnerId: user.partner_id, action: "OTP_GENERATED", req });

  const showDevOtp = process.env.NODE_ENV !== "production" || process.env.DEV_SHOW_OTP === "true";
  return ok(res, {
    step: "otp_required",
    userId: user.id,
    email: maskEmail(user.email),
    message: `A verification code has been sent to ${maskEmail(user.email)}`,
    ...(showDevOtp ? { devOtp: otp } : {}),
  });
});

// ─── Verify OTP — step 2 ──────────────────────────────────────────────────────

router.post("/auth/verify-otp", partnerAuthLimiter, async (req, res) => {
  const { userId, otp } = req.body;
  if (!userId || !otp) return errorResponse(res, 400, "VALIDATION_ERROR", "userId and otp required");

  const otpHash = hashToken(String(otp).trim());
  const record = await pgGet(
    `SELECT * FROM partner_otp WHERE partner_user_id = ? AND otp_hash = ? AND NOT used AND expires_at > now()`,
    [userId, otpHash]
  );

  if (!record) {
    await portalAudit({ eventType: "OTP_FAILURE", userId, partnerId: null, action: "OTP_INVALID", req });
    return errorResponse(res, 401, "INVALID_OTP", "Invalid or expired verification code");
  }

  // Mark OTP as used
  await pgRun(`UPDATE partner_otp SET used = true WHERE id = ?`, [record.id]);

  const user = await pgGet(`SELECT * FROM partner_users WHERE id = ? AND status = 'Active'`, [userId]);
  if (!user) return errorResponse(res, 403, "FORBIDDEN", "Account not active");

  // Create session token
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  await pgRun(
    `INSERT INTO partner_sessions (id, partner_user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), userId, tokenHash, expiresAt, req.ip || null, req.headers["user-agent"] || null]
  );

  await pgRun(`UPDATE partner_users SET last_login_at = now(), updated_at = now() WHERE id = ?`, [userId]);

  const partner = await pgGet(`SELECT id, name, tier, status FROM partners WHERE id = ?`, [user.partner_id]);
  await portalAudit({ eventType: "LOGIN_SUCCESS", userId: user.id, partnerId: user.partner_id, action: "LOGIN", req });

  return ok(res, {
    accessToken: token,
    expiresAt,
    user: {
      id: user.id, email: user.email, fullName: user.full_name,
      role: user.role, partnerId: user.partner_id,
      partnerName: partner?.name, partnerTier: partner?.tier,
    },
  });
});

router.post("/auth/forgot-password", async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  if (!email) return errorResponse(res, 400, "VALIDATION_ERROR", "email is required");

  const user = await pgGet(`SELECT id, email, partner_id FROM partner_users WHERE email = ?`, [email]);
  if (!user) return ok(res, { message: "If an account exists, a reset link has been generated." });

  const now = new Date().toISOString();
  const rawToken = generateResetToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60000).toISOString();

  await pgRun(
    `UPDATE partner_password_reset_tokens SET used_at = ? WHERE partner_user_id = ? AND used_at IS NULL`,
    [now, user.id]
  ).catch(() => {});

  await pgRun(
    `INSERT INTO partner_password_reset_tokens (id, partner_user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), user.id, tokenHash, expiresAt, now]
  );

  const link = `${portalBaseUrl(req)}/partner-portal-reset-password.html?token=${encodeURIComponent(rawToken)}`;
  // If no outbound mail service is configured for partner portal, log reset link for support/admin ops.
  console.log(`[PARTNER-RESET] ${user.email} -> ${link}`);

  await portalAudit({ eventType: "PASSWORD_RESET_REQUESTED", userId: user.id, partnerId: user.partner_id, action: "FORGOT_PASSWORD", req });
  return ok(res, { message: "If an account exists, a reset link has been generated." });
});

router.post("/auth/reset-password", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const newPassword = String(req.body?.newPassword || "");
  if (!token || !newPassword) return errorResponse(res, 400, "VALIDATION_ERROR", "token and newPassword required");
  if (newPassword.length < 8) return errorResponse(res, 400, "VALIDATION_ERROR", "Password must be at least 8 characters");

  const tokenHash = hashToken(token);
  const record = await pgGet(`SELECT * FROM partner_password_reset_tokens WHERE token_hash = ?`, [tokenHash]);
  if (!record || record.used_at) return errorResponse(res, 400, "INVALID_TOKEN", "This reset link is invalid or already used.");
  if (new Date(record.expires_at).getTime() < Date.now()) return errorResponse(res, 400, "TOKEN_EXPIRED", "This reset link has expired.");

  const user = await pgGet(`SELECT id, partner_id FROM partner_users WHERE id = ?`, [record.partner_user_id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found");

  const now = new Date().toISOString();
  const hashed = await bcrypt.hash(newPassword, 12);
  await pgRun(`UPDATE partner_users SET password_hash = ?, login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = ?`, [hashed, user.id]);
  await pgRun(`UPDATE partner_password_reset_tokens SET used_at = ? WHERE id = ?`, [now, record.id]);
  await pgRun(`DELETE FROM partner_sessions WHERE partner_user_id = ?`, [user.id]).catch(() => {});

  await portalAudit({ eventType: "PASSWORD_RESET_COMPLETED", userId: user.id, partnerId: user.partner_id, action: "RESET_PASSWORD", req });
  return ok(res, { reset: true }, "Password updated successfully");
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post("/auth/logout", requirePartnerAuth, async (req: any, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) {
    await pgRun(`DELETE FROM partner_sessions WHERE token_hash = ?`, [hashToken(token)]).catch(() => {});
  }
  await portalAudit({ eventType: "LOGOUT", userId: req.partnerUser.id, partnerId: req.partnerUser.partnerId, action: "LOGOUT", req });
  return ok(res, { loggedOut: true });
});

// ─── Me ───────────────────────────────────────────────────────────────────────

router.get("/auth/me", requirePartnerAuth, async (req: any, res) => {
  const user = await pgGet(
    `SELECT pu.*, p.name AS partner_name, p.tier AS partner_tier, p.status AS partner_status
     FROM partner_users pu
     JOIN partners p ON p.id = pu.partner_id
     WHERE pu.id = ?`,
    [req.partnerUser.id]
  );
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found");

  return ok(res, {
    id: user.id, email: user.email, fullName: user.full_name,
    role: user.role, partnerId: user.partner_id,
    partnerName: user.partner_name, partnerTier: user.partner_tier,
    notifyEmail: user.notify_email, notifySms: user.notify_sms,
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get("/dashboard", requirePartnerAuth, async (req: any, res) => {
  const pid = req.partnerUser.partnerId;

  const [vCount, cCount, loanVehicles, recentVehicles, leadsData, financeRows, installationRows] = await Promise.all([
    pgGet(`SELECT count(*) AS n FROM crm_customer_vehicles WHERE partner_id = ? AND deleted_at IS NULL`, [pid]),
    pgGet(`SELECT count(DISTINCT customer_id) AS n FROM crm_customer_vehicles WHERE partner_id = ? AND deleted_at IS NULL`, [pid]),
    pgAll(
      `SELECT v.registration, v.loan_tenure_months, v.loan_start_date,
              cp.full_name AS customer_name, corp.company_name, c.account_no
       FROM crm_customer_vehicles v
       JOIN crm_customers c ON c.id = v.customer_id
       LEFT JOIN crm_individual_profiles cp ON cp.customer_id = v.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
       WHERE v.partner_id = ? AND v.deleted_at IS NULL
         AND v.loan_tenure_months IS NOT NULL AND v.loan_start_date IS NOT NULL
       ORDER BY v.loan_start_date`,
      [pid]
    ),
    pgAll(
      `SELECT v.registration, v.created_at,
              cp.full_name AS individual_name, corp.company_name, c.account_no
       FROM crm_customer_vehicles v
       JOIN crm_customers c ON c.id = v.customer_id
       LEFT JOIN crm_individual_profiles cp ON cp.customer_id = v.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
       WHERE v.partner_id = ? AND v.deleted_at IS NULL
       ORDER BY v.created_at DESC LIMIT 10`,
      [pid]
    ),
    pgAll(
      `SELECT l.id, l.lead_no, l.status, l.lead_source, l.lead_date, l.customer_name,
              l.company_name, l.customer_id, l.created_at,
              cp.full_name AS individual_name
       FROM crm_leads l
       LEFT JOIN crm_customers c ON c.id = l.customer_id
       LEFT JOIN crm_individual_profiles cp ON cp.customer_id = l.customer_id
       WHERE l.partner_id = ? AND l.deleted_at IS NULL
       ORDER BY l.created_at DESC LIMIT 20`,
      [pid]
    ),
    pgAll(
      `SELECT v.registration,
              inv.id AS invoice_id,
              inv.invoice_number,
              inv.status AS invoice_status,
              inv.amount AS invoice_amount,
              inv.currency AS invoice_currency,
              inv.issued_on,
              inv.due_on,
              inv.created_at AS invoice_created_at,
              lat_it.ticket_no
       FROM crm_customer_vehicles v
       LEFT JOIN LATERAL (
         SELECT invoice_id, ticket_no
         FROM installation_tickets
         WHERE vehicle_id = v.id AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) lat_it ON TRUE
       LEFT JOIN invoices inv ON inv.id = lat_it.invoice_id
       WHERE v.partner_id = ? AND v.deleted_at IS NULL
       ORDER BY inv.created_at DESC NULLS LAST, v.created_at DESC`,
      [pid]
    ),
    pgAll(
      `SELECT v.id AS vehicle_id,
              v.registration,
              v.make,
              v.model,
              v.loan_tenure_months,
              v.loan_start_date,
              it.id AS installation_ticket_id,
              it.ticket_no,
              it.status AS installation_status,
              it.invoice_id,
              inv.invoice_number,
              inv.amount AS invoice_amount,
              inv.currency AS invoice_currency,
              it.created_at AS installation_created_at,
              it.updated_at AS installation_updated_at,
              vi.completed_at AS installation_completed_at,
              cert.id AS certificate_id,
              cert.serial_no AS certificate_serial_no,
              cert.end_date AS certificate_expiry
       FROM crm_customer_vehicles v
       LEFT JOIN LATERAL (
         SELECT id, ticket_no, status, invoice_id, created_at, updated_at, vi_installation_id
         FROM installation_tickets
         WHERE vehicle_id = v.id AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) it ON TRUE
       LEFT JOIN invoices inv ON inv.id = it.invoice_id
       LEFT JOIN vi_installations vi ON vi.id = it.vi_installation_id
       LEFT JOIN LATERAL (
         SELECT id, serial_no, end_date, created_at
         FROM certificates
         WHERE REPLACE(UPPER(car_registration), ' ', '') = REPLACE(UPPER(v.registration), ' ', '')
         ORDER BY created_at DESC
         LIMIT 1
       ) cert ON TRUE
       WHERE v.partner_id = ? AND v.deleted_at IS NULL
       ORDER BY COALESCE(it.updated_at::text, it.created_at::text, v.created_at::text) DESC
       LIMIT 40`,
      [pid]
    ),
  ]);

  const now = new Date();
  const loanMonitoring = loanVehicles.map((v: any) => {
    const expiry = new Date(v.loan_start_date);
    expiry.setMonth(expiry.getMonth() + v.loan_tenure_months);
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / 86400000);
    let urgency = "ok";
    if (daysLeft <= 0)   urgency = "expired";
    else if (daysLeft <= 7)   urgency = "critical";
    else if (daysLeft <= 30)  urgency = "moderate";
    else if (daysLeft <= 60)  urgency = "warning60";
    else if (daysLeft <= 90)  urgency = "warning90";
    else if (daysLeft <= 180) urgency = "warning180";
    else if (daysLeft <= 365) urgency = "warning365";
    return {
      registration: v.registration,
      customerName: v.customer_name || v.company_name || "—",
      accountNo: v.account_no,
      loanTenureMonths: v.loan_tenure_months,
      expiryDate: expiry.toISOString().slice(0, 10),
      daysLeft, urgency,
    };
  }).sort((a: any, b: any) => a.daysLeft - b.daysLeft);

  const linkedInvoices = financeRows.filter((r: any) => !!r.invoice_id);
  const paidRows = linkedInvoices.filter((r: any) => String(r.invoice_status || "").toLowerCase() === "paid");
  const unpaidRows = linkedInvoices.filter((r: any) => ["unpaid", "overdue"].includes(String(r.invoice_status || "").toLowerCase()));
  const invoicedRows = linkedInvoices.filter((r: any) => !["paid", "unpaid", "overdue"].includes(String(r.invoice_status || "").toLowerCase()));
  const totalInvoiceAmount = linkedInvoices.reduce((sum: number, r: any) => sum + Number(r.invoice_amount || 0), 0);
  const paidAmount = paidRows.reduce((sum: number, r: any) => sum + Number(r.invoice_amount || 0), 0);
  const unpaidAmount = unpaidRows.reduce((sum: number, r: any) => sum + Number(r.invoice_amount || 0), 0);
  const standardAmount = linkedInvoices.length ? Math.round(totalInvoiceAmount / linkedInvoices.length) : 0;

  return ok(res, {
    totalVehicles: Number(vCount?.n || 0),
    totalCustomers: Number(cCount?.n || 0),
    totalLeads: leadsData.length,
    loansDueCount: loanMonitoring.filter((l: any) => ["critical", "moderate", "expired"].includes(l.urgency)).length,
    loanMonitoring,
    recentVehicles: recentVehicles.map((v: any) => ({
      registration: v.registration,
      customerName: v.individual_name || v.company_name || "—",
      accountNo: v.account_no,
      registeredAt: v.created_at,
    })),
    recentLeads: leadsData.map((l: any) => ({
      id: l.id,
      leadNo: l.lead_no,
      status: l.status,
      leadSource: l.lead_source,
      leadDate: l.lead_date,
      customerName: l.individual_name || l.customer_name || l.company_name || "—",
    })),
    finance: {
      totalInvoices: linkedInvoices.length,
      invoicedCount: invoicedRows.length,
      unpaidCount: unpaidRows.length,
      paidCount: paidRows.length,
      totalInvoiceAmount,
      paidAmount,
      unpaidAmount,
      standardAmount,
      rows: linkedInvoices.slice(0, 20).map((r: any) => ({
        registration: r.registration,
        ticketNo: r.ticket_no || null,
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        invoiceStatus: r.invoice_status,
        invoiceAmount: Number(r.invoice_amount || 0),
        invoiceCurrency: r.invoice_currency || "KES",
        issuedOn: r.issued_on || null,
        dueOn: r.due_on || null,
        createdAt: r.invoice_created_at || null,
      })),
    },
    installationVehicles: installationRows.map((r: any) => ({
      vehicleId: r.vehicle_id,
      registration: r.registration,
      makeModel: [r.make, r.model].filter(Boolean).join(" ") || "—",
      loanTenureMonths: r.loan_tenure_months || null,
      loanStartDate: r.loan_start_date || null,
      installationTicketId: r.installation_ticket_id || null,
      installationTicketNo: r.ticket_no || null,
      installationStatus: r.installation_status || "NotStarted",
      invoiceId: r.invoice_id || null,
      invoiceNumber: r.invoice_number || null,
      invoiceAmount: Number(r.invoice_amount || 0),
      invoiceCurrency: r.invoice_currency || "KES",
      installationCreatedAt: r.installation_created_at || null,
      installationUpdatedAt: r.installation_updated_at || null,
      installationCompletedAt: r.installation_completed_at || null,
      certificateId: r.certificate_id || null,
      certificateSerialNo: r.certificate_serial_no || null,
      certificateExpiry: r.certificate_expiry || null,
    })),
  });
});

router.get("/certificates/:id/download", requirePartnerAuth, async (req: any, res) => {
  const pid = req.partnerUser.partnerId;
  const cert = await pgGet(
    `SELECT c.id, c.serial_no, c.pdf_base64
     FROM certificates c
     JOIN crm_customer_vehicles v
       ON REPLACE(UPPER(v.registration), ' ', '') = REPLACE(UPPER(c.car_registration), ' ', '')
     WHERE c.id = ? AND v.partner_id = ? AND v.deleted_at IS NULL
     LIMIT 1`,
    [req.params.id, pid]
  );
  if (!cert) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found");

  const raw = String(cert.pdf_base64 || "");
  const base64 = raw.includes(",") ? raw.split(",").pop() || "" : raw;
  if (!base64) return errorResponse(res, 404, "NOT_FOUND", "Certificate PDF not available");

  const fileName = `certificate-${String(cert.serial_no || cert.id).replace(/[^a-zA-Z0-9_-]/g, "")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
  return res.status(200).send(Buffer.from(base64, "base64"));
});

router.get("/invoices/:id/download", requirePartnerAuth, async (req: any, res) => {
  const pid = req.partnerUser.partnerId;
  const row = await pgGet(
    `SELECT i.*
     FROM invoices i
     WHERE i.id = ?
       AND EXISTS (
         SELECT 1
         FROM installation_tickets it
         JOIN crm_customer_vehicles v ON v.id = it.vehicle_id
         WHERE it.invoice_id = i.id
           AND v.partner_id = ?
           AND v.deleted_at IS NULL
           AND it.deleted_at IS NULL
       )
     LIMIT 1`,
    [req.params.id, pid]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");

  const items = await pgAll(
    "SELECT item, description, qty, rate, amount, vat FROM invoice_items WHERE invoice_id = ?",
    [req.params.id]
  );

  const inv = {
    invoiceNumber: row.invoice_number,
    customer: row.customer,
    representative: row.representative,
    vatMode: row.vat_mode,
    taxDate: row.tax_date || row.issued_on,
    jobCardNo: row.job_card_no,
    pinNo: row.pin_no || "P051961922E",
    subtotal: row.subtotal,
    vatTotal: row.vat_total,
    total: row.total,
    paymentPaybill: row.payment_paybill,
    paymentAccountHint: row.payment_account_hint,
    bankName: row.bank_name,
    bankAccountNo: row.bank_account_no,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    etimsControlNo: row.etims_control_no || null,
    etimsReceiptNo: row.etims_receipt_no || null,
    etrReceiptNo: row.etr_receipt_no || null,
    etimsSignedAt: row.etims_signed_at || null,
  };

  const pdfBytes = await renderInvoicePdf(inv, items, { debug: false, grid: false });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=\"Invoice_${row.invoice_number}.pdf\"`);
  return res.status(200).send(Buffer.from(pdfBytes));
});

// ─── Vehicles ─────────────────────────────────────────────────────────────────

router.get("/vehicles", requirePartnerAuth, async (req: any, res) => {
  const { page = "1", pageSize = "20", search = "" } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  const pid = req.partnerUser.partnerId;

  const conditions = ["v.partner_id = ?", "v.deleted_at IS NULL"];
  const params: any[] = [pid];

  if (search) {
    conditions.push("(v.registration ILIKE ? OR cp.full_name ILIKE ? OR corp.company_name ILIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conditions.join(" AND ");
  const countParams = [...params];

  const total = await pgGet(
    `SELECT count(*) AS n FROM crm_customer_vehicles v
     LEFT JOIN crm_customers c ON c.id = v.customer_id
     LEFT JOIN crm_individual_profiles cp ON cp.customer_id = v.customer_id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
     WHERE ${where}`,
    countParams
  );

  params.push(parseInt(pageSize), offset);
  const rows = await pgAll(
    `SELECT v.id, v.registration, v.make, v.model, v.body_type, v.color, v.year_of_manufacture,
            v.loan_tenure_months, v.loan_start_date, v.created_at,
            c.account_no, c.type AS customer_type,
            cp.full_name AS individual_name, corp.company_name
     FROM crm_customer_vehicles v
     JOIN crm_customers c ON c.id = v.customer_id
     LEFT JOIN crm_individual_profiles cp ON cp.customer_id = v.customer_id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
     WHERE ${where}
     ORDER BY v.created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );

  const now = new Date();
  const data = rows.map((v: any) => {
    let loanDaysLeft = null;
    let loanExpiry = null;
    if (v.loan_start_date && v.loan_tenure_months) {
      const expiry = new Date(v.loan_start_date);
      expiry.setMonth(expiry.getMonth() + v.loan_tenure_months);
      loanDaysLeft = Math.ceil((expiry.getTime() - now.getTime()) / 86400000);
      loanExpiry = expiry.toISOString().slice(0, 10);
    }
    return {
      id: v.id, registration: v.registration, make: v.make, model: v.model,
      bodyType: v.body_type, color: v.color, yearOfManufacture: v.year_of_manufacture,
      customerName: v.individual_name || v.company_name || "—",
      accountNo: v.account_no, customerType: v.customer_type,
      loanTenureMonths: v.loan_tenure_months, loanStartDate: v.loan_start_date,
      loanExpiry, loanDaysLeft, createdAt: v.created_at,
    };
  });

  return ok(res, { data, meta: { total: Number(total?.n || 0), page: parseInt(page), pageSize: parseInt(pageSize) } });
});

// ─── Partner profile ──────────────────────────────────────────────────────────

router.get("/profile", requirePartnerAuth, async (req: any, res) => {
  const partner = await pgGet(
    `SELECT p.*, u.email AS kam_email FROM partners p
     LEFT JOIN users u ON u.id = p.key_account_manager_id
     WHERE p.id = ? AND p.deleted_at IS NULL`,
    [req.partnerUser.partnerId]
  );
  if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

  const contracts = await pgAll(
    `SELECT id, file_name, file_size, mime_type, uploaded_at FROM partner_contracts WHERE partner_id = ? ORDER BY uploaded_at DESC`,
    [req.partnerUser.partnerId]
  );

  return ok(res, {
    id: partner.id, name: partner.name, businessRegNo: partner.business_reg_no,
    regions: typeof partner.regions === "string" ? JSON.parse(partner.regions) : (partner.regions || ["All"]),
    contactEmail: partner.contact_email, contactPhone: partner.contact_phone,
    tier: partner.tier, kamEmail: partner.kam_email,
    contractRef: partner.contract_ref, contractScope: partner.contract_scope,
    contractStart: partner.contract_start, contractExpiry: partner.contract_expiry,
    portalLogoUrl: partner.portal_logo_url || null,
    portalPrimaryColor: partner.portal_primary_color || null,
    portalTheme: partner.portal_theme_json ? JSON.parse(partner.portal_theme_json) : null,
    status: partner.status,
    contracts: contracts.map((c: any) => ({
      id: c.id, fileName: c.file_name, fileSize: c.file_size, uploadedAt: c.uploaded_at,
    })),
  });
});

router.get("/settings", requirePartnerAuth, async (req: any, res) => {
  const partner = await pgGet(
    `SELECT id, name, portal_logo_url, portal_primary_color, portal_theme_json
     FROM partners WHERE id = ? AND deleted_at IS NULL`,
    [req.partnerUser.partnerId]
  );
  if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");
  return ok(res, {
    name: partner.name,
    portalLogoUrl: partner.portal_logo_url || null,
    portalPrimaryColor: partner.portal_primary_color || "#1d4ed8",
    portalTheme: partner.portal_theme_json ? JSON.parse(partner.portal_theme_json) : null,
  });
});

router.put("/settings", requirePartnerAuth, async (req: any, res) => {
  if (req.partnerUser.role !== "PartnerAdmin") return errorResponse(res, 403, "FORBIDDEN", "PartnerAdmin access required");
  const { portalPrimaryColor, portalTheme } = req.body || {};
  await pgRun(
    `UPDATE partners
     SET portal_primary_color = COALESCE(?, portal_primary_color),
         portal_theme_json = COALESCE(?, portal_theme_json),
         updated_at = now()
     WHERE id = ?`,
    [portalPrimaryColor || null, portalTheme ? JSON.stringify(portalTheme) : null, req.partnerUser.partnerId]
  );
  await portalAudit({ eventType: "SETTINGS_UPDATED", userId: req.partnerUser.id, partnerId: req.partnerUser.partnerId, action: "UPDATE_SETTINGS", req });
  return ok(res, { updated: true }, "Portal settings updated");
});

router.post("/settings/logo", requirePartnerAuth, async (req: any, res) => {
  if (req.partnerUser.role !== "PartnerAdmin") return errorResponse(res, 403, "FORBIDDEN", "PartnerAdmin access required");
  const logoBase64 = String(req.body?.logoBase64 || "");
  if (!logoBase64.startsWith("data:image/")) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "logoBase64 must be an image data URL");
  }

  const match = logoBase64.match(/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,(.+)$/i);
  if (!match) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid image format");
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : (match[1].toLowerCase() === "svg+xml" ? "svg" : match[1].toLowerCase());
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 2 * 1024 * 1024) return errorResponse(res, 400, "VALIDATION_ERROR", "Logo too large. Max 2MB.");

  const dir = path.join(process.cwd(), "uploads", "partner-logos");
  await fs.mkdir(dir, { recursive: true });
  const fileName = `partner-${req.partnerUser.partnerId}-${Date.now()}.${ext}`;
  const absPath = path.join(dir, fileName);
  await fs.writeFile(absPath, bytes);

  const logoUrl = `/uploads/partner-logos/${fileName}`;
  await pgRun(
    `UPDATE partners SET portal_logo_url = ?, updated_at = now() WHERE id = ?`,
    [logoUrl, req.partnerUser.partnerId]
  );
  await portalAudit({ eventType: "LOGO_UPDATED", userId: req.partnerUser.id, partnerId: req.partnerUser.partnerId, action: "UPLOAD_LOGO", req });
  return ok(res, { logoUrl }, "Portal logo updated");
});

router.post("/auth/change-password", requirePartnerAuth, async (req: any, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!currentPassword || !newPassword) return errorResponse(res, 400, "VALIDATION_ERROR", "currentPassword and newPassword required");
  if (newPassword.length < 8) return errorResponse(res, 400, "VALIDATION_ERROR", "Password must be at least 8 characters");

  const user = await pgGet(`SELECT id, password_hash, partner_id FROM partner_users WHERE id = ?`, [req.partnerUser.id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found");

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return errorResponse(res, 401, "UNAUTHORIZED", "Current password is incorrect");

  const hashed = await bcrypt.hash(newPassword, 12);
  await pgRun(`UPDATE partner_users SET password_hash = ?, updated_at = now() WHERE id = ?`, [hashed, user.id]);
  await pgRun(`DELETE FROM partner_sessions WHERE partner_user_id = ?`, [user.id]).catch(() => {});
  await portalAudit({ eventType: "PASSWORD_CHANGED", userId: user.id, partnerId: user.partner_id, action: "CHANGE_PASSWORD", req });
  return ok(res, { changed: true }, "Password changed. Please sign in again.");
});

// ─── Portal user management (PartnerAdmin only) ───────────────────────────────

router.get("/users", requirePartnerAuth, async (req: any, res) => {
  if (req.partnerUser.role !== "PartnerAdmin") return errorResponse(res, 403, "FORBIDDEN", "PartnerAdmin access required");

  const rows = await pgAll(
    `SELECT id, email, full_name, role, status, notify_email, notify_sms, last_login_at, created_at
     FROM partner_users WHERE partner_id = ? ORDER BY created_at`,
    [req.partnerUser.partnerId]
  );
  return ok(res, {
    data: rows.map((u: any) => ({
      id: u.id, email: u.email, fullName: u.full_name, role: u.role, status: u.status,
      notifyEmail: u.notify_email, notifySms: u.notify_sms, lastLoginAt: u.last_login_at,
    })),
  });
});

router.post("/users", requirePartnerAuth, async (req: any, res) => {
  if (req.partnerUser.role !== "PartnerAdmin") return errorResponse(res, 403, "FORBIDDEN", "PartnerAdmin access required");

  const { email, fullName, phone, password, role = "PartnerUser" } = req.body;
  if (!email || !fullName || !password) return errorResponse(res, 400, "VALIDATION_ERROR", "email, fullName, password required");

  const existing = await pgGet(`SELECT id FROM partner_users WHERE email = ?`, [email.toLowerCase().trim()]);
  if (existing) return errorResponse(res, 409, "CONFLICT", "Email already registered");

  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  const now = new Date().toISOString();

  await pgRun(
    `INSERT INTO partner_users (id, partner_id, email, password_hash, full_name, phone, role, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
    [id, req.partnerUser.partnerId, email.toLowerCase().trim(), hash, fullName, phone || null, role, req.partnerUser.id, now, now]
  );

  await portalAudit({ eventType: "USER_CREATED", userId: req.partnerUser.id, partnerId: req.partnerUser.partnerId, action: "CREATE_USER", req });
  return created(res, { id, email, fullName, role, status: "Active" }, "User created");
});

router.patch("/users/:id", requirePartnerAuth, async (req: any, res) => {
  if (req.partnerUser.role !== "PartnerAdmin") return errorResponse(res, 403, "FORBIDDEN", "PartnerAdmin access required");

  const user = await pgGet(
    `SELECT * FROM partner_users WHERE id = ? AND partner_id = ?`,
    [req.params.id, req.partnerUser.partnerId]
  );
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found");

  const { fullName, phone, status, password, notifyEmail, notifySms } = req.body;
  let passwordHash = user.password_hash;
  if (password) passwordHash = await bcrypt.hash(password, 12);

  await pgRun(
    `UPDATE partner_users SET
       full_name = COALESCE(?, full_name),
       phone = COALESCE(?, phone),
       status = COALESCE(?, status),
       password_hash = ?,
       notify_email = COALESCE(?, notify_email),
       notify_sms = COALESCE(?, notify_sms),
       updated_at = now()
     WHERE id = ?`,
    [fullName || null, phone || null, status || null, passwordHash,
     notifyEmail != null ? notifyEmail : null, notifySms != null ? notifySms : null,
     req.params.id]
  );

  if (status && status !== "Active") {
    await pgRun(`DELETE FROM partner_sessions WHERE partner_user_id = ?`, [req.params.id]).catch(() => {});
  }

  await portalAudit({ eventType: "USER_UPDATED", userId: req.partnerUser.id, partnerId: req.partnerUser.partnerId, action: "UPDATE_USER", req });

  return ok(res, { id: req.params.id, updated: true });
});

// ─── Support tickets ──────────────────────────────────────────────────────────

router.get("/tickets", requirePartnerAuth, async (req: any, res) => {
  const pid = req.partnerUser.partnerId;

  const rows = await pgAll(
    `SELECT DISTINCT t.id, t.ticket_no, t.subject, t.category, t.priority, t.status,
            t.opened_at, t.resolved_at, t.created_at
     FROM crm_tickets t
     JOIN crm_customers c ON c.id = t.customer_id
     JOIN crm_customer_vehicles v ON v.customer_id = c.id
     WHERE v.partner_id = ? AND t.deleted_at IS NULL
     ORDER BY t.created_at DESC LIMIT 50`,
    [pid]
  );

  return ok(res, {
    data: rows.map((t: any) => ({
      id: t.id, ticketNo: t.ticket_no, subject: t.subject,
      category: t.category, priority: t.priority, status: t.status,
      openedAt: t.opened_at, resolvedAt: t.resolved_at,
    })),
  });
});

router.post("/tickets", requirePartnerAuth, async (req: any, res) => {
  const { subject, category, description, priority = "Normal", deviceImei, vehicleRegistration } = req.body;
  if (!subject || !category || !description) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "subject, category, description required");
  }

  const id = uuidv4();
  const ticketNo = `PT-${Date.now().toString(36).toUpperCase()}`;
  const now = new Date().toISOString();
  const pid = req.partnerUser.partnerId;

  // Attach to first customer of this partner as a reference anchor
  const anchor = await pgGet(
    `SELECT DISTINCT customer_id FROM crm_customer_vehicles WHERE partner_id = ? AND deleted_at IS NULL LIMIT 1`,
    [pid]
  );

  const notes = `[Partner Portal — ${req.partnerUser.email}]\nIMEI: ${deviceImei || "—"} | Reg: ${vehicleRegistration || "—"}\n\n${description}`;

  await pgRun(
    `INSERT INTO crm_tickets (id, ticket_no, subject, category, priority, status, opened_at, customer_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)`,
    [id, ticketNo, subject, category, priority, now, anchor?.customer_id || null, notes, now, now]
  );

  await portalAudit({ eventType: "TICKET_CREATED", userId: req.partnerUser.id, partnerId: pid, action: "CREATE_TICKET", req });
  return created(res, { id, ticketNo, subject, status: "Open" }, "Support ticket raised");
});

export default router;
