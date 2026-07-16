import { pgGet } from "../db.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

export type RoleConfigCacheEntry = {
  baseRole: string | null;
  capabilities: string[];
  expires: number;
};

const roleCache = new Map<string, RoleConfigCacheEntry>();

export async function getRoleConfig(roleKey: string): Promise<RoleConfigCacheEntry | null> {
  const cached = roleCache.get(roleKey);
  if (cached && cached.expires > Date.now()) return cached;

  const row = await pgGet(
    "SELECT base_role, capabilities_json FROM role_configs WHERE role_key = $1",
    [roleKey],
  );
  if (!row) return null;

  const entry: RoleConfigCacheEntry = {
    baseRole: row.base_role ?? null,
    capabilities: JSON.parse(row.capabilities_json ?? "[]"),
    expires: Date.now() + CACHE_TTL_MS,
  };
  roleCache.set(roleKey, entry);
  return entry;
}

export function invalidateRoleCache(roleKey?: string): void {
  if (roleKey) roleCache.delete(roleKey);
  else roleCache.clear();
}
