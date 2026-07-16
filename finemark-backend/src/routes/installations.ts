import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { assertTransition } from "../domain/installation.js";
import { hashRefreshToken } from "../utils/tokens.js";
import { assignSchema, statusSchema } from "../utils/installationValidators.js";
import { jobCardSchema, confirmSignatureSchema, otpVerifySchema } from "../utils/validators.js";

const router = Router();

const toJob = (row: any) => ({
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
  jobDetails: row.job_details_json ? JSON.parse(row.job_details_json) : null,
  jobCard: row.job_card_json ? JSON.parse(row.job_card_json) : null,
  confirmation: row.confirmation_json ? JSON.parse(row.confirmation_json) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { status, assignedTo, search, page = "1", pageSize = "50", from, to, range } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (pageNum - 1) * sizeNum;

  const filters: string[] = [];
  const params: any[] = [];

  if (status) { filters.push("status = ?"); params.push(status); }
  if (search) {
    filters.push("(customer_name ILIKE ? OR request_id ILIKE ? OR location ILIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  let fromDate = from ? new Date(from).toISOString() : null;
  let toDate = to ? new Date(to).toISOString() : null;
  if (range) {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    toDate = new Date().toISOString();
  }
  if (fromDate) { filters.push("created_at >= ?"); params.push(fromDate); }
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    filters.push("created_at <= ?");
    params.push(end.toISOString());
  }

  if (req.user?.role === "Technician") {
    filters.push("assigned_technician_id = ?");
    params.push(req.user.id);
  } else if (assignedTo === "me") {
    filters.push("assigned_technician_id = ?");
    params.push(req.user?.id);
  } else if (req.user?.role === "Sales") {
    return errorResponse(res, 403, "FORBIDDEN", "Sales cannot access installations list.");
  } else if (req.user?.role === "InstallOffice") {
    // InstallOffice sees all jobs — no ABAC filter
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const list = await pgAll(`SELECT * FROM installation_jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, sizeNum, offset]);
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM installation_jobs ${where}`, params);

  return res.status(200).json({ data: list.map(toJob), meta: { total: Number(totalRow?.total ?? 0) } });
});

router.patch("/:id/assign", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), async (req: AuthRequest, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const { technicianId, scheduledDate } = parsed.data;
  const technician = await pgGet("SELECT * FROM users WHERE id = ?", [technicianId]);
  if (!technician) return errorResponse(res, 404, "NOT_FOUND", "Technician not found.");
  if (technician.role !== "Technician" || technician.status !== "Active") {
    return errorResponse(res, 400, "INVALID_TECHNICIAN", "Technician is not active or has invalid role.");
  }

  const job = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [req.params.id]);
  if (!job) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");

  const canAssignStatuses = ["Requested", "Rescheduled", "Assigned"];
  if (!canAssignStatuses.includes(job.status)) {
    return errorResponse(res, 400, "INVALID_STATUS_TRANSITION", `Cannot assign from status ${job.status}.`);
  }
  if (job.status !== "Assigned") assertTransition(job.status, "Assigned");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_jobs SET assigned_technician_id = ?, assigned_technician_email = ?, scheduled_date = ?, status = ?, updated_at = ? WHERE id = ?`,
    [technicianId, technician.email, scheduledDate || job.scheduled_date, "Assigned", now, job.id]
  );
  const updated = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [job.id]);
  const isPastDate = new Date(scheduledDate).getTime() < Date.now();
  const action = job.status === "Assigned" ? "INSTALLATION_REASSIGNED" : "INSTALLATION_ASSIGNED";
  auditLog(req, action, `installation:${job.id}`, isPastDate ? "Warning" : "Info", { technicianId, technicianEmail: technician.email, scheduledDate, fromStatus: job.status, toStatus: "Assigned", requestId: job.request_id }).catch(console.error);

  return res.status(200).json({ data: toJob(updated), message: "Assigned" });
});

router.patch("/:id/status", requireAuth, async (req: AuthRequest, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const { status } = parsed.data;
  const job = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [req.params.id]);
  if (!job) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");

  const role = req.user?.role;
  if (role === "Technician" && job.assigned_technician_id !== req.user?.id) {
    return errorResponse(res, 403, "FORBIDDEN", "Not assigned to this job.");
  }
  if (status === job.status) return res.status(200).json({ data: toJob(job), message: "No change" });

  const allowedByRole: Record<string, string[]> = {
    Admin: ["Requested", "Assigned", "InProgress", "AwaitingConfirmation", "Completed", "Rescheduled", "Failed"],
    Technical: ["Requested", "Assigned", "Rescheduled", "Failed"],
    Technician: ["InProgress", "AwaitingConfirmation"],
  };
  if (role && allowedByRole[role] && !allowedByRole[role].includes(status)) {
    return errorResponse(res, 403, "FORBIDDEN_STATUS", `Role ${role} cannot set status ${status}.`);
  }

  try { assertTransition(job.status, status); } catch (_error) {
    return errorResponse(res, 400, "INVALID_STATUS_TRANSITION", `Cannot change status from ${job.status} to ${status}.`);
  }

  const now = new Date().toISOString();
  await pgRun("UPDATE installation_jobs SET status = ?, updated_at = ? WHERE id = ?", [status, now, job.id]);
  const updated = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [job.id]);
  const severity = ["Failed", "Rescheduled"].includes(status) ? "Warning" : "Info";
  auditLog(req, "INSTALLATION_STATUS_UPDATED", `installation:${job.id}`, severity, { requestId: job.request_id, fromStatus: job.status, toStatus: status, actorRole: role }).catch(console.error);
  if (status === "Failed") auditLog(req, "INSTALLATION_FAILED", `installation:${job.id}`, "Warning", { requestId: job.request_id, fromStatus: job.status, toStatus: status, actorRole: role }).catch(console.error);
  if (status === "Rescheduled") auditLog(req, "INSTALLATION_RESCHEDULED", `installation:${job.id}`, "Warning", { requestId: job.request_id, fromStatus: job.status, toStatus: status, actorRole: role }).catch(console.error);

  return res.status(200).json({ data: toJob(updated), message: "Status updated" });
});

router.patch("/:id/job-card", requireAuth, requireRole(["Technician", "Admin"]), async (req: AuthRequest, res) => {
  const parsed = jobCardSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const { checklist, photos, notes } = parsed.data;
  const job = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [req.params.id]);
  if (!job) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
  if (!["InProgress", "AwaitingConfirmation"].includes(job.status)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Job card can only be updated in progress or awaiting confirmation.");
  }

  const updatedCard = { checklist: checklist || [], photos: photos || [], notes: notes || "" };
  const now = new Date().toISOString();
  await pgRun("UPDATE installation_jobs SET job_card_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(updatedCard), now, job.id]);
  const updated = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [job.id]);
  auditLog(req, "JOB_CARD_UPDATED", job.id, "Info", {}).catch(console.error);
  return res.status(200).json({ data: toJob(updated) });
});

router.patch("/:id/confirm/signature", requireAuth, requireRole(["Technician", "Admin"]), async (req: AuthRequest, res) => {
  const parsed = confirmSignatureSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const { signedBy, signatureData } = parsed.data;
  const job = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [req.params.id]);
  if (!job) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
  if (job.status !== "AwaitingConfirmation") return errorResponse(res, 400, "VALIDATION_ERROR", "Job is not awaiting confirmation.");

  assertTransition(job.status, "Completed");
  const now = new Date().toISOString();
  const confirmation = { method: "signature", verified: true, signedBy, signatureData, verifiedAt: now };
  await pgRun("UPDATE installation_jobs SET confirmation_json = ?, status = ?, updated_at = ? WHERE id = ?", [JSON.stringify(confirmation), "Completed", now, job.id]);
  const updated = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [job.id]);
  auditLog(req, "INSTALLATION_COMPLETED_SIGNATURE", job.id, "Info", { signedBy }).catch(console.error);
  return res.status(200).json({ data: toJob(updated), message: "Completed" });
});

router.post("/:id/confirm/otp/request", requireAuth, requireRole(["Technician", "Admin"]), async (req: AuthRequest, res) => {
  return errorResponse(res, 403, "FORBIDDEN", "OTP confirmation is temporarily disabled.");

  const job = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [req.params.id]);
  if (!job) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
  if (job.status !== "AwaitingConfirmation") return errorResponse(res, 400, "VALIDATION_ERROR", "Job is not awaiting confirmation.");

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = hashRefreshToken(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await pgRun(
    `INSERT INTO otp_verifications (id, installation_id, otp_hash, expires_at, attempts, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), job.id, otpHash, expiresAt, 0, null, new Date().toISOString()]
  );
  auditLog(req, "OTP_REQUESTED", job.id, "Info", {}).catch(console.error);
  const response: any = { message: "OTP sent", data: { expiresAt } };
  if (process.env.NODE_ENV !== "production") response.data.devOtp = otp;
  return res.status(200).json(response);
});

