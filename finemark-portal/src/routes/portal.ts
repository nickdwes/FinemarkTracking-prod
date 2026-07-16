import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import {
  generateOTP, hashOTP, storeOTP, getOTP, consumeOTP,
  signPortalToken, requirePortalAuth, PortalRequest,
} from "../auth.js";
import { isMailConfigured, sendOTPEmail } from "../mailer.js";
import { otpLimiter } from "../rateLimit.js";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────
function ok(res: Response, data: any, message?: string) {
  res.json({ ok: true, data, ...(message ? { message } : {}) });
}
function err(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ ok: false, code, message });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC – no auth required
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/request-otp
// Looks up registered email in crm_customer_users → sends OTP.
// Always returns 200 to prevent email enumeration.
router.post("/auth/request-otp", otpLimiter, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(res, 400, "INVALID_EMAIL", "A valid email address is required.");
  }

  const user = await pgGet<any>(
    `SELECT cu.id, cu.customer_id, cu.name, cu.role,
            c.type AS customer_type, c.status AS customer_status
     FROM crm_customer_users cu
     JOIN crm_customers c ON c.id = cu.customer_id
     WHERE cu.email = ? AND cu.status = 'Active'`,
    [email]
  );

  if (user && user.customer_status === "Active") {
    const existing = getOTP(email);
    const now = Date.now();
    if (!existing || now - existing.lastSentAt > 60_000) {
      const otp = generateOTP();
      storeOTP(email, {
        hash:         hashOTP(otp),
        expiresAt:    now + 10 * 60 * 1000,
        userId:       user.id,
        customerId:   user.customer_id,
        role:         user.role,
        customerType: user.customer_type,
        userName:     user.name,
        lastSentAt:   now,
      });

      if (isMailConfigured()) {
        sendOTPEmail({ to: email, otp, name: user.name?.split(" ")[0] }).catch((e: Error) => {
          console.error("[portal] OTP email failed:", e.message);
        });
      } else {
        console.log(`[portal-dev] OTP for ${email}: ${otp}`);
      }
    }
  }

  return ok(res, { message: "If that email is registered, a verification code has been sent." });
});

