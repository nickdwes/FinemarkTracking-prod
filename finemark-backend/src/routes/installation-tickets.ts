/**
 * Installation Tickets
 *
 * A Sales-raised work order linking an invoice to a vehicle installation job.
 * Flow:
 *   Sales raises ticket (POST /) from invoice detail page
 *   → Admin/Finance assigns a technician (PATCH /:id/assign)
 *   → Technician picks up the job, advances stages (PATCH /:id/status)
 *   → On completion, Customer 360 installation tab is populated
 *
 * Table: installation_tickets
 */

import { Router, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { hashRefreshToken } from "../utils/tokens.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgGet, pgAll, pgRun } from "../db.js";
import { isGraphConfigured, sendEmailViaGraph, MAILBOXES } from "../services/graphMailService.js";
import { sendSms, isAtConfigured } from "../services/smsService.js";
import { sendWhatsApp, isTwilioConfigured } from "../services/whatsappService.js";
import { createNotification } from "./notifications.js";
import {
  materializeRetailQuoteForTicket,
  sendProformaApprovalLinkForTicket,
} from "../services/retailQuoteAutomation.js";
import {
  bootstrapHistoryTable,
  recordHistory,
  getTicketHistory,
} from "../services/ticketHistoryService.js";
import { computeSla, slaStatusLabel } from "../services/slaEngine.js";

// ── Schema bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS installation_tickets (
    id                   TEXT PRIMARY KEY,
    ticket_no            TEXT UNIQUE NOT NULL,
    invoice_id           TEXT,
    proforma_id          TEXT,
    customer_id          TEXT,
    customer_name        TEXT,
    vehicle_id           TEXT,
    vehicle_registration TEXT,
    notes                TEXT,
    devices_json         TEXT NOT NULL DEFAULT '[]',
    assigned_to_user_id  TEXT,
    assigned_to_email    TEXT,
    assigned_at          TEXT,
    status               TEXT NOT NULL DEFAULT 'Pending',
    stage                INTEGER NOT NULL DEFAULT 0,
    vi_installation_id   TEXT,
    created_by_user_id   TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    deleted_at           TEXT
  )
`, []).catch(console.error);

// ── Additive column migrations ────────────────────────────────────────────────
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS checklist_json TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS assigned_device_id TEXT`, []).catch(() => {});
// Extended workflow columns
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS vehicle_details_json TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS pre_install_checklist_json TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS electrical_checklist_json TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS device_install_json TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_json TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS post_install_checklist_json TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS site_photos_json TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS technician_signed_off_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS job_card_photo_url TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS engineer_signed_off_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS engineer_signed_off_by TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS customer_otp TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS customer_otp_verified_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS csat_score INTEGER`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS csat_comment TEXT`, []).catch(() => {});
// ISO officer columns
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS iso_user_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS iso_email TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS iso_name TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS iso_assigned_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS crm_ticket_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_requested_at TEXT`, []).catch(() => {});
// ISO Assisted Installation — ISO completes the job card on behalf of the technician
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS assist_mode TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS assist_started_by_user_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS assist_started_by_name TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS assist_started_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS technician_signed_off_by_user_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS technician_signed_off_by_name TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS technician_signed_off_on_behalf BOOLEAN NOT NULL DEFAULT FALSE`, []).catch(() => {});
// SLA tracking columns
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_ack_hours INTEGER DEFAULT 4`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_start_hours INTEGER DEFAULT 24`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_signoff_hours INTEGER DEFAULT 48`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_iso_hours INTEGER DEFAULT 8`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_acknowledged_by_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_started_by_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_signed_off_by_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sla_iso_closed_by_at TEXT`, []).catch(() => {});
// Global SLA defaults table
pgRun(`CREATE TABLE IF NOT EXISTS sla_defaults (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT,
  updated_by TEXT
)`, []).catch(() => {});
// Seed defaults if not present
const SLA_DEFAULT_SEEDS: Record<string, string> = {
  sla_ack_hours: "4", sla_start_hours: "24", sla_signoff_hours: "48", sla_iso_hours: "8"
};
for (const [k, v] of Object.entries(SLA_DEFAULT_SEEDS)) {
  pgRun(`INSERT INTO sla_defaults (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, [k, v]).catch(() => {});
}
// History table
bootstrapHistoryTable();
// Phase 2 — Technician Acknowledgement & GPS
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS acknowledged_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS acknowledged_gps_lat REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS acknowledged_gps_lng REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS acknowledged_gps_accuracy REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS rejected_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS rejection_reason TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS travel_started_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS travel_started_gps_lat REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS travel_started_gps_lng REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS travel_started_gps_accuracy REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS arrived_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS arrived_gps_lat REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS arrived_gps_lng REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS arrived_gps_accuracy REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS installation_location_lat REAL`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS installation_location_lng REAL`, []).catch(() => {});
// Retail lead linkage columns
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS retail_lead_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS installation_location TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS installation_contact_name TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS installation_contact_phone TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS sales_notes TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS installation_financer TEXT`, []).catch(() => {});
// Phase 3 — Wizard steps & ISO activation approval
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS checkin_json TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_approved_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_approved_by TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_approved_json TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_rejected_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS activation_rejection_reason TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE installation_tickets ADD COLUMN IF NOT EXISTS expected_gadget_count INTEGER`, []).catch(() => {});
// Closed-ticket edit unlocks — an Admin must verify an OTP (emailed to their
// own account) before they can mutate a ticket that has already been closed.
pgRun(`CREATE TABLE IF NOT EXISTS installation_ticket_edit_unlocks (
  id                TEXT PRIMARY KEY,
  ticket_id         TEXT NOT NULL,
  admin_user_id     TEXT NOT NULL,
  otp_hash          TEXT NOT NULL,
  otp_expires_at    TEXT NOT NULL,
  verified_at       TEXT,
  unlock_expires_at TEXT,
  created_at        TEXT NOT NULL
)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_ticket_edit_unlocks_lookup ON installation_ticket_edit_unlocks(ticket_id, admin_user_id)`, []).catch(() => {});

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────────
function mapTicket(row: any) {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    invoiceId: row.invoice_id || null,
    proformaId: row.proforma_id || null,
    customerId: row.customer_id || null,
    customerName: row.customer_name || null,
    vehicleId: row.vehicle_id || null,
    vehicleRegistration: row.vehicle_registration || null,
    notes: row.notes || null,
    devices: (() => { try { return JSON.parse(row.devices_json || "[]"); } catch { return []; } })(),
    assignedToUserId: row.assigned_to_user_id || null,
    assignedToEmail: row.assigned_to_email || null,
    assignedAt: row.assigned_at || null,
    coTechnicianUserId: row.co_technician_user_id || null,
    coTechnicianEmail: row.co_technician_email || null,
    coTechnicianName: row.co_technician_name || null,
    status: row.status,
    stage: Number(row.stage || 0),
    viInstallationId: row.vi_installation_id || null,
    assignedDeviceId: row.assigned_device_id || null,
    checklist: (() => { try { return JSON.parse(row.checklist_json || "[]"); } catch { return []; } })(),
    vehicleDetails: (() => { try { return row.vehicle_details_json ? JSON.parse(row.vehicle_details_json) : null; } catch { return null; } })(),
    preInstallChecklist: (() => { try { return JSON.parse(row.pre_install_checklist_json || "[]"); } catch { return []; } })(),
    electricalChecklist: (() => { try { return JSON.parse(row.electrical_checklist_json || "[]"); } catch { return []; } })(),
    deviceInstall: (() => { try { return row.device_install_json ? JSON.parse(row.device_install_json) : null; } catch { return null; } })(),
    activation: (() => { try { return row.activation_json ? JSON.parse(row.activation_json) : null; } catch { return null; } })(),
    postInstallChecklist: (() => { try { return JSON.parse(row.post_install_checklist_json || "[]"); } catch { return []; } })(),
    sitePhotos: (() => { try { return row.site_photos_json ? JSON.parse(row.site_photos_json) : {}; } catch { return {}; } })(),
    jobCardPhotoUrl: row.job_card_photo_url || null,
    technicianSignedOffAt: row.technician_signed_off_at || null,
    technicianSignedOffByUserId: row.technician_signed_off_by_user_id || null,
    technicianSignedOffByName: row.technician_signed_off_by_name || null,
    technicianSignedOffOnBehalf: !!row.technician_signed_off_on_behalf,
    engineerSignedOffAt: row.engineer_signed_off_at || null,
    engineerSignedOffBy: row.engineer_signed_off_by || null,
    customerOtpVerifiedAt: row.customer_otp_verified_at || null,
    csatScore: row.csat_score ?? null,
    csatComment: row.csat_comment || null,
    isoUserId: row.iso_user_id || null,
    isoEmail: row.iso_email || null,
    isoName: row.iso_resolved_name || row.iso_name || null,
    isoAssignedAt: row.iso_assigned_at || null,
    activationRequestedAt: row.activation_requested_at || null,
    assistMode: row.assist_mode || null,
    assistStartedByUserId: row.assist_started_by_user_id || null,
    assistStartedByName: row.assist_started_by_name || null,
    assistStartedAt: row.assist_started_at || null,
    crmTicketId: row.crm_ticket_id || null,
    retailLeadId: row.retail_lead_id || null,
    installationLocation: row.installation_location || null,
    installationContactName: row.installation_contact_name || null,
    installationContactPhone: row.installation_contact_phone || null,
    salesNotes: row.sales_notes || null,
    installationFinancer: row.installation_financer || null,
    createdByUserId: row.created_by_user_id || null,
    createdByName: row.created_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // SLA fields
    slaAckHours:        row.sla_ack_hours     != null ? Number(row.sla_ack_hours)     : 4,
    slaStartHours:      row.sla_start_hours   != null ? Number(row.sla_start_hours)   : 24,
    slaSignoffHours:    row.sla_signoff_hours != null ? Number(row.sla_signoff_hours) : 48,
    slaIsoHours:        row.sla_iso_hours     != null ? Number(row.sla_iso_hours)     : 8,
    slaAcknowledgedByAt: row.sla_acknowledged_by_at || null,
    slaStartedByAt:      row.sla_started_by_at      || null,
    slaSignedOffByAt:    row.sla_signed_off_by_at   || null,
    slaIsoClosedByAt:    row.sla_iso_closed_by_at   || null,
    // Phase 2 — Acknowledgement & GPS
    acknowledgedAt:           row.acknowledged_at         || null,
    acknowledgedGpsLat:       row.acknowledged_gps_lat    != null ? Number(row.acknowledged_gps_lat)    : null,
    acknowledgedGpsLng:       row.acknowledged_gps_lng    != null ? Number(row.acknowledged_gps_lng)    : null,
    acknowledgedGpsAccuracy:  row.acknowledged_gps_accuracy != null ? Number(row.acknowledged_gps_accuracy) : null,
    rejectedAt:               row.rejected_at             || null,
    rejectionReason:          row.rejection_reason        || null,
    travelStartedAt:          row.travel_started_at       || null,
    travelStartedGpsLat:      row.travel_started_gps_lat  != null ? Number(row.travel_started_gps_lat)  : null,
    travelStartedGpsLng:      row.travel_started_gps_lng  != null ? Number(row.travel_started_gps_lng)  : null,
    travelStartedGpsAccuracy: row.travel_started_gps_accuracy != null ? Number(row.travel_started_gps_accuracy) : null,
    arrivedAt:                row.arrived_at              || null,
    arrivedGpsLat:            row.arrived_gps_lat         != null ? Number(row.arrived_gps_lat)         : null,
    arrivedGpsLng:            row.arrived_gps_lng         != null ? Number(row.arrived_gps_lng)         : null,
    arrivedGpsAccuracy:       row.arrived_gps_accuracy    != null ? Number(row.arrived_gps_accuracy)    : null,
    installationLocationLat:  row.installation_location_lat != null ? Number(row.installation_location_lat) : null,
    installationLocationLng:  row.installation_location_lng != null ? Number(row.installation_location_lng) : null,
    // Phase 3 — Wizard steps & ISO activation approval
    checkinData:              (() => { try { return row.checkin_json ? JSON.parse(row.checkin_json) : null; } catch { return null; } })(),
    activationApprovedAt:     row.activation_approved_at   || null,
    activationApprovedBy:     row.activation_approved_by   || null,
    activationApprovedData:   (() => { try { return row.activation_approved_json ? JSON.parse(row.activation_approved_json) : null; } catch { return null; } })(),
    activationRejectedAt:     row.activation_rejected_at   || null,
    activationRejectionReason: row.activation_rejection_reason || null,
    // Closed jobs are read-only for everyone except an Admin with a verified OTP unlock.
    isLocked: LOCKED_STATUSES.has(row.status),
    expectedGadgetCount: row.expected_gadget_count != null ? Number(row.expected_gadget_count) : null,
    // Only present when the query joined retail_leads (e.g. the list endpoint below);
    // GET /:id overwrites this with its own richer lookup afterward.
    partnerName: row.retail_partner_name || row.retail_secondary_partner_name || null,
  };
}

