/**
 * Microsoft Graph User Service
 * Manages Entra ID user provisioning for HR employee onboarding.
 *
 * Required Azure AD App permissions (Application):
 *   User.ReadWrite.All, Directory.ReadWrite.All, GroupMember.ReadWrite.All
 *   Mail.ReadWrite (to enable mailbox)
 *
 * .env keys:
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
 *   M365_DOMAIN            — e.g. finemarktracking.co.ke
 *   M365_LICENSE_SKU_ID    — GUID of the M365 license SKU to assign
 *   M365_DEFAULT_GROUPS    — comma-separated group Object IDs to add all users to
 *   M365_AUTO_PROVISION    — "true" to auto-create on HR approval
 */

import "isomorphic-fetch";
import { ConfidentialClientApplication, Configuration } from "@azure/msal-node";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── MSAL setup (separate singleton from graphMailService) ────────────────────
let _msalApp: ConfidentialClientApplication | null = null;
function getMsalApp(): ConfidentialClientApplication {
  if (_msalApp) return _msalApp;
  const config: Configuration = {
    auth: {
      clientId: process.env.GRAPH_CLIENT_ID || "",
      authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || ""}`,
      clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
    },
  };
  _msalApp = new ConfidentialClientApplication(config);
  return _msalApp;
}

async function getToken(): Promise<string> {
  const result = await getMsalApp().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) throw new Error("Graph: failed to acquire token");
  return result.accessToken;
}

async function graphFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const token = await getToken();
  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((opts.headers as any) || {}),
    },
  });
  if (res.status === 404) return null;
  if (res.status === 204) return null;
  const body = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Graph ${res.status}: ${body}`);
  try { return JSON.parse(body); } catch { return body; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export const M365_DOMAIN =
  process.env.M365_DOMAIN || "finemarktracking.co.ke";

/** Slugify a name part for use in an email address */
function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Generate a temporary password that satisfies Azure AD complexity requirements. */
function generateTempPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%";
  const rand = (s: string) => s[Math.floor(Math.random() * s.length)];
  let pw = rand(upper) + rand(special) + rand(digits);
  for (let i = 0; i < 9; i++) pw += rand(chars);
  return pw.split("").sort(() => Math.random() - 0.5).join("");
}

export function isGraphConfigured(): boolean {
  return (
    !!process.env.GRAPH_TENANT_ID &&
    process.env.GRAPH_TENANT_ID !== "YOUR_AZURE_TENANT_ID" &&
    !!process.env.GRAPH_CLIENT_ID &&
    process.env.GRAPH_CLIENT_ID !== "YOUR_AZURE_APP_CLIENT_ID" &&
    !!process.env.GRAPH_CLIENT_SECRET &&
    process.env.GRAPH_CLIENT_SECRET !== "YOUR_AZURE_APP_CLIENT_SECRET"
  );
}

// ── Email suggestion ─────────────────────────────────────────────────────────
export function buildEmailCandidates(fullName: string): string[] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = slug(parts[0] || "");
  const last = slug(parts.slice(1).join("") || parts[0] || "");
  const fInitial = first.charAt(0);
  const lInitial = last.charAt(0);
  const d = M365_DOMAIN;
  return [
    `${first}.${last}@${d}`,
    `${first}.${last}1@${d}`,
    `${first}.${last}2@${d}`,
    `${fInitial}.${last}@${d}`,
    `${first}${lInitial}@${d}`,
    `${first}${last}@${d}`,
  ].filter((e, i, a) => e && a.indexOf(e) === i);
}

// ── Graph operations ─────────────────────────────────────────────────────────

/** Returns the Entra ID user object if found, null otherwise. */
export async function getEntraUser(upn: string): Promise<any | null> {
  return graphFetch(
    `/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName,mail,accountEnabled,createdDateTime,department,jobTitle,employeeId`
  );
}

/** Returns true if the UPN exists in Entra ID, false if not, null on error. */
async function upnExists(upn: string): Promise<boolean | null> {
  try {
    // Use $filter rather than GET /users/{upn} — returns empty array (not 404)
    // when the user doesn't exist, which is more reliable across tenants.
    const result = await graphFetch(
      `/users?$filter=userPrincipalName eq '${encodeURIComponent(upn)}'&$select=id&$top=1`
    );
    if (!result) return null; // graphFetch returned null (auth/network error)
    return Array.isArray(result.value) ? result.value.length > 0 : null;
  } catch {
    return null; // unknown — don't report as taken
  }
}

