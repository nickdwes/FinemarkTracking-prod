import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";
import { hashPassword } from "../utils/password.js";
import { linkIdentitiesOnUserCreate } from "./identityService.js";

export const invalidateUserRefreshTokens = async (userId: string): Promise<void> => {
  await pgRun("DELETE FROM refresh_tokens WHERE user_id = ?", [userId]);
};

export const listUsers = async (filters: {
  search?: string;
  role?: string;
  status?: string;
  page: number;
  pageSize: number;
}) => {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filters.search) {
    clauses.push("(name ILIKE ? OR email ILIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.role) {
    const roles = filters.role.split(",").map(r => r.trim()).filter(Boolean);
    if (roles.length === 1) {
      clauses.push("role = ?");
      params.push(roles[0]);
    } else {
      clauses.push(`role IN (${roles.map(() => "?").join(",")})`);
      params.push(...roles);
    }
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await pgAll(
    `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM users ${where}`, params);

  return { rows, total: Number(totalRow?.total ?? 0) };
};

export const getUserById = async (id: string) => {
  return pgGet("SELECT * FROM users WHERE id = ?", [id]);
};

export const createUser = async (data: {
  name: string;
  email: string;
  role: string;
  tempPassword: string;
  forcePasswordReset?: boolean;
  status: string;
}) => {
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(data.tempPassword);
  const id = crypto.randomUUID();
  await pgRun(
    `INSERT INTO users (id, name, email, role, status, password_hash, force_password_reset, last_login_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.email,
      data.role,
      data.status,
      passwordHash,
      data.forcePasswordReset ? 1 : 0,
      null,
      now,
      now,
    ]
  );
  // Stitch together HR and roster back-links so all identity spaces stay in sync
  await linkIdentitiesOnUserCreate(id, data.name, data.email).catch(() => {});
  return pgGet("SELECT * FROM users WHERE email = ?", [data.email]);
};

export const updateUser = async (id: string, patch: Record<string, any>) => {
  const updates: string[] = [];
  const params: any[] = [];

  if (patch.name) {
    updates.push("name = ?");
    params.push(patch.name);
  }
  if (patch.role) {
    updates.push("role = ?");
    params.push(patch.role);
  }
  if (patch.status) {
    updates.push("status = ?");
    params.push(patch.status);
  }
  if (patch.force_password_reset !== undefined) {
    updates.push("force_password_reset = ?");
    params.push(patch.force_password_reset ? 1 : 0);
  }

  updates.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  await pgRun(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);
  return getUserById(id);
};

export const adminResetPassword = async (id: string, tempPassword: string, forcePasswordReset: boolean) => {
  const passwordHash = await hashPassword(tempPassword);
  await pgRun(
    "UPDATE users SET password_hash = ?, force_password_reset = ?, updated_at = ? WHERE id = ?",
    [passwordHash, forcePasswordReset ? 1 : 0, new Date().toISOString(), id]
  );
  await invalidateUserRefreshTokens(id);
  return getUserById(id);
};
