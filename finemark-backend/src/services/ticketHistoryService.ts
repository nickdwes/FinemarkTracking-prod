/**
 * Ticket History Service
 *
 * Records an immutable append-only activity log for every installation ticket.
 * All mutations in installation-tickets.ts call recordHistory() — it is
 * fire-and-forget (errors are logged, never thrown).
 */

import { pgRun, pgAll } from "../db.js";
import { v4 as uuidv4 } from "uuid";
import type { AuthRequest } from "../middleware/auth.js";

// ── Event catalogue ───────────────────────────────────────────────────────────
export const HISTORY_EVENTS = {
  // Lifecycle
  TICKET_CREATED:          "Ticket Created",
  TICKET_ASSIGNED:         "Technician Assigned",
  CO_TECHNICIAN_ASSIGNED:  "Co-Technician Assigned",
  CO_TECHNICIAN_CLEARED:   "Co-Technician Cleared",
  ISO_ASSIGNED:            "ISO Officer Assigned",
  ISO_NOTIFIED:            "Activation Requested",
  STATUS_CHANGED:          "Status Updated",
  STAGE_ADVANCED:          "Stage Advanced",
  VEHICLE_UPDATED:         "Vehicle Details Updated",
  ISO_ASSIST_STARTED:      "ISO Assisted Mode Started",
  ISO_ASSIST_ENDED:        "ISO Assisted Mode Ended",
  TECH_SIGNOFF_ON_BEHALF:  "Technician Sign-off (On Behalf by ISO)",
  // Phase 2 — Acknowledgement & GPS (stub labels, wired in Phase 2)
  TECHNICIAN_ACCEPTED:     "Technician Accepted",
  TECHNICIAN_REJECTED:     "Technician Rejected",
  TRAVEL_STARTED:          "Technician Started Travel",
  ARRIVED_ON_SITE:         "Technician Arrived On Site",
  JOB_STARTED:             "Job Started",
  // Phase 3/4 — Workflow steps
  STEP_COMPLETED:          "Step Completed",
  ACTIVATION_APPROVED:     "Device Activation Approved",
  ACTIVATION_REJECTED:     "Device Activation Rejected",
  CUSTOMER_SIGNED_OFF:     "Customer Signed Off",
  TICKET_CLOSED:           "Ticket Closed",
  // SLA events
  SLA_AT_RISK:             "SLA At Risk",
  SLA_BREACHED:            "SLA Breached",
} as const;

export type HistoryEventType = keyof typeof HISTORY_EVENTS;

export interface HistoryExtras {
  statusBefore?: string | null;
  statusAfter?: string | null;
  stageBefore?: number | null;
  stageAfter?: number | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  gpsAccuracy?: number | null;
  notes?: string | null;
  details?: Record<string, any>;
}

// ── Schema bootstrap (called once at module load from installation-tickets.ts) ─
export function bootstrapHistoryTable(): void {
  pgRun(`
    CREATE TABLE IF NOT EXISTS installation_ticket_history (
      id                    TEXT PRIMARY KEY,
      ticket_id             TEXT NOT NULL,
      event_type            TEXT NOT NULL,
      event_label           TEXT NOT NULL,
      performed_by_user_id  TEXT,
      performed_by_email    TEXT,
      performed_at          TEXT NOT NULL,
      status_before         TEXT,
      status_after          TEXT,
      stage_before          INTEGER,
      stage_after           INTEGER,
      gps_lat               REAL,
      gps_lng               REAL,
      gps_accuracy_m        REAL,
      notes                 TEXT,
      details_json          TEXT
    )
  `, []).catch(console.error);
  pgRun(
    `CREATE INDEX IF NOT EXISTS idx_ticket_history_ticket_id ON installation_ticket_history(ticket_id, performed_at)`,
    []
  ).catch(console.error);
}

// ── Core insert ───────────────────────────────────────────────────────────────
export function recordHistory(
  ticketId: string,
  eventType: HistoryEventType,
  req: AuthRequest,
  extras: HistoryExtras = {}
): void {
  const user = req.user!;
  const now = new Date().toISOString();
  pgRun(
    `INSERT INTO installation_ticket_history
       (id, ticket_id, event_type, event_label, performed_by_user_id,
        performed_by_email, performed_at,
        status_before, status_after, stage_before, stage_after,
        gps_lat, gps_lng, gps_accuracy_m, notes, details_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uuidv4(), ticketId, eventType,
      HISTORY_EVENTS[eventType],
      user.id, user.email || null, now,
      extras.statusBefore ?? null,
      extras.statusAfter  ?? null,
      extras.stageBefore  ?? null,
      extras.stageAfter   ?? null,
      extras.gpsLat       ?? null,
      extras.gpsLng       ?? null,
      extras.gpsAccuracy  ?? null,
      extras.notes        ?? null,
      extras.details ? JSON.stringify(extras.details) : null,
    ]
  ).catch(e => console.error("[ticketHistory] insert failed:", e?.message));
}

// ── Query ─────────────────────────────────────────────────────────────────────
export async function getTicketHistory(ticketId: string): Promise<any[]> {
  const rows = await pgAll(
    `SELECT * FROM installation_ticket_history WHERE ticket_id = ? ORDER BY performed_at ASC`,
    [ticketId]
  );
  return rows.map(r => ({
    id:               r.id,
    ticketId:         r.ticket_id,
    eventType:        r.event_type,
    eventLabel:       r.event_label,
    performedByUserId: r.performed_by_user_id || null,
    performedByEmail: r.performed_by_email || null,
    performedAt:      r.performed_at,
    statusBefore:     r.status_before || null,
    statusAfter:      r.status_after  || null,
    stageBefore:      r.stage_before  != null ? Number(r.stage_before) : null,
    stageAfter:       r.stage_after   != null ? Number(r.stage_after)  : null,
    gpsLat:           r.gps_lat       != null ? Number(r.gps_lat)      : null,
    gpsLng:           r.gps_lng       != null ? Number(r.gps_lng)      : null,
    gpsAccuracyM:     r.gps_accuracy_m != null ? Number(r.gps_accuracy_m) : null,
    notes:            r.notes || null,
    details:          (() => { try { return r.details_json ? JSON.parse(r.details_json) : null; } catch { return null; } })(),
  }));
}
