import { pgGet } from "../db.js";

// Caches the identity JOIN (users + hr_employees + technical_team_roster)
// that requireAuth() runs on every single authenticated request. This is
// safe to cache short-term because the actual revocation enforcement point —
// the refresh_tokens session-row lookup in requireAuth() — is NOT cached and
// runs fresh every request; users.ts's PATCH /:id already calls
// invalidateUserRefreshTokens() on any role change or disable, which fails
// that (uncached) session check on the very next request regardless of what
// this cache is still holding. So a stale identity row here can, at worst,
// carry slightly-outdated hrEmployeeId/rosterId/rosterMemberType for up to
// the TTL — never a stale role on an account whose session wasn't already
// killed by the same action that changed it.
const CACHE_TTL_MS = 30 * 1000;

export type IdentityCacheEntry = {
  id: string;
  role: string;
  email: string;
  status: string;
  hrEmployeeId: string | null;
  employeeNo: string | null;
  rosterId: string | null;
  rosterMemberType: string | null;
  expires: number;
};

const identityCache = new Map<string, IdentityCacheEntry>();

export async function getIdentity(userId: string): Promise<IdentityCacheEntry | null> {
  const cached = identityCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached;

  const row = await pgGet(
    `SELECT
       u.id, u.role, u.email, u.status,
       e.id          AS hr_employee_id,
       e.employee_no,
       r.id          AS roster_id,
       r.member_type AS roster_member_type
     FROM users u
     LEFT JOIN hr_employees          e ON e.user_account_id = u.id
     LEFT JOIN technical_team_roster r ON r.user_account_id = u.id
                                       OR (r.hr_employee_id = e.id AND r.user_account_id IS NULL)
     WHERE u.id = ?`,
    [userId],
  );
  if (!row) return null;

  const entry: IdentityCacheEntry = {
    id: row.id,
    role: row.role,
    email: row.email,
    status: row.status,
    hrEmployeeId: row.hr_employee_id || null,
    employeeNo: row.employee_no || null,
    rosterId: row.roster_id || null,
    rosterMemberType: row.roster_member_type || null,
    expires: Date.now() + CACHE_TTL_MS,
  };
  identityCache.set(userId, entry);
  return entry;
}

export function invalidateIdentityCache(userId?: string): void {
  if (userId) identityCache.delete(userId);
  else identityCache.clear();
}
