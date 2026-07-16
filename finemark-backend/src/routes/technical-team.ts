/**
 * technical-team.ts
 *
 * Authoritative roster for Technicians and Installation Support Officers (ISO).
 * Members are explicitly enrolled via this module and stored in technical_team_roster.
 * This is the single source of truth used by every module that needs a technician list.
 *
 * Endpoints:
 *   GET    /technical-team/members          – roster (active + on-leave by default)
 *   GET    /technical-team/me               – current user's own roster entry + check-in status
 *   GET    /technical-team/candidates       – HR employees / user accounts not yet enrolled
 *   POST   /technical-team/members          – enrol a new member
 *   POST   /technical-team/checkin          – technician self check-in with location
 *   PATCH  /technical-team/members/:id      – update duty status / name / notes
 *   DELETE /technical-team/members/:id      – remove from roster
 */

import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { pgAll, pgGet, pgRun } from "../db.js";
import { v4 as uuidv4 } from "uuid";

const router = Router();

const VIEW_ROLES   = ["Admin", "Technical", "Technician", "InventoryManager", "WarehouseOfficer", "Sales", "InstallOffice", "CertAdmin"] as const;

// ────────────────────────────────────────────────────────────────
// Shared helper — used by this route AND device-custody
// id returned = user_account_id || hr_employee_id || roster_id
//   (preserves backward-compat with stored assignedTechnicianId values)
// ────────────────────────────────────────────────────────────────
export async function fetchTechnicalTeam(opts: {
  roleFilter?: "Technician" | "ISO" | "all";
  activeOnly?: boolean;
} = {}) {
  const { roleFilter = "all", activeOnly = true } = opts;
  const statusFilter = activeOnly ? `AND r.duty_status IN ('Active','On Leave')` : "";

  const rows = await pgAll(
    `SELECT
       r.id            AS roster_id,
       r.member_type,
       r.display_name,
       r.email         AS roster_email,
       r.phone,
       r.user_account_id,
       r.hr_employee_id,
       r.duty_status,
       r.notes,
       r.current_location,
       r.checked_in_at,
       r.added_at,
       -- HR enrichment
       e.full_name      AS hr_full_name,
       e.work_email     AS hr_work_email,
       e.status         AS hr_status,
       e.employee_no,
       jr.title         AS job_role_title,
       ou.name          AS org_unit_name,
       -- User account enrichment
       u.name           AS user_name,
       u.role           AS user_role,
       u.status         AS user_status
     FROM technical_team_roster r
     LEFT JOIN hr_employees e  ON e.id  = r.hr_employee_id
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     LEFT JOIN users u         ON u.id  = r.user_account_id
     WHERE 1=1 ${statusFilter}
     ORDER BY r.display_name`,
    []
  ).catch(() => [] as any[]);

  const members = rows.map((r: any) => {
    const jobTitle = r.job_role_title ||
      (r.member_type === "ISO" ? "Installation Support Officer" : "Technician");
    return {
      // Backward-compat id for assignment comparisons
      id:            r.user_account_id || r.hr_employee_id || r.roster_id,
      rosterId:      r.roster_id,
      fullName:      r.hr_full_name   || r.user_name || r.display_name || "—",
      email:         r.hr_work_email  || r.roster_email || "",
      phone:         r.phone          || "",
      memberRole:    r.member_type    as "Technician" | "ISO",
      jobRoleTitle:  jobTitle,
      orgUnitName:   r.org_unit_name  || "Technical",
      hasUserAccount: !!r.user_account_id,
      hrEmployeeId:  r.hr_employee_id || null,
      userRole:      r.user_role      || null,
      employeeNo:    r.employee_no    || "",
      status:        r.duty_status,
      dutyStatus:    r.duty_status,
      notes:         r.notes          || "",
      currentLocation: r.current_location || null,
      checkedInAt:   r.checked_in_at  || null,
      addedAt:       r.added_at,
    };
  });

  if (roleFilter === "Technician") return members.filter((m: any) => m.memberRole === "Technician");
  if (roleFilter === "ISO")        return members.filter((m: any) => m.memberRole === "ISO");
  return members;
}

// ────────────────────────────────────────────────────────────────
// GET /technical-team/me  — current user's own roster entry
// ────────────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req: AuthRequest, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: { message: "Unauthorized" } });
  const row = await pgGet(
    `SELECT r.*, u.name AS user_name, u.role AS user_role
     FROM technical_team_roster r
     LEFT JOIN users u ON u.id = r.user_account_id
     WHERE r.user_account_id = $1`,
    [userId]
  ).catch(() => null);
  if (!row) return res.json({ data: null });
  return res.json({
    data: {
      rosterId:        row.id,
      dutyStatus:      row.duty_status,
      currentLocation: row.current_location || null,
      checkedInAt:     row.checked_in_at  || null,
      displayName:     row.display_name,
      memberType:      row.member_type,
    }
  });
});

