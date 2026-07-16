import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// ── Table bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_installation_surveys (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    technician_id TEXT,
    sales_rep_id TEXT,
    survey_token TEXT UNIQUE,
    survey_link_sent_at TEXT,
    installation_rating INTEGER,
    technician_rating INTEGER,
    service_quality_rating INTEGER,
    comments TEXT,
    submitted_at TEXT,
    submitted_channel TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[crm_installation_surveys] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_surveys_install ON crm_installation_surveys(installation_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_surveys_customer ON crm_installation_surveys(customer_id)`, []).catch(() => {});

function mapSurvey(r: any) {
  return {
    id: r.id, installationId: r.installation_id, customerId: r.customer_id,
    technicianId: r.technician_id, salesRepId: r.sales_rep_id,
    surveyToken: r.survey_token, surveyLinkSentAt: r.survey_link_sent_at,
    installationRating: r.installation_rating, technicianRating: r.technician_rating,
    serviceQualityRating: r.service_quality_rating, comments: r.comments,
    submittedAt: r.submitted_at, submittedChannel: r.submitted_channel,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin","Sales","Technical","Technician"]), async (req: AuthRequest, res) => {
  const { customerId, installationId, submitted, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset  = (pageNum - 1) * sizeNum;

  const filters: string[] = ["s.deleted_at IS NULL"];
  const params: any[] = [];

  // Role-based scoping
  if (req.user!.role === "Technician") { filters.push("s.technician_id = ?"); params.push(req.user!.id); }
  if (req.user!.role === "Sales")      { filters.push("s.sales_rep_id = ?");  params.push(req.user!.id); }

  if (customerId)     { filters.push("s.customer_id = ?");      params.push(customerId); }
  if (installationId) { filters.push("s.installation_id = ?");  params.push(installationId); }
  if (submitted === "true")  { filters.push("s.submitted_at IS NOT NULL"); }
  if (submitted === "false") { filters.push("s.submitted_at IS NULL"); }

  const where = `WHERE ${filters.join(" AND ")}`;
  const rows  = await pgAll(
    `SELECT s.*, COALESCE(i.full_name, corp.company_name) as customer_name
     FROM crm_installation_surveys s
     JOIN crm_customers c ON c.id = s.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_installation_surveys s ${where}`, params);
  return ok(res, {
    data: rows.map(r => ({ ...mapSurvey(r), customerName: r.customer_name })),
    meta: { total: Number(totalRow?.total ?? 0) },
  });
});

// ── POST / ─ create survey (system sends after installation complete) ──────────
router.post("/", requireAuth, requireRole(["Admin","Technical","Technician"]), async (req: AuthRequest, res) => {
  const { installationId, customerId, technicianId, salesRepId } = req.body;
  if (!installationId || !customerId)
    return errorResponse(res, 400, "MISSING_FIELD", "installationId and customerId required.");

  // One survey per installation
  const existing = await pgGet(
    `SELECT id FROM crm_installation_surveys WHERE installation_id = ? AND deleted_at IS NULL`, [installationId]
  );
  if (existing) return errorResponse(res, 409, "ALREADY_EXISTS", "Survey already exists for this installation.");

  const now   = new Date().toISOString();
  const id    = uuidv4();
  const token = uuidv4().replace(/-/g, "");   // survey link token

  await pgRun(
    `INSERT INTO crm_installation_surveys
       (id,installation_id,customer_id,technician_id,sales_rep_id,survey_token,survey_link_sent_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, installationId, customerId, technicianId||null, salesRepId||null, token, now, now, now]
  );

  const survey = await pgGet("SELECT * FROM crm_installation_surveys WHERE id = ?", [id]);
  auditLog(req, "SURVEY_CREATED", "crm_installation_surveys", "Info", { installationId }).catch(console.error);
  return created(res, { data: { ...mapSurvey(survey!), surveyUrl: `/crm-survey.html?token=${token}` } }, "Survey created.");
});

// ── GET /by-token/:token ─ public survey fetch (no auth — customer link) ──────
router.get("/by-token/:token", async (req, res) => {
  const survey = await pgGet(
    `SELECT s.*, COALESCE(i.full_name, corp.company_name) as customer_name
     FROM crm_installation_surveys s
     JOIN crm_customers c ON c.id = s.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     WHERE s.survey_token = ? AND s.deleted_at IS NULL`,
    [req.params.token]
  );
  if (!survey) return errorResponse(res, 404, "NOT_FOUND", "Survey not found.");
  return ok(res, { data: { ...mapSurvey(survey), customerName: survey.customer_name } });
});

// ── POST /by-token/:token/submit ─ customer submits survey ───────────────────
router.post("/by-token/:token/submit", async (req, res) => {
  const survey = await pgGet(
    `SELECT * FROM crm_installation_surveys WHERE survey_token = ? AND deleted_at IS NULL`,
    [req.params.token]
  );
  if (!survey) return errorResponse(res, 404, "NOT_FOUND", "Survey not found.");
  if (survey.submitted_at) return errorResponse(res, 409, "ALREADY_SUBMITTED", "Survey already submitted.");

  const { installationRating, technicianRating, serviceQualityRating, comments, channel } = req.body;

  if (!installationRating || !technicianRating || !serviceQualityRating)
    return errorResponse(res, 400, "MISSING_FIELD", "All three ratings are required.");

  const rating = (v: any) => Math.min(5, Math.max(1, parseInt(v, 10) || 1));
  const now = new Date().toISOString();

  await pgRun(
    `UPDATE crm_installation_surveys
     SET installation_rating=?, technician_rating=?, service_quality_rating=?,
         comments=?, submitted_at=?, submitted_channel=?, updated_at=?
     WHERE id=?`,
    [rating(installationRating), rating(technicianRating), rating(serviceQualityRating),
     comments||null, now, channel||"web", now, survey.id]
  );

  return ok(res, { message: "Thank you for your feedback!" });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Admin","Sales","Technical","Technician"]), async (req: AuthRequest, res) => {
  const row = await pgGet(
    `SELECT s.*, COALESCE(i.full_name, corp.company_name) as customer_name
     FROM crm_installation_surveys s
     JOIN crm_customers c ON c.id = s.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     WHERE s.id = ? AND s.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Survey not found.");
  return ok(res, { data: { ...mapSurvey(row), customerName: row.customer_name } });
});

export default router;