// POST /api/auth/verify-otp
router.post("/auth/verify-otp", otpLimiter, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const otp   = String(req.body?.otp   ?? "").trim();

  if (!email || !otp) {
    return err(res, 400, "MISSING_FIELDS", "email and otp are required.");
  }

  const entry = getOTP(email);
  if (!entry || Date.now() > entry.expiresAt || hashOTP(otp) !== entry.hash) {
    return err(res, 401, "INVALID_OTP", "Invalid or expired verification code.");
  }

  consumeOTP(email);

  await pgRun(
    `UPDATE crm_customer_users SET last_login_at = ?, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), new Date().toISOString(), entry.userId]
  );

  const token = signPortalToken({
    sub:        entry.userId,
    customerId: entry.customerId,
    role:       entry.role,
    email,
  });

  return ok(res, {
    token,
    expiresIn: "8h",
    user: {
      id:           entry.userId,
      customerId:   entry.customerId,
      name:         entry.userName,
      email,
      role:         entry.role,
      customerType: entry.customerType,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED – requirePortalAuth on every route below
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/me  — Customer 360 profile
router.get("/me", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId, role } = req.portalUser!;

  const customer = await pgGet<any>(
    `SELECT c.*,
            COALESCE(ind.full_name, corp.company_name) AS display_name
     FROM crm_customers c
     LEFT JOIN crm_individual_profiles  ind  ON ind.customer_id  = c.id
     LEFT JOIN crm_corporate_profiles   corp ON corp.customer_id = c.id
     WHERE c.id = ?`,
    [customerId]
  );
  if (!customer) return err(res, 404, "NOT_FOUND", "Customer record not found.");

  let profile: any = null;
  if (customer.type === "Individual") {
    const row = await pgGet<any>(`SELECT * FROM crm_individual_profiles WHERE customer_id = ?`, [customerId]);
    if (row) {
      profile = {
        fullName:   row.full_name,
        nationalId: row.national_id,
        phone:      row.phone,
        email:      row.email,
        address:    row.address,
        dob:        row.dob,
        gender:     row.gender,
        industry:   row.industry,
      };
    }
  } else {
    const row = await pgGet<any>(`SELECT * FROM crm_corporate_profiles WHERE customer_id = ?`, [customerId]);
    if (row) {
      profile = {
        companyName:        row.company_name,
        registrationNumber: row.registration_number,
        kraPin:             row.kra_pin,
        industry:           row.industry,
        physicalAddress:    row.physical_address,
        website:            row.website,
      };
    }
  }

  let contacts: any[] = [];
  if (customer.type === "Corporate") {
    const rows = await pgAll<any>(
      `SELECT id, name, role, phone, email, is_primary
       FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at ASC`,
      [customerId]
    );
    contacts = rows.map((r: any) => ({
      id:        r.id,
      name:      r.name,
      role:      r.role,
      phone:     r.phone,
      email:     r.email,
      isPrimary: r.is_primary,
    }));
  }

  return ok(res, {
    customer: {
      id:           customer.id,
      accountNo:    customer.account_no,
      type:         customer.type,
      status:       customer.status,
      region:       customer.region,
      source:       customer.source,
      displayName:  customer.display_name,
      registeredAt: customer.registered_at,
    },
    profile,
    contacts,
    portalRole: role,
  });
});

// GET /api/me/vehicles  — customer vehicles + installation summaries
router.get("/me/vehicles", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;

  const vehicles = await pgAll<any>(
    `SELECT v.*,
            i.id           AS install_id,
            i.status       AS install_status,
            i.completed_at AS install_date,
            i.stage        AS install_stage
     FROM crm_customer_vehicles v
     LEFT JOIN vi_installations i ON i.vehicle_id = v.id AND i.deleted_at IS NULL
     WHERE v.customer_id = ? AND v.deleted_at IS NULL
     ORDER BY v.created_at DESC`,
    [customerId]
  );

  return ok(res, vehicles.map((v: any) => ({
    id:            v.id,
    registration:  v.registration,
    make:          v.make,
    model:         v.model,
    yearOfManufacture: v.year_of_manufacture,
    color:         v.color,
    chassisNumber: v.chassis_number,
    engineNumber:  v.engine_number,
    installation: v.install_id ? {
      id:          v.install_id,
      status:      v.install_status,
      completedAt: v.install_date,
      stage:       v.install_stage,
    } : null,
  })));
});

// GET /api/me/subscriptions
router.get("/me/subscriptions", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const rows = await pgAll<any>(
    `SELECT * FROM crm_subscriptions
     WHERE customer_id = ?
     ORDER BY start_date DESC`,
    [customerId]
  );
  return ok(res, rows.map((r: any) => ({
    id:                  r.id,
    serviceType:         r.service_type,
    planName:            r.plan_name,
    status:              r.status,
    startDate:           r.start_date,
    endDate:             r.end_date,
    renewalReminderDays: r.renewal_reminder_days,
    monthlyFee:          r.monthly_fee,
    currency:            r.currency,
    notes:               r.notes,
  })));
});

// GET /api/me/devices
router.get("/me/devices", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const rows = await pgAll<any>(
    `SELECT * FROM crm_devices
     WHERE customer_id = ?
     ORDER BY installed_at DESC`,
    [customerId]
  );
  return ok(res, rows.map((r: any) => ({
    id:          r.id,
    deviceType:  r.device_type,
    model:       r.model,
    imei:        r.imei,
    serialNo:    r.serial_no,
    status:      r.status,
    installedAt: r.installed_at,
    location:    r.location,
    notes:       r.notes,
  })));
});

// GET /api/me/tickets
router.get("/me/tickets", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const { status, page = "1" } = req.query as any;
  const pageNum  = Math.max(parseInt(page, 10) || 1, 1);
  const pageSize = 20;
  const offset   = (pageNum - 1) * pageSize;

  const filters: string[] = ["t.customer_id = ?"];
  const params:  any[]    = [customerId];
  if (status) { filters.push("t.status = ?"); params.push(status); }

  const where = `WHERE ${filters.join(" AND ")}`;

  const rows = await pgAll<any>(
    `SELECT t.id, t.ticket_no, t.subject, t.category, t.priority, t.status,
            t.sla_breach_at, t.opened_at, t.resolved_at, t.closed_at
     FROM crm_tickets t ${where}
     ORDER BY t.opened_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const totalRow = await pgGet<any>(
    `SELECT COUNT(*) AS total FROM crm_tickets t ${where}`, params
  );

  return ok(res, {
    data: rows,
    meta: { total: Number(totalRow?.total ?? 0), page: pageNum, pageSize },
  });
});

// GET /api/me/tickets/:id
router.get("/me/tickets/:id", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const ticket = await pgGet<any>(
    `SELECT * FROM crm_tickets WHERE id = ? AND customer_id = ?`,
    [req.params.id, customerId]
  );
  if (!ticket) return err(res, 404, "NOT_FOUND", "Ticket not found.");

  const actions = await pgAll<any>(
    `SELECT ta.action_type, ta.comment, ta.actioned_at
     FROM crm_ticket_actions ta
     WHERE ta.ticket_id = ? ORDER BY ta.actioned_at ASC`,
    [req.params.id]
  );

  return ok(res, { ticket, actions });
});