// ── Closed-ticket lock guard ────────────────────────────────────────────────
// Once a job reaches a terminal status the whole card becomes read-only.
// Only an Admin who has verified an OTP emailed to their own account (see
// POST /:id/request-edit-otp + POST /:id/verify-edit-otp below) may mutate
// it again, and only for the duration of that unlock window.
const LOCKED_STATUSES = new Set(["Completed", "Closed"]);

async function requireTicketUnlocked(req: AuthRequest, res: Response, next: NextFunction) {
  const ticket = await pgGet("SELECT status FROM installation_tickets WHERE id = ?", [req.params.id]);
  if (!ticket || !LOCKED_STATUSES.has(ticket.status)) return next();

  if (req.user!.role !== "Admin") {
    return errorResponse(res, 403, "TICKET_LOCKED",
      "This installation is closed and locked. Only an Admin with verified edit access can make changes.");
  }
  const unlock = await pgGet(
    `SELECT id FROM installation_ticket_edit_unlocks
     WHERE ticket_id = ? AND admin_user_id = ? AND verified_at IS NOT NULL AND unlock_expires_at > ?
     ORDER BY unlock_expires_at DESC LIMIT 1`,
    [req.params.id, req.user!.id, new Date().toISOString()]
  );
  if (!unlock) {
    return errorResponse(res, 403, "TICKET_LOCKED",
      "This installation is closed. Request edit access via the OTP sent to your email before making changes.");
  }
  return next();
}

// ── Customer identity resolver ───────────────────────────────────────────────
/**
 * Resolves a CRM customer identity by ID first, then by name as fallback.
 * Ensures installation_tickets always store the canonical crm_customers.id
 * and display name even when the caller's ID comes from a different context.
 */
async function getSlaDefaults(): Promise<{ ackHours: number; startHours: number; signoffHours: number; isoHours: number }> {
  const rows = await pgAll(`SELECT key, value FROM sla_defaults WHERE key IN ('sla_ack_hours','sla_start_hours','sla_signoff_hours','sla_iso_hours')`, []).catch(() => []);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.key] = Number(r.value) || 0;
  return {
    ackHours:     map["sla_ack_hours"]     || 4,
    startHours:   map["sla_start_hours"]   || 24,
    signoffHours: map["sla_signoff_hours"] || 48,
    isoHours:     map["sla_iso_hours"]     || 8,
  };
}

// ── GET /sla/defaults ── read current global SLA defaults ─────────────────────
router.get("/sla/defaults",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  async (_req, res) => {
    const rows = await pgAll(`SELECT key, value, updated_at, updated_by FROM sla_defaults`, []).catch(() => []);
    const map: Record<string, any> = {};
    for (const r of rows) map[r.key] = { value: Number(r.value), updatedAt: r.updated_at, updatedBy: r.updated_by };
    return res.json({ data: {
      slaAckHours:     map["sla_ack_hours"]     || { value: 4 },
      slaStartHours:   map["sla_start_hours"]   || { value: 24 },
      slaSignoffHours: map["sla_signoff_hours"] || { value: 48 },
      slaIsoHours:     map["sla_iso_hours"]     || { value: 8 },
    }});
  }
);

