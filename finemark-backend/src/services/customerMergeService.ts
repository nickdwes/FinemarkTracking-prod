import { v4 as uuidv4 } from "uuid";
import { pool, pgGet } from "../db.js";
import { scanAllCustomersForDuplicates, DuplicateCluster } from "./customerDedupeService.js";
import { invalidateCustomerCaches } from "./customerCacheService.js";

// Merges duplicate crm_customers rows found by customerDedupeService — for
// each cluster, the customer with the most installation_tickets survives
// ("most active in terms of tickets", per the actual ask), every other
// customer_id in the cluster is re-pointed to the survivor across every
// table that references it, then soft-deleted.

// "Safe many" tables: no unique constraint on customer_id (confirmed via
// direct \d inspection of the live schema), so a blind UPDATE can't collide.
// Includes tables with zero current rows for the known duplicate set too —
// harmless no-ops, but keeps this list correct if that changes before the
// merge runs.
const REPOINT_TABLES = [
  "crm_contact_persons", "crm_customer_vehicles", "crm_proforma_invoices",
  "crm_quotes", "installation_tickets", "inv_items", "retail_leads",
  "vi_installations", "crm_leads", "invoices", "crm_communication_logs",
  "crm_subscriptions", "crm_devices", "crm_tickets", "customer_documents",
  "crm_installation_surveys", "crm_customer_users", "invoices_advanced",
  "quotes", "inv_warranty_tickets",
] as const;

// crm_campaign_members has UNIQUE(campaign_id, customer_id) — re-pointing
// could collide if the loser and winner are both already members of the
// same campaign, so it gets its own conflict-aware step instead of a blind
// UPDATE like the tables above.
const CAMPAIGN_MEMBERS_TABLE = "crm_campaign_members";

// 1:1 profile tables — UNIQUE(customer_id), so the loser's row can never be
// re-pointed onto a winner that already has one; it's dropped instead
// (the winner's own profile is always the one that survives).
const PROFILE_TABLES = ["crm_individual_profiles", "crm_corporate_profiles"] as const;

export interface MergePlan {
  winnerId: string;
  winnerName: string;
  loserIds: string[];
  matchedOn: string[];
  ticketCounts: Record<string, number>;
  rowCounts: Record<string, number>; // table -> rows that would be re-pointed (summed across all losers)
}

async function countTicketsFor(customerId: string): Promise<number> {
  const row = await pgGet<{ n: string }>(
    `SELECT COUNT(*) AS n FROM installation_tickets WHERE customer_id = ? AND deleted_at IS NULL`,
    [customerId]
  );
  return Number(row?.n || 0);
}

async function totalActivityFor(customerId: string): Promise<number> {
  let total = 0;
  for (const table of REPOINT_TABLES) {
    const row = await pgGet<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE customer_id = ?`, [customerId]);
    total += Number(row?.n || 0);
  }
  return total;
}

// Winner = most installation_tickets; ties broken by total activity across
// every related table, then by earliest created_at (the first-created
// record is the most likely to be the "real" original, with the others
// being accidental re-registrations of the same person/company).
async function pickWinner(cluster: DuplicateCluster): Promise<{ winnerId: string; ticketCounts: Record<string, number> }> {
  const ticketCounts: Record<string, number> = {};
  for (const c of cluster.customers) ticketCounts[c.id] = await countTicketsFor(c.id);

  const maxTickets = Math.max(...Object.values(ticketCounts));
  let candidates = cluster.customers.filter((c) => ticketCounts[c.id] === maxTickets);

  if (candidates.length > 1) {
    const activity: Record<string, number> = {};
    for (const c of candidates) activity[c.id] = await totalActivityFor(c.id);
    const maxActivity = Math.max(...candidates.map((c) => activity[c.id]));
    candidates = candidates.filter((c) => activity[c.id] === maxActivity);
  }

  if (candidates.length > 1) {
    const rows = await Promise.all(
      candidates.map((c) => pgGet<{ created_at: string }>(`SELECT created_at FROM crm_customers WHERE id = ?`, [c.id]))
    );
    let oldest = candidates[0];
    let oldestAt = rows[0]?.created_at || "";
    for (let i = 1; i < candidates.length; i++) {
      const at = rows[i]?.created_at || "";
      if (at && (!oldestAt || at < oldestAt)) { oldest = candidates[i]; oldestAt = at; }
    }
    candidates = [oldest];
  }

  return { winnerId: candidates[0].id, ticketCounts };
}

export async function planAllMerges(): Promise<MergePlan[]> {
  const clusters = await scanAllCustomersForDuplicates();
  const plans: MergePlan[] = [];
  for (const cluster of clusters) {
    const { winnerId, ticketCounts } = await pickWinner(cluster);
    const winner = cluster.customers.find((c) => c.id === winnerId)!;
    const loserIds = cluster.customers.filter((c) => c.id !== winnerId).map((c) => c.id);

    const rowCounts: Record<string, number> = {};
    for (const table of [...REPOINT_TABLES, CAMPAIGN_MEMBERS_TABLE]) {
      const row = await pgGet<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE customer_id = ANY(?::text[])`,
        [loserIds]
      );
      rowCounts[table] = Number(row?.n || 0);
    }

    plans.push({ winnerId, winnerName: winner.displayName, loserIds, matchedOn: cluster.matchedOn, ticketCounts, rowCounts });
  }
  return plans;
}