// ────────────────────────────────────────────────────────────────
// GET /technical-team/members
// ────────────────────────────────────────────────────────────────
router.get("/members", requireAuth, requireRole([...VIEW_ROLES]), async (req: AuthRequest, res) => {
  const roleRaw    = (req.query.role as string) || "all";
  const roleFilter = (["Technician","ISO","all"].includes(roleRaw) ? roleRaw : "all") as any;
  const activeOnly = req.query.active !== "false";
  const members    = await fetchTechnicalTeam({ roleFilter, activeOnly });
  return res.json({ data: members });
});

// ────────────────────────────────────────────────────────────────
// GET /technical-team/candidates
// Returns HR employees + user accounts NOT yet in the roster.
// Used by the "Add Technician / ISO" modal on technical.html.
// ────────────────────────────────────────────────────────────────
router.get("/candidates", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), async (_req: AuthRequest, res) => {
  const [hrRows, userRows] = await Promise.all([
    pgAll(
      `SELECT e.id, e.full_name, e.email, e.work_email, e.user_account_id,
              jr.title AS job_role_title, ou.name AS org_unit_name
       FROM hr_employees e
       LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
       LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
       WHERE e.status IN ('Active','On Leave')
         AND ou.name ILIKE 'Technical'
         AND NOT EXISTS (SELECT 1 FROM technical_team_roster r WHERE r.hr_employee_id = e.id)
         AND (
           e.user_account_id IS NULL OR
           NOT EXISTS (SELECT 1 FROM technical_team_roster r WHERE r.user_account_id = e.user_account_id)
         )
       ORDER BY e.full_name`,
      []
    ).catch(() => [] as any[]),
    pgAll(
      `SELECT u.id, u.name, u.email, u.role
       FROM users u
       WHERE u.role IN ('Technician','Technical')
         AND u.status = 'Active'
         AND NOT EXISTS (SELECT 1 FROM technical_team_roster r WHERE r.user_account_id = u.id)
       ORDER BY u.name`,
      []
    ).catch(() => [] as any[]),
  ]);

  const candidates = [
    ...hrRows.map((e: any) => ({
      candidateId:  e.id,
      source:       "hr" as const,
      displayName:  e.full_name,
      email:        e.work_email || e.email,
      jobRoleTitle: e.job_role_title || "",
      orgUnitName:  e.org_unit_name  || "",
      userAccountId: e.user_account_id || null,
      suggestedType: (e.job_role_title || "").toLowerCase().includes("support officer") ? "ISO" : "Technician",
    })),
    ...userRows.map((u: any) => ({
      candidateId:  u.id,
      source:       "user" as const,
      displayName:  u.name || u.email,
      email:        u.email,
      jobRoleTitle: u.role,
      orgUnitName:  "Technical",
      userAccountId: u.id,
      suggestedType: "Technician" as const,
    })),
  ];

  return res.json({ data: candidates });
});

// ────────────────────────────────────────────────────────────────
// POST /technical-team/members  — enrol a new member
// Body: { memberType, displayName, email, phone?, userAccountId?, hrEmployeeId?, notes? }
// ────────────────────────────────────────────────────────────────
router.post("/members", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), async (req: AuthRequest, res) => {
  const { memberType, displayName, email, phone, userAccountId, hrEmployeeId, notes } = req.body || {};
  if (!memberType || !["Technician","ISO"].includes(memberType)) {
    return res.status(400).json({ error: { message: "memberType must be Technician or ISO" } });
  }
  if (!displayName?.trim()) {
    return res.status(400).json({ error: { message: "displayName is required" } });
  }

  // Prevent duplicates
  if (userAccountId) {
    const existing = await pgGet(`SELECT id FROM technical_team_roster WHERE user_account_id=$1`, [userAccountId]).catch(() => null);
    if (existing) return res.status(409).json({ error: { message: "This user account is already on the team" } });
  }
  if (hrEmployeeId) {
    const existing = await pgGet(`SELECT id FROM technical_team_roster WHERE hr_employee_id=$1`, [hrEmployeeId]).catch(() => null);
    if (existing) return res.status(409).json({ error: { message: "This HR employee is already on the team" } });
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO technical_team_roster
       (id, member_type, display_name, email, phone, user_account_id, hr_employee_id, notes, added_by, added_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, memberType, displayName.trim(), email || null, phone || null,
     userAccountId || null, hrEmployeeId || null, notes || null,
     (req as any).user?.id || null, now, now]
  );

  const member = await pgGet(
    `SELECT r.*, e.full_name, e.work_email, jr.title AS job_role_title, ou.name AS org_unit_name, u.name AS user_name, u.role AS user_role
     FROM technical_team_roster r
     LEFT JOIN hr_employees e ON e.id=r.hr_employee_id
     LEFT JOIN hr_job_roles jr ON jr.id=e.job_role_id
     LEFT JOIN hr_org_units ou ON ou.id=e.org_unit_id
     LEFT JOIN users u ON u.id=r.user_account_id
     WHERE r.id=$1`, [id]
  ).catch(() => null);

  return res.status(201).json({ data: member });
});

