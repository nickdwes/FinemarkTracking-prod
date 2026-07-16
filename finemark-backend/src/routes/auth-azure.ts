/**
 * Azure AD SSO — Authorization Code + PKCE flow
 *
 * Routes:
 *   GET /api/auth/azure/login    — redirect to Microsoft login
 *   GET /api/auth/azure/callback — handle Microsoft callback, issue Finemark JWT
 *
 * Azure AD app registration requirements:
 *   - Add a Redirect URI:  {AZURE_SSO_REDIRECT_URI}  (type: Web)
 *   - Supported account types: Accounts in this organizational directory only
 *   - No additional API permissions needed beyond OpenID (openid, profile, email)
 *
 * .env keys:
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET  (shared with Graph services)
 *   AZURE_SSO_REDIRECT_URI   e.g. http://localhost:3000/api/auth/azure/callback
 *   FRONTEND_URL             e.g. http://localhost:5500
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { ConfidentialClientApplication, Configuration, CryptoProvider } from "@azure/msal-node";
import { pgGet, pgRun } from "../db.js";
import { signAccessToken, generateRefreshToken, hashRefreshToken } from "../utils/tokens.js";
import { authLimiter, loginLimiter } from "../middleware/rateLimit.js";
import { auditLog } from "../services/auditService.js";
import { resolveIdentity } from "../services/identityService.js";
import { getIdleMinutes } from "../services/sessionTimeoutService.js";
import { setAuthCookie } from "./auth.js";

const router = Router();
const cryptoProvider = new CryptoProvider();

const REDIRECT_URI =
  process.env.AZURE_SSO_REDIRECT_URI || "http://localhost:3000/api/auth/azure/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5500";
const refreshDays = Number(process.env.REFRESH_EXPIRES_DAYS || 7);

function getMsalClient(): ConfidentialClientApplication {
  const config: Configuration = {
    auth: {
      clientId: process.env.GRAPH_CLIENT_ID || "",
      authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || ""}`,
      clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
    },
  };
  return new ConfidentialClientApplication(config);
}

// Short-lived state store for PKCE verifiers (keyed by state UUID)
interface StateEntry {
  pkceVerifier: string;
  createdAt: number;
}
const stateStore = new Map<string, StateEntry>();

// Purge stale states every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10-minute TTL
  for (const [k, v] of stateStore) {
    if (v.createdAt < cutoff) stateStore.delete(k);
  }
}, 5 * 60 * 1000);

// Short-lived one-time SSO exchange codes so tokens are never in the URL
interface SsoEntry {
  accessToken: string;
  refreshToken: string;
  loginMethod: string;
  idleTimeoutMinutes: number;
  user: Record<string, unknown>;
  createdAt: number;
}
const ssoStore = new Map<string, SsoEntry>();

// Purge stale SSO codes every minute
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 1000; // 2-minute TTL
  for (const [k, v] of ssoStore) {
    if (v.createdAt < cutoff) ssoStore.delete(k);
  }
}, 60 * 1000);

// ── GET /api/auth/azure/login ────────────────────────────────────────────────
// Initiate the OAuth2 Authorization Code + PKCE flow.
//
// Returns JSON { url } instead of issuing an HTTP 302 redirect.
// A 302 would place the full Microsoft authorization URL — including Tenant ID
// and Client ID — in the Location response header, making it visible to
// unauthenticated callers (curl -I), proxy logs, and Referer headers.
// The frontend fetches this endpoint and then navigates via window.location.href
// so the Azure credentials only appear in a JS response body.
router.get("/login", authLimiter, async (req, res) => {
  if (!process.env.GRAPH_CLIENT_ID || !process.env.GRAPH_TENANT_ID || !process.env.GRAPH_CLIENT_SECRET) {
    return res.status(503).json({ error: "Azure SSO is not configured on this server." });
  }

  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = uuidv4();
  stateStore.set(state, { pkceVerifier: verifier, createdAt: Date.now() });

  const msalClient = getMsalClient();
  const authUrl = await msalClient.getAuthCodeUrl({
    scopes: ["openid", "profile", "email"],
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    prompt: "select_account",
  });

  // Return the URL as JSON — never redirect, to prevent Azure credentials
  // from leaking into Location headers, proxy logs, or Referer headers.
  return res.json({ url: authUrl });
});

// ── GET /api/auth/azure/callback ─────────────────────────────────────────────
// Exchange code for tokens, look up user in DB, issue Finemark JWT
router.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    const msg = encodeURIComponent(error_description || error || "Azure authentication failed");
    return res.redirect(`${FRONTEND_URL}/login.html?sso=error&message=${msg}`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/login.html?sso=error&message=Missing+authorization+code`);
  }

  const storedState = stateStore.get(state);
  if (!storedState) {
    return res.redirect(`${FRONTEND_URL}/login.html?sso=error&message=Invalid+or+expired+state.+Please+try+again.`);
  }
  stateStore.delete(state);

  // Exchange authorization code for tokens
  let email: string;
  try {
    const msalClient = getMsalClient();
    const tokenResponse = await msalClient.acquireTokenByCode({
      code,
      scopes: ["openid", "profile", "email"],
      redirectUri: REDIRECT_URI,
      codeVerifier: storedState.pkceVerifier,
    });

    // Prefer UPN (corporate email) then preferred_username then email claim
    const claims = tokenResponse?.idTokenClaims as Record<string, unknown> | undefined;
    email =
      (claims?.preferred_username as string) ||
      (claims?.email as string) ||
      (claims?.upn as string) ||
      tokenResponse?.account?.username ||
      "";

    if (!email) throw new Error("Azure AD did not return an email address");
  } catch (err: unknown) {
    const msg = encodeURIComponent(
      err instanceof Error ? err.message : "Azure authentication failed"
    );
    return res.redirect(`${FRONTEND_URL}/login.html?sso=error&message=${msg}`);
  }

  // Look up user in Finemark DB
  const user = await pgGet("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [email]);
  if (!user) {
    auditLog(req, "LOGIN_FAILED", `user:${email}`, "Warning", { email, method: "azure", reason: "no_such_account" }, { email }).catch(console.error);
    const msg = encodeURIComponent(
      `Sign-in failed. Contact your administrator.`
    );
    return res.redirect(`${FRONTEND_URL}/login.html?sso=error&message=${msg}`);
  }
  if (user.status === "Disabled") {
    auditLog(req, "LOGIN_FAILED", `user:${user.id}`, "Warning", { email, method: "azure", reason: "account_disabled" }, { id: user.id, email, role: user.role }).catch(console.error);
    return res.redirect(`${FRONTEND_URL}/login.html?sso=error&message=Your+account+is+disabled.+Contact+your+administrator.`);
  }

  // Issue Finemark tokens
  const sessionId = uuidv4();
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email, sid: sessionId });
  const refreshToken = generateRefreshToken();
  const refreshHash = hashRefreshToken(refreshToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + refreshDays * 86400000).toISOString();

  await pgRun(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, login_method, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, user.id, refreshHash, expiresAt, now.toISOString(), "azure", now.toISOString()]
  );
  await pgRun("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", [
    now.toISOString(), now.toISOString(), user.id,
  ]);

  auditLog(req, "LOGIN_SSO_AZURE", `user:${user.id}`, "Info", { email: user.email }, { id: user.id, email: user.email, role: user.role }).catch(console.error);

  // Resolve full identity for session hydration
  const identity = await resolveIdentity(user.id).catch(() => null);

  // Store tokens in short-lived SSO exchange store (avoid tokens in URL)
  const ssoCode = uuidv4();
  ssoStore.set(ssoCode, {
    accessToken,
    refreshToken,
    loginMethod: "azure",
    idleTimeoutMinutes: await getIdleMinutes("azure"),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      forcePasswordReset: Boolean(user.force_password_reset),
      lastLoginAt: now.toISOString(),
      hrEmployeeId:     identity?.hrEmployeeId     ?? null,
      employeeNo:       identity?.employeeNo       ?? null,
      rosterId:         identity?.rosterId         ?? null,
      rosterMemberType: identity?.rosterMemberType ?? null,
    },
    createdAt: Date.now(),
  });

  return res.redirect(`${FRONTEND_URL}/login.html?sso=pending&code=${ssoCode}`);
});

// ── POST /api/auth/azure/exchange ────────────────────────────────────────────
// Frontend calls this to exchange a one-time SSO code for the actual tokens
router.post("/exchange", loginLimiter, (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: "Missing code" });

  const entry = ssoStore.get(code);
  if (!entry) return res.status(401).json({ error: "Invalid or expired SSO code" });
  if (Date.now() - entry.createdAt > 2 * 60 * 1000) {
    ssoStore.delete(code);
    return res.status(401).json({ error: "SSO code expired" });
  }

  ssoStore.delete(code); // one-time use

  // Set the HttpOnly session cookie used by nginx auth_request to gate HTML
  // pages — without this, Microsoft-authenticated users would hold a valid
  // client-side session but get bounced back to login on every page load.
  setAuthCookie(res, entry.refreshToken);

  return res.status(200).json({
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken,
    loginMethod: entry.loginMethod,
    idleTimeoutMinutes: entry.idleTimeoutMinutes,
    user: entry.user,
  });
});

export default router;
