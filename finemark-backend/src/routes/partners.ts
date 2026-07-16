import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapPartner(r: any) {
  return {
    id: r.id,
    name: r.name,
    businessRegNo: r.business_reg_no,
    regions: typeof r.regions === "string" ? JSON.parse(r.regions) : (r.regions || ["All"]),
    primaryContactName: r.primary_contact_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    tier: r.tier,
    keyAccountManagerId: r.key_account_manager_id,
    kamEmail: r.kam_email,
    contractRef: r.contract_ref,
    contractScope: r.contract_scope,
    contractStart: r.contract_start,
    contractExpiry: r.contract_expiry,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapContract(r: any) {
  return {
    id: r.id,
    partnerId: r.partner_id,
    fileName: r.file_name,
    filePath: r.file_path,
    fileSize: r.file_size,
    mimeType: r.mime_type,
    uploadedAt: r.uploaded_at,
  };
}

async function partnerAudit(req: AuthRequest, action: string, target: string, details?: string) {
  try {
    await auditLog(req, action, target, "Info", details ? { details } : {});
  } catch (_) {}
}

// ─── List partners ────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Finance", "Support", "Operations", "CertAdmin"]),
  async (req: AuthRequest, res) => {
    const { search = "", status = "", tier = "", page = "1", pageSize = "25" } = req.query as Record<string, string>;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    const conditions: string[] = ["p.deleted_at IS NULL"];
    const params: any[] = [];

    if (search) {
      conditions.push("(p.name ILIKE ? OR p.business_reg_no ILIKE ? OR p.contact_email ILIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) { conditions.push("p.status = ?"); params.push(status); }
    if (tier)   { conditions.push("p.tier = ?"); params.push(tier); }

    const where = conditions.join(" AND ");
    const countParams = [...params];

    const total = await pgGet(`SELECT count(*) AS n FROM partners p WHERE ${where}`, countParams);
    params.push(parseInt(pageSize), offset);

    const rows = await pgAll(
      `SELECT p.*, u.email AS kam_email
       FROM partners p
       LEFT JOIN users u ON u.id = p.key_account_manager_id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      params
    );

    return ok(res, {
      data: rows.map(mapPartner),
      meta: { total: Number(total?.n || 0), page: parseInt(page), pageSize: parseInt(pageSize) },
    });
  }
);

// ─── Create partner ───────────────────────────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const {
      name, businessRegNo, regions, primaryContactName, contactEmail,
      contactPhone, tier, keyAccountManagerId, contractRef, contractScope,
      contractStart, contractExpiry, notes,
    } = req.body;

    if (!name?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "Partner name is required");

    const id = uuidv4();
    const now = new Date().toISOString();

    await pgRun(
      `INSERT INTO partners
         (id, name, business_reg_no, regions, primary_contact_name, contact_email,
          contact_phone, tier, key_account_manager_id, contract_ref, contract_scope,
          contract_start, contract_expiry, notes, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
      [
        id, name.trim(), businessRegNo || null,
        JSON.stringify(regions || ["All"]),
        primaryContactName || null, contactEmail || null, contactPhone || null,
        tier || "Standard", keyAccountManagerId || null,
        contractRef || null, contractScope || null,
        contractStart || null, contractExpiry || null,
        notes || null, req.user!.id, now, now,
      ]
    );

    await partnerAudit(req, "PARTNER_CREATED", `partners/${id}`, `Created partner: ${name.trim()}`);

    const row = await pgGet(
      `SELECT p.*, u.email AS kam_email FROM partners p LEFT JOIN users u ON u.id = p.key_account_manager_id WHERE p.id = ?`,
      [id]
    );
    return created(res, mapPartner(row), "Partner created");
  }
);

// ─── Get partner ──────────────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Finance", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      `SELECT p.*, u.email AS kam_email FROM partners p LEFT JOIN users u ON u.id = p.key_account_manager_id WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    const contracts = await pgAll(
      `SELECT * FROM partner_contracts WHERE partner_id = ? ORDER BY uploaded_at DESC`,
      [req.params.id]
    );

    return ok(res, { ...mapPartner(row), contracts: contracts.map(mapContract) });
  }
);

// ─── Update partner ───────────────────────────────────────────────────────────

router.patch(
  "/:id",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const existing = await pgGet(`SELECT * FROM partners WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    const {
      name, businessRegNo, regions, primaryContactName, contactEmail,
      contactPhone, tier, keyAccountManagerId, contractRef, contractScope,
      contractStart, contractExpiry, notes, status,
    } = req.body;

    const now = new Date().toISOString();

    await pgRun(
      `UPDATE partners SET
         name = COALESCE(?, name),
         business_reg_no = COALESCE(?, business_reg_no),
         regions = COALESCE(?, regions),
         primary_contact_name = COALESCE(?, primary_contact_name),
         contact_email = COALESCE(?, contact_email),
         contact_phone = COALESCE(?, contact_phone),
         tier = COALESCE(?, tier),
         key_account_manager_id = COALESCE(?, key_account_manager_id),
         contract_ref = COALESCE(?, contract_ref),
         contract_scope = COALESCE(?, contract_scope),
         contract_start = COALESCE(?, contract_start),
         contract_expiry = COALESCE(?, contract_expiry),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status),
         updated_at = ?
       WHERE id = ?`,
      [
        name || null, businessRegNo || null,
        regions ? JSON.stringify(regions) : null,
        primaryContactName || null, contactEmail || null, contactPhone || null,
        tier || null, keyAccountManagerId || null, contractRef || null,
        contractScope || null, contractStart || null, contractExpiry || null,
        notes || null, status || null, now, req.params.id,
      ]
    );

    await partnerAudit(req, "PARTNER_UPDATED", `partners/${req.params.id}`, JSON.stringify(req.body));

    const updated = await pgGet(
      `SELECT p.*, u.email AS kam_email FROM partners p LEFT JOIN users u ON u.id = p.key_account_manager_id WHERE p.id = ?`,
      [req.params.id]
    );
    return ok(res, mapPartner(updated));
  }
);

// ─── Soft-delete partner ──────────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const row = await pgGet(`SELECT id, name FROM partners WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    await pgRun(
      `UPDATE partners SET deleted_at = ?, status = 'Inactive', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), req.params.id]
    );

    await partnerAudit(req, "PARTNER_DELETED", `partners/${req.params.id}`, `Deleted partner: ${row.name}`);
    return ok(res, { deleted: true });
  }
);

// ─── Partner 360 view ─────────────────────────────────────────────────────────

router.get(
  "/:id/360",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Finance", "Support", "Operations", "Technical"]),
  async (req: AuthRequest, res) => {
    const partner = await pgGet(
      `SELECT p.*, u.email AS kam_email FROM partners p LEFT JOIN users u ON u.id = p.key_account_manager_id WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    const [contracts, leads, vehicles, portalUsers] = await Promise.all([
      pgAll(`SELECT * FROM partner_contracts WHERE partner_id = ? ORDER BY uploaded_at DESC`, [req.params.id]),

      pgAll(
        `SELECT l.id, l.lead_no, l.status, l.lead_source, l.lead_date, l.created_at,
                c.account_no,
                cp.full_name AS individual_name
         FROM crm_leads l
         LEFT JOIN crm_customers c ON c.id = l.customer_id
         LEFT JOIN crm_individual_profiles cp ON cp.customer_id = l.customer_id
         WHERE l.partner_id = ?
         ORDER BY l.created_at DESC
         LIMIT 100`,
        [req.params.id]
      ),

      pgAll(
        `SELECT v.id, v.registration, v.make, v.model, v.body_type, v.color,
                v.year_of_manufacture, v.loan_tenure_months, v.loan_start_date, v.created_at,
                c.account_no, c.type AS customer_type,
                cp.full_name AS individual_name,
                corp.company_name,
                lat_it.invoice_id,
                lat_it.ticket_no,
                inv.invoice_number,
                inv.amount   AS invoice_amount,
                inv.status   AS invoice_status,
                cert.id           AS cert_id,
                cert.serial_no    AS cert_serial_no,
                cert.end_date     AS cert_end_date
         FROM crm_customer_vehicles v
         JOIN crm_customers c ON c.id = v.customer_id
         LEFT JOIN crm_individual_profiles cp ON cp.customer_id = v.customer_id
         LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
         LEFT JOIN LATERAL (
           SELECT invoice_id, ticket_no
           FROM installation_tickets
           WHERE vehicle_id = v.id AND deleted_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1
         ) lat_it ON TRUE
         LEFT JOIN invoices inv ON inv.id = lat_it.invoice_id
         LEFT JOIN LATERAL (
           SELECT id, serial_no, end_date
           FROM certificates
           WHERE UPPER(car_registration) = UPPER(v.registration)
           ORDER BY created_at DESC
           LIMIT 1
         ) cert ON TRUE
         WHERE v.partner_id = ? AND v.deleted_at IS NULL
         ORDER BY v.created_at DESC`,
        [req.params.id]
      ),

      pgAll(
        `SELECT id, email, full_name, role, status, last_login_at, created_at FROM partner_users WHERE partner_id = ? ORDER BY created_at`,
        [req.params.id]
      ),
    ]);

    const totalLeads = leads.length;
    const convertedLeads = leads.filter((l: any) => l.status === "Converted").length;
    const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

    const now = new Date();
    const vehiclesWithLoan = vehicles.map((v: any) => {
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
        loanTenureMonths: v.loan_tenure_months, loanStartDate: v.loan_start_date,
        loanExpiry, loanDaysLeft,
        customerName: v.individual_name || v.company_name || "—",
        accountNo: v.account_no, customerType: v.customer_type, createdAt: v.created_at,
        ticketNo: v.ticket_no || null,
        invoiceId: v.invoice_id || null,
        invoiceNumber: v.invoice_number || null,
        invoiceAmount: v.invoice_amount ?? null,
        invoiceStatus: v.invoice_status || null,
        certId: v.cert_id || null,
        certSerialNo: v.cert_serial_no || null,
        certEndDate: v.cert_end_date || null,
      };
    });

    return ok(res, {
      partner: mapPartner(partner),
      contracts: contracts.map(mapContract),
      stats: {
        totalLeads, convertedLeads, conversionRate,
        totalVehicles: vehicles.length,
        activePortalUsers: portalUsers.filter((u: any) => u.status === "Active").length,
      },
      leads: leads.map((l: any) => ({
        id: l.id, leadNo: l.lead_no, status: l.status, leadSource: l.lead_source,
        leadDate: l.lead_date, customerName: l.individual_name || "—", accountNo: l.account_no,
        createdAt: l.created_at,
      })),
      vehicles: vehiclesWithLoan,
      portalUsers: portalUsers.map((u: any) => ({
        id: u.id, email: u.email, fullName: u.full_name,
        role: u.role, status: u.status, lastLoginAt: u.last_login_at,
      })),
    });
  }
);

