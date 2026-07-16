import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { ok } from "../utils/responses.js";

const router = Router();

// ── Bootstrap table ─────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS app_notifications (
    id TEXT PRIMARY KEY,
    target_role TEXT,
    target_user_id TEXT,
    type TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[app_notifications] init:", e));

// ── Internal helper ─────────────────────────────────────────────────────────
export async function createNotification(opts: {
  targetRole?: string;
  targetUserId?: string;
  type?: string;
  title: string;
  body?: string;
  link?: string;
}) {
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO app_notifications (id, target_role, target_user_id, type, title, body, link, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?)`,
    [uuidv4(), opts.targetRole || null, opts.targetUserId || null,
     opts.type || "info", opts.title, opts.body || null, opts.link || null, now]
  );
}

// ── GET / ── list notifications for the current user ────────────────────────
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const role = req.user!.role;

  const rows = await pgAll(
    `SELECT * FROM app_notifications
     WHERE (target_user_id = ? OR target_role = ?)
       AND read = FALSE
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId, role]
  );

  return ok(res, {
    notifications: rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      read: r.read,
      createdAt: r.created_at,
    })),
    unread: rows.filter((r: any) => !r.read).length,
  });
});

// ── PATCH /:id/read ─────────────────────────────────────────────────────────
router.patch("/:id/read", requireAuth, async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE app_notifications SET read = TRUE WHERE id = ? AND (target_user_id = ? OR target_role = ?)`,
    [req.params.id, req.user!.id, req.user!.role]
  );
  return ok(res, { message: "Marked as read." });
});

// ── PATCH /read-all ──────────────────────────────────────────────────────────
router.patch("/read-all", requireAuth, async (req: AuthRequest, res) => {
  await pgRun(
    `UPDATE app_notifications SET read = TRUE WHERE (target_user_id = ? OR target_role = ?) AND read = FALSE`,
    [req.user!.id, req.user!.role]
  );
  return ok(res, { message: "All marked as read." });
});

export default router;