/** Check which emails from a candidate list are available (not yet in Entra ID). */
export async function checkEmailAvailability(
  candidates: string[]
): Promise<{ email: string; available: boolean | null }[]> {
  const results = await Promise.allSettled(candidates.map((email) => upnExists(email)));
  return candidates.map((email, i) => {
    const r = results[i];
    if (r.status === "rejected") return { email, available: null };
    const exists = r.value;
    if (exists === null) return { email, available: null };
    return { email, available: !exists };
  });
}

export interface CreateUserOptions {
  upn: string;
  displayName: string;
  givenName: string;
  surname: string;
  department?: string;
  jobTitle?: string;
  officeLocation?: string;
  employeeId?: string;
  mobilePhone?: string;
  managerId?: string;
}

export interface CreateUserResult {
  objectId: string;
  upn: string;
  tempPassword: string;
  graphTransactionId: string;
}

/** Create a user in Entra ID and optionally assign license + groups. */
export async function createEntraUser(opts: CreateUserOptions): Promise<CreateUserResult> {
  const mailNickname = opts.upn.split("@")[0];
  const tempPassword = generateTempPassword();

  const payload: any = {
    accountEnabled: true,
    displayName: opts.displayName,
    givenName: opts.givenName,
    surname: opts.surname,
    userPrincipalName: opts.upn,
    mailNickname,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: tempPassword,
    },
  };
  if (opts.department) payload.department = opts.department;
  if (opts.jobTitle) payload.jobTitle = opts.jobTitle;
  if (opts.officeLocation) payload.officeLocation = opts.officeLocation;
  if (opts.employeeId) payload.employeeId = opts.employeeId;
  if (opts.mobilePhone) payload.mobilePhone = opts.mobilePhone;

  const user = await graphFetch("/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const objectId: string = user.id;

  // Assign manager if provided
  if (opts.managerId) {
    await graphFetch(`/users/${objectId}/manager/$ref`, {
      method: "PUT",
      body: JSON.stringify({ "@odata.id": `${GRAPH_BASE}/directoryObjects/${opts.managerId}` }),
    }).catch((e) => console.warn("[m365] Could not set manager:", e.message));
  }

  // Assign license if SKU configured
  const skuId = process.env.M365_LICENSE_SKU_ID;
  if (skuId) {
    await graphFetch(`/users/${objectId}/assignLicense`, {
      method: "POST",
      body: JSON.stringify({ addLicenses: [{ skuId }], removeLicenses: [] }),
    }).catch((e) => console.warn("[m365] License assign failed:", e.message));
  }

  // Add to default security groups
  const defaultGroups = (process.env.M365_DEFAULT_GROUPS || "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  for (const groupId of defaultGroups) {
    await graphFetch(`/groups/${groupId}/members/$ref`, {
      method: "POST",
      body: JSON.stringify({ "@odata.id": `${GRAPH_BASE}/directoryObjects/${objectId}` }),
    }).catch((e) => console.warn(`[m365] Group ${groupId} add failed:`, e.message));
  }

  return {
    objectId,
    upn: opts.upn,
    tempPassword,
    graphTransactionId: objectId, // Graph doesn't return a tx ID; use object ID as reference
  };
}

/** Update an existing Entra ID user's profile fields. */
export async function syncEntraUser(
  objectId: string,
  updates: Partial<{
    displayName: string;
    department: string;
    jobTitle: string;
    officeLocation: string;
    mobilePhone: string;
    employeeId: string;
  }>
): Promise<void> {
  const body: any = {};
  if (updates.displayName) body.displayName = updates.displayName;
  if (updates.department) body.department = updates.department;
  if (updates.jobTitle) body.jobTitle = updates.jobTitle;
  if (updates.officeLocation) body.officeLocation = updates.officeLocation;
  if (updates.mobilePhone) body.mobilePhone = updates.mobilePhone;
  if (updates.employeeId) body.employeeId = updates.employeeId;
  if (!Object.keys(body).length) return;
  await graphFetch(`/users/${objectId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** Get the assigned license SKU IDs for a user. */
export async function getUserLicenses(objectId: string): Promise<string[]> {
  const result = await graphFetch(`/users/${objectId}/licenseDetails?$select=skuId`);
  return (result?.value ?? []).map((l: any) => l.skuId);
}
