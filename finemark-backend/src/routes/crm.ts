import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { createInvoice } from "../services/invoiceService.js";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { createCRMRecordSchema, listCRMRecordsQuerySchema } from "../utils/crmValidators.js";

const router = Router();

const toRecord = (row: any) => ({
  id: row.id,
  type: row.type,
  customer: row.customer,
  location: row.location,
  status: row.status,
  owner: row.owner_email,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  details: row.details_json ? JSON.parse(row.details_json) : {},
});

const toInstallationJob = (row: any) => ({
  id: row.id,
  requestId: row.request_id,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  location: row.location,
  scheduledDate: row.scheduled_date,
  assignedTechnician: row.assigned_technician_id
    ? { id: row.assigned_technician_id, email: row.assigned_technician_email }
    : null,
  status: row.status,
  jobDetails: row.job_details_json ? JSON.parse(row.job_details_json) : {},
  jobCard: row.job_card_json ? JSON.parse(row.job_card_json) : {},
  confirmation: row.confirmation_json ? JSON.parse(row.confirmation_json) : {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

router.post("/records", requireAuth, requireRole(["Sales", "Technical", "Technician", "Admin"]), async (req: AuthRequest, res) => {
  const parsed = createCRMRecordSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const { type, customer, location, customerPhone, customerEmail, details, status: incomingStatus, bank, salesPerson, issuedOn, dueOn, currency, items, notes } = parsed.data;
  const now = new Date().toISOString();
  const recordId = uuidv4();
  const status = incomingStatus || (type === "invoice" ? "Draft" : "Submitted");
  const payloadDetails = details || {};
  const recordDetails: any = { ...payloadDetails };
  if (notes) recordDetails.notes = notes;

  await pgRun(
    `INSERT INTO crm_records (id, type, customer, location, status, owner_email, created_by_user_id, customer_phone, customer_email, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [recordId, type, customer, location, status, req.user?.email, req.user?.id, customerPhone || null, customerEmail || null, JSON.stringify(recordDetails), now, now]
  );

  let installationPayload: any = null;
  let invoicePayload: any = null;

  if (type === "installation") {
    const jobId = uuidv4();
    const jobDetails = {
      notes: payloadDetails?.notes || "",
      products: payloadDetails?.products || (payloadDetails?.product ? [payloadDetails.product] : []),
      priority: payloadDetails?.priority || "Medium",
      preferredDate: payloadDetails?.preferredDate || null,
      source: "crm_record",
    };
    await pgRun(
      `INSERT INTO installation_jobs (id, request_id, customer_name, customer_phone, location, scheduled_date, assigned_technician_id, assigned_technician_email, status, job_details_json, job_card_json, confirmation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobId, recordId, customer, customerPhone || payloadDetails?.customerPhone || null, location, payloadDetails?.preferredDate || null, null, null, "Requested", JSON.stringify(jobDetails), "{}", "{}", now, now]
    );
    const jobRow = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [jobId]);
    installationPayload = toInstallationJob(jobRow);
    auditLog(req, "INSTALLATION_CREATED", `installation:${jobId}`, "Info", { requestId: recordId }).catch(console.error);
  }

  if (type === "invoice") {
    const computedItems = (items || []).map((item: any) => ({
      description: item.description,
      qty: item.qty,
      unitPrice: item.unitPrice,
      lineTotal: item.qty * item.unitPrice,
    }));
    const amount = computedItems.reduce((sum: number, item: any) => sum + item.lineTotal, 0);
    const invoiceDetails: any = {
      notes: notes || recordDetails?.notes || "",
      items: computedItems,
      amount,
      currency: currency || "KES",
      status: "Draft",
      issuedOn: issuedOn || now.slice(0, 10),
      dueOn: dueOn || now.slice(0, 10),
      bank: bank || null,
      salesPerson: salesPerson || req.user?.email || null,
    };

    const invoice = await createInvoice({
      customer,
      amount,
      currency: currency || "KES",
      status: "Draft",
      issuedOn: invoiceDetails.issuedOn,
      dueOn: invoiceDetails.dueOn,
      bank: invoiceDetails.bank || undefined,
      salesPerson: invoiceDetails.salesPerson || undefined,
      details: invoiceDetails,
      crmRecordId: recordId,
    });

    invoiceDetails.invoiceNumber = invoice.invoiceNumber;
    await pgRun(
      "UPDATE crm_records SET details_json = ?, status = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(invoiceDetails), "Draft", now, recordId]
    );
    invoicePayload = invoice;
    auditLog(req, "INVOICE_CREATED_VIA_CRM", `invoice:${invoice.id}`, "Info", {
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount,
      customer,
      crmRecordId: recordId,
    }).catch(console.error);
  }

  const recordRow = await pgGet("SELECT * FROM crm_records WHERE id = ?", [recordId]);
  auditLog(req, "CRM_RECORD_CREATED", `crm_record:${recordId}`, "Info", { type, customer, location, status }).catch(console.error);

  return res.status(201).json({
    data: installationPayload
      ? { record: toRecord(recordRow), installation: installationPayload }
      : invoicePayload
        ? { record: toRecord(recordRow), invoice: invoicePayload }
        : { record: toRecord(recordRow) },
    message: "Request created",
  });
});

router.get("/invoices", requireAuth, requireRole(["Sales", "Admin"]), async (req: AuthRequest, res) => {
  const parsed = listCRMRecordsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const pageNum = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const sizeNum = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const offset = (pageNum - 1) * sizeNum;
  const { search, status } = parsed.data;
  const { from, to } = parsed.data;

  const filters: string[] = ["crm_records.type = 'invoice'"];
  const params: any[] = [];

  if (search) {
    filters.push("(crm_records.customer ILIKE ? OR crm_records.location ILIKE ? OR crm_records.id ILIKE ? OR invoices.invoice_number ILIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) { filters.push("invoices.status = ?"); params.push(status); }
  if (from) { filters.push("crm_records.created_at >= ?"); params.push(new Date(from).toISOString()); }
  if (to) {
    const end = new Date(to as string);
    end.setHours(23, 59, 59, 999);
    filters.push("crm_records.created_at <= ?");
    params.push(end.toISOString());
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await pgAll(
    `SELECT crm_records.*, invoices.id as invoice_id, invoices.invoice_number, invoices.amount as invoice_amount, invoices.currency as invoice_currency,
      invoices.status as invoice_status, invoices.issued_on, invoices.due_on, invoices.bank, invoices.sales_person, invoices.details_json as invoice_details_json,
      invoices.created_at as invoice_created_at, invoices.updated_at as invoice_updated_at
     FROM crm_records
     JOIN invoices ON invoices.crm_record_id = crm_records.id
     ${where}
     ORDER BY crm_records.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(
    `SELECT COUNT(*) as total FROM crm_records JOIN invoices ON invoices.crm_record_id = crm_records.id ${where}`,
    params
  );

  const data = rows.map((row: any) => ({
    record: toRecord(row),
    invoice: {
      id: row.invoice_id,
      invoiceNumber: row.invoice_number,
      amount: row.invoice_amount,
      currency: row.invoice_currency || "KES",
      status: row.invoice_status,
      issuedOn: row.issued_on,
      dueOn: row.due_on,
      bank: row.bank,
      salesPerson: row.sales_person,
      details: row.invoice_details_json ? JSON.parse(row.invoice_details_json) : null,
      createdAt: row.invoice_created_at,
      updatedAt: row.invoice_updated_at,
      crmRecordId: row.id,
    },
  }));

  return res.status(200).json({ data, meta: { total: Number(totalRow?.total ?? 0) } });
});

router.get("/records", requireAuth, requireRole(["Sales", "Admin"]), async (req: AuthRequest, res) => {
  const parsed = listCRMRecordsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const pageNum = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const sizeNum = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const offset = (pageNum - 1) * sizeNum;
  const { search, type, status, range } = parsed.data;
  let { from, to } = parsed.data;

  if (range) {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  const filters: string[] = [];
  const params: any[] = [];

  if (search) { filters.push("(customer ILIKE ? OR location ILIKE ? OR id ILIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (type) { filters.push("type = ?"); params.push(type); }
  if (status) { filters.push("status = ?"); params.push(status); }
  if (from) { filters.push("created_at >= ?"); params.push(new Date(from).toISOString()); }
  if (to) {
    const end = new Date(to as string);
    end.setHours(23, 59, 59, 999);
    filters.push("created_at <= ?");
    params.push(end.toISOString());
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const list = await pgAll(`SELECT * FROM crm_records ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, sizeNum, offset]);
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_records ${where}`, params);

  return res.status(200).json({ data: list.map(toRecord), meta: { total: Number(totalRow?.total ?? 0) } });
});

export default router;
