/**
 * Installation Positions
 *
 * Master list of valid mount locations for tracker devices.
 * Used by the job-card wizard (Step 6 – Device Installation) as a dropdown.
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse, ok, created } from "../utils/responses.js";
import { pgGet, pgAll, pgRun } from "../db.js";

const router = Router();

// ── Schema bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS installation_positions (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )
`, []).then(() => {
  // Seed defaults if the table is empty
  return pgAll("SELECT COUNT(*) AS cnt FROM installation_positions", []).then(([r]) => {
    if (Number((r as any).cnt) === 0) {
      const defaults = [
        "Dashboard / Centre Console",
        "Under Steering Column",
        "Boot Area",
        "Engine Bay",
        "Roof Lining",
        "Fuel Tank Area",
        "Under Dashboard Left",
        "Under Dashboard Right",
      ];
      const now = new Date().toISOString();
      defaults.forEach((label, i) => {
        pgRun(
          `INSERT INTO installation_positions (id, label, order_index, active, created_at, updated_at)
           VALUES (?,?,?,1,?,?)`,
          [uuidv4(), label, i, now, now]
        ).catch(console.error);
      });
    }
  });
}).catch(console.error);

// ── GET / — active positions ordered for dropdown ─────────────────────────────
router.get("/", requireAuth, async (_req, res) => {
  const rows = await pgAll(
    `SELECT id, label, order_index FROM installation_positions
     WHERE active = 1 ORDER BY order_index, label`,
    []
  );
  return ok(res, rows);
});

// ── GET /all — all positions incl. inactive (Admin / Technical) ───────────────
router.get("/all", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), async (_req, res) => {
  const rows = await pgAll(
    `SELECT * FROM installation_positions ORDER BY order_index, label`,
    []
  );
  return ok(res, rows);
});

// ── POST / — create a new position ────────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Admin", "Technical"]), async (req: AuthRequest, res) => {
  const { label, orderIndex } = req.body || {};
  if (!label?.trim()) return errorResponse(res, 400, "INVALID_INPUT", "label is required.");

  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO installation_positions (id, label, order_index, active, created_at, updated_at)
     VALUES (?,?,?,1,?,?)`,
    [id, label.trim(), orderIndex ?? 99, now, now]
  );
  const row = await pgGet(`SELECT * FROM installation_positions WHERE id = ?`, [id]);
  return created(res, row, "Position created.");
});

// ── PATCH /:id — update label / order / active ─────────────────────────────────
router.patch("/:id", requireAuth, requireRole(["Admin", "Technical"]), async (req: AuthRequest, res) => {
  const { label, orderIndex, active } = req.body || {};
  const row = await pgGet(`SELECT id FROM installation_positions WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Position not found.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_positions
     SET label       = COALESCE(?, label),
         order_index = COALESCE(?, order_index),
         active      = COALESCE(?, active),
         updated_at  = ?
     WHERE id = ?`,
    [
      label     !== undefined ? label.trim() : null,
      orderIndex !== undefined ? orderIndex : null,
      active    !== undefined ? (active ? 1 : 0) : null,
      now,
      req.params.id,
    ]
  );
  const updated = await pgGet(`SELECT * FROM installation_positions WHERE id = ?`, [req.params.id]);
  return ok(res, updated, "Position updated.");
});

// ── DELETE /:id — soft-delete (set active = 0) ──────────────────────────────
router.delete("/:id", requireAuth, requireRole(["Admin", "Technical"]), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM installation_positions WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Position not found.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_positions SET active = 0, updated_at = ? WHERE id = ?`,
    [now, req.params.id]
  );
  return ok(res, null, "Position deactivated.");
});

export default router;
