/**
 * identityService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central identity harmonization layer.
 *
 * The system has three independent ID spaces for the same physical person:
 *
 *   ┌─────────────────────┐    user_account_id     ┌──────────────────────┐
 *   │  users              │◄───────────────────────│  hr_employees        │
 *   │  (ERP / login GUID) │                        │  (HR record GUID)    │
 *   └──────────┬──────────┘                        └──────────┬───────────┘
 *              │ user_account_id                              │ hr_employee_id
 *              └────────────────────────────────────────────►│
 *                                                   ┌─────────▼─────────────┐
 *                                                   │ technical_team_roster │
 *                                                   │ (duty-rota GUID)      │
 *                                                   └───────────────────────┘
 *
 * Rules:
 *  • users.id is ALWAYS the canonical ID once an ERP account exists.
 *  • hr_employees.user_account_id → users.id  (set when account is provisioned)
 *  • technical_team_roster.user_account_id → users.id
 *  • technical_team_roster.hr_employee_id  → hr_employees.id
 *
 * This service:
 *  1. Provides `resolveIdentity(anyId)` — resolves any of the three IDs to the
 *     full identity picture.
 *  2. Provides `linkIdentitiesOnUserCreate(userId, name, email)` — called after
 *     every ERP user creation to stitch together the HR record and roster entry.
 *  3. Provides `syncRosterUserAccountIds()` — idempotent reconciliation run that
 *     fills in missing user_account_id links; called once on server startup.
 */

import { pgGet, pgAll, pgRun } from "../db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersonIdentity {
  /** Canonical ERP identifier — users.id. Null if person has no ERP login. */
  userId: string | null;
  displayName: string | null;
  loginEmail: string | null;
  erpRole: string | null;
  accountStatus: string | null;

  /** HR record identifier — hr_employees.id */
  hrEmployeeId: string | null;
  employeeNo: string | null;

  /** Technical team roster identifier — technical_team_roster.id */
  rosterId: string | null;
  rosterMemberType: string | null;
  rosterDutyStatus: string | null;
}

const EMPTY: PersonIdentity = {
  userId: null, displayName: null, loginEmail: null, erpRole: null,
  accountStatus: null, hrEmployeeId: null, employeeNo: null,
  rosterId: null, rosterMemberType: null, rosterDutyStatus: null,
};

const mapRow = (row: any): PersonIdentity => ({
  userId:            row.user_id           || null,
  displayName:       row.display_name      || null,
  loginEmail:        row.login_email       || null,
  erpRole:           row.erp_role          || null,
  accountStatus:     row.account_status    || null,
  hrEmployeeId:      row.hr_employee_id    || null,
  employeeNo:        row.employee_no       || null,
  rosterId:          row.roster_id         || null,
  rosterMemberType:  row.roster_member_type || null,
  rosterDutyStatus:  row.roster_duty_status || null,
});

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * Given ANY person identifier — users.id, hr_employees.id, or
 * technical_team_roster.id — return the complete identity picture.
 *
 * Uses a single three-way JOIN for efficiency.
 */
export async function resolveIdentity(anyId: string): Promise<PersonIdentity | null> {
  if (!anyId) return null;

  const sql = `
    SELECT
      u.id                                    AS user_id,
      COALESCE(u.name, e.full_name, r.display_name) AS display_name,
      COALESCE(u.email, e.work_email, e.email, r.email) AS login_email,
      u.role                                  AS erp_role,
      u.status                                AS account_status,
      e.id                                    AS hr_employee_id,
      e.employee_no,
      r.id                                    AS roster_id,
      r.member_type                           AS roster_member_type,
      r.duty_status                           AS roster_duty_status
    FROM users u
    LEFT JOIN hr_employees          e ON e.user_account_id = u.id
    LEFT JOIN technical_team_roster r ON r.user_account_id = u.id
                                      OR (r.hr_employee_id = e.id AND r.user_account_id IS NULL)
    WHERE u.id = ?
  `;

  // 1. Try as users.id (most common — this is the session ID)
  const byUser = await pgGet(sql, [anyId]);
  if (byUser) return mapRow(byUser);

  // 2. Try as hr_employees.id
  const byHR = await pgGet(`
    SELECT
      u.id                                    AS user_id,
      COALESCE(u.name, e.full_name)           AS display_name,
      COALESCE(u.email, e.work_email, e.email) AS login_email,
      u.role                                  AS erp_role,
      u.status                                AS account_status,
      e.id                                    AS hr_employee_id,
      e.employee_no,
      r.id                                    AS roster_id,
      r.member_type                           AS roster_member_type,
      r.duty_status                           AS roster_duty_status
    FROM hr_employees e
    LEFT JOIN users u                  ON u.id = e.user_account_id
    LEFT JOIN technical_team_roster r  ON r.hr_employee_id = e.id
                                       OR r.user_account_id = u.id
    WHERE e.id = ?
  `, [anyId]);
  if (byHR) return mapRow(byHR);

  // 3. Try as technical_team_roster.id
  const byRoster = await pgGet(`
    SELECT
      u.id                                    AS user_id,
      COALESCE(u.name, e.full_name, r.display_name) AS display_name,
      COALESCE(u.email, e.work_email, e.email, r.email) AS login_email,
      u.role                                  AS erp_role,
      u.status                                AS account_status,
      e.id                                    AS hr_employee_id,
      e.employee_no,
      r.id                                    AS roster_id,
      r.member_type                           AS roster_member_type,
      r.duty_status                           AS roster_duty_status
    FROM technical_team_roster r
    LEFT JOIN users u           ON u.id = r.user_account_id
    LEFT JOIN hr_employees e    ON e.id = r.hr_employee_id
                                OR e.user_account_id = u.id
    WHERE r.id = ?
  `, [anyId]);
  if (byRoster) return mapRow(byRoster);

  return null;
}