// ── PUT /sla/defaults ── update global SLA defaults ───────────────────────────
router.put("/sla/defaults",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  async (req: AuthRequest, res) => {
    const { slaAckHours, slaStartHours, slaSignoffHours, slaIsoHours, applyToPending } = req.body || {};
    const fields: Array<[string, number]> = [];
    if (slaAckHours     != null) fields.push(["sla_ack_hours",     Math.max(1, Number(slaAckHours))]);
    if (slaStartHours   != null) fields.push(["sla_start_hours",   Math.max(1, Number(slaStartHours))]);
    if (slaSignoffHours != null) fields.push(["sla_signoff_hours", Math.max(1, Number(slaSignoffHours))]);
    if (slaIsoHours     != null) fields.push(["sla_iso_hours",     Math.max(1, Number(slaIsoHours))]);
    if (!fields.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No SLA fields provided.");

    const now = new Date().toISOString();
    const userId = req.user!.id;
    for (const [key, val] of fields) {
      await pgRun(
        `INSERT INTO sla_defaults (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        [key, String(val), now, userId]
      );
    }

    // Optional: backfill all non-started (Pending/Assigned) tickets
    if (applyToPending) {
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [key, val] of fields) {
        const col = key; // column name matches key
        sets.push(`${col} = ?`);
        vals.push(val);
      }
      sets.push("updated_at = ?"); vals.push(now);
      await pgRun(
        `UPDATE installation_tickets SET ${sets.join(", ")} WHERE status IN ('Pending','Assigned') AND deleted_at IS NULL`,
        vals
      ).catch(console.error);
    }

    auditLog(req, "SLA_DEFAULTS_UPDATED", "system:sla_defaults", "Info",
      { fields: Object.fromEntries(fields), applyToPending: !!applyToPending }).catch(console.error);

    return res.json({ message: "SLA defaults updated.", applied: fields.length, backfilled: !!applyToPending });
  }
);

// ── PATCH /:id/sla ── override SLA targets on a single ticket ─────────────────
router.patch("/:id/sla",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  async (req: AuthRequest, res) => {
    const { slaAckHours, slaStartHours, slaSignoffHours, slaIsoHours } = req.body || {};
    const ticket = await pgGet(`SELECT id, status FROM installation_tickets WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found.");

    const sets: string[] = ["updated_at = ?"];
    const vals: any[] = [new Date().toISOString()];
    if (slaAckHours     != null) { sets.push("sla_ack_hours = ?");     vals.push(Math.max(1, Number(slaAckHours))); }
    if (slaStartHours   != null) { sets.push("sla_start_hours = ?");   vals.push(Math.max(1, Number(slaStartHours))); }
    if (slaSignoffHours != null) { sets.push("sla_signoff_hours = ?"); vals.push(Math.max(1, Number(slaSignoffHours))); }
    if (slaIsoHours     != null) { sets.push("sla_iso_hours = ?");     vals.push(Math.max(1, Number(slaIsoHours))); }
    if (sets.length === 1) return errorResponse(res, 400, "VALIDATION_ERROR", "No SLA fields provided.");

    vals.push(req.params.id);
    await pgRun(`UPDATE installation_tickets SET ${sets.join(", ")} WHERE id = ?`, vals);
    auditLog(req, "SLA_TARGET_OVERRIDE", `installation_ticket:${req.params.id}`, "Info",
      { slaAckHours, slaStartHours, slaSignoffHours, slaIsoHours }).catch(console.error);

    const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
    return res.json({ data: mapTicket(updated) });
  }
);

async function resolveCustomerIdentity(
  customerId: string | null | undefined,
  customerName: string | null | undefined
): Promise<{ id: string | null; displayName: string | null }> {
  const nameQuery = `
    SELECT c.id, COALESCE(ind.full_name, corp.company_name) AS display_name
    FROM crm_customers c
    LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
    LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
    WHERE c.deleted_at IS NULL`;

  if (customerId) {
    const row = await pgGet(`${nameQuery} AND c.id = ?`, [customerId]).catch(() => null);
    if (row) return { id: row.id, displayName: row.display_name };
  }
  if (customerName) {
    const row = await pgGet(
      `${nameQuery} AND LOWER(COALESCE(ind.full_name, corp.company_name)) = LOWER(?) ORDER BY c.created_at ASC`,
      [customerName]
    ).catch(() => null);
    if (row) return { id: row.id, displayName: row.display_name };
  }
  // Return as-is when CRM has no record (e.g. walk-in / data entry in progress)
  return { id: customerId || null, displayName: customerName || null };
}

async function nextTicketNo(): Promise<string> {
  // Scoped to IT-% and ordered by ticket_no itself (not created_at) — retail
  // leads write RTL-<random> tickets into this same table, and picking "most
  // recent row by created_at" would occasionally land on one of those, whose
  // non-numeric suffix silently fails the regex below and resets seq to 1,
  // colliding with an existing IT-00001. Confirmed live via a real 409 while
  // testing the Phase 4 batch endpoint.
  const row = await pgGet(
    `SELECT ticket_no FROM installation_tickets WHERE ticket_no LIKE 'IT-%' ORDER BY ticket_no DESC LIMIT 1`, []
  ).catch(() => null);
  let seq = 1;
  if (row?.ticket_no) {
    const m = String(row.ticket_no).match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `IT-${String(seq).padStart(5, "0")}`;
}

interface CreateTicketParams {
  invoiceId?: string; proformaId?: string; customerId?: string; customerName?: string;
  vehicleId?: string; vehicleRegistration?: string; notes?: string; devices?: any[];
  viInstallationId?: string; crmTicketId?: string;
}

/** Shared row-creation logic behind both POST / (single) and POST /batch. */
async function createInstallationTicket(params: CreateTicketParams, userId: string): Promise<{ id: string; ticketNo: string; canonicalCustomerId: string | null; canonicalCustomerName: string | null }> {
  const { invoiceId, proformaId, customerId, customerName, vehicleId, vehicleRegistration, notes, devices, viInstallationId, crmTicketId } = params;
  const now = new Date().toISOString();
  const id = uuidv4();
  const ticketNo = await nextTicketNo();

  // If only viInstallationId provided, look up customer from vi_installations
  let resolvedCustomerId = customerId;
  let resolvedCustomerName = customerName;
  let resolvedDevices = devices || [];
  if (viInstallationId && !resolvedCustomerId && !resolvedCustomerName) {
    const vi = await pgGet("SELECT customer_id FROM vi_installations WHERE id = ?", [viInstallationId]);
    if (vi?.customer_id) resolvedCustomerId = vi.customer_id;
  }

  // If invoiceId provided, pull customer and device info from invoice
  if (invoiceId && !resolvedCustomerName) {
    const inv = await pgGet("SELECT customer, details_json FROM invoices WHERE id = ?", [invoiceId]);
    if (inv) {
      resolvedCustomerName = inv.customer;
      if (!resolvedDevices.length && inv.details_json) {
        try {
          const details = JSON.parse(inv.details_json);
          resolvedDevices = details.items || details.devices || [];
        } catch { /* ignored */ }
      }
    }
  }

  // Canonicalize customer identity against CRM — resolves the correct
  // crm_customers.id and display name regardless of which ID space the caller used.
  const crmIdentity = await resolveCustomerIdentity(resolvedCustomerId, resolvedCustomerName);
  const canonicalCustomerId   = crmIdentity.id;
  const canonicalCustomerName = crmIdentity.displayName || resolvedCustomerName || null;
  const slaDefaults = await getSlaDefaults();

  // Auto-create the linked vi_installations row up front so this ticket
  // appears in the Technical Pipeline — this endpoint (the general "raise
  // ticket" path used by POST / and POST /batch) previously never created
  // one unless the caller happened to pass viInstallationId explicitly,
  // which normal usage never does, leaving every ticket raised here
  // permanently invisible to Technical/Technician users. Only guarded on a
  // resolved customer since vi_installations.customer_id is NOT NULL.
  let finalViInstallationId = viInstallationId || null;
  if (!finalViInstallationId && canonicalCustomerId) {
    finalViInstallationId = uuidv4();
    await pgRun(
      `INSERT INTO vi_installations
         (id, vehicle_id, customer_id, ticket_ref, status, stage, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [finalViInstallationId, vehicleId || null, canonicalCustomerId, ticketNo, "Pending", 0, userId, now, now]
    );
  }

  await pgRun(
    `INSERT INTO installation_tickets
       (id,ticket_no,invoice_id,proforma_id,customer_id,customer_name,
        vehicle_id,vehicle_registration,notes,devices_json,
        status,stage,vi_installation_id,crm_ticket_id,created_by_user_id,
        sla_ack_hours,sla_start_hours,sla_signoff_hours,sla_iso_hours,
        created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, ticketNo, invoiceId || null, proformaId || null, canonicalCustomerId || null,
     canonicalCustomerName || null, vehicleId || null, vehicleRegistration ? vehicleRegistration.replace(/\s+/g, '').toUpperCase() : null,
     notes || null, JSON.stringify(resolvedDevices), "Pending", 0,
     finalViInstallationId, crmTicketId || null, userId,
     slaDefaults.ackHours, slaDefaults.startHours, slaDefaults.signoffHours, slaDefaults.isoHours,
     now, now]
  );

  return { id, ticketNo, canonicalCustomerId, canonicalCustomerName };
}

// ── POST / ── raise a new installation ticket ─────────────────────────────────
router.post("/", requireAuth, requireRole(["Sales", "Admin", "Finance", "InstallOffice", "Technical", "BDM", "BDMCorporate", "CorporateSales"]), async (req: AuthRequest, res) => {
  const { invoiceId, proformaId, customerId, customerName, vehicleId, vehicleRegistration, notes, devices, viInstallationId, crmTicketId } = req.body || {};
  if (!customerId && !customerName && !viInstallationId) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "customerId, customerName, or viInstallationId is required.");
  }

  const { id, ticketNo, canonicalCustomerId } = await createInstallationTicket(
    { invoiceId, proformaId, customerId, customerName, vehicleId, vehicleRegistration, notes, devices, viInstallationId, crmTicketId },
    req.user!.id
  );

  auditLog(req, "INSTALL_TICKET_CREATED", `installation_ticket:${id}`, "Info",
    { ticketNo, invoiceId, customerId }).catch(console.error);
  recordHistory(id, "TICKET_CREATED", req, { statusAfter: "Pending", stageAfter: 0,
    details: { ticketNo, invoiceId: invoiceId || null, customerId: canonicalCustomerId || null } });

  const ticket = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [id]);
  return res.status(201).json({ data: mapTicket(ticket), message: "Installation ticket raised." });
});

// ── POST /batch ── raise installation tickets for multiple vehicles at once ──
// Corporate Lead Redesign Phase 4 — one click on the post-vehicle-capture toast
// raises one ticket per vehicle, then fires exactly one fan-out notification
// for the whole batch (not one per ticket) to Technical/InstallOffice/Admin +
// the acting rep, mirroring retail-leads.ts's existing notification pattern.
router.post("/batch", requireAuth, requireRole(["Sales", "Admin", "Finance", "InstallOffice", "Technical", "BDM", "BDMCorporate", "CorporateSales"]), async (req: AuthRequest, res) => {
  const { customerId, vehicleIds, notes, crmTicketId } = req.body || {};
  if (!customerId) return errorResponse(res, 400, "VALIDATION_ERROR", "customerId is required.");
  if (!Array.isArray(vehicleIds) || !vehicleIds.length)
    return errorResponse(res, 400, "VALIDATION_ERROR", "vehicleIds must be a non-empty array.");

  const created: { id: string; ticketNo: string; vehicleId: string }[] = [];
  const errors: { vehicleId: string; reason: string }[] = [];
  let canonicalCustomerName: string | null = null;

  for (const vehicleId of vehicleIds) {
    const vehicle = await pgGet("SELECT id, registration FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL", [vehicleId]);
    if (!vehicle) { errors.push({ vehicleId, reason: "Vehicle not found" }); continue; }
    try {
      const result = await createInstallationTicket(
        { customerId, vehicleId, vehicleRegistration: vehicle.registration, notes, crmTicketId },
        req.user!.id
      );
      canonicalCustomerName = result.canonicalCustomerName;
      created.push({ id: result.id, ticketNo: result.ticketNo, vehicleId });
      recordHistory(result.id, "TICKET_CREATED", req, { statusAfter: "Pending", stageAfter: 0,
        details: { ticketNo: result.ticketNo, batch: true, customerId: result.canonicalCustomerId } });
    } catch (err: any) {
      errors.push({ vehicleId, reason: err?.message || "Failed to create ticket" });
    }
  }

  auditLog(req, "INSTALL_TICKET_BATCH_CREATED", "installation_tickets", "Info",
    { customerId, count: created.length, errors: errors.length }).catch(console.error);

  // Exactly one notification for the whole batch — not one per ticket.
  if (created.length) {
    const summary = `${created.length} installation ticket${created.length !== 1 ? "s" : ""} raised for ${canonicalCustomerName || "customer"}.`;
    const link = `crm-customer-360.html?id=${customerId}`;
    await Promise.all([
      createNotification({ targetRole: "Technical",    type: "info", title: "Installation Tickets Raised", body: summary, link }),
      createNotification({ targetRole: "InstallOffice", type: "info", title: "Installation Tickets Raised", body: summary, link }),
      createNotification({ targetRole: "Admin",         type: "info", title: "Installation Tickets Raised", body: summary, link }),
      createNotification({ targetUserId: req.user!.id,  type: "success", title: "Installation Tickets Raised", body: summary, link }),
    ]);
    if (isGraphConfigured()) {
      sendEmailViaGraph({
        fromMailbox: MAILBOXES.notification,
        to: MAILBOXES.notification,
        subject: `Installation Tickets Raised — ${canonicalCustomerName || "Customer"}`,
        htmlBody: `<p>${summary}</p><ul>${created.map(c => `<li>${c.ticketNo}</li>`).join("")}</ul>`,
      }).catch(e => console.error("[installation-tickets batch] email error:", e.message));
    }
  }

  return res.status(created.length ? 201 : 400).json({ data: { created, errors }, message: `${created.length} of ${vehicleIds.length} ticket(s) created.` });
});

// ── GET / ── list tickets ─────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Sales", "Admin", "Finance", "Technical", "InstallOffice", "BDMCorporate", "CorporateSales"]), async (req, res) => {
  const { status, assignedTo, customerId, vehicleRegistration: regFilter, page: pageQ, pageSize: sizeQ } = req.query as Record<string, string>;
  const page = Math.max(parseInt(pageQ || "1", 10), 1);
  const pageSize = Math.min(parseInt(sizeQ || "50", 10), 200);
  const offset = (page - 1) * pageSize;

  const clauses: string[] = ["it.deleted_at IS NULL"];
  const params: any[] = [];
  if (status) { clauses.push("it.status = ?"); params.push(status); }
  if (assignedTo) { clauses.push("it.assigned_to_email = ?"); params.push(assignedTo); }
  if (regFilter) { clauses.push("it.vehicle_registration = ?"); params.push(regFilter.replace(/\s+/g, '').toUpperCase()); }
  if (customerId) {
    // Also match by customer_name in case the stored customer_id was created
    // from a different identity context than the calling filter.
    const crmIdent = await resolveCustomerIdentity(customerId, null);
    const cName = crmIdent.displayName || '';
    clauses.push(`(it.customer_id = ? OR (? <> '' AND it.customer_name = ?))`);
    params.push(customerId, cName, cName);
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT it.*,
            COALESCE(cbe.full_name, cu.name) AS created_by_name,
            COALESCE(ise.full_name, isu.name) AS iso_resolved_name,
            rl.partner_name AS retail_partner_name,
            rl.secondary_partner_name AS retail_secondary_partner_name
     FROM installation_tickets it
     LEFT JOIN users cu  ON cu.id  = it.created_by_user_id
     LEFT JOIN hr_employees cbe ON cbe.user_account_id = it.created_by_user_id
     LEFT JOIN users isu ON isu.id = it.iso_user_id
     LEFT JOIN hr_employees ise ON ise.user_account_id = it.iso_user_id
     LEFT JOIN retail_leads rl ON rl.id = it.retail_lead_id
     ${where} ORDER BY it.created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const total = await pgGet(`SELECT COUNT(*) as total FROM installation_tickets it ${where}`, params);
  return res.status(200).json({ data: rows.map(mapTicket), meta: { total: Number(total?.total ?? 0) } });
});

// ── GET /for-invoice/:invoiceId ───────────────────────────────────────────────
router.get("/for-invoice/:invoiceId", requireAuth, requireRole(["Sales", "Admin", "Finance", "Technical", "InstallOffice", "BDMCorporate", "CorporateSales"]), async (req, res) => {
  const rows = await pgAll(
    `SELECT * FROM installation_tickets WHERE invoice_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    [req.params.invoiceId]
  );
  return res.status(200).json({ data: rows.map(mapTicket) });
});

// ── GET /for-customer/:customerId ─────────────────────────────────────────────
router.get("/for-customer/:customerId", requireAuth, requireRole(["Sales", "Admin", "Finance", "Technical", "InstallOffice", "BDMCorporate", "CorporateSales"]), async (req, res) => {
  const cid = req.params.customerId;
  const identity = await resolveCustomerIdentity(cid, null);
  const cName = identity.displayName || '';
  const rows = await pgAll(
    `SELECT * FROM installation_tickets
     WHERE (customer_id = ? OR (? <> '' AND customer_name = ?))
       AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [cid, cName, cName]
  );
  return res.status(200).json({ data: rows.map(mapTicket) });
});

// ── GET /available-technicians ── roster technicians who have devices in custody ──
router.get("/available-technicians", requireAuth, requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Finance"]), async (_req, res) => {
  // Fetch all active Technicians from roster, joined with device custody count.
  // Counts devices from BOTH di_tracker_devices (new custody system) AND
  // inv_items (Device Ledger issued_to_id — legacy/parallel issuance system).
  const rows = await pgAll(
    `SELECT
       r.id              AS roster_id,
       r.display_name,
       r.email           AS roster_email,
       r.user_account_id,
       r.hr_employee_id,
       r.duty_status,
       u.name            AS user_name,
       u.email           AS user_email,
       e.full_name       AS hr_full_name,
       e.work_email      AS hr_work_email,
       COUNT(DISTINCT d.id) + COUNT(DISTINCT inv.id) AS device_count,
       COUNT(DISTINCT s.id) AS sim_count
     FROM technical_team_roster r
     LEFT JOIN users u ON u.id = r.user_account_id
     LEFT JOIN hr_employees e ON e.id = r.hr_employee_id
     LEFT JOIN di_tracker_devices d ON (
         d.custodian_technician_id = r.user_account_id
      OR d.custodian_technician_id = r.hr_employee_id
      OR d.custodian_technician_id = r.id
      OR d.custodian_technician_email = r.email
     ) AND d.inventory_status = 'InCustody' AND d.deleted_at IS NULL
     LEFT JOIN inv_items inv ON (
         inv.issued_to_id = r.user_account_id
      OR inv.issued_to_id = r.hr_employee_id
      OR inv.issued_to_id = r.id
     ) AND inv.issued_to_id IS NOT NULL AND inv.deleted_at IS NULL
     LEFT JOIN inv_sims s ON (
         s.issued_to_id = r.user_account_id
      OR s.issued_to_id = r.hr_employee_id
      OR s.issued_to_id = r.id
     ) AND s.status = 'issued' AND s.deleted_at IS NULL
     WHERE r.member_type = 'Technician'
       AND r.duty_status IN ('Active', 'On Leave')
     GROUP BY r.id, r.display_name, r.email, r.user_account_id, r.hr_employee_id,
              r.duty_status, u.name, u.email, e.full_name, e.work_email
     HAVING COUNT(DISTINCT d.id) + COUNT(DISTINCT inv.id) > 0
     ORDER BY r.display_name`, []
  ).catch(() => [] as any[]);

  const technicians = rows.map((r: any) => ({
    id:          r.user_account_id || r.hr_employee_id || r.roster_id,
    rosterId:    r.roster_id,
    fullName:    r.hr_full_name || r.user_name || r.display_name || "—",
    email:       r.hr_work_email || r.user_email || r.roster_email || "",
    deviceCount: Number(r.device_count || 0),
    simCount:    Number(r.sim_count || 0),
    dutyStatus:  r.duty_status,
  }));

  return res.status(200).json({ data: technicians });
});

