import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { sendEmailViaGraph, createCalendarEvent, isGraphConfigured, MAILBOXES } from "../services/graphMailService.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField } from "../services/cryptoService.js";
import { IdGenerator } from "../utils/idGenerator.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

// ── File upload setup ─────────────────────────────────────────────────────────
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads/lead-attachments");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg","image/png","image/gif","image/webp","application/pdf",
      "application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "audio/mpeg","audio/mp4","audio/ogg","audio/webm","audio/wav","audio/x-m4a",
      "video/mp4","text/plain",
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type ${file.mimetype} not allowed`));
  },
});

// ── Table bootstrap ───────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_leads (
    id TEXT PRIMARY KEY,
    lead_no TEXT UNIQUE NOT NULL,
    lead_source TEXT NOT NULL,
    customer_type TEXT NOT NULL DEFAULT 'new_customer',
    service_requested TEXT NOT NULL DEFAULT '[]',
    sales_rep_id TEXT NOT NULL,
    sales_rep_email TEXT,
    lead_date TEXT NOT NULL,
    lead_notes TEXT,
    status TEXT NOT NULL DEFAULT 'New',
    customer_id TEXT,
    customer_name TEXT,
    email TEXT,
    phone TEXT,
    id_number TEXT,
    company_name TEXT,
    address TEXT,
    account_manager_id TEXT,
    converted_at TEXT,
    converted_to_quote_id TEXT,
    disqualified_reason TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[crm_leads] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_leads_customer ON crm_leads(customer_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status)`, []).catch(() => {});

// ── Migrate: product category + interested products columns ─────────────────
setTimeout(async () => {
  for (const col of [
    "product_category_id TEXT",
    "product_category_name TEXT",
    "products_interested TEXT NOT NULL DEFAULT '[]'",
    "partner_id TEXT",
    "partner_name TEXT",
    "assigned_to_id TEXT",
    "assigned_to_email TEXT",
    "lead_owner_role TEXT",
  ]) {
    await pgRun(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }
}, 1500);

pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_conversations (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    notes TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'Phone call',
    interaction_date TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_by_name TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_conversations] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_convs_lead ON crm_lead_conversations(lead_id)`, []).catch(() => {});

// ── Lead follow-up tasks table ────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_followups (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'Call',
    scheduled_at TEXT NOT NULL,
    reminder_minutes INTEGER NOT NULL DEFAULT 60,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    completed_at TEXT,
    created_by_user_id TEXT NOT NULL,
    created_by_name TEXT,
    assigned_to_id TEXT,
    assigned_to_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_followups] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_followups_lead ON crm_lead_followups(lead_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_followups_scheduled ON crm_lead_followups(scheduled_at)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_followups_status ON crm_lead_followups(status)`, []).catch(() => {});

// ── Helpers ──────────────────────────────────────────────────────────────────
function nextLeadNo(): string {
  return IdGenerator.generateId("lead");
}

