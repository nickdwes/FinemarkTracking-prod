import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, ROLES, LEGACY_ROLE_MAP } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { created, errorResponse, ok } from "../utils/responses.js";
import {
  createEmployeeSchema, updateEmployeeSchema, listEmployeesQuerySchema,
  createEmergencyContactSchema, updateEmergencyContactSchema,
  uploadDocumentSchema,
} from "../utils/hrValidators.js";

const router = Router();

// Only HR Admin sees sensitive fields. Managers/TeamLeads get a redacted view.
const mapEmployee = (row: any, isAdmin: boolean) => ({
  id: row.id,
  employeeNo: row.employee_no,
  personalFileNo: row.personal_file_no,
  fullName: row.full_name,
  phone: row.phone,
  email: row.email,
  workEmail: row.work_email,
  userAccountId: row.user_account_id,
  residentialAddress: row.residential_address,
  dateOfBirth: isAdmin ? row.date_of_birth : undefined,
  nationalId: isAdmin ? row.national_id : undefined,
  kraPin: isAdmin ? row.kra_pin : undefined,
  salary: isAdmin ? row.salary : undefined,
  jobRoleId: row.job_role_id,
  jobRoleTitle: row.job_role_title,
  orgUnitId: row.org_unit_id,
  orgUnitName: row.org_unit_name,
  managerId: row.manager_id,
  managerName: row.manager_name,
  cadreId: row.cadre_id,
  cadreName: row.cadre_name,
  benefitPlanId: row.benefit_plan_id,
  employmentType: row.employment_type,
  startDate: row.start_date,
  status: row.status,
  privacyNoticeAcknowledged: Boolean(row.privacy_notice_acknowledged),
  emergencyContactConsent: Boolean(row.emergency_contact_consent),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const EMP_SELECT = `
  SELECT e.*,
    jr.title       AS job_role_title,
    ou.name        AS org_unit_name,
    m.full_name    AS manager_name,
    c.name         AS cadre_name
  FROM hr_employees e
  LEFT JOIN hr_job_roles   jr ON jr.id = e.job_role_id
  LEFT JOIN hr_org_units   ou ON ou.id = e.org_unit_id
  LEFT JOIN hr_employees    m ON  m.id = e.manager_id
  LEFT JOIN hr_cadres       c ON  c.id = e.cadre_id
`;

// ── Employee number: configurable per employment type ───────────────────────
// Format: {prefix}-{type_code}-{NNNN}  e.g. FM-PERM-0001
const nextEmployeeNo = async (employmentType: string): Promise<string> => {
  // Load config for this type (fall back to generic FM-EMP if not configured)
  const cfg = await pgGet(
    "SELECT prefix, type_code, padding FROM hr_emp_no_config WHERE employment_type = ?",
    [employmentType]
  ) as { prefix: string; type_code: string; padding: number } | undefined;
  const prefix   = cfg?.prefix    ?? "FM";
  const typeCode = cfg?.type_code ?? "EMP";
  const padding  = cfg?.padding   ?? 4;

  // Find the highest existing sequence for this type code to avoid duplicates
  const rows = await pgAll(
    "SELECT employee_no FROM hr_employees WHERE employee_no LIKE ? ORDER BY employee_no",
    [`${prefix}-${typeCode}-%`]
  );
  let maxSeq = 0;
  for (const r of rows) {
    const parts = r.employee_no.split("-");
    const seq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}-${typeCode}-${String(maxSeq + 1).padStart(padding, "0")}`;
};

// ── Personal File Number: 5-digit unique, never changes ──────────────────────
const nextPersonalFileNo = async (): Promise<string> => {
  const last = await pgGet(
    "SELECT personal_file_no FROM hr_employees WHERE personal_file_no IS NOT NULL ORDER BY personal_file_no DESC LIMIT 1"
  ) as { personal_file_no: string } | undefined;
  if (!last?.personal_file_no) return "00001";
  const num = parseInt(last.personal_file_no, 10) || 0;
  return String(num + 1).padStart(5, "0");
};

// ═══════════════════════════════════════════════════════════════════════════════
// LIST EMPLOYEES
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const parsed = listEmployeesQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());
  const { search, status, orgUnitId, cadreId, employmentType } = parsed.data;
  const page = Math.max(parseInt(parsed.data.page || "1", 10), 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "20", 10), 100);
  const offset = (page - 1) * pageSize;

  const requesterRole = req.user?.role;
  const isAdmin = requesterRole === "Admin";

  const where: string[] = [];
  const params: any[] = [];
  if (search) {
    where.push("(e.full_name LIKE ? OR e.email LIKE ? OR e.phone LIKE ? OR e.employee_no LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (status) { where.push("e.status = ?"); params.push(status); }
  if (orgUnitId) { where.push("e.org_unit_id = ?"); params.push(orgUnitId); }
  if (cadreId) { where.push("e.cadre_id = ?"); params.push(cadreId); }
  if (employmentType) { where.push("e.employment_type = ?"); params.push(employmentType); }

  // Team leads can only see their direct reports
  if (requesterRole === "TeamLead") {
    const self = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user?.id]);
    if (self) { where.push("e.manager_id = ?"); params.push(self.id); }
    else { return ok(res, { data: [], meta: { total: 0, page, pageSize } }); }
  }

  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (await pgGet(`SELECT COUNT(*) AS cnt FROM hr_employees e ${whereClause}`, params))?.cnt ?? 0;
  const rows = await pgAll(
    `${EMP_SELECT} ${whereClause} ORDER BY e.full_name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return ok(res, { data: rows.map((r: any) => mapEmployee(r, isAdmin)), meta: { total, page, pageSize } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE USER MANAGEMENT LIST  (must be before /:id to avoid conflict)
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/user-management", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (_req, res) => {
  const rows = await pgAll(
    `SELECT
        e.id, e.employee_no, e.full_name, e.email, e.work_email, e.status AS emp_status,
        e.user_account_id, e.start_date, e.employment_type,
        jr.title AS job_role_title, ou.name AS org_unit_name,
        u.id AS user_id, u.role AS user_role, u.status AS user_status,
        u.last_login_at, u.force_password_reset, u.email AS user_email
     FROM hr_employees e
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     LEFT JOIN users u ON u.id = e.user_account_id
     ORDER BY e.full_name`,
    []
  );
  return res.json({
    data: rows.map((r: any) => ({
      id: r.id,
      employeeNo: r.employee_no,
      fullName: r.full_name,
      email: r.email,
      workEmail: r.work_email,
      empStatus: r.emp_status,
      jobRoleTitle: r.job_role_title,
      orgUnitName: r.org_unit_name,
      startDate: r.start_date,
      employmentType: r.employment_type,
      userAccountId: r.user_account_id,
      user: r.user_id ? {
        id: r.user_id,
        email: r.user_email,
        role: r.user_role,
        status: r.user_status,
        lastLoginAt: r.last_login_at,
        forcePasswordReset: Boolean(r.force_password_reset),
      } : null,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id", requireAuth, async (req: AuthRequest, res) => {
  const isAdmin = req.user?.role === "Admin";
  const row = await pgGet(`${EMP_SELECT} WHERE e.id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");

  // Self access: employee can view own profile
  const selfRecord = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user?.id]);
  const isSelf = selfRecord?.id === req.params.id;
  const canonicalRole = LEGACY_ROLE_MAP[req.user?.role ?? ""] ?? req.user?.role;
  const canAccess = isAdmin || isSelf || canonicalRole === ROLES.EXECUTIVE ||
    (req.user?.role === "TeamLead" && row.manager_id === selfRecord?.id);
  if (!canAccess) return errorResponse(res, 403, "FORBIDDEN", "Access denied.");

  const [contacts, docs, promotions, trainings, perf, reports] = await Promise.all([
    pgAll("SELECT * FROM hr_emergency_contacts WHERE employee_id = ?", [req.params.id]),
    pgAll("SELECT id, document_type, file_name, uploaded_by, created_at FROM hr_documents WHERE employee_id = ?", [req.params.id]),
    pgAll(`SELECT ph.*, jr.title AS to_role_title FROM hr_promotion_history ph
           LEFT JOIN hr_job_roles jr ON jr.id = ph.to_role_id
           WHERE ph.employee_id = ? ORDER BY ph.effective_date`, [req.params.id]),
    pgAll("SELECT * FROM hr_training_records WHERE employee_id = ? ORDER BY completion_date DESC", [req.params.id]),
    pgAll("SELECT * FROM hr_performance_records WHERE employee_id = ? ORDER BY review_date DESC", [req.params.id]),
    pgAll(`SELECT e.id, e.employee_no, e.full_name, e.status, jr.title AS job_role_title, ou.name AS org_unit_name
           FROM hr_employees e
           LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
           LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
           WHERE e.manager_id = ? ORDER BY e.full_name`, [req.params.id]),
  ]);

  const directReports = reports.map((r: any) => ({
    id: r.id,
    employeeNo: r.employee_no,
    fullName: r.full_name,
    status: r.status,
    jobRoleTitle: r.job_role_title,
    orgUnitName: r.org_unit_name,
  }));

  return ok(res, { ...mapEmployee(row, isAdmin), emergencyContacts: contacts, documents: docs, promotions, trainings, performance: perf, directReports });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const emailExists = await pgGet("SELECT id FROM hr_employees WHERE email = ?", [d.email]);
  if (emailExists) return errorResponse(res, 409, "CONFLICT", "Employee with this email already exists.");
  const id = uuidv4();
  const [employeeNo, personalFileNo] = await Promise.all([
    nextEmployeeNo(d.employmentType),
    nextPersonalFileNo(),
  ]);
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_employees
      (id, employee_no, personal_file_no, full_name, national_id, kra_pin, date_of_birth, phone, email,
       residential_address, job_role_id, org_unit_id, manager_id, cadre_id, benefit_plan_id, employment_type,
       start_date, salary, status, privacy_notice_acknowledged, emergency_contact_consent, user_account_id,
       created_by_user_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, employeeNo, personalFileNo, d.fullName, d.nationalId || null, d.kraPin || null, d.dateOfBirth || null,
     d.phone, d.email, d.residentialAddress || null, d.jobRoleId || null, d.orgUnitId || null,
     d.managerId || null, d.cadreId || null, d.benefitPlanId || null, d.employmentType,
     d.startDate, d.salary ?? null, d.status, d.privacyNoticeAcknowledged, d.emergencyContactConsent,
     d.userAccountId || null, req.user?.id, now, now]
  );
  auditLog(req, "HR_EMPLOYEE_CREATED", `hr_employee:${id}`, "Info", { employeeNo, personalFileNo, fullName: d.fullName }).catch(console.error);
  return created(res, { id, employeeNo, personalFileNo, fullName: d.fullName, status: d.status }, "Employee created");
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════════════
router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT * FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const isAdmin = req.user?.role === "Admin";
  const selfRecord = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user?.id]);
  const isSelf = selfRecord?.id === req.params.id;
  if (!isAdmin && !isSelf) return errorResponse(res, 403, "FORBIDDEN", "Only HR Admin can update employees.");

  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;

  // Non-admins cannot change sensitive or structural fields
  if (!isAdmin) {
    const forbidden = ["salary", "nationalId", "kraPin", "jobRoleId", "orgUnitId", "managerId",
      "cadreId", "benefitPlanId", "employmentType", "status"] as const;
    for (const f of forbidden) {
      if (d[f] !== undefined) return errorResponse(res, 403, "FORBIDDEN", `Cannot modify field: ${f}`);
    }
  }
  const now = new Date().toISOString();

  // If employment type is changing, regenerate employee number for the new type
  let newEmployeeNo: string | null = null;
  if (d.employmentType && d.employmentType !== emp.employment_type) {
    newEmployeeNo = await nextEmployeeNo(d.employmentType);
    auditLog(req, "HR_EMPLOYEE_NO_CHANGED", `hr_employee:${req.params.id}`, "Info", {
      oldEmploymentType: emp.employment_type,
      newEmploymentType: d.employmentType,
      oldEmployeeNo: emp.employee_no,
      newEmployeeNo,
    }).catch(console.error);
  }

  await pgRun(
    `UPDATE hr_employees SET
      full_name=COALESCE(?,full_name), national_id=COALESCE(?,national_id), kra_pin=COALESCE(?,kra_pin),
      date_of_birth=COALESCE(?,date_of_birth), phone=COALESCE(?,phone), email=COALESCE(?,email),
      residential_address=COALESCE(?,residential_address), job_role_id=COALESCE(?,job_role_id),
      org_unit_id=COALESCE(?,org_unit_id), manager_id=COALESCE(?,manager_id),
      cadre_id=COALESCE(?,cadre_id), benefit_plan_id=COALESCE(?,benefit_plan_id),
      employment_type=COALESCE(?,employment_type),
      employee_no=COALESCE(?,employee_no),
      start_date=COALESCE(?,start_date),
      salary=COALESCE(?,salary), status=COALESCE(?,status),
      work_email=COALESCE(?,work_email),
      privacy_notice_acknowledged=COALESCE(?,privacy_notice_acknowledged),
      emergency_contact_consent=COALESCE(?,emergency_contact_consent),
      user_account_id=COALESCE(?,user_account_id), updated_at=? WHERE id=?`,
    [d.fullName ?? null, d.nationalId ?? null, d.kraPin ?? null, d.dateOfBirth ?? null,
     d.phone ?? null, d.email ?? null, d.residentialAddress ?? null, d.jobRoleId ?? null,
     d.orgUnitId ?? null, d.managerId ?? null, d.cadreId ?? null, d.benefitPlanId ?? null,
     d.employmentType ?? null, newEmployeeNo,
     d.startDate ?? null, d.salary ?? null, d.status ?? null,
     d.workEmail ?? null,
     d.privacyNoticeAcknowledged ?? null, d.emergencyContactConsent ?? null,
     d.userAccountId ?? null, now, req.params.id]
  );
  auditLog(req, "HR_EMPLOYEE_UPDATED", `hr_employee:${req.params.id}`, "Info", d).catch(console.error);
  const updated = await pgGet("SELECT employee_no, personal_file_no FROM hr_employees WHERE id = ?", [req.params.id]);
  return ok(res, { id: req.params.id, employeeNo: updated?.employee_no, personalFileNo: updated?.personal_file_no }, "Employee updated");
});

// ── Archive / delete (data retention) ────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id, status FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  if (emp.status !== "Terminated") return errorResponse(res, 409, "CONFLICT", "Employee must be Terminated before deletion.");
  // Cascade soft-delete of related records
  await pgRun("DELETE FROM hr_emergency_contacts WHERE employee_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_documents WHERE employee_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_promotion_history WHERE employee_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_training_records WHERE employee_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_performance_records WHERE employee_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_employees WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_EMPLOYEE_DELETED", `hr_employee:${req.params.id}`, "Critical", { reason: "data_retention" }).catch(console.error);
  return ok(res, null, "Employee and related records permanently deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMERGENCY CONTACTS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id/emergency-contacts", requireAuth, async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  return ok(res, await pgAll("SELECT * FROM hr_emergency_contacts WHERE employee_id = ?", [req.params.id]));
});

router.post("/:id/emergency-contacts", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const parsed = createEmergencyContactSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    "INSERT INTO hr_emergency_contacts (id, employee_id, name, relationship, phone, consent_given, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, req.params.id, parsed.data.name, parsed.data.relationship, parsed.data.phone, parsed.data.consentGiven, now, now]
  );
  auditLog(req, "HR_EMERGENCY_CONTACT_ADDED", `hr_employee:${req.params.id}`, "Info", {}).catch(console.error);
  return created(res, { id }, "Emergency contact added");
});

router.patch("/:id/emergency-contacts/:cid", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const contact = await pgGet("SELECT id FROM hr_emergency_contacts WHERE id = ? AND employee_id = ?", [req.params.cid, req.params.id]);
  if (!contact) return errorResponse(res, 404, "NOT_FOUND", "Contact not found.");
  const parsed = updateEmergencyContactSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  await pgRun(
    "UPDATE hr_emergency_contacts SET name=COALESCE(?,name), relationship=COALESCE(?,relationship), phone=COALESCE(?,phone), consent_given=COALESCE(?,consent_given), updated_at=? WHERE id=?",
    [d.name ?? null, d.relationship ?? null, d.phone ?? null, d.consentGiven ?? null, now, req.params.cid]
  );
  return ok(res, null, "Contact updated");
});

router.delete("/:id/emergency-contacts/:cid", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  await pgRun("DELETE FROM hr_emergency_contacts WHERE id = ? AND employee_id = ?", [req.params.cid, req.params.id]);
  return ok(res, null, "Contact deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id/documents", requireAuth, async (req: AuthRequest, res) => {
  const isAdmin = req.user?.role === "Admin";
  const self = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user?.id]);
  const isSelf = self?.id === req.params.id;
  if (!isAdmin && !isSelf) return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
  const docs = await pgAll("SELECT id, document_type, file_name, uploaded_by, created_at FROM hr_documents WHERE employee_id = ?", [req.params.id]);
  return ok(res, docs);
});

router.post("/:id/documents", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const parsed = uploadDocumentSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    "INSERT INTO hr_documents (id, employee_id, document_type, file_name, file_base64, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)",
    [id, req.params.id, parsed.data.documentType, parsed.data.fileName, parsed.data.fileBase64, req.user?.email || "system", now]
  );
  auditLog(req, "HR_DOCUMENT_UPLOADED", `hr_employee:${req.params.id}`, "Info", { documentType: parsed.data.documentType }).catch(console.error);
  return created(res, { id, fileName: parsed.data.fileName }, "Document uploaded");
});

router.get("/:id/documents/:did", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const doc = await pgGet("SELECT * FROM hr_documents WHERE id = ? AND employee_id = ?", [req.params.did, req.params.id]);
  if (!doc) return errorResponse(res, 404, "NOT_FOUND", "Document not found.");
  return ok(res, doc);
});

router.delete("/:id/documents/:did", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const doc = await pgGet("SELECT id FROM hr_documents WHERE id = ? AND employee_id = ?", [req.params.did, req.params.id]);
  if (!doc) return errorResponse(res, 404, "NOT_FOUND", "Document not found.");
  await pgRun("DELETE FROM hr_documents WHERE id = ?", [req.params.did]);
  auditLog(req, "HR_DOCUMENT_DELETED", `hr_employee:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Document deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORK EMAIL
// ═══════════════════════════════════════════════════════════════════════════════
router.patch("/:id/work-email", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const { workEmail } = req.body as { workEmail?: string };
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");

  if (workEmail) {
    const taken = await pgGet("SELECT id FROM hr_employees WHERE work_email = ? AND id != ?", [workEmail, req.params.id]);
    if (taken) return errorResponse(res, 409, "CONFLICT", "This work email is already assigned to another employee.");
    // Also check if it's in use as a user login
    const userTaken = await pgGet("SELECT id FROM users WHERE email = ?", [workEmail]);
    const linked = await pgGet("SELECT user_account_id FROM hr_employees WHERE id = ?", [req.params.id]);
    if (userTaken && userTaken.id !== linked?.user_account_id) {
      return errorResponse(res, 409, "CONFLICT", "This email is already used by another ERP user account.");
    }
  }

  const now = new Date().toISOString();
  await pgRun(
    "UPDATE hr_employees SET work_email = ?, updated_at = ? WHERE id = ?",
    [workEmail || null, now, req.params.id]
  );
  auditLog(req, "HR_WORK_EMAIL_UPDATED", `hr_employee:${req.params.id}`, "Info", { workEmail }).catch(console.error);
  return ok(res, { workEmail: workEmail || null }, "Work email updated");
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE ERP USER FROM EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/:id/create-user", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  try {
  const emp = await pgGet("SELECT * FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");

  if (emp.user_account_id) {
    return errorResponse(res, 409, "CONFLICT", "This employee already has an ERP user account linked.");
  }

  const loginEmail = emp.work_email || emp.email;
  const { role, tempPassword, forcePasswordReset = true } = req.body as {
    role?: string;
    tempPassword?: string;
    forcePasswordReset?: boolean;
  };

  if (!role) return errorResponse(res, 400, "VALIDATION_ERROR", "role is required.");
  if (!tempPassword || tempPassword.length < 8) return errorResponse(res, 400, "VALIDATION_ERROR", "tempPassword must be at least 8 characters.");
  if (!/[A-Z]/.test(tempPassword)) return errorResponse(res, 400, "VALIDATION_ERROR", "tempPassword must include an uppercase letter.");
  if (!/[0-9]/.test(tempPassword)) return errorResponse(res, 400, "VALIDATION_ERROR", "tempPassword must include a number.");

  // Check email not already in users table
  const existing = await pgGet("SELECT id FROM users WHERE email = ?", [loginEmail]);
  if (existing) {
    return errorResponse(res, 409, "CONFLICT", `The email '${loginEmail}' is already used by another user. Set a unique work email first.`);
  }

  const { createUser } = await import("../services/userService.js");
  let newUser: any;
  try {
    newUser = await createUser({
      name: emp.full_name,
      email: loginEmail,
      role,
      tempPassword,
      forcePasswordReset: Boolean(forcePasswordReset),
      status: emp.status === "Active" ? "Active" : "Disabled",
    });
  } catch (err: any) {
    console.error("[hr] createUser failed:", err?.message);
    const msg = err?.message || "";
    if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("duplicate") || msg.includes("already exists")) {
      return errorResponse(res, 409, "CONFLICT", `An account with email '${loginEmail}' already exists.`);
    }
    return errorResponse(res, 500, "DB_ERROR", "Failed to create user account. " + (msg || ""));
  }

  const now = new Date().toISOString();
  await pgRun("UPDATE hr_employees SET user_account_id = ?, updated_at = ? WHERE id = ?", [newUser.id, now, req.params.id]);

  auditLog(req, "HR_ERP_USER_CREATED", `hr_employee:${req.params.id}`, "Info", {
    userId: newUser.id,
    loginEmail,
    role,
    employeeName: emp.full_name,
  }).catch(console.error);

  return res.status(201).json({
    message: "ERP user account created and linked to employee.",
    userId: newUser.id,
    loginEmail,
    role,
    forcePasswordReset: Boolean(forcePasswordReset),
  });
  } catch (outerErr: any) {
    console.error("[hr] create-user unhandled:", outerErr?.message, outerErr);
    return errorResponse(res, 500, "SERVER_ERROR", outerErr?.message || "Failed to create ERP user account.");
  }
});

export default router;