// ── GET /my ── Technician's / ISO's own tickets (all statuses) ───────────────
router.get("/my", requireAuth, requireRole(["Technician", "Technical", "Admin", "Support", "InstallOffice"]), async (req: AuthRequest, res) => {
  const user = req.user!;
  // Match by user_id OR email — as technician, co-technician, OR ISO officer
  const rows = await pgAll(
    `SELECT * FROM installation_tickets
     WHERE deleted_at IS NULL
       AND (
         assigned_to_user_id = ? OR assigned_to_email = ?
         OR co_technician_user_id = ? OR co_technician_email = ?
         OR iso_user_id = ? OR iso_email = ?
       )
     ORDER BY updated_at DESC`,
    [user.id, user.email || "", user.id, user.email || "", user.id, user.email || ""]
  );
  const tickets = rows.map(mapTicket);

  // Summary stats
  const byStatus: Record<string, number> = {};
  let csatTotal = 0, csatCount = 0;
  for (const t of tickets) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if (t.csatScore != null) { csatTotal += t.csatScore; csatCount++; }
  }
  const avgCsat = csatCount > 0 ? Math.round((csatTotal / csatCount) * 10) / 10 : null;

  return res.status(200).json({ data: tickets, meta: { byStatus, avgCsat, csatCount } });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Sales", "Admin", "Finance", "Technical", "Technician", "InstallOffice"]), async (req, res) => {
  let row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  // Also accept a vi_installations ID passed via job-details.html
  if (!row) row = await pgGet("SELECT * FROM installation_tickets WHERE vi_installation_id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");
  const ticket: any = mapTicket(row);

  // Attach linked CRM vehicle record (includes loan tenure).
  // If vehicle_id is not set on the ticket, fall back to the customer's most recent vehicle.
  let vehicleId = row.vehicle_id;
  if (!vehicleId && row.customer_id) {
    const cvFallback = await pgGet(
      `SELECT id FROM crm_customer_vehicles
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [row.customer_id]
    ).catch(() => null);
    if (cvFallback?.id) {
      vehicleId = cvFallback.id;
      // Persist vehicle_id back onto the ticket for future lookups
      pgRun(`UPDATE installation_tickets SET vehicle_id = ?, updated_at = ? WHERE id = ?`,
        [vehicleId, new Date().toISOString(), row.id]).catch(() => {});
    }
  }
  if (vehicleId) {
    const vrow = await pgGet(
      `SELECT id, registration, registration_known, make, model, model_number, body_type, color, year_of_manufacture,
              chassis_number, engine_number, loan_tenure_months, loan_start_date, vehicle_category
       FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL`,
      [vehicleId]
    ).catch(() => null);
    if (vrow) {
      ticket.vehicleId = vrow.id;
      // Only backfill the ticket-level registration from the vehicle record
      // when that vehicle is actually known to be registered — otherwise a
      // vehicle correctly holding no registration (registration_known=false)
      // must not silently surface a stale/empty value as if it were real.
      ticket.vehicleRegistration = ticket.vehicleRegistration || (vrow.registration_known ? vrow.registration : null) || null;
      ticket.vehicleRecord = {
        registration: vrow.registration || null,
        registrationKnown: vrow.registration_known !== false,
        make: vrow.make || null,
        model: vrow.model || null,
        modelNumber: vrow.model_number || null,
        bodyType: vrow.body_type || null,
        color: vrow.color || null,
        yearOfManufacture: vrow.year_of_manufacture || null,
        chassisNumber: vrow.chassis_number || null,
        engineNumber: vrow.engine_number || null,
        loanTenureMonths: vrow.loan_tenure_months ? Number(vrow.loan_tenure_months) : null,
        loanStartDate: vrow.loan_start_date || null,
        vehicleCategory: vrow.vehicle_category || "motor_vehicle",
      };
    }
  }

  // Attach installed device details from inv_items (IMEI, serial, SIM)
  if (row.assigned_device_id) {
    const drow = await pgGet(
      `SELECT i.serial_number, i.imei, i.sim_phone, i.sim_serial,
              p.product_name, p.device_model
       FROM inv_items i
       LEFT JOIN inv_product_catalog p ON p.id = i.product_id
       WHERE i.id = ?`,
      [row.assigned_device_id]
    ).catch(() => null);
    if (drow) {
      ticket.assignedDevice = {
        serialNumber: drow.serial_number || null,
        imei:         drow.imei          || null,
        simPhone:     drow.sim_phone     || null,
        simSerial:    drow.sim_serial    || null,
        productName:  drow.product_name  || null,
        deviceModel:  drow.device_model  || null,
      };
    }
  }

  // Attach partner / financer / customer-segment info — sourced from the linked
  // retail lead when this ticket came from the retail pipeline, falling back to
  // the CRM customer record's type (individual/corporate) otherwise.
  let partnerName: string | null = null;
  let customerSegment: string | null = null;
  if (row.retail_lead_id) {
    const rl = await pgGet(
      "SELECT partner_name, secondary_partner_name, customer_entity_type, installation_financer FROM retail_leads WHERE id = ?",
      [row.retail_lead_id]
    ).catch(() => null);
    if (rl) {
      partnerName = rl.partner_name || rl.secondary_partner_name || null;
      customerSegment = rl.customer_entity_type
        ? (rl.customer_entity_type === "corporate" ? "Corporate" : "Individual")
        : null;
      if (!ticket.installationFinancer) ticket.installationFinancer = rl.installation_financer || null;
    }
  }
  if (!customerSegment && row.customer_id) {
    const cc = await pgGet("SELECT type FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [row.customer_id]).catch(() => null);
    if (cc?.type) customerSegment = cc.type === "corporate" ? "Corporate" : "Individual";
  }
  ticket.partnerName = partnerName;
  ticket.customerSegment = customerSegment;

  return res.status(200).json({ data: ticket });
});

// ── POST /:id/iso-assign ── ISO officer claims or is assigned to a ticket ─────
router.post("/:id/iso-assign", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const caller = req.user!;
  // Technical / InstallOffice role can only assign themselves; Admin can assign anyone
  const isoUserId = (caller.role === "Admin" && req.body?.isoUserId)
    ? req.body.isoUserId
    : caller.id;
  const isoEmail  = (caller.role === "Admin" && req.body?.isoEmail)
    ? req.body.isoEmail
    : caller.email;
  const isoName   = (caller.role === "Admin" && req.body?.isoName)
    ? req.body.isoName
    : await (async () => {
        if (caller.hrEmployeeId) {
          const hr = await pgGet("SELECT full_name FROM hr_employees WHERE id = ?", [caller.hrEmployeeId]).catch(() => null);
          if (hr?.full_name) return hr.full_name;
        }
        const u = await pgGet("SELECT name FROM users WHERE id = ?", [caller.id]).catch(() => null);
        return u?.name || caller.email;
      })();

  // Confirm the user is an ISO in the roster
  // req.user.rosterId and rosterMemberType are now populated by auth middleware
  if (caller.role === "Technical" || caller.role === "InstallOffice") {
    const isIso = caller.rosterMemberType === "ISO" && caller.rosterId;
    if (!isIso) {
      // Belt-and-suspenders fallback in case roster not yet synced
      const inRoster = await pgGet(
        `SELECT id FROM technical_team_roster
         WHERE member_type = 'ISO'
           AND duty_status IN ('Active','On Leave')
           AND (user_account_id = ? OR email = ?)`,
        [caller.id, caller.email || ""]
      ).catch(() => null);
      if (!inRoster) return errorResponse(res, 403, "FORBIDDEN", "You are not enrolled as an ISO officer.");
    }
  }

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets SET iso_user_id=?, iso_email=?, iso_name=?, iso_assigned_at=?, updated_at=? WHERE id=?`,
    [isoUserId, isoEmail || null, isoName || null, now, now, req.params.id]
  );

  auditLog(req, "INSTALL_TICKET_ISO_ASSIGNED", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no, isoEmail }).catch(console.error);
  recordHistory(req.params.id, "ISO_ASSIGNED", req,
    { statusBefore: row.status, statusAfter: row.status, details: { isoEmail, isoUserId } });

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "ISO officer assigned." });
});

// ── POST /:id/assist-mode ── ISO Assisted Installation: the ticket's own ISO
// takes over data entry on behalf of the assigned technician, who still performs
// the physical install. Unlike most gates in this file, this one is scoped to
// THIS ticket's own ISO (not any Technical/InstallOffice-role holder) — it's the
// switch that lets the ISO sign the technician sign-off on their behalf later.
router.post("/:id/assist-mode", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { enabled } = req.body || {};
  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  if (!row.assigned_to_user_id || !row.iso_user_id) {
    return errorResponse(res, 422, "ASSIGNMENT_INCOMPLETE",
      "Both a technician and an ISO officer must be assigned before ISO Assisted mode can be used.");
  }

  const caller = req.user!;
  const isTicketIso = row.iso_user_id === caller.id || (row.iso_email && row.iso_email === caller.email);
  if (caller.role !== "Admin" && !isTicketIso) {
    return errorResponse(res, 403, "FORBIDDEN", "Only this ticket's assigned ISO officer can manage assisted mode.");
  }

  const now = new Date().toISOString();
  if (enabled) {
    const u = await pgGet("SELECT name FROM users WHERE id = ?", [caller.id]).catch(() => null);
    await pgRun(
      `UPDATE installation_tickets SET assist_mode='iso_assisted',
         assist_started_by_user_id=?, assist_started_by_name=?, assist_started_at=?, updated_at=?
       WHERE id=?`,
      [caller.id, u?.name || caller.email || null, now, now, req.params.id]
    );
    auditLog(req, "INSTALL_TICKET_ASSIST_MODE_STARTED", `installation_ticket:${req.params.id}`, "Info",
      { ticketNo: row.ticket_no }).catch(console.error);
    recordHistory(req.params.id, "ISO_ASSIST_STARTED", req,
      { statusBefore: row.status, statusAfter: row.status });
  } else {
    await pgRun(
      `UPDATE installation_tickets SET assist_mode=NULL, updated_at=? WHERE id=?`,
      [now, req.params.id]
    );
    auditLog(req, "INSTALL_TICKET_ASSIST_MODE_ENDED", `installation_ticket:${req.params.id}`, "Info",
      { ticketNo: row.ticket_no }).catch(console.error);
    recordHistory(req.params.id, "ISO_ASSIST_ENDED", req,
      { statusBefore: row.status, statusAfter: row.status });
  }

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: enabled ? "ISO Assisted mode started." : "ISO Assisted mode ended." });
});

// ── PATCH /:id/assign ── Assign technician (Admin, Finance, or ticket's ISO) ──
router.patch("/:id/assign", requireAuth, requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Finance"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { technicianEmail, technicianUserId } = req.body || {};
  if (!technicianEmail) return errorResponse(res, 400, "VALIDATION_ERROR", "technicianEmail is required.");

  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const caller = req.user!;
  // Technical role must be the ISO who claimed this ticket
  if (caller.role === "Technical") {
    const isIso = row.iso_user_id === caller.id || row.iso_email === caller.email;
    if (!isIso) return errorResponse(res, 403, "FORBIDDEN", "Only the assigned ISO officer can assign a technician to this ticket.");
  }

  // Validate the technician has devices in custody (di_tracker_devices or inv_items)
  const hasCustodyDI = await pgGet(
    `SELECT id FROM di_tracker_devices
     WHERE inventory_status = 'InCustody' AND deleted_at IS NULL
       AND (custodian_technician_id = ? OR custodian_technician_email = ?)
     LIMIT 1`,
    [technicianUserId || "", technicianEmail]
  ).catch(() => null);

  const hasCustodyInv = hasCustodyDI ? null : await pgGet(
    `SELECT id FROM inv_items
     WHERE issued_to_id IS NOT NULL AND deleted_at IS NULL
       AND (issued_to_id = ?
         OR issued_to_id IN (
           SELECT COALESCE(r.hr_employee_id, r.id)
           FROM technical_team_roster r
           WHERE r.user_account_id = ?
              OR r.email = ?
         ))
     LIMIT 1`,
    [technicianUserId || "", technicianUserId || "", technicianEmail]
  ).catch(() => null);

  if (!hasCustodyDI && !hasCustodyInv) {
    return errorResponse(res, 422, "NO_DEVICES", "The selected technician has no devices in custody and cannot be assigned.");
  }

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets SET assigned_to_email=?, assigned_to_user_id=?, assigned_at=?, status='Assigned', updated_at=? WHERE id=?`,
    [technicianEmail, technicianUserId || null, now, now, req.params.id]
  );

  // Notify technician by email (best-effort)
  if (isGraphConfigured()) {
    sendEmailViaGraph({
      fromMailbox: MAILBOXES.notification,
      to: technicianEmail,
      subject: `Installation Job Assigned — Ticket ${row.ticket_no}`,
      htmlBody: `<p>Hi,</p><p>You have been assigned installation ticket <strong>${row.ticket_no}</strong>.</p>
        <p>Customer: <strong>${row.customer_name || "—"}</strong>${row.vehicle_registration ? ` | Vehicle: <strong>${row.vehicle_registration}</strong>` : ""}</p>
        ${row.notes ? `<p>Notes: ${row.notes}</p>` : ""}
        <p>Please log in to the Finemark portal to view full job details.</p>
        <p>Regards,<br/>Finemark Tracking</p>`,
    }).catch((e: any) => console.error("[install-ticket/assign] email failed:", e?.message));
  }

  auditLog(req, "INSTALL_TICKET_ASSIGNED", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no, technicianEmail }).catch(console.error);
  recordHistory(req.params.id, "TICKET_ASSIGNED", req, {
    statusBefore: row.status, statusAfter: "Assigned",
    details: { technicianEmail, technicianUserId: technicianUserId || null },
  });

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "Technician assigned." });
});

// ── PATCH /:id/assign-co-technician ── Assign / clear a co-technician ────────
router.patch("/:id/assign-co-technician", requireAuth, requireRole(["Technical", "Admin", "Support", "InstallOffice"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { coTechnicianUserId, coTechnicianEmail, coTechnicianName } = req.body || {};
  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets
     SET co_technician_user_id=?, co_technician_email=?, co_technician_name=?, updated_at=?
     WHERE id=?`,
    [coTechnicianUserId || null, coTechnicianEmail || null, coTechnicianName || null, now, req.params.id]
  );

  if (coTechnicianEmail && isGraphConfigured()) {
    sendEmailViaGraph({
      fromMailbox: MAILBOXES.notification,
      to: coTechnicianEmail,
      subject: `You've been added to Installation Job — ${row.ticket_no}`,
      htmlBody: `<p>Hi${coTechnicianName ? " " + coTechnicianName : ""},</p>
        <p>You have been added as a co-technician on ticket <strong>${row.ticket_no}</strong>.</p>
        <p>Customer: <strong>${row.customer_name || "—"}</strong>${row.vehicle_registration ? ` | Vehicle: <strong>${row.vehicle_registration}</strong>` : ""}</p>
        <p>Please log in to the Finemark portal to view the job.</p>
        <p>Regards,<br/>Finemark Tracking</p>`,
    }).catch((e: any) => console.error("[install-ticket/co-assign] email failed:", e?.message));
  }

  auditLog(req, "INSTALL_TICKET_CO_ASSIGNED", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no, coTechnicianEmail: coTechnicianEmail || null }).catch(console.error);
  recordHistory(req.params.id,
    coTechnicianEmail ? "CO_TECHNICIAN_ASSIGNED" : "CO_TECHNICIAN_CLEARED",
    req,
    { statusBefore: row.status, statusAfter: row.status,
      details: { coTechnicianEmail: coTechnicianEmail || null, coTechnicianName: coTechnicianName || null } }
  );

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: coTechnicianEmail ? "Co-technician assigned." : "Co-technician cleared." });
});