// ─── Add contract document ────────────────────────────────────────────────────

router.post(
  "/:id/contracts",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const partner = await pgGet(`SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    const { fileName, filePath, fileSize, mimeType } = req.body;
    if (!fileName || !filePath) return errorResponse(res, 400, "VALIDATION_ERROR", "fileName and filePath required");

    const id = uuidv4();
    await pgRun(
      `INSERT INTO partner_contracts (id, partner_id, file_name, file_path, file_size, mime_type, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, fileName, filePath, fileSize || null, mimeType || null, req.user!.id, new Date().toISOString()]
    );

    await partnerAudit(req, "CONTRACT_UPLOADED", `partners/${req.params.id}/contracts/${id}`, fileName);

    const row = await pgGet(`SELECT * FROM partner_contracts WHERE id = ?`, [id]);
    return created(res, mapContract(row), "Contract uploaded");
  }
);

// ─── Remove contract document ─────────────────────────────────────────────────

router.delete(
  "/:id/contracts/:cid",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      `SELECT * FROM partner_contracts WHERE id = ? AND partner_id = ?`,
      [req.params.cid, req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Contract not found");

    await pgRun(`DELETE FROM partner_contracts WHERE id = ?`, [req.params.cid]);
    await partnerAudit(req, "CONTRACT_REMOVED", `partners/${req.params.id}/contracts/${req.params.cid}`, row.file_name);
    return ok(res, { deleted: true });
  }
);