// ── Link identities when an ERP user is created ───────────────────────────────

/**
 * After creating a new ERP user account (users row), ensure that:
 *  • hr_employees.user_account_id is set for any matching HR record
 *  • technical_team_roster.user_account_id is set for any matching roster entry
 *
 * Matching is attempted by: exact email → work_email → full_name (case-insensitive).
 * Safe to call multiple times (only updates NULL fields).
 */
export async function linkIdentitiesOnUserCreate(
  userId: string,
  name: string,
  email: string,
): Promise<void> {
  const now = new Date().toISOString();

  // Link hr_employees ─────────────────────────────────────────────────────────
  // Try by email match first (most reliable), then by name
  const hrByEmail = await pgGet(
    `SELECT id FROM hr_employees WHERE (work_email = ? OR email = ?) AND user_account_id IS NULL LIMIT 1`,
    [email, email],
  );
  const hrByName = !hrByEmail
    ? await pgGet(
        `SELECT id FROM hr_employees WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?)) AND user_account_id IS NULL LIMIT 1`,
        [name],
      )
    : null;

  const hrId = hrByEmail?.id || hrByName?.id || null;
  if (hrId) {
    await pgRun(
      `UPDATE hr_employees SET user_account_id = ?, updated_at = ? WHERE id = ?`,
      [userId, now, hrId],
    );
  }

  // Link technical_team_roster ────────────────────────────────────────────────
  // Try: user_account_id match → hr_employee_id match → email match → name match
  // Priority: if we just found the hr_employee record, match via hr_employee_id
  if (hrId) {
    await pgRun(
      `UPDATE technical_team_roster SET user_account_id = ?, updated_at = ?
       WHERE hr_employee_id = ? AND user_account_id IS NULL`,
      [userId, now, hrId],
    );
    return; // roster linked via hr record — done
  }

  // Fallback: match roster by email then name
  const rosterByEmail = await pgGet(
    `SELECT id FROM technical_team_roster WHERE email = ? AND user_account_id IS NULL LIMIT 1`,
    [email],
  );
  const rosterByName = !rosterByEmail
    ? await pgGet(
        `SELECT id FROM technical_team_roster WHERE LOWER(TRIM(display_name)) = LOWER(TRIM(?)) AND user_account_id IS NULL LIMIT 1`,
        [name],
      )
    : null;

  const rosterId = rosterByEmail?.id || rosterByName?.id || null;
  if (rosterId) {
    await pgRun(
      `UPDATE technical_team_roster SET user_account_id = ?, updated_at = ? WHERE id = ?`,
      [userId, now, rosterId],
    );
  }
}

// ── Startup reconciliation ────────────────────────────────────────────────────

/**
 * Idempotent reconciliation pass run once on server startup.
 * Fills in missing user_account_id links in hr_employees and
 * technical_team_roster by cross-referencing existing users.
 *
 * Logic:
 *  1. For each users row, if a hr_employee with matching email/name exists but
 *     has user_account_id = NULL, set it.
 *  2. For each hr_employees row that now has user_account_id, ensure the
 *     technical_team_roster row (matched via hr_employee_id) also has
 *     user_account_id set.
 */
export async function syncRosterUserAccountIds(): Promise<void> {
  const now = new Date().toISOString();

  // Step 1 — link hr_employees → users by email (work_email OR email)
  await pgRun(
    `UPDATE hr_employees e
     SET user_account_id = u.id, updated_at = ?
     FROM users u
     WHERE (LOWER(TRIM(u.email)) = LOWER(TRIM(e.work_email))
         OR LOWER(TRIM(u.email)) = LOWER(TRIM(e.email)))
       AND e.user_account_id IS NULL`,
    [now],
  ).catch(() => {});

  // Step 2 — link hr_employees → users by name (fallback)
  await pgRun(
    `UPDATE hr_employees e
     SET user_account_id = u.id, updated_at = ?
     FROM users u
     WHERE LOWER(TRIM(u.name)) = LOWER(TRIM(e.full_name))
       AND e.user_account_id IS NULL`,
    [now],
  ).catch(() => {});

  // Step 3 — propagate to technical_team_roster via hr_employee_id
  await pgRun(
    `UPDATE technical_team_roster r
     SET user_account_id = e.user_account_id, updated_at = ?
     FROM hr_employees e
     WHERE r.hr_employee_id = e.id
       AND e.user_account_id IS NOT NULL
       AND r.user_account_id IS NULL`,
    [now],
  ).catch(() => {});

  // Step 4 — link roster → users by email (for roster members with no HR record)
  await pgRun(
    `UPDATE technical_team_roster r
     SET user_account_id = u.id, updated_at = ?
     FROM users u
     WHERE LOWER(TRIM(u.email)) = LOWER(TRIM(r.email))
       AND r.user_account_id IS NULL`,
    [now],
  ).catch(() => {});

  // Step 5 — link roster → users by name fallback
  await pgRun(
    `UPDATE technical_team_roster r
     SET user_account_id = u.id, updated_at = ?
     FROM users u
     WHERE LOWER(TRIM(u.name)) = LOWER(TRIM(r.display_name))
       AND r.user_account_id IS NULL`,
    [now],
  ).catch(() => {});
}