// ── POST /:id/notify-iso ── Technician notifies ISO that activation is needed ─
router.post("/:id/notify-iso", requireAuth, requireRole(["Technical", "Admin", "Technician", "Support", "InstallOffice"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const now = new Date().toISOString();
  await pgRun("UPDATE installation_tickets SET activation_requested_at = ?, updated_at = ? WHERE id = ?", [now, now, req.params.id]);

  const body = `Ticket ${row.ticket_no}${row.customer_name ? ` — ${row.customer_name}` : ''}${row.vehicle_registration ? ` (${row.vehicle_registration})` : ''} is ready for device activation. Please proceed to the job card.`;
  const link = `/job-card.html?id=${row.id}`;

  // Notify the specific ISO if assigned, otherwise broadcast to InstallOffice role
  if (row.iso_user_id) {
    createNotification({
      targetUserId: row.iso_user_id,
      type: "action",
      title: "Activation Required — " + row.ticket_no,
      body, link,
    }).catch(console.error);
  } else {
    createNotification({
      targetRole: "InstallOffice",
      type: "action",
      title: "Activation Required — " + row.ticket_no,
      body, link,
    }).catch(console.error);
  }
  // Also notify Technical lead and Support roles
  createNotification({
    targetRole: "Technical",
    type: "action",
    title: "Activation Required — " + row.ticket_no,
    body, link,
  }).catch(console.error);

  auditLog(req, "INSTALL_TICKET_ISO_NOTIFIED", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no }).catch(console.error);
  recordHistory(req.params.id, "ISO_NOTIFIED", req,
    { statusBefore: row.status, statusAfter: row.status });

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "ISO notified." });
});

// ── POST /:id/acknowledge ── Technician accept/reject ─────────────────────────
router.post("/:id/acknowledge", requireAuth, requireRole(["Technician", "Technical", "Admin"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { accept, rejectionReason, gpsLat, gpsLng, gpsAccuracy } = req.body || {};
  if (typeof accept !== "boolean") return errorResponse(res, 400, "INVALID_INPUT", "'accept' (boolean) is required.");

  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");
  if (row.acknowledged_at) return errorResponse(res, 409, "ALREADY_ACKNOWLEDGED", "Ticket already acknowledged.");

  // Only the assigned technician may acknowledge
  const user = req.user!;
  const isTechAssigned = row.assigned_to_user_id === user.id || row.assigned_to_email === user.email;
  const isAdmin = ["Admin", "Technical"].includes(user.role);
  if (!isTechAssigned && !isAdmin) return errorResponse(res, 403, "FORBIDDEN", "Only the assigned technician can acknowledge this ticket.");

  const now = new Date().toISOString();

  if (accept) {
    await pgRun(
      `UPDATE installation_tickets SET
         acknowledged_at = ?,
         acknowledged_gps_lat = ?, acknowledged_gps_lng = ?, acknowledged_gps_accuracy = ?,
         sla_acknowledged_by_at = ?,
         status = CASE WHEN status = 'Pending' THEN 'Assigned' ELSE status END,
         updated_at = ?
       WHERE id = ?`,
      [now, gpsLat ?? null, gpsLng ?? null, gpsAccuracy ?? null, now, now, req.params.id]
    );
    recordHistory(req.params.id, "TECHNICIAN_ACCEPTED", req, {
      statusBefore: row.status, statusAfter: row.status === "Pending" ? "Assigned" : row.status,
      gpsLat: gpsLat ?? null, gpsLng: gpsLng ?? null, gpsAccuracy: gpsAccuracy ?? null,
    });
    auditLog(req, "INSTALL_TICKET_ACKNOWLEDGED", `installation_ticket:${req.params.id}`, "Info",
      { ticketNo: row.ticket_no }).catch(console.error);
  } else {
    if (!rejectionReason?.trim()) return errorResponse(res, 400, "INVALID_INPUT", "'rejectionReason' is required when rejecting.");
    await pgRun(
      `UPDATE installation_tickets SET
         rejected_at = ?, rejection_reason = ?,
         assigned_to_user_id = NULL, assigned_to_email = NULL, assigned_at = NULL,
         status = 'Pending', updated_at = ?
       WHERE id = ?`,
      [now, rejectionReason.trim(), now, req.params.id]
    );
    recordHistory(req.params.id, "TECHNICIAN_REJECTED", req, {
      statusBefore: row.status, statusAfter: "Pending",
      notes: rejectionReason.trim(),
    });
    auditLog(req, "INSTALL_TICKET_REJECTED", `installation_ticket:${req.params.id}`, "Warning",
      { ticketNo: row.ticket_no, reason: rejectionReason.trim() }).catch(console.error);
    // Notify Technical Manager that technician rejected
    createNotification({
      targetRole: "Technical",
      type: "alert",
      title: `Ticket Rejected — ${row.ticket_no}`,
      body: `${user.email} rejected ticket ${row.ticket_no}: ${rejectionReason.trim()}`,
      link: `/job-details.html?ticketId=${req.params.id}`,
    }).catch(console.error);
  }

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: accept ? "Ticket accepted." : "Ticket rejected — returned to pool." });
});

// ── POST /:id/travel-start ── Technician starting travel to site ──────────────
router.post("/:id/travel-start", requireAuth, requireRole(["Technician", "Technical", "Admin"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { gpsLat, gpsLng, gpsAccuracy } = req.body || {};

  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");
  if (!row.acknowledged_at) return errorResponse(res, 409, "NOT_ACKNOWLEDGED", "Ticket must be acknowledged before travel can start.");
  if (row.travel_started_at) return errorResponse(res, 409, "ALREADY_STARTED", "Travel already recorded for this ticket.");

  const user = req.user!;
  const isTechAssigned = row.assigned_to_user_id === user.id || row.assigned_to_email === user.email;
  if (!isTechAssigned && !["Admin", "Technical"].includes(user.role)) {
    return errorResponse(res, 403, "FORBIDDEN", "Only the assigned technician can record travel.");
  }

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets SET
       travel_started_at = ?,
       travel_started_gps_lat = ?, travel_started_gps_lng = ?, travel_started_gps_accuracy = ?,
       updated_at = ?
     WHERE id = ?`,
    [now, gpsLat ?? null, gpsLng ?? null, gpsAccuracy ?? null, now, req.params.id]
  );
  recordHistory(req.params.id, "TRAVEL_STARTED", req, {
    statusBefore: row.status, statusAfter: row.status,
    gpsLat: gpsLat ?? null, gpsLng: gpsLng ?? null, gpsAccuracy: gpsAccuracy ?? null,
  });
  auditLog(req, "INSTALL_TICKET_TRAVEL_START", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no }).catch(console.error);

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "Travel started." });
});

// ── POST /:id/arrived ── Technician marked arrived on site ────────────────────
router.post("/:id/arrived", requireAuth, requireRole(["Technician", "Technical", "Admin"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { gpsLat, gpsLng, gpsAccuracy } = req.body || {};

  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");
  if (!row.travel_started_at) return errorResponse(res, 409, "TRAVEL_NOT_STARTED", "Travel has not been started yet.");
  if (row.arrived_at) return errorResponse(res, 409, "ALREADY_ARRIVED", "Arrival already recorded for this ticket.");

  const user = req.user!;
  const isTechAssigned = row.assigned_to_user_id === user.id || row.assigned_to_email === user.email;
  if (!isTechAssigned && !["Admin", "Technical"].includes(user.role)) {
    return errorResponse(res, 403, "FORBIDDEN", "Only the assigned technician can record arrival.");
  }

  const now = new Date().toISOString();

  // Compute distance to job site if coordinates are available
  let distanceKm: number | null = null;
  if (gpsLat != null && gpsLng != null && row.installation_location_lat != null && row.installation_location_lng != null) {
    const R = 6371;
    const dLat = ((Number(row.installation_location_lat) - gpsLat) * Math.PI) / 180;
    const dLng = ((Number(row.installation_location_lng) - gpsLng) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos((gpsLat * Math.PI) / 180) * Math.cos((Number(row.installation_location_lat) * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
    distanceKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
  }

  await pgRun(
    `UPDATE installation_tickets SET
       arrived_at = ?,
       arrived_gps_lat = ?, arrived_gps_lng = ?, arrived_gps_accuracy = ?,
       updated_at = ?
     WHERE id = ?`,
    [now, gpsLat ?? null, gpsLng ?? null, gpsAccuracy ?? null, now, req.params.id]
  );
  recordHistory(req.params.id, "ARRIVED_ON_SITE", req, {
    statusBefore: row.status, statusAfter: row.status,
    gpsLat: gpsLat ?? null, gpsLng: gpsLng ?? null, gpsAccuracy: gpsAccuracy ?? null,
    details: distanceKm != null ? { distanceFromSiteKm: distanceKm } : undefined,
  });
  auditLog(req, "INSTALL_TICKET_ARRIVED", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no, distanceKm }).catch(console.error);

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "Arrival recorded.", distanceFromSiteKm: distanceKm });
});

// ── PATCH /:id/location-coords ── Technical/Admin sets job-site coordinates ───
router.patch("/:id/location-coords", requireAuth, requireRole(ROLE_GROUPS.TICKET_MANAGEMENT), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return errorResponse(res, 400, "INVALID_INPUT", "'lat' and 'lng' are required.");
  const latN = Number(lat);
  const lngN = Number(lng);
  if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return errorResponse(res, 400, "INVALID_INPUT", "Invalid coordinates.");
  }

  const row = await pgGet("SELECT id, ticket_no, status FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets SET installation_location_lat = ?, installation_location_lng = ?, updated_at = ? WHERE id = ?`,
    [latN, lngN, now, req.params.id]
  );
  recordHistory(req.params.id, "VEHICLE_UPDATED", req, {
    statusBefore: row.status, statusAfter: row.status,
    gpsLat: latN, gpsLng: lngN,
    details: { note: "Job site coordinates set" },
  });

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "Job site coordinates saved." });
});