router.post("/:id/confirm/otp/verify", requireAuth, requireRole(["Technician", "Admin"]), async (req: AuthRequest, res) => {
  return errorResponse(res, 403, "FORBIDDEN", "OTP confirmation is temporarily disabled.");
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error!.flatten());

  const { otp } = parsed.data!;
  const job = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [req.params.id]);
  if (!job) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");

  const otpRow = await pgGet(
    `SELECT * FROM otp_verifications WHERE installation_id = ? AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [job.id]
  );
  if (!otpRow) return errorResponse(res, 404, "NOT_FOUND", "OTP not found.");
  if (new Date(otpRow.expires_at).getTime() < Date.now()) return errorResponse(res, 401, "UNAUTHORIZED", "OTP expired.");

  const otpHash = hashRefreshToken(otp);
  const attempts = otpRow.attempts + 1;
  if (otpRow.otp_hash !== otpHash) {
    await pgRun("UPDATE otp_verifications SET attempts = ? WHERE id = ?", [attempts, otpRow.id]);
    if (attempts > 3) return errorResponse(res, 429, "VALIDATION_ERROR", "Too many attempts.");
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid OTP.");
  }

  const verifiedAt = new Date().toISOString();
  await pgRun("UPDATE otp_verifications SET verified_at = ?, attempts = ? WHERE id = ?", [verifiedAt, attempts, otpRow.id]);
  assertTransition(job.status, "Completed");
  const confirmation = { method: "otp", verified: true, verifiedAt };
  await pgRun("UPDATE installation_jobs SET confirmation_json = ?, status = ?, updated_at = ? WHERE id = ?", [JSON.stringify(confirmation), "Completed", verifiedAt, job.id]);
  const updated = await pgGet("SELECT * FROM installation_jobs WHERE id = ?", [job.id]);
  auditLog(req, "INSTALLATION_COMPLETED_OTP", job.id, "Info", {}).catch(console.error);
  return res.status(200).json({ data: toJob(updated), message: "Completed" });
});

export default router;