// POST /api/me/tickets
router.post("/me/tickets", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId, sub: userId } = req.portalUser!;
  const { subject, description, category, priority = "Normal" } = req.body;

  if (!subject?.trim()) return err(res, 400, "MISSING_FIELDS", "subject is required.");

  const SLA_MAP: Record<string, number> = { Critical: 4, High: 8, Normal: 24, Low: 72 };
  const slaHours   = SLA_MAP[priority] ?? 24;
  const slaBreachAt = new Date(Date.now() + slaHours * 3_600_000).toISOString();

  const lastRow = await pgGet<any>(`SELECT ticket_no FROM crm_tickets ORDER BY created_at DESC LIMIT 1`, []);
  let nextNum = 1;
  if (lastRow?.ticket_no) {
    const m = lastRow.ticket_no.match(/-(\d+)$/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  const ticketNo = `TKT-${String(nextNum).padStart(5, "0")}`;

  const id  = uuidv4();
  const now = new Date().toISOString();

  await pgRun(
    `INSERT INTO crm_tickets
       (id, ticket_no, customer_id, subject, description, category, priority, status,
        sla_hours, sla_breach_at, opened_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)`,
    [id, ticketNo, customerId, subject.trim(), description ?? null,
     category ?? null, priority, slaHours, slaBreachAt, now, now, now]
  );

  await pgRun(
    `INSERT INTO crm_ticket_actions
       (id, ticket_id, action_type, comment, actor_user_id, actioned_at, created_at)
     VALUES (?, ?, 'Opened', 'Submitted via Customer Portal', ?, ?, ?)`,
    [uuidv4(), id, userId, now, now]
  );

  const ticket = await pgGet<any>(`SELECT * FROM crm_tickets WHERE id = ?`, [id]);
  return res.status(201).json({ ok: true, data: ticket, message: "Ticket submitted successfully." });
});

// GET /api/me/invoices
router.get("/me/invoices", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const { status, page = "1" } = req.query as any;
  const pageNum  = Math.max(parseInt(page, 10) || 1, 1);
  const pageSize = 20;
  const offset   = (pageNum - 1) * pageSize;

  const filters: string[] = ["customer_id = ?"];
  const params:  any[]    = [customerId];
  if (status) { filters.push("status = ?"); params.push(status); }

  const where = `WHERE ${filters.join(" AND ")}`;

  const rows = await pgAll<any>(
    `SELECT id, invoice_number, issued_on, due_on, status,
            amount, currency
     FROM invoices ${where}
     ORDER BY issued_on DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const totalRow = await pgGet<any>(
    `SELECT COUNT(*) AS total FROM invoices ${where}`, params
  );

  return ok(res, {
    data: rows.map((r: any) => ({
      id:            r.id,
      invoiceNumber: r.invoice_number,
      issuedOn:      r.issued_on,
      dueOn:         r.due_on,
      status:        r.status,
      amount:        r.amount,
      currency:      r.currency || "KES",
    })),
    meta: { total: Number(totalRow?.total ?? 0), page: pageNum, pageSize },
  });
});

// GET /api/me/communications
router.get("/me/communications", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const rows = await pgAll<any>(
    `SELECT channel, direction, subject, contacted_at, created_at
     FROM crm_communication_logs
     WHERE customer_id = ?
     ORDER BY contacted_at DESC LIMIT 50`,
    [customerId]
  );
  return ok(res, rows);
});

// GET /api/me/stats  — aggregated counts for the dashboard header
router.get("/me/stats", requirePortalAuth, async (req: PortalRequest, res: Response) => {
  const { customerId } = req.portalUser!;
  const [subs, devices, openTickets, unpaidInvoices, vehicles] = await Promise.all([
    pgGet<any>(`SELECT COUNT(*) AS n FROM crm_subscriptions WHERE customer_id = ? AND status = 'Active'`, [customerId]),
    pgGet<any>(`SELECT COUNT(*) AS n FROM crm_devices WHERE customer_id = ?`, [customerId]),
    pgGet<any>(`SELECT COUNT(*) AS n FROM crm_tickets WHERE customer_id = ? AND status NOT IN ('Closed','Resolved')`, [customerId]),
    pgGet<any>(`SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND status NOT IN ('Paid','Cancelled','Void')`, [customerId]),
    pgGet<any>(`SELECT COUNT(*) AS n FROM crm_customer_vehicles WHERE customer_id = ? AND deleted_at IS NULL`, [customerId]),
  ]);

  return ok(res, {
    activeSubscriptions: Number(subs?.n ?? 0),
    devices:             Number(devices?.n ?? 0),
    openTickets:         Number(openTickets?.n ?? 0),
    unpaidInvoices:      Number(unpaidInvoices?.n ?? 0),
    vehicles:            Number(vehicles?.n ?? 0),
  });
});

export default router;