// ── PATCH /:id/status ── Technician / Engineer updates stage/status ─────────
router.patch("/:id/status", requireAuth, requireRole(["Technical", "Admin", "Technician", "Support", "InstallOffice"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const {
    status, stage, notes, checklist, assignedDeviceId,
    vehicleDetails, preInstallChecklist, electricalChecklist,
    deviceInstall, activation, postInstallChecklist,
    technicianSignedOff, engineerSignedOff, sitePhotos,
    expectedGadgetCount, jobCardPhotoUrl,
  } = req.body || {};

  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  // ── Access gate: only the assigned technician, co-technician, ISO officer, or a
  // supervisory role may mutate this ticket — mirrors the party-gate already
  // enforced on PATCH /:id/step/:stepKey. Without this, any user holding one of
  // this route's allowed roles could edit ANY other technician's job card.
  {
    const caller = req.user!;
    const isSupervisor = ["Admin", "Technical", "InstallOffice"].includes(caller.role);
    const isAssignedParty =
      row.assigned_to_user_id === caller.id || (row.assigned_to_email && row.assigned_to_email === caller.email) ||
      row.co_technician_user_id === caller.id || (row.co_technician_email && row.co_technician_email === caller.email) ||
      row.iso_user_id === caller.id || (row.iso_email && row.iso_email === caller.email);
    if (!isSupervisor && !isAssignedParty) {
      return errorResponse(res, 403, "FORBIDDEN", "Only the assigned technician, co-technician, or ISO officer may edit this job.");
    }
  }

  // ── Technician sign-off: narrower than the gate above. The blanket supervisor
  // bypass (Admin/Technical/InstallOffice) is deliberately NOT enough here — this
  // field records the TECHNICIAN's own attestation of physical completion, so it
  // may only be set by the assigned technician/co-technician, OR by this ticket's
  // own ISO while ISO Assisted mode is active (an explicit, attributed act — see
  // POST /:id/assist-mode), OR by Admin.
  if (technicianSignedOff) {
    const caller = req.user!;
    const isAssignedTech =
      row.assigned_to_user_id === caller.id || (row.assigned_to_email && row.assigned_to_email === caller.email) ||
      row.co_technician_user_id === caller.id || (row.co_technician_email && row.co_technician_email === caller.email);
    const isTicketIso = row.iso_user_id === caller.id || (row.iso_email && row.iso_email === caller.email);
    const isAssistedByThisIso = row.assist_mode === "iso_assisted" && isTicketIso;
    if (!isAssignedTech && !isAssistedByThisIso && caller.role !== "Admin") {
      return errorResponse(res, 403, "TECH_SIGNOFF_NOT_ALLOWED",
        "Only the assigned technician may sign off. To sign on their behalf, the ticket's ISO must first enable ISO Assisted mode.");
    }
  }

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const vals: any[] = [now];
  if (status)                    { sets.push("status = ?");                       vals.push(status); }
  if (stage !== undefined)       { sets.push("stage = ?");                         vals.push(Number(stage)); }
  if (notes !== undefined)       { sets.push("notes = ?");                         vals.push(notes); }
  if (checklist !== undefined)   { sets.push("checklist_json = ?");                vals.push(JSON.stringify(checklist)); }
  if (assignedDeviceId !== undefined) { sets.push("assigned_device_id = ?");      vals.push(assignedDeviceId); }
  if (vehicleDetails !== undefined)   { sets.push("vehicle_details_json = ?");    vals.push(JSON.stringify(vehicleDetails));
    if (vehicleDetails?.vehicleRegistration) { sets.push("vehicle_registration = ?"); vals.push(vehicleDetails.vehicleRegistration.replace(/\s+/g, '').toUpperCase()); }
  }
  if (preInstallChecklist !== undefined)  { sets.push("pre_install_checklist_json = ?");  vals.push(JSON.stringify(preInstallChecklist)); }
  if (electricalChecklist !== undefined)  { sets.push("electrical_checklist_json = ?");  vals.push(JSON.stringify(electricalChecklist)); }
  if (deviceInstall !== undefined)        { sets.push("device_install_json = ?");         vals.push(JSON.stringify(deviceInstall)); }
  if (activation !== undefined)           { sets.push("activation_json = ?");             vals.push(JSON.stringify(activation)); }
  if (postInstallChecklist !== undefined) { sets.push("post_install_checklist_json = ?"); vals.push(JSON.stringify(postInstallChecklist)); }
  if (sitePhotos !== undefined)           { sets.push("site_photos_json = ?");           vals.push(JSON.stringify(sitePhotos)); }
  if (expectedGadgetCount !== undefined)  { sets.push("expected_gadget_count = ?");      vals.push(expectedGadgetCount === null || expectedGadgetCount === "" ? null : parseInt(String(expectedGadgetCount), 10)); }
  if (jobCardPhotoUrl !== undefined)      { sets.push("job_card_photo_url = ?");        vals.push(jobCardPhotoUrl || null); }
  let onBehalfSignoff = false;
  if (technicianSignedOff)   {
    const signerUser = await pgGet("SELECT name FROM users WHERE id = ?", [req.user!.id]).catch(() => null);
    sets.push("technician_signed_off_at = ?"); vals.push(now);
    sets.push("technician_signed_off_by_user_id = ?"); vals.push(req.user!.id);
    sets.push("technician_signed_off_by_name = ?"); vals.push(signerUser?.name || req.user!.email || null);
    const isAssignedTech =
      row.assigned_to_user_id === req.user!.id || (row.assigned_to_email && row.assigned_to_email === req.user!.email) ||
      row.co_technician_user_id === req.user!.id || (row.co_technician_email && row.co_technician_email === req.user!.email);
    onBehalfSignoff = !isAssignedTech;
    sets.push("technician_signed_off_on_behalf = ?"); vals.push(onBehalfSignoff);
  }
  if (engineerSignedOff)     {
    sets.push("engineer_signed_off_at = ?");  vals.push(now);
    sets.push("engineer_signed_off_by = ?");  vals.push(req.user!.id);
  }
  vals.push(req.params.id);

  await pgRun(`UPDATE installation_tickets SET ${sets.join(", ")} WHERE id = ?`, vals);

  // ── Device-linking: keep inv_items.installation_id in sync with assigned_device_id ──
  if (assignedDeviceId !== undefined) {
    const prevDeviceId: string | null = row.assigned_device_id || null;
    // Clear old device's installation link if the device is being changed
    if (prevDeviceId && prevDeviceId !== assignedDeviceId) {
      await pgRun(
        `UPDATE inv_items SET installation_id = NULL, updated_at = ? WHERE id = ? AND installation_id = ?`,
        [now, prevDeviceId, row.id]
      ).catch(console.error);
    }
    // Link new device to this ticket
    if (assignedDeviceId) {
      await pgRun(
        `UPDATE inv_items SET installation_id = COALESCE(installation_id, ?), updated_at = ? WHERE id = ?`,
        [row.id, now, assignedDeviceId]
      ).catch(console.error);
    }
  }

  // Mirror vehicle details back to crm_customer_vehicles so Customer 360 stays up to date
  if (vehicleDetails && row.vehicle_id) {
    const vSets: string[] = ["updated_at = ?"];
    const vVals: any[]   = [now];
    if (vehicleDetails.make)         { vSets.push("make = ?");               vVals.push(vehicleDetails.make); }
    if (vehicleDetails.model)        { vSets.push("model = ?");              vVals.push(vehicleDetails.model); }
    if (vehicleDetails.modelNumber)  { vSets.push("model_number = ?");       vVals.push(vehicleDetails.modelNumber); }
    if (vehicleDetails.bodyType)     { vSets.push("body_type = ?");          vVals.push(vehicleDetails.bodyType); }
    if (vehicleDetails.colour || vehicleDetails.color) {
      vSets.push("color = ?"); vVals.push(vehicleDetails.colour || vehicleDetails.color);
    }
    if (vehicleDetails.year)         { vSets.push("year_of_manufacture = ?"); vVals.push(vehicleDetails.year); }
    if (vehicleDetails.vin)          { vSets.push("chassis_number = ?");     vVals.push(vehicleDetails.vin); }
    if (vehicleDetails.engineNo)     { vSets.push("engine_number = ?");      vVals.push(vehicleDetails.engineNo); }
    if (vehicleDetails.vehicleCategory) { vSets.push("vehicle_category = ?"); vVals.push(vehicleDetails.vehicleCategory); }
    // Registered/Not Registered — mirror both the flag and the registration
    // value itself (cleared, not left stale, when switching to not-registered)
    // so the job card is the source of truth for this state, same as every
    // other vehicle field here.
    if (vehicleDetails.regStatus === "registered") {
      vSets.push("registration_known = ?"); vVals.push(true);
      if (vehicleDetails.registration) { vSets.push("registration = ?"); vVals.push(vehicleDetails.registration); }
    } else if (vehicleDetails.regStatus === "not_registered") {
      vSets.push("registration_known = ?"); vVals.push(false);
      vSets.push("registration = NULL");
    }
    if (vSets.length > 1) {
      vVals.push(row.vehicle_id);
      await pgRun(
        `UPDATE crm_customer_vehicles SET ${vSets.join(", ")} WHERE id = ?`,
        vVals
      ).catch(console.error);
    }
  }

  // Notify ISO/Technical roles when technician signs off — they need to confirm
  if (technicianSignedOff && !row.technician_signed_off_at) {
    createNotification({
      targetRole: "Technical",
      type: "info",
      title: "Technician Sign-off: ISO Confirmation Required",
      body: `Technician has signed off on ticket ${row.ticket_no}${row.customer_name ? ` (${row.customer_name})` : ''}. Please review and complete ISO sign-off to close the job.`,
      link: `/job-card.html?id=${row.id}`,
    }).catch(console.error);
    createNotification({
      targetRole: "Support",
      type: "info",
      title: "Technician Sign-off: ISO Confirmation Required",
      body: `Technician has signed off on ticket ${row.ticket_no}${row.customer_name ? ` (${row.customer_name})` : ''}. Please review and complete ISO sign-off to close the job.`,
      link: `/job-card.html?id=${row.id}`,
    }).catch(console.error);
  }

  // ── Auto-mark device(s) — and their paired SIM(s) — as Installed when ticket closes ──
  // Every device committed to this job (via /device-custody/assign-to-job, which sets
  // installation_id) is covered here, not just the single legacy assignedDeviceId field,
  // so multi-device jobs and their SIM pairings both get consumed correctly.
  if (status === 'Completed') {
    const legacyDeviceId: string | null = (assignedDeviceId !== undefined ? assignedDeviceId : row.assigned_device_id) || null;
    const deviceRows = await pgAll(
      `SELECT * FROM inv_items
       WHERE deleted_at IS NULL AND status = 'Issued for Installation'
         AND (installation_id = ? OR id = ?)`,
      [row.id, legacyDeviceId || row.id]
    ).catch(() => []);
    for (const deviceRow of deviceRows) {
      await pgRun(
        `UPDATE inv_items
         SET status = 'Installed',
             installation_id = COALESCE(installation_id, ?),
             customer_id     = COALESCE(customer_id, ?),
             deployed_at     = COALESCE(deployed_at, ?),
             updated_at      = ?
         WHERE id = ?`,
        [row.id, row.customer_id || null, now, now, deviceRow.id]
      ).catch(console.error);
      await pgRun(
        `INSERT INTO inv_movements
           (id, item_id, product_id, action, from_status, to_status,
            from_location, to_location, installation_id,
            performed_by_user_id, performed_by_email, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          uuidv4(), deviceRow.id, deviceRow.product_id,
          'INSTALLED', 'Issued for Installation', 'Installed',
          'Field', 'Customer Site', row.id,
          req.user!.id, req.user!.email || '',
          `Auto-installed via ticket ${row.ticket_no}`, now,
        ]
      ).catch(console.error);

      // The SIM paired with this device (if any) is now consumed — drop it out
      // of the technician's custody pool the same way the device itself leaves it.
      if (deviceRow.sim_serial) {
        const simRow = await pgGet(
          `SELECT id, status FROM inv_sims WHERE iccid = ? AND deleted_at IS NULL`,
          [deviceRow.sim_serial]
        ).catch(() => null);
        if (simRow && simRow.status === 'issued') {
          await pgRun(
            `UPDATE inv_sims SET status = 'installed', installation_id = ?, device_item_id = ?, installed_at = ?, updated_at = ? WHERE id = ?`,
            [row.id, deviceRow.id, now, now, simRow.id]
          ).catch(console.error);
          await pgRun(
            `INSERT INTO inv_sim_ledger (id, sim_id, action, from_status, to_status, actor_id, actor_email, notes, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [uuidv4(), simRow.id, 'SIM_INSTALLED', 'issued', 'installed', req.user!.id, req.user!.email || '',
              `Auto-installed with device ${deviceRow.serial_number || deviceRow.id} via ticket ${row.ticket_no}`, now]
          ).catch(console.error);
        }
      }
    }
  }

  // When the ticket is closed, mirror the status, stage and technician on the linked vi_installation record
  if (status === 'Completed' && row.vi_installation_id) {
    // Resolve technician: prefer user account ID, fall back to hr_employee lookup via email
    let viTechId: string | null = row.assigned_to_user_id || null;
    let viTechEmail: string | null = row.assigned_to_email || null;
    if (!viTechId && viTechEmail) {
      const uRow = await pgGet("SELECT id FROM users WHERE email = ? LIMIT 1", [viTechEmail]).catch(() => null);
      if (uRow?.id) viTechId = uRow.id;
    }
    await pgRun(
      `UPDATE vi_installations
       SET status = 'Completed', stage = 7,
           completed_at = ?,
           assigned_technician_id = COALESCE(assigned_technician_id, ?),
           assigned_technician_email = COALESCE(assigned_technician_email, ?),
           assigned_at = COALESCE(assigned_at, ?),
           updated_at = ?
       WHERE id = ?`,
      [now, viTechId, viTechEmail, row.assigned_at || now, now, row.vi_installation_id]
    ).catch(console.error);
  }

  auditLog(req, "INSTALL_TICKET_STATUS_UPDATE", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no, status, stage, assignedDeviceId }).catch(console.error);

  // Record history — STATUS_CHANGED covers both status and stage transitions
  const newStatus  = status ?? row.status;
  const newStage   = stage  != null ? Number(stage) : Number(row.stage || 0);
  const prevStage  = Number(row.stage || 0);
  const eventType  = stage != null && newStage !== prevStage ? "STAGE_ADVANCED" : "STATUS_CHANGED";
  // SLA clock updates: mark sla_started_by_at when stage advances to 1+ and technician sign-off
  const slaUpdates: string[] = [];
  const slaVals: any[] = [];
  if (stage != null && newStage >= 1 && !row.sla_started_by_at) {
    slaUpdates.push("sla_started_by_at = ?"); slaVals.push(now);
  }
  if (technicianSignedOff && !row.sla_signed_off_by_at) {
    slaUpdates.push("sla_signed_off_by_at = ?"); slaVals.push(now);
  }
  if (status === "Closed" && !row.sla_iso_closed_by_at) {
    slaUpdates.push("sla_iso_closed_by_at = ?"); slaVals.push(now);
  }
  if (slaUpdates.length) {
    pgRun(`UPDATE installation_tickets SET ${slaUpdates.map(s => s).join(", ")}, updated_at = ? WHERE id = ?`,
      [...slaVals, now, req.params.id]).catch(console.error);
  }
  recordHistory(req.params.id, eventType, req, {
    statusBefore: row.status, statusAfter: newStatus,
    stageBefore: prevStage, stageAfter: newStage,
    details: { assignedDeviceId: assignedDeviceId ?? null, notes: notes ?? null },
  });
  if (technicianSignedOff && onBehalfSignoff) {
    recordHistory(req.params.id, "TECH_SIGNOFF_ON_BEHALF", req,
      { details: { onBehalfOf: row.assigned_to_email || row.assigned_to_user_id, signedBy: req.user!.email } });
  }

  // ── Retail auto-quote: materialise/update quote+proforma when device assigned ──
  // Fire-and-forget; install workflow must never fail because of quote errors.
  // Also fires when a retail ticket already has a device but never got a quote
  // (e.g. tickets that existed before this automation was deployed).
  const priorDeviceId: string | null = row.assigned_device_id || null;
  const deviceJustAssigned = assignedDeviceId !== undefined && assignedDeviceId !== null && assignedDeviceId !== priorDeviceId;
  const retailQuoteMissing = !!(row.retail_lead_id && (priorDeviceId || assignedDeviceId) && !row.proforma_id);
  if (row.retail_lead_id && (deviceJustAssigned || retailQuoteMissing)) {
    materializeRetailQuoteForTicket(row.id, { userId: req.user!.id, email: req.user!.email || "" })
      .then((r) => console.log(
        `[retail-auto-quote] ${r.isNew ? "Created" : "Updated"} ${r.quoteNo}/${r.proformaNo} for ticket ${row.ticket_no}. pricingMissing=${r.pricingMissing}`
      ))
      .catch((e: any) => console.error("[retail-auto-quote] materialize failed (non-fatal):", e?.message));
  }

  // ── Retail auto-quote: send approval link to customer on completion ──────
  if (status === "Completed" && row.retail_lead_id) {
    sendProformaApprovalLinkForTicket(row.id)
      .catch((e: any) => console.error("[retail-auto-quote] approval link failed (non-fatal):", e?.message));
  }

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "Status updated." });
});