function mapLead(row: any) {
  return {
    id: row.id,
    leadNo: row.lead_no,
    leadSource: row.lead_source,
    customerType: row.customer_type,
    serviceRequested: (() => { try { return JSON.parse(row.service_requested || "[]"); } catch { return []; } })(),
    salesRepId: row.sales_rep_id,
    salesRepName: row.sales_rep_name || null,
    salesRepEmail: row.sales_rep_email,
    leadDate: row.lead_date,
    leadNotes: row.lead_notes,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    email: row.email,
    phone: row.phone,
    idNumber: row.id_number,
    companyName: row.company_name,
    address: row.address,
    accountManagerId: row.account_manager_id,
    convertedAt: row.converted_at,
    convertedToQuoteId: row.converted_to_quote_id,
    disqualifiedReason: row.disqualified_reason,
    createdByUserId: row.created_by_user_id,
    productCategoryId: row.product_category_id,
    productCategoryName: row.product_category_name,
    productsInterested: (() => { try { return JSON.parse(row.products_interested || "[]"); } catch { return []; } })(),
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    assignedToId: row.assigned_to_id,
    assignedToEmail: row.assigned_to_email,
    leadOwnerRole: row.lead_owner_role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFollowup(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id,
    title: row.title,
    taskType: row.task_type,
    scheduledAt: row.scheduled_at,
    reminderMinutes: row.reminder_minutes,
    notes: row.notes,
    status: row.status,
    completedAt: row.completed_at,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    assignedToId: row.assigned_to_id,
    assignedToName: row.assigned_to_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── GET / ─ list all leads ───────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  async (req: AuthRequest, res) => {
    const { page = "1", pageSize = "50", search = "", status, salesRepId, customerId } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;

    const filters: string[] = ["l.deleted_at IS NULL"];
    const params: any[] = [];

    // Admin, Executives, and BDM see all leads; everyone else sees only their own or assigned
    const isGlobalViewer = ["Admin", "CEO", "Director", "ExecutiveManagement", "BDM"].includes(req.user!.role);
    if (!isGlobalViewer) {
      filters.push("(l.sales_rep_id = ? OR COALESCE(l.assigned_to_id,'') = ?)");
      params.push(req.user!.id, req.user!.id);
    }

    if (search) {
      filters.push("(l.lead_no ILIKE ? OR l.customer_name ILIKE ? OR l.email ILIKE ? OR l.phone ILIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status)     { filters.push("l.status = ?");         params.push(status); }
    if (salesRepId) { filters.push("l.sales_rep_id = ?");   params.push(salesRepId); }
    if (customerId) { filters.push("l.customer_id = ?");    params.push(customerId); }

    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await pgAll(
      `SELECT l.*, u.name AS sales_rep_name
       FROM crm_leads l LEFT JOIN users u ON u.id = l.sales_rep_id
       ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );
    const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_leads l ${where}`, params);

    auditLog(req, "LEADS_LISTED", "crm_leads", "Info", { status, salesRepId }).catch(console.error);
    return ok(res, { data: rows.map(mapLead), meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── POST / ─ create lead ─────────────────────────────────────────────────────
// Any authenticated staff member can create a lead; sales_rep_id is always set
// to the creator for attribution — only Admin may delegate credit via salesRepId.
router.post(
  "/",
  requireAuth,
  async (req: AuthRequest, res) => {
    const {
      leadSource, customerType = "new_customer", serviceRequested = [],
      salesRepId, salesRepEmail, leadDate, leadNotes,
      customerId, customerName, email, phone, idNumber,
      companyName, address, accountManagerId,
      productCategoryId, productsInterested = [],
      partnerId,
    } = req.body;

    if (!leadSource)   return errorResponse(res, 400, "MISSING_FIELD", "leadSource is required.");
    if (!leadDate)     return errorResponse(res, 400, "MISSING_FIELD", "leadDate is required.");

    // If new_customer, name is required
    if (customerType === "new_customer" && !customerName)
      return errorResponse(res, 400, "MISSING_FIELD", "customerName is required for new customers.");

    // If existing_customer, customerId must be supplied
    if (customerType === "existing_customer" && !customerId)
      return errorResponse(res, 400, "MISSING_FIELD", "customerId is required for existing customers.");

    // Resolve customer name from existing customer if needed
    let resolvedCustomerName = customerName;
    if (customerType === "existing_customer" && customerId) {
      const cust = await pgGet(
        `SELECT c.id,
                COALESCE(i.full_name, corp.company_name) as display_name
         FROM crm_customers c
         LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
         LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
         WHERE c.id = ? AND c.deleted_at IS NULL`,
        [customerId]
      );
      if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");
      resolvedCustomerName = cust.display_name;
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const leadNo = nextLeadNo();

    // Resolve product category name
    let productCategoryName: string | null = null;
    if (productCategoryId) {
      const cat = await pgGet("SELECT name FROM inv_product_categories WHERE id = ?", [productCategoryId]);
      productCategoryName = cat?.name ?? null;
    }

    // Resolve partner name
    let resolvedPartnerName: string | null = null;
    if (partnerId) {
      const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [partnerId]);
      resolvedPartnerName = p?.name ?? null;
    }

    // Attribution: Admin may delegate credit via salesRepId body param;
    // all other roles are always attributed to themselves (the creator).
    const effectiveSalesRepId    = req.user!.role === "Admin" ? (salesRepId || req.user!.id) : req.user!.id;
    const effectiveSalesRepEmail = req.user!.role === "Admin" ? (salesRepEmail || req.user!.email) : req.user!.email;

    await pgRun(
      `INSERT INTO crm_leads
         (id, lead_no, lead_source, customer_type, service_requested, sales_rep_id, sales_rep_email,
          lead_date, lead_notes, status, customer_id, customer_name, email, phone, id_number,
          company_name, address, account_manager_id, product_category_id, product_category_name,
          products_interested, partner_id, partner_name, created_by_user_id, lead_owner_role, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, leadNo, leadSource, customerType,
        JSON.stringify(Array.isArray(serviceRequested) ? serviceRequested : [serviceRequested]),
        effectiveSalesRepId, effectiveSalesRepEmail,
        leadDate, leadNotes || null, "New",
        customerId || null, resolvedCustomerName || null, email || null, phone || null,
        idNumber || null, companyName || null, address || null, accountManagerId || null,
        productCategoryId || null, productCategoryName,
        JSON.stringify(Array.isArray(productsInterested) ? productsInterested : []),
        partnerId || null, resolvedPartnerName,
        req.user!.id, req.user!.role, now, now,
      ]
    );

    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ?", [id]);
    auditLog(req, "LEAD_CREATED", "crm_leads", "Info", { leadNo, customerId, leadSource }).catch(console.error);
    return created(res, mapLead(lead), "Lead created.");
  }
);

// ── GET /:id ─ get lead detail ───────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT l.*, u.name AS sales_rep_name FROM crm_leads l LEFT JOIN users u ON u.id = l.sales_rep_id WHERE l.id = ? AND l.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    // Admin, Executives, and BDM can view any lead; others only their own or assigned
    const isGlobalViewer = ["Admin", "CEO", "Director", "ExecutiveManagement", "BDM"].includes(req.user!.role);
    if (!isGlobalViewer && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Access denied.");

    return ok(res, { data: mapLead(lead) });
  }
);

// ── PATCH /:id ─ update lead ─────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // Non-admin can only edit leads they created or are assigned to work
    if (req.user!.role !== "Admin" && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Cannot edit this lead.");

    const allowed = [
      "lead_source","customer_type","service_requested","lead_date","lead_notes",
      "customer_name","email","phone","id_number","company_name","address","account_manager_id",
      "partner_id","partner_name",
    ];
    // Only Admin can reassign the working rep via PATCH
    if (req.user!.role === "Admin") allowed.push("assigned_to_id", "assigned_to_email");
    const updates: string[] = [];
    const vals: any[] = [];

    // Auto-resolve partner_name when only partnerId is provided
    if (req.body.partnerId && !req.body.partnerName) {
      const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [req.body.partnerId]);
      req.body.partnerName = p?.name ?? "";
    }

    for (const key of allowed) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) {
        updates.push(`${key} = ?`);
        vals.push(key === "service_requested" ? JSON.stringify(req.body[camel]) : req.body[camel]);
      }
    }
    if (!updates.length) return errorResponse(res, 400, "NO_CHANGES", "No updatable fields supplied.");
    updates.push("updated_at = ?");
    vals.push(new Date().toISOString(), req.params.id);

    await pgRun(`UPDATE crm_leads SET ${updates.join(", ")} WHERE id = ?`, vals);
    const updated = await pgGet("SELECT * FROM crm_leads WHERE id = ?", [req.params.id]);
    auditLog(req, "LEAD_UPDATED", "crm_leads", "Info", { leadId: req.params.id }).catch(console.error);
    return ok(res, { data: mapLead(updated!) });
  }
);

// ── POST /:id/qualify ─────────────────────────────────────────────────────────
router.post(
  "/:id/qualify",
  requireAuth,
  requireRole(["Admin", "BDM", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // Admin and BDM can qualify any lead; others only their own or assigned
    if (!(["Admin", "BDM"].includes(req.user!.role)) && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Not your lead.");
    if (lead.status !== "New") return errorResponse(res, 409, "INVALID_STATE", "Only New leads can be qualified.");

    await pgRun(`UPDATE crm_leads SET status = 'Qualified', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), req.params.id]);
    auditLog(req, "LEAD_QUALIFIED", "crm_leads", "Info", { leadId: req.params.id }).catch(console.error);
    return ok(res, { message: "Lead qualified." });
  }
);

// ── POST /:id/disqualify ──────────────────────────────────────────────────────
router.post(
  "/:id/disqualify",
  requireAuth,
  requireRole(["Admin", "BDM", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // Admin and BDM can disqualify any lead; others only their own or assigned
    if (!(["Admin", "BDM"].includes(req.user!.role)) && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Not your lead.");
    if (lead.status === "Converted") return errorResponse(res, 409, "INVALID_STATE", "Converted leads cannot be disqualified.");

    const { reason } = req.body;
    await pgRun(`UPDATE crm_leads SET status = 'Disqualified', disqualified_reason = ?, updated_at = ? WHERE id = ?`,
      [reason || null, new Date().toISOString(), req.params.id]);
    auditLog(req, "LEAD_DISQUALIFIED", "crm_leads", "Info", { leadId: req.params.id, reason }).catch(console.error);
    return ok(res, { message: "Lead disqualified." });
  }
);

// ── POST /:id/convert ─ convert to customer + quote ───────────────────────────
router.post(
  "/:id/convert",
  requireAuth,
  requireRole(["Admin", "BDM", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // Admin and BDM can convert any lead; others only their own or assigned
    if (!(["Admin", "BDM"].includes(req.user!.role)) && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Not your lead.");
    if (lead.status === "Converted") return errorResponse(res, 409, "ALREADY_CONVERTED", "Lead already converted.");

    const now = new Date().toISOString();
    let targetCustomerId = lead.customer_id;
    const { customerId: providedCustomerId } = req.body as { customerId?: string };

    // Sales rep registered the customer via the registration form — just link it
    if (providedCustomerId) {
      const cust = await pgGet(`SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL`, [providedCustomerId]);
      if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Provided customer not found.");
      targetCustomerId = providedCustomerId;
      await pgRun(`UPDATE crm_leads SET customer_id = ?, updated_at = ? WHERE id = ?`, [providedCustomerId, now, lead.id]);
    } else if (lead.customer_type === "new_customer" && !lead.customer_id) {
      const custId   = uuidv4();
      const custType = lead.company_name ? "corporate" : "individual";

      // Generate non-sequential customer account number
      const accountNo = IdGenerator.generateId("customer");

      await pgRun(
        `INSERT INTO crm_customers (id, account_no, type, status, source, created_by_user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [custId, accountNo, custType, "Active", lead.lead_source, req.user!.id, now, now]
      );

      if (lead.company_name) {
        // Corporate profile
        await pgRun(
          `INSERT INTO crm_corporate_profiles (id, customer_id, company_name, physical_address, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
          [uuidv4(), custId, lead.company_name, lead.address || null, now, now]
        );
        // Primary contact person carrying the lead contact details
        await pgRun(
          `INSERT INTO crm_contact_persons (id, customer_id, name, phone_enc, email_enc, is_primary, is_billing, is_operations, created_at, updated_at)
           VALUES (?,?,?,?,?,1,0,0,?,?)`,
          [uuidv4(), custId, lead.customer_name || "Contact", encryptField(lead.phone), encryptField(lead.email), now, now]
        );
      } else {
        // Individual profile — sensitive fields stored encrypted
        await pgRun(
          `INSERT INTO crm_individual_profiles
             (id, customer_id, full_name, full_name_enc, national_id_enc, phone_enc, email_enc, address_enc, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            uuidv4(), custId,
            lead.customer_name || "",
            encryptField(lead.customer_name),
            encryptField(lead.id_number),
            encryptField(lead.phone),
            encryptField(lead.email),
            encryptField(lead.address),
            now, now,
          ]
        );
      }

      targetCustomerId = custId;
      await pgRun(`UPDATE crm_leads SET customer_id = ?, updated_at = ? WHERE id = ?`,
        [custId, now, lead.id]);
    }

    // guard: if still no customer to link, bail out cleanly
    if (!targetCustomerId) {
      return errorResponse(res, 422, "NO_CUSTOMER", "No customer linked. Please register or select a customer first.");
    }

    await pgRun(
      `UPDATE crm_leads SET status = 'Converted', converted_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, req.params.id]
    );

    auditLog(req, "LEAD_CONVERTED", "crm_leads", "Info", { leadId: req.params.id, targetCustomerId }).catch(console.error);
    return ok(res, { data: { customerId: targetCustomerId }, message: "Lead converted to customer." });
  }
);

// ── GET /:id/conversations ────────────────────────────────────────────────────
function mapConversation(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id,
    notes: row.notes,
    channel: row.channel,
    interactionDate: row.interaction_date,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    attachments: (() => { try { return JSON.parse(row.attachments || "[]"); } catch { return []; } })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/:id/conversations",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id, sales_rep_id, assigned_to_id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    const isGlobalViewer = ["Admin", "CEO", "Director", "ExecutiveManagement"].includes(req.user!.role);
    if (!isGlobalViewer && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
    const rows = await pgAll(
      "SELECT * FROM crm_lead_conversations WHERE lead_id = ? ORDER BY interaction_date DESC, created_at DESC",
      [req.params.id]
    );
    return ok(res, { data: rows.map(mapConversation) });
  }
);

// ── POST /:id/conversations ───────────────────────────────────────────────────
router.post(
  "/:id/conversations",
  requireAuth,
  upload.array("attachments", 10) as any,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id, sales_rep_id, assigned_to_id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    if (req.user!.role !== "Admin" && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
    const { notes, channel = "Phone call", interactionDate } = req.body;
    if (!notes?.trim()) return errorResponse(res, 400, "MISSING_FIELD", "notes is required.");
    const files = (req.files as Express.Multer.File[]) || [];
    const attachments = files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      url: `/uploads/lead-attachments/${f.filename}`,
    }));
    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_lead_conversations
         (id, lead_id, notes, channel, interaction_date, created_by_user_id, created_by_name, attachments, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id, req.params.id, notes.trim(), channel,
        interactionDate || now.slice(0, 10),
        req.user!.id, req.user!.email,
        JSON.stringify(attachments), now, now,
      ]
    );
    auditLog(req, "LEAD_CONVERSATION_ADDED", "crm_lead_conversations", "Info", { leadId: req.params.id }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_lead_conversations WHERE id = ?", [id]);
    return created(res, { data: mapConversation(row) }, "Conversation logged.");
  }
);

// ── POST /:id/assign ── assign lead to a Sales team member ──────────────────
// Admin, BDM, Sales managers and TeamLeads can assign any lead to a Telesales,
// FieldSales or Sales person who will then run the sales cycle.
// The original lead creator (sales_rep_id) is preserved for attribution/credit.
router.post(
  "/:id/assign",
  requireAuth,
  requireRole(["Admin", "BDM", "Sales", "TeamLead"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    const { assignedToId } = req.body;
    if (!assignedToId) return errorResponse(res, 400, "MISSING_FIELD", "assignedToId is required.");

    const assignee = await pgGet("SELECT id, email, role FROM users WHERE id = ?", [assignedToId]);
    if (!assignee) return errorResponse(res, 404, "NOT_FOUND", "Assignee user not found.");
    if (!["Telesales", "FieldSales", "Sales", "Admin"].includes(assignee.role))
      return errorResponse(res, 422, "INVALID_ROLE", "Leads can only be assigned to Telesales, FieldSales or Sales team members.");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE crm_leads SET assigned_to_id = ?, assigned_to_email = ?, updated_at = ? WHERE id = ?`,
      [assignedToId, assignee.email, now, req.params.id]
    );
    auditLog(req, "LEAD_ASSIGNED", `crm_leads:${req.params.id}`, "Info",
      { assignedToId, assigneeEmail: assignee.email, assignedBy: req.user!.email }).catch(console.error);

    const updated = await pgGet("SELECT * FROM crm_leads WHERE id = ?", [req.params.id]);
    return ok(res, { data: mapLead(updated) }, `Lead assigned to ${assignee.email}.`);
  }
);

// ── GET /:id/followups ─────────────────────────────────────────────────────
router.get(
  "/:id/followups",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    const rows = await pgAll(
      `SELECT * FROM crm_lead_followups WHERE lead_id = ? ORDER BY scheduled_at ASC`,
      [req.params.id]
    );
    return ok(res, { data: rows.map(mapFollowup) });
  }
);

// ── POST /:id/followups ────────────────────────────────────────────────────
router.post(
  "/:id/followups",
  requireAuth,
  requireRole(["Admin", "Sales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    const { title, taskType, scheduledAt, reminderMinutes, notes, assignedToId, assignedToName } = req.body;
    if (!title?.trim()) return errorResponse(res, 400, "VALIDATION", "Title is required.");
    if (!scheduledAt) return errorResponse(res, 400, "VALIDATION", "Scheduled date/time is required.");

    const id = uuidv4();
    const now = new Date().toISOString();
    const user = req.user!;
    const createdByName = user.email;

    await pgRun(
      `INSERT INTO crm_lead_followups
        (id, lead_id, title, task_type, scheduled_at, reminder_minutes, notes, status,
         created_by_user_id, created_by_name, assigned_to_id, assigned_to_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, title.trim(), taskType || "Call", scheduledAt,
       reminderMinutes ?? 60, notes || null, user.id, createdByName,
       assignedToId || null, assignedToName || null, now, now]
    );
    auditLog(req, "LEAD_FOLLOWUP_CREATED", "crm_lead_followups", "Info", { leadId: req.params.id, title }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_lead_followups WHERE id = ?", [id]);

    // ── Notify sales rep via email + O365 calendar ────────────────────────
    if (isGraphConfigured()) {
      const lead = await pgGet(
        "SELECT lead_no, customer_name, sales_rep_email, assigned_to_email FROM crm_leads WHERE id = ?",
        [req.params.id]
      );
      const recipientEmail = assignedToId
        ? (await pgGet("SELECT email FROM users WHERE id = ?", [assignedToId]))?.email
        : lead?.sales_rep_email;

      if (recipientEmail) {
        const dt = new Date(scheduledAt);
        const dtLabel = dt.toLocaleString("en-KE", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
          hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi",
        });
        const endDt = new Date(dt.getTime() + 60 * 60 * 1000).toISOString().slice(0, 19); // +1 hr

        // Email
        sendEmailViaGraph({
          fromMailbox: MAILBOXES.notification,
          to: recipientEmail,
          subject: `Follow-Up Reminder: ${title} — ${lead?.customer_name ?? ""}`,
          htmlBody: `<p>Hi,</p>
<p>A follow-up task has been booked for lead <strong>${lead?.lead_no ?? ""}</strong> — <strong>${lead?.customer_name ?? ""}</strong>.</p>
<table style="border-collapse:collapse;font-size:14px">
  <tr><td style="padding:4px 12px 4px 0;color:#555">Task</td><td><strong>${title}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555">Type</td><td>${taskType || "Call"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555">Scheduled</td><td>${dtLabel}</td></tr>
  ${notes ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Notes</td><td>${notes}</td></tr>` : ""}
</table>
<p>Please ensure you are prepared for this follow-up.</p>
<p style="color:#888;font-size:12px">Finemark Tracking — CRM</p>`,
        }).catch(e => console.error("[followup] email error:", e.message));

        // Calendar event
        createCalendarEvent({
          userEmail: recipientEmail,
          subject: `Follow-Up: ${title} — ${lead?.customer_name ?? ""}`,
          body: `<p>Lead: ${lead?.lead_no ?? ""} — ${lead?.customer_name ?? ""}</p><p>Type: ${taskType || "Call"}</p>${notes ? `<p>Notes: ${notes}</p>` : ""}`,
          startDateTime: scheduledAt.slice(0, 19),
          endDateTime: endDt,
          timeZone: "Africa/Nairobi",
          reminderMinutes: reminderMinutes ?? 60,
        }).catch(e => console.error("[followup] calendar error:", e.message));
      }
    }

    return created(res, { data: mapFollowup(row) }, "Follow-up task created.");
  }
);

// ── PATCH /:id/followups/:fid ──────────────────────────────────────────────
router.patch(
  "/:id/followups/:fid",
  requireAuth,
  requireRole(["Admin", "Sales"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      "SELECT * FROM crm_lead_followups WHERE id = ? AND lead_id = ?",
      [req.params.fid, req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Follow-up not found.");

    const { title, taskType, scheduledAt, reminderMinutes, notes, status, assignedToId, assignedToName } = req.body;
    const now = new Date().toISOString();
    const completedAt = status === "Completed" && row.status !== "Completed" ? now : row.completed_at;

    await pgRun(
      `UPDATE crm_lead_followups SET
        title = ?, task_type = ?, scheduled_at = ?, reminder_minutes = ?,
        notes = ?, status = ?, assigned_to_id = ?, assigned_to_name = ?,
        completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        title ?? row.title, taskType ?? row.task_type,
        scheduledAt ?? row.scheduled_at, reminderMinutes ?? row.reminder_minutes,
        notes ?? row.notes, status ?? row.status,
        assignedToId ?? row.assigned_to_id, assignedToName ?? row.assigned_to_name,
        completedAt, now, req.params.fid
      ]
    );
    auditLog(req, "LEAD_FOLLOWUP_UPDATED", "crm_lead_followups", "Info", { fid: req.params.fid, status }).catch(console.error);
    const updated = await pgGet("SELECT * FROM crm_lead_followups WHERE id = ?", [req.params.fid]);
    return ok(res, { data: mapFollowup(updated) });
  }
);

// ── DELETE /:id/followups/:fid ─────────────────────────────────────────────
router.delete(
  "/:id/followups/:fid",
  requireAuth,
  requireRole(["Admin", "Sales"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      "SELECT id FROM crm_lead_followups WHERE id = ? AND lead_id = ?",
      [req.params.fid, req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Follow-up not found.");
    await pgRun("DELETE FROM crm_lead_followups WHERE id = ?", [req.params.fid]);
    auditLog(req, "LEAD_FOLLOWUP_DELETED", "crm_lead_followups", "Info", { fid: req.params.fid }).catch(console.error);
    return ok(res, { message: "Follow-up deleted." });
  }
);

// ── GET /followups/upcoming (all upcoming follow-ups for current user) ──────
router.get(
  "/all/followups/upcoming",
  requireAuth,
  async (req: AuthRequest, res) => {
    const user = req.user!;
    const now = new Date().toISOString();
    const isAdmin = ["Admin", "Sales Manager"].includes(user.role);
    const whereUser = isAdmin ? "" : "AND (f.created_by_user_id = ? OR f.assigned_to_id = ?)";
    const params: any[] = isAdmin ? [now] : [now, user.id, user.id];
    const rows = await pgAll(
      `SELECT f.*, l.lead_no, l.customer_name
       FROM crm_lead_followups f
       JOIN crm_leads l ON l.id = f.lead_id
       WHERE f.scheduled_at >= ? AND f.status = 'Pending'
       ${whereUser}
       ORDER BY f.scheduled_at ASC
       LIMIT 50`,
      params
    );
    return ok(res, { data: rows.map(r => ({ ...mapFollowup(r), leadNo: r.lead_no, customerName: r.customer_name })) });
  }
);

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    await pgRun(`UPDATE crm_leads SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), req.params.id]);
    auditLog(req, "LEAD_DELETED", "crm_leads", "Info", { leadId: req.params.id }).catch(console.error);
    return ok(res, { message: "Lead deleted." });
  }
);

export default router;