export interface MergeResult extends MergePlan {
  status: "merged" | "error";
  error?: string;
}

// Executes one cluster's merge in a single DB transaction (BEGIN/COMMIT on a
// dedicated pool client, not the shared pgRun helper — pgRun pulls a fresh
// connection from the pool per call, which can't hold a transaction across
// multiple statements). A failure partway through rolls the whole cluster
// back rather than leaving a half-repointed customer.
export async function executeMerge(plan: MergePlan, actorEmail: string): Promise<MergeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const loserId of plan.loserIds) {
      for (const table of REPOINT_TABLES) {
        await client.query(`UPDATE ${table} SET customer_id = $1 WHERE customer_id = $2`, [plan.winnerId, loserId]);
      }

      // crm_campaign_members: UNIQUE(campaign_id, customer_id) — drop the
      // loser's membership row wherever re-pointing it would collide with a
      // membership the winner already has in the same campaign.
      await client.query(
        `DELETE FROM ${CAMPAIGN_MEMBERS_TABLE} cm
         WHERE cm.customer_id = $1
           AND EXISTS (SELECT 1 FROM ${CAMPAIGN_MEMBERS_TABLE} cm2 WHERE cm2.customer_id = $2 AND cm2.campaign_id = cm.campaign_id)`,
        [loserId, plan.winnerId]
      );
      await client.query(`UPDATE ${CAMPAIGN_MEMBERS_TABLE} SET customer_id = $1 WHERE customer_id = $2`, [plan.winnerId, loserId]);

      // 1:1 profile tables — the winner keeps its own; the loser's is dropped.
      for (const table of PROFILE_TABLES) {
        await client.query(`DELETE FROM ${table} WHERE customer_id = $1`, [loserId]);
      }

      // Soft-delete the loser's customer record.
      await client.query(
        `UPDATE crm_customers SET deleted_at = $1, deleted_by = $2 WHERE id = $3`,
        [new Date().toISOString(), `merged-into:${plan.winnerId}`, loserId]
      );
    }

    // Demote any duplicate is_primary contact left on the winner after
    // re-pointing — cosmetic cleanup, not required for correctness (nothing
    // enforces uniqueness here), but avoids two "primary" contacts sitting
    // side by side on the surviving customer.
    await client.query(
      `UPDATE crm_contact_persons SET is_primary = 0
       WHERE customer_id = $1 AND is_primary = 1
         AND id NOT IN (SELECT id FROM crm_contact_persons WHERE customer_id = $1 AND is_primary = 1 ORDER BY created_at ASC LIMIT 1)`,
      [plan.winnerId]
    );

    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO audit_logs (id, timestamp, user_email, action, target, severity, details_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuidv4(), now, actorEmail, "CUSTOMER_MERGED", `crm_customer:${plan.winnerId}`, "Warning",
        JSON.stringify({ winnerId: plan.winnerId, winnerName: plan.winnerName, loserIds: plan.loserIds, matchedOn: plan.matchedOn, rowCounts: plan.rowCounts }),
        now,
      ]
    );

    await client.query("COMMIT");
    return { ...plan, status: "merged" };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ...plan, status: "error", error: e?.message || String(e) };
  } finally {
    client.release();
  }
}

export async function executeAllMerges(actorEmail: string): Promise<MergeResult[]> {
  const plans = await planAllMerges();
  const results: MergeResult[] = [];
  for (const plan of plans) {
    results.push(await executeMerge(plan, actorEmail));
  }
  invalidateCustomerCaches();
  return results;
}