// ── POST /:id/send-csat ── Send OTP to customer via email, SMS, or WhatsApp ──
router.post("/:id/send-csat", requireAuth, requireRole(["Technical", "Admin", "Technician", "Support", "InstallOffice"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  let row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) row = await pgGet("SELECT * FROM installation_tickets WHERE ticket_no = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) row = await pgGet("SELECT * FROM installation_tickets WHERE vi_installation_id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const { contact, channel = "email" } = req.body || {};
  if (!contact) return errorResponse(res, 400, "MISSING_FIELD", "contact is required.");
  if (!["email", "sms", "whatsapp"].includes(channel))
    return errorResponse(res, 400, "INVALID_FIELD", "channel must be email, sms, or whatsapp.");

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const now = new Date().toISOString();
  await pgRun(`UPDATE installation_tickets SET customer_otp = ?, updated_at = ? WHERE id = ?`, [otp, now, row.id]);

  const otpText = `Your Finemark installation verification code is: ${otp}. Please give this to the technician to complete your satisfaction survey.`;
  let delivered = false;

  try {
    if (channel === "email" && isGraphConfigured()) {
      await sendEmailViaGraph({
        fromMailbox: MAILBOXES.customer,
        to: contact,
        subject: "Your Installation Verification Code",
        htmlBody: `<p>Hello,</p><p>Your verification code for the Finemark installation service survey is:</p><h2 style="letter-spacing:6px;font-size:28px">${otp}</h2><p>Please provide this code to the field technician to complete your satisfaction survey.</p><p style="color:#888;font-size:12px">If you did not request this, please ignore this message.</p>`,
        textBody: otpText,
      });
      delivered = true;
    } else if (channel === "sms" && isAtConfigured()) {
      await sendSms([contact], otpText);
      delivered = true;
    } else if (channel === "whatsapp" && isTwilioConfigured()) {
      await sendWhatsApp(contact, otpText);
      delivered = true;
    }
  } catch (e) {
    console.error(`[CSAT OTP] Delivery via ${channel} failed:`, e);
  }

  auditLog(req, "INSTALL_CSAT_SENT", `installation_ticket:${row.id}`, "Info",
    { ticketNo: row.ticket_no, channel, delivered }).catch(console.error);

  const viaLabel = channel === "email" ? "email" : channel === "sms" ? "SMS" : "WhatsApp";
  return res.status(200).json({
    message: delivered ? `OTP sent to customer via ${viaLabel}.` : `OTP generated (${viaLabel} service not configured — check server settings).`,
    delivered,
    // Return OTP to authenticated staff so they can read it to the customer
    // if the delivery channel is not configured or unreliable.
    otp: delivered ? undefined : otp,
  });
});

// ── POST /:id/csat ── Customer submits OTP + CSAT ────────────────────────────
router.post("/:id/csat", async (req, res) => {
  const { otp, score, csatScore, comment, csatComment } = req.body || {};
  const finalScore = score ?? csatScore;   // frontend sends csatScore
  const finalComment = comment ?? csatComment ?? null;
  if (!otp || finalScore === undefined) return errorResponse(res, 400, "VALIDATION_ERROR", "otp and score are required.");

  let row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) row = await pgGet("SELECT * FROM installation_tickets WHERE ticket_no = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) row = await pgGet("SELECT * FROM installation_tickets WHERE vi_installation_id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
  if (row.customer_otp !== String(otp).trim()) return errorResponse(res, 400, "INVALID_OTP", "Invalid or expired OTP.");
  if (row.customer_otp_verified_at) return errorResponse(res, 409, "ALREADY_SUBMITTED", "CSAT already submitted.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets SET csat_score=?, csat_comment=?, customer_otp_verified_at=?, status='Closed', updated_at=? WHERE id=?`,
    [Number(finalScore), finalComment, now, now, row.id]
  );

  return res.status(200).json({ message: "Thank you for your feedback!" });
});

// ── POST /:id/request-edit-otp ── Admin requests OTP to edit a closed job ────
// The code is emailed to the Admin's OWN account email (never a free-text
// address) so possession of the OTP proves it's really that Admin, not just
// someone with the Admin role logged into a shared session.
router.post("/:id/request-edit-otp", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), authLimiter, async (req: AuthRequest, res) => {
  const ticket = await pgGet("SELECT id, ticket_no, status FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");
  if (!LOCKED_STATUSES.has(ticket.status)) {
    return errorResponse(res, 400, "NOT_LOCKED", "This installation is not closed — no edit unlock is needed.");
  }

  const admin = await pgGet("SELECT id, name, email FROM users WHERE id = ?", [req.user!.id]);
  if (!admin?.email) return errorResponse(res, 400, "NO_EMAIL", "Your account has no email on file to send the code to.");

  const now = new Date();
  // Invalidate any prior unused codes for this admin+ticket
  await pgRun(
    `UPDATE installation_ticket_edit_unlocks SET otp_expires_at = ? WHERE ticket_id = ? AND admin_user_id = ? AND verified_at IS NULL`,
    [now.toISOString(), req.params.id, admin.id]
  );

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = hashRefreshToken(otp);
  const otpExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 min to enter the code

  await pgRun(
    `INSERT INTO installation_ticket_edit_unlocks (id, ticket_id, admin_user_id, otp_hash, otp_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), req.params.id, admin.id, otpHash, otpExpiresAt, now.toISOString()]
  );

  const otpMailbox = process.env.GRAPH_OTP_MAILBOX;
  let delivered = false;
  if (isGraphConfigured() && otpMailbox) {
    await sendEmailViaGraph({
      fromMailbox: otpMailbox,
      to: admin.email,
      subject: `Edit access code — closed job ${ticket.ticket_no}`,
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#0f766e;padding:24px 32px;border-radius:12px 12px 0 0">
            <h1 style="color:#fff;font-size:20px;margin:0">Closed Job Edit Access</h1>
          </div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 12px 12px">
            <p style="color:#334155;font-size:15px">Hi ${admin.name},</p>
            <p style="color:#334155;font-size:15px">You requested edit access to closed installation job <strong>${ticket.ticket_no}</strong>. Use the code below to unlock it. This code expires in <strong>10 minutes</strong>.</p>
            <div style="text-align:center;margin:32px 0">
              <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 40px;font-size:36px;font-weight:700;letter-spacing:10px;color:#0f172a;font-family:monospace">${otp}</span>
            </div>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:12px">If you didn't request this, someone may have access to your account — please investigate or ignore if this was you on another device.</p>
          </div>
        </div>`,
    }).then(() => { delivered = true; }).catch(e => console.error("[install-ticket] Failed to send edit-unlock OTP email:", e.message));
  } else {
    console.log(`[install-ticket] Edit-unlock OTP for ${admin.email} (ticket ${ticket.ticket_no}): ${otp}`);
  }

  auditLog(req, "INSTALL_TICKET_EDIT_OTP_REQUESTED", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: ticket.ticket_no, delivered }).catch(console.error);

  return res.status(200).json({
    message: delivered ? `A verification code was sent to ${admin.email}.` : "Code generated (email service not configured — check server logs).",
    delivered,
  });
});

// ── POST /:id/verify-edit-otp ── Admin verifies the OTP to unlock editing ────
router.post("/:id/verify-edit-otp", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), authLimiter, async (req: AuthRequest, res) => {
  const otp = String(req.body?.otp || "").trim();
  if (!otp) return errorResponse(res, 400, "VALIDATION_ERROR", "otp is required.");

  const ticket = await pgGet("SELECT id, ticket_no FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const now = new Date();
  const otpHash = hashRefreshToken(otp);
  const record = await pgGet(
    `SELECT * FROM installation_ticket_edit_unlocks
     WHERE ticket_id = ? AND admin_user_id = ? AND otp_hash = ? AND verified_at IS NULL AND otp_expires_at > ?`,
    [req.params.id, req.user!.id, otpHash, now.toISOString()]
  );
  if (!record) {
    auditLog(req, "INSTALL_TICKET_EDIT_OTP_FAILED", `installation_ticket:${req.params.id}`, "Warning",
      { ticketNo: ticket.ticket_no }).catch(console.error);
    return errorResponse(res, 401, "INVALID_OTP", "Invalid or expired code.");
  }

  const unlockExpiresAt = new Date(now.getTime() + 20 * 60 * 1000).toISOString(); // 20 min edit window
  await pgRun(
    `UPDATE installation_ticket_edit_unlocks SET verified_at = ?, unlock_expires_at = ? WHERE id = ?`,
    [now.toISOString(), unlockExpiresAt, record.id]
  );

  auditLog(req, "INSTALL_TICKET_EDIT_UNLOCKED", `installation_ticket:${req.params.id}`, "Warning",
    { ticketNo: ticket.ticket_no, unlockExpiresAt }).catch(console.error);

  return res.status(200).json({ message: "Edit access granted.", unlockExpiresAt });
});

// ── GET /:id/edit-unlock-status ── check whether the current Admin already has
// an active unlock for this ticket (e.g. after a page refresh) ────────────────
router.get("/:id/edit-unlock-status", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const unlock = await pgGet(
    `SELECT unlock_expires_at FROM installation_ticket_edit_unlocks
     WHERE ticket_id = ? AND admin_user_id = ? AND verified_at IS NOT NULL AND unlock_expires_at > ?
     ORDER BY unlock_expires_at DESC LIMIT 1`,
    [req.params.id, req.user!.id, new Date().toISOString()]
  );
  return res.status(200).json({ unlocked: !!unlock, unlockExpiresAt: unlock?.unlock_expires_at || null });
});

// ── PATCH /:id/vehicle ── set or update vehicle on the ticket ─────────────────
router.patch("/:id/vehicle", requireAuth, requireRole(["Sales", "Admin", "Technical", "InstallOffice"]), requireTicketUnlocked, async (req: AuthRequest, res) => {
  const { vehicleId, vehicleRegistration } = req.body || {};
  if (!vehicleId && !vehicleRegistration) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "vehicleId or vehicleRegistration is required.");
  }

  const row = await pgGet("SELECT * FROM installation_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE installation_tickets SET vehicle_id=?, vehicle_registration=?, updated_at=? WHERE id=?`,
    [vehicleId || null, vehicleRegistration ? vehicleRegistration.replace(/\s+/g, '').toUpperCase() : null, now, req.params.id]
  );

  auditLog(req, "INSTALL_TICKET_VEHICLE_SET", `installation_ticket:${req.params.id}`, "Info",
    { ticketNo: row.ticket_no, vehicleId, vehicleRegistration }).catch(console.error);
  recordHistory(req.params.id, "VEHICLE_UPDATED", req,
    { statusBefore: row.status, statusAfter: row.status,
      details: { vehicleId: vehicleId || null, vehicleRegistration: vehicleRegistration || null } });

  const updated = await pgGet("SELECT * FROM installation_tickets WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: mapTicket(updated), message: "Vehicle updated." });
});