// ────────────────────────────────────────────────────────────────
// PATCH /technical-team/members/:id  — update duty status / name / notes
// ────────────────────────────────────────────────────────────────
router.patch("/members/:id", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), async (req: AuthRequest, res) => {
  const existing = await pgGet(
    `SELECT id FROM technical_team_roster WHERE id=$1 OR user_account_id=$1 OR hr_employee_id=$1`,
    [req.params.id]
  ).catch(() => null);
  if (!existing) return res.status(404).json({ error: { message: "Member not found" } });

  const { dutyStatus, displayName, notes, phone } = req.body || {};
  const allowed = ["Active","Inactive","On Leave"];
  if (dutyStatus && !allowed.includes(dutyStatus)) {
    return res.status(400).json({ error: { message: `dutyStatus must be one of: ${allowed.join(", ")}` } });
  }

  const sets: string[] = [`updated_at=$1`];
  const vals: any[] = [new Date().toISOString()];
  if (dutyStatus)          { sets.push(`duty_status=$${sets.length+1}`);   vals.push(dutyStatus); }
  if (displayName)         { sets.push(`display_name=$${sets.length+1}`);  vals.push(displayName.trim()); }
  if (notes !== undefined) { sets.push(`notes=$${sets.length+1}`);         vals.push(notes); }
  if (phone !== undefined) { sets.push(`phone=$${sets.length+1}`);         vals.push(phone ? phone.trim() : null); }

  vals.push(existing.id);
  await pgRun(
    `UPDATE technical_team_roster SET ${sets.join(",")} WHERE id=$${vals.length}`,
    vals
  );
  return res.json({ message: "Updated" });
});

// ────────────────────────────────────────────────────────────────
// POST /technical-team/checkin  — technician self check-in
// Body: { currentLocation: string }
// Sets duty_status = Active, records location + timestamp.
// ────────────────────────────────────────────────────────────────
router.post("/checkin", requireAuth, async (req: AuthRequest, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: { message: "Unauthorized" } });

  const { currentLocation } = req.body || {};
  if (!currentLocation?.trim()) {
    return res.status(400).json({ error: { message: "currentLocation is required" } });
  }

  const roster = await pgGet(
    `SELECT id, display_name FROM technical_team_roster WHERE user_account_id = $1`,
    [userId]
  ).catch(() => null);

  if (!roster) {
    return res.status(404).json({ error: { message: "You are not registered in the technical team roster" } });
  }

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE technical_team_roster
     SET duty_status = 'Active', current_location = $1, checked_in_at = $2, updated_at = $3
     WHERE id = $4`,
    [currentLocation.trim(), now, now, roster.id]
  );

  return res.json({
    message: `Checked in from ${currentLocation.trim()}`,
    data: {
      rosterId:        roster.id,
      displayName:     roster.display_name,
      dutyStatus:      "Active",
      currentLocation: currentLocation.trim(),
      checkedInAt:     now,
    }
  });
});

// ────────────────────────────────────────────────────────────────
// DELETE /technical-team/members/:id  — remove from roster
// ────────────────────────────────────────────────────────────────
router.delete("/members/:id", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), async (req: AuthRequest, res) => {
  const existing = await pgGet(`SELECT id, display_name FROM technical_team_roster WHERE id=$1`, [req.params.id]).catch(() => null);
  if (!existing) return res.status(404).json({ error: { message: "Member not found" } });
  await pgRun(`DELETE FROM technical_team_roster WHERE id=$1`, [req.params.id]);
  return res.json({ message: `${existing.display_name} removed from the technical team` });
});

export default router;