// ─── List portal users (internal admin view) ──────────────────────────────────

router.get(
  "/:id/users",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const partner = await pgGet(`SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    const rows = await pgAll(
      `SELECT id, email, full_name, role, status, last_login_at, created_at FROM partner_users WHERE partner_id = ? ORDER BY created_at`,
      [req.params.id]
    );

    return ok(res, {
      data: rows.map((u: any) => ({
        id: u.id, email: u.email, fullName: u.full_name,
        role: u.role, status: u.status, lastLoginAt: u.last_login_at, createdAt: u.created_at,
      })),
    });
  }
);

// ─── Create portal user (internal admin) ─────────────────────────────────────

router.post(
  "/:id/users",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const partner = await pgGet(`SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found");

    const { email, fullName, phone, role = "PartnerUser", password } = req.body;
    if (!email || !fullName || !password) return errorResponse(res, 400, "VALIDATION_ERROR", "email, fullName, password required");

    const existing = await pgGet(`SELECT id FROM partner_users WHERE email = ?`, [email.toLowerCase()]);
    if (existing) return errorResponse(res, 409, "CONFLICT", "Email already registered");

    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const now = new Date().toISOString();

    await pgRun(
      `INSERT INTO partner_users (id, partner_id, email, password_hash, full_name, phone, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`,
      [id, req.params.id, email.toLowerCase(), hash, fullName, phone || null, role, now, now]
    );

    await partnerAudit(req, "PORTAL_USER_CREATED", `partners/${req.params.id}/users/${id}`, email);

    return created(res, { id, email, fullName, role, status: "Active" }, "Portal user created");
  }
);

// ─── Update portal user (internal admin) ─────────────────────────────────────

router.patch(
  "/:id/users/:uid",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const user = await pgGet(
      `SELECT * FROM partner_users WHERE id = ? AND partner_id = ?`,
      [req.params.uid, req.params.id]
    );
    if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found");

    const { fullName, phone, role, status, password } = req.body;
    const now = new Date().toISOString();
    let passwordHash = user.password_hash;
    if (password) passwordHash = await bcrypt.hash(password, 12);

    await pgRun(
      `UPDATE partner_users SET
         full_name = COALESCE(?, full_name),
         phone = COALESCE(?, phone),
         role = COALESCE(?, role),
         status = COALESCE(?, status),
         password_hash = ?,
         updated_at = ?
       WHERE id = ?`,
      [fullName || null, phone || null, role || null, status || null, passwordHash, now, req.params.uid]
    );

    return ok(res, { id: req.params.uid, updated: true });
  }
);

export default router;