// ── GET /:id/history ── immutable activity timeline for a ticket ──────────────
router.get("/:id/history", requireAuth, requireRole(["Sales", "Admin", "Finance", "Technical", "Technician", "InstallOffice"]), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT id, status, created_at, assigned_at, sla_ack_hours, sla_start_hours, sla_signoff_hours, sla_iso_hours, sla_acknowledged_by_at, sla_started_by_at, sla_signed_off_by_at, sla_iso_closed_by_at FROM installation_tickets WHERE (id = ? OR vi_installation_id = ?) AND deleted_at IS NULL", [req.params.id, req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

  const history = await getTicketHistory(row.id);
  const sla = computeSla(row);
  return res.status(200).json({ data: { history, sla } });
});

// ── GET /sla/summary ── aggregate SLA metrics for the dashboard ────────────────
router.get("/sla/summary", requireAuth, requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Finance"]), async (req: AuthRequest, res) => {
  const { range = "30d" } = req.query as Record<string, string>;
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const rows = await pgAll(
    `SELECT id, status, created_at, assigned_at,
            sla_ack_hours, sla_start_hours, sla_signoff_hours, sla_iso_hours,
            sla_acknowledged_by_at, sla_started_by_at,
            sla_signed_off_by_at, sla_iso_closed_by_at,
            assigned_to_email
     FROM installation_tickets
     WHERE deleted_at IS NULL AND created_at >= ?`,
    [since]
  );

  let onTrack = 0, atRisk = 0, breached = 0, met = 0;
  const techMap: Record<string, { total: number; breached: number; totalHours: number }> = {};
  let totalHoursSum = 0, completedCount = 0;

  for (const r of rows) {
    const result = computeSla(r);
    if (result.overallStatus === "Breached") breached++;
    else if (result.overallStatus === "AtRisk") atRisk++;
    else if (result.overallStatus === "Met") { met++; }
    else onTrack++;

    const email = r.assigned_to_email || "unassigned";
    if (!techMap[email]) techMap[email] = { total: 0, breached: 0, totalHours: 0 };
    techMap[email].total++;
    if (result.overallStatus === "Breached") techMap[email].breached++;
    if (result.totalElapsedHours != null) { techMap[email].totalHours += result.totalElapsedHours; }

    if (result.overallStatus === "Met" && result.totalElapsedHours != null) {
      totalHoursSum += result.totalElapsedHours;
      completedCount++;
    }
  }

  const total = rows.length;
  const compliancePct = total > 0 ? Math.round(((onTrack + met) / total) * 100) : 100;
  const avgCompletionHours = completedCount > 0 ? Math.round((totalHoursSum / completedCount) * 10) / 10 : null;

  const techPerformance = Object.entries(techMap).map(([email, d]) => ({
    email,
    total: d.total,
    breached: d.breached,
    breachRate: d.total > 0 ? Math.round((d.breached / d.total) * 100) : 0,
    avgHours: d.total > 0 ? Math.round((d.totalHours / d.total) * 10) / 10 : null,
  })).sort((a, b) => b.breachRate - a.breachRate);

  return res.status(200).json({
    data: {
      range, days, total, onTrack, atRisk, breached, met,
      compliancePct,
      avgCompletionHours,
      techPerformance,
    }
  });
});

// ── Phase 3: Generic step handler ───────────────────────────────────────────
// stepKey → { requiredCurrentStage, nextStage, column }
const STEP_CONFIG: Record<string, { column: string; nextStage: number }> = {
  checkin:    { column: "checkin_json",              nextStage: 1 },
  vehicle:    { column: "vehicle_details_json",       nextStage: 2 },
  preInstall: { column: "pre_install_checklist_json", nextStage: 3 },
  electrical: { column: "electrical_checklist_json",  nextStage: 4 },
  install:    { column: "device_install_json",        nextStage: 5 },
  postInstall:{ column: "post_install_checklist_json",nextStage: 7 },
  photos:     { column: "site_photos_json",           nextStage: 8 },
};

router.patch("/:id/step/:stepKey",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  requireTicketUnlocked,
  async (req: AuthRequest, res) => {
    const { stepKey } = req.params;
    const cfg = STEP_CONFIG[stepKey];
    if (!cfg) return errorResponse(res, 400, "INVALID_STEP", `Unknown step '${stepKey}'.`);

    const ticket = await pgGet(
      `SELECT id, stage, status, assigned_to_user_id, co_technician_user_id, iso_user_id FROM installation_tickets WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Installation ticket not found.");

    // ── Assignment gate: both technician AND ISO officer must be assigned before any step can run ──
    if (!ticket.assigned_to_user_id) {
      return errorResponse(res, 422, "ASSIGNMENT_INCOMPLETE", "A technician must be assigned before this job can be started.");
    }
    if (!ticket.iso_user_id) {
      return errorResponse(res, 422, "ASSIGNMENT_INCOMPLETE", "An ISO officer must be assigned before this job can be started.");
    }

    // ── Access gate: only the assigned technician, co-technician, ISO officer, or Admin may execute steps ──
    const user = (req as AuthRequest).user!;
    const isAdmin = ["Admin", "Technical", "InstallOffice"].includes(user.role);
    const isAssignedParty = ticket.assigned_to_user_id === user.id
      || ticket.co_technician_user_id === user.id
      || ticket.iso_user_id === user.id;
    if (!isAdmin && !isAssignedParty) {
      return errorResponse(res, 403, "FORBIDDEN", "Only the assigned technician, co-technician, or ISO officer may execute this job.");
    }

    const now = new Date().toISOString();
    const dataJson = JSON.stringify(req.body || {});
    const newStage = Math.max(Number(ticket.stage || 0), cfg.nextStage);

    await pgRun(
      `UPDATE installation_tickets SET ${cfg.column} = ?, stage = ?, updated_at = ? WHERE id = ?`,
      [dataJson, newStage, now, req.params.id]
    );

    recordHistory(req.params.id, "STEP_COMPLETED", req as AuthRequest, { details: { step: stepKey, stageAfter: newStage } });

    const updated = await pgGet(`SELECT * FROM installation_tickets WHERE id = ?`, [req.params.id]);
    return res.status(200).json({ data: mapTicket(updated) });
  }
);

// ── Phase 3: File upload (multer disk storage) ────────────────────────────────
const buildUploadStorage = (subDir: string) =>
  multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(process.cwd(), "uploads", subDir, (req.params as any).id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".bin";
      cb(null, uuidv4() + ext);
    },
  });

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
]);

const uploadMiddleware = multer({
  storage: buildUploadStorage("installations"),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error("Only images and PDFs are allowed."));
  },
}).single("file");

router.post(
  "/:id/upload",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  requireTicketUnlocked,
  (req, res, next) => {
    const ticket = pgGet(
      `SELECT id FROM installation_tickets WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    ).then((t) => {
      if (!t) { res.status(404).json({ error: { code: "NOT_FOUND", message: "Ticket not found." } }); return; }
      uploadMiddleware(req, res, (err) => {
        if (err) {
          return res.status(400).json({ error: { code: "UPLOAD_ERROR", message: err.message } });
        }
        next();
      });
    }).catch(next);
  },
  async (req, res) => {
    if (!(req as any).file) {
      return errorResponse(res, 400, "NO_FILE", "No file attached.");
    }
    const f = (req as any).file as Express.Multer.File;
    const filename = f.filename;
    const url = `/uploads/installations/${req.params.id}/${filename}`;
    return res.status(200).json({ data: { filename, url, sizeBytes: f.size, mimetype: f.mimetype } });
  }
);

// ── Phase 3: ISO Activation Approve ──────────────────────────────────────────
router.post(
  "/:id/activation-approve",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  requireTicketUnlocked,
  async (req: AuthRequest, res) => {
    const ticket = await pgGet(
      `SELECT id, status, stage, activation_requested_at, activation_approved_at,
              assigned_to_user_id, assigned_to_email, iso_user_id, iso_email
       FROM installation_tickets WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found.");
    if (ticket.activation_approved_at) {
      return errorResponse(res, 409, "ALREADY_APPROVED", "Activation already approved.");
    }

    const user = (req as AuthRequest).user!;
    // Only this ticket's own assigned ISO officer may approve — not just any user
    // holding an ISO-capable role. Admin retains full override for support cases.
    if (user.role !== "Admin" && ticket.iso_user_id !== user.id && !(ticket.iso_email && ticket.iso_email === user.email)) {
      return errorResponse(res, 403, "FORBIDDEN", "Only this ticket's assigned ISO officer may approve activation.");
    }
    const { notes, ignitionOk, locationOk, platformScreenshotUrl } = req.body || {};
    const now = new Date().toISOString();
    const approvalJson = JSON.stringify({ notes, ignitionOk, locationOk, platformScreenshotUrl });

    // The ISO can activate directly without a prior "notify ISO" request from the
    // technician (e.g. self-service ISO, or an ISO Assisted installation where the
    // ISO is running the whole wizard) — backfill the request timestamp in that case
    // rather than requiring a request step that has no actor to perform it.
    await pgRun(
      `UPDATE installation_tickets
       SET activation_requested_at  = COALESCE(activation_requested_at, ?),
           activation_approved_at   = ?,
           activation_approved_by   = ?,
           activation_approved_json = ?,
           activation_json          = ?,
           stage                    = GREATEST(stage, 6),
           status                   = CASE WHEN status = 'In Progress' THEN 'In Progress' ELSE status END,
           updated_at               = ?
       WHERE id = ?`,
      [now, now, user.email, approvalJson, approvalJson, now, req.params.id]
    );

    recordHistory(req.params.id, "ACTIVATION_APPROVED", req as AuthRequest, { details: { approvedBy: user.email } });

    // Notify assigned technician
    if (ticket.assigned_to_user_id) {
      createNotification({
        targetUserId: ticket.assigned_to_user_id,
        targetRole: undefined,
        type: "info",
        title: "Activation Approved",
        body: `ISO has approved activation for ticket ${req.params.id}. Proceed to post-installation checks.`,
        link: `/job-card.html?ticketId=${req.params.id}`,
      }).catch(console.error);
    }

    const updated = await pgGet(`SELECT * FROM installation_tickets WHERE id = ?`, [req.params.id]);
    return res.status(200).json({ data: mapTicket(updated), message: "Activation approved." });
  }
);

// ── Phase 3: ISO Activation Reject ───────────────────────────────────────────
router.post(
  "/:id/activation-reject",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  requireTicketUnlocked,
  async (req: AuthRequest, res) => {
    const ticket = await pgGet(
      `SELECT id, activation_requested_at, activation_approved_at,
              assigned_to_user_id, iso_user_id, iso_email
       FROM installation_tickets WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found.");
    if (!ticket.activation_requested_at) {
      return errorResponse(res, 400, "NOT_REQUESTED", "Activation has not been requested for this ticket.");
    }

    const { reason } = req.body || {};
    if (!reason?.trim()) return errorResponse(res, 400, "INVALID_INPUT", "reason is required.");

    const user = (req as AuthRequest).user!;
    // Only this ticket's own assigned ISO officer may reject — same rule as approve.
    if (user.role !== "Admin" && ticket.iso_user_id !== user.id && !(ticket.iso_email && ticket.iso_email === user.email)) {
      return errorResponse(res, 403, "FORBIDDEN", "Only this ticket's assigned ISO officer may reject activation.");
    }
    const now = new Date().toISOString();

    await pgRun(
      `UPDATE installation_tickets
       SET activation_rejected_at      = ?,
           activation_rejection_reason = ?,
           activation_requested_at     = NULL,
           activation_approved_at      = NULL,
           updated_at                  = ?
       WHERE id = ?`,
      [now, reason.trim(), now, req.params.id]
    );

    recordHistory(req.params.id, "ACTIVATION_REJECTED", req as AuthRequest, { details: { reason: reason.trim() } });

    // Notify technician to fix and re-request
    if (ticket.assigned_to_user_id) {
      createNotification({
        targetUserId: ticket.assigned_to_user_id,
        targetRole: undefined,
        type: "warning",
        title: "Activation Rejected",
        body: `ISO rejected activation: ${reason.trim()}. Please fix and re-request.`,
        link: `/job-card.html?ticketId=${req.params.id}`,
      }).catch(console.error);
    }

    const updated = await pgGet(`SELECT * FROM installation_tickets WHERE id = ?`, [req.params.id]);
    return res.status(200).json({ data: mapTicket(updated), message: "Activation rejected." });
  }
);

export default router;
