/**
 * SLA Engine
 *
 * Computes Service Level Agreement status for installation tickets across
 * four gates: Acknowledgement, Job Start, Technician Sign-Off, ISO Closure.
 *
 * Designed to be called synchronously on every ticket fetch and every
 * mutation — no cron required (lazy evaluation).
 *
 * Default SLA thresholds (overridable per-ticket via sla_* columns):
 *   Ack      → 4 hours  from ticket creation
 *   Start    → 24 hours from assignment
 *   Sign-off → 48 hours from job start
 *   ISO      → 8 hours  from technician sign-off
 */

export type SlaStatus = "OnTrack" | "AtRisk" | "Breached" | "Met" | "Pending";

export interface SlaGate {
  name:         string;
  label:        string;
  targetHours:  number;
  startedAt:    string | null;
  completedAt:  string | null;
  targetAt:     string | null;   // ISO timestamp when SLA deadline is/was due
  status:       SlaStatus;
  elapsedHours: number | null;
  remainingHours: number | null;
}

export interface SlaResult {
  overallStatus:      SlaStatus;
  gates:              SlaGate[];
  totalElapsedHours:  number | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function hoursBetween(start: string, end?: string | null): number {
  const endT = end ? new Date(end).getTime() : Date.now();
  return (endT - new Date(start).getTime()) / 3_600_000;
}

function evalGate(
  startedAt:   string | null,
  completedAt: string | null,
  targetHours: number
): Pick<SlaGate, "status" | "elapsedHours" | "remainingHours" | "targetAt"> {
  if (!startedAt) {
    return { status: "Pending", elapsedHours: null, remainingHours: null, targetAt: null };
  }
  const targetAt = new Date(
    new Date(startedAt).getTime() + targetHours * 3_600_000
  ).toISOString();
  const elapsed = hoursBetween(startedAt, completedAt ?? null);

  if (completedAt) {
    return {
      status:         elapsed <= targetHours ? "Met" : "Breached",
      elapsedHours:   elapsed,
      remainingHours: null,
      targetAt,
    };
  }

  // Still in progress
  const remaining = targetHours - elapsed;
  // Last 25% of the window → AtRisk
  const status: SlaStatus =
    remaining < 0                         ? "Breached"
    : remaining <= targetHours * 0.25    ? "AtRisk"
    : "OnTrack";

  return { status, elapsedHours: elapsed, remainingHours: remaining, targetAt };
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Compute the full SLA result from a raw DB row (snake_case fields).
 *
 * All timestamp fields are ISO strings. Missing/null timestamps are treated
 * as "not yet reached" for the corresponding gate.
 */
export function computeSla(row: any): SlaResult {
  const gateDefs: Array<{
    name: string;
    label: string;
    startedAt: string | null;
    completedAt: string | null;
    targetHours: number;
  }> = [
    {
      name:        "ack",
      label:       "Acknowledgement",
      startedAt:   row.created_at             || null,
      completedAt: row.sla_acknowledged_by_at || null,
      targetHours: Number(row.sla_ack_hours   ?? 4),
    },
    {
      name:        "start",
      label:       "Job Start",
      startedAt:   row.assigned_at            || null,
      completedAt: row.sla_started_by_at      || null,
      targetHours: Number(row.sla_start_hours ?? 24),
    },
    {
      name:        "signoff",
      label:       "Technician Sign-Off",
      startedAt:   row.sla_started_by_at      || null,
      completedAt: row.sla_signed_off_by_at   || null,
      targetHours: Number(row.sla_signoff_hours ?? 48),
    },
    {
      name:        "iso",
      label:       "ISO Closure",
      startedAt:   row.sla_signed_off_by_at   || null,
      completedAt: row.sla_iso_closed_by_at   || null,
      targetHours: Number(row.sla_iso_hours   ?? 8),
    },
  ];

  const gates: SlaGate[] = gateDefs.map(g => ({
    ...g,
    ...evalGate(g.startedAt, g.completedAt, g.targetHours),
  }));

  const statuses = gates.map(g => g.status);
  const overallStatus: SlaStatus =
    statuses.includes("Breached")  ? "Breached"
    : statuses.includes("AtRisk") ? "AtRisk"
    : statuses.some(s => s === "Met") && !statuses.some(s => s === "OnTrack" || s === "AtRisk")
      ? "Met"
    : "OnTrack";

  const totalElapsedHours = row.created_at
    ? hoursBetween(row.created_at, row.sla_iso_closed_by_at ?? null)
    : null;

  return { overallStatus, gates, totalElapsedHours };
}

/**
 * Human-readable SLA label for API responses / UI badges.
 */
export function slaStatusLabel(status: SlaStatus): string {
  return {
    OnTrack: "On Track",
    AtRisk:  "At Risk",
    Breached:"Breached",
    Met:     "Met",
    Pending: "Pending",
  }[status] ?? status;
}
