import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun, pgExec } from "../db.js";
import { repriceBankFinancedForLead } from "../services/retailQuoteAutomation.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, buildCustomerOwnershipFilter, isIndividualSalesRole } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField, decryptField, maskValue } from "../services/cryptoService.js";
import { cacheDeleteByPrefix, cacheGetOrSet } from "../utils/cache.js";
import { IdGenerator } from "../utils/idGenerator.js";
import { buildCsv, sendCsv } from "../utils/csv.js";
import { getByPhoneRows, invalidateCustomerCaches, CachedRow } from "../services/customerCacheService.js";
import { findDuplicateCustomers, findDuplicateCustomersLive } from "../services/customerDedupeService.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

const CUSTOMER_LIST_TTL_MS = 30_000;

// ── Ensure vehicles table exists ──────────────────────────────────────────────
// Migrate crm_customers: add affiliate partner + segment columns if not present
setTimeout(async () => {
  for (const col of ["affiliate_partner_id TEXT", "affiliate_partner_name TEXT", "segment TEXT", "secondary_partner_id TEXT", "secondary_partner_name TEXT", "fleet_size INTEGER"]) {
    await pgExec(`ALTER TABLE crm_customers ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
}, 1500);

pgExec(`
  CREATE TABLE IF NOT EXISTS crm_customer_vehicles (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    -- Nullable: an unregistered vehicle (registration_known = FALSE) is keyed on its
    -- chassis/VIN and carries no plate until one is issued.
    registration VARCHAR(50),
    registration_known BOOLEAN NOT NULL DEFAULT TRUE,
    make VARCHAR(100),
    model VARCHAR(200),
    model_number VARCHAR(100),
    body_type VARCHAR(50),
    color VARCHAR(50),
    year_of_manufacture INTEGER,
    chassis_number VARCHAR(100),
    engine_number VARCHAR(100),
    notes TEXT,
    created_by_user_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
  )
`).catch(e => console.error("[vehicles] table init failed:", e));

// Corporate Lead Redesign Phase 4 — loose traceability back to the originating
// lead (nullable, same style as the existing partner_id), for Stage Two batch
// vehicle capture off vehicle-register.html.
setTimeout(async () => {
  await pgExec(`ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS lead_id TEXT`).catch(() => {});
  // Registered (plate) vs unregistered (chassis only). Also relax the legacy NOT NULL
  // on registration so an unregistered vehicle can be stored without a plate.
  await pgExec(`ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS registration_known BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
  await pgExec(`ALTER TABLE crm_customer_vehicles ALTER COLUMN registration DROP NOT NULL`).catch(() => {});
  // Motor vehicle / motorcycle / tractor / tuktuk / special_equipment — mirrors
  // vehicle_specs.vehicle_category in the separate finemark_vehicles DB, lets
  // the make/model picker narrow to the right catalog subset for this vehicle.
  await pgExec(`ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS vehicle_category TEXT NOT NULL DEFAULT 'motor_vehicle'`).catch(() => {});
  // Extended vehicle-detail fields edited from Vehicle 360 / the registry form.
  // These were referenced by the /vehicles PATCH whitelist and the edit form, but
  // the columns were never added — so any edit that included one of them made the
  // whole UPDATE fail ("column does not exist") and silently didn't save.
  for (const col of [
    "trim TEXT", "vin TEXT", "status TEXT", "fuel_type TEXT", "transmission TEXT",
    "odometer NUMERIC", "insurance_details TEXT", "insurance_expiry TEXT",
    "ntsa_status TEXT", "fleet_number TEXT", "asset_code TEXT",
  ]) {
    await pgExec(`ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
}, 1500);

// ── Account number generator ─────────────────────────────────────────────────
function nextAccountNo(_type: string): string {
  return IdGenerator.generateId("customer");
}

// ── ABAC helper ───────────────────────────────────────────────────────────────
// buildCustomerOwnershipFilter/isIndividualSalesRole now live in
// ../middleware/rbac.ts — vehicles.ts had the exact same filter duplicated
// (it joins crm_customers to reach a vehicle's owner), so both now share one
// copy instead.
const buildAbacFilter = buildCustomerOwnershipFilter;

// ── Mappers ───────────────────────────────────────────────────────────────────
function mapCustomer(row: any) {
  return {
    id: row.id,
    accountNo: row.account_no,
    type: row.type,
    status: row.status,
    segment: row.segment || null,
    accountManagerId: row.account_manager_id,
    accountManagerEmail: row.account_manager_email,
    region: row.region,
    source: row.source,
    notes: row.notes,
    affiliatePartnerId: row.affiliate_partner_id,
    affiliatePartnerName: row.affiliate_partner_name,
    secondaryPartnerId: row.secondary_partner_id || null,
    secondaryPartnerName: row.secondary_partner_name || null,
    fleetSize: row.fleet_size ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // joined profile
    displayName: row.display_name || null,
  };
}

function decryptIndividual(row: any, masked = false) {
  const dec = masked ? maskValue : ((v: any) => decryptField(v) || "—");
  return {
    fullName: row.full_name,
    nationalId: dec(row.national_id_enc),
    passportNo: dec(row.passport_no_enc),
    kraPin: dec(row.kra_pin_enc),
    phone: dec(row.phone_enc),
    email: dec(row.email_enc),
    address: dec(row.address_enc),
    industry: row.industry,
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
  };
}

function decryptCorporate(row: any, masked = false) {
  const dec = masked ? maskValue : ((v: any) => decryptField(v) || "—");
  return {
    companyName: row.company_name,
    regNumber: dec(row.reg_number_enc),
    kraPin: dec(row.kra_pin_enc),
    industry: row.industry,
    physicalAddress: row.physical_address,
    website: row.website,
  };
}

function decryptContact(row: any, masked = false) {
  const dec = masked ? maskValue : ((v: any) => decryptField(v) || "—");
  return {
    id: row.id,
    name: row.name,
    roleLabel: row.role_label,
    phone: dec(row.phone_enc),
    email: dec(row.email_enc),
    isPrimary: !!row.is_primary,
    isBilling: !!row.is_billing,
    isOperations: !!row.is_operations,
    isConcierge: !!row.is_concierge,
    selfNominatedAt: row.self_nominated_at || null,
    createdAt: row.created_at,
  };
}

// ── List customers ─────────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const { search, type, status, region, accountManagerId, industry, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;

    const abac = buildAbacFilter(req.user!);
    const conditions: string[] = ["c.deleted_at IS NULL"];
    const params: any[] = [...abac.params];

    if (abac.clause) conditions.push(abac.clause);
    if (type) { conditions.push("c.type = ?"); params.push(type); }
    if (status) { conditions.push("c.status = ?"); params.push(status); }
    if (region) { conditions.push("c.region ILIKE ?"); params.push(`%${region}%`); }
    if (accountManagerId) { conditions.push("c.account_manager_id = ?"); params.push(accountManagerId); }
    if (industry) { conditions.push("(ind.industry ILIKE ? OR corp.industry ILIKE ?)"); params.push(`%${industry}%`, `%${industry}%`); }
    if (search) {
      conditions.push(`(c.account_no ILIKE ? OR ind.full_name ILIKE ? OR corp.company_name ILIKE ?)`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const cacheKey = `customers:list:${req.user!.id}:${req.user!.role}:${JSON.stringify({ search: search || "", type: type || "", status: status || "", region: region || "", accountManagerId: accountManagerId || "", industry: industry || "", page: pageNum, pageSize: sizeNum })}`;
    const payload = await cacheGetOrSet(cacheKey, CUSTOMER_LIST_TTL_MS, async () => {
      const rows = await pgAll(
        `SELECT c.*,
                u.email AS account_manager_email,
                COALESCE(ind.full_name, corp.company_name) AS display_name
         FROM crm_customers c
         LEFT JOIN users u ON u.id = c.account_manager_id
         LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
         LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
         ${where}
         ORDER BY c.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, sizeNum, offset]
      );

      const totalRow = await pgGet(
        `SELECT COUNT(*) AS total
         FROM crm_customers c
         LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
         LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
         ${where}`,
        params
      );

      return { data: rows.map(mapCustomer), meta: { total: Number(totalRow?.total ?? 0) } };
    });

    return ok(res, payload);
  }
);

// ── Search customers by phone number / name ───────────────────────────────────
// Uses an in-memory TTL cache so repeated typeahead keystrokes don't re-hit DB.
router.get(
  "/by-phone",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const q = ((req.query.q as string) || "").trim().replace(/\s+/g, "");
    if (q.length < 2) return ok(res, { data: [] });

    const allRows = await getByPhoneRows();
    const ql = q.toLowerCase();
    const qu = q.toUpperCase();
    const matches: CachedRow[] = [];
    for (const row of allRows) {
      const phoneMatch = row.phone.includes(q);
      const nameMatch  = row.displayName.toLowerCase().includes(ql);
      const emailMatch = row.email.toLowerCase().includes(ql);
      const regMatch   = !!row.vehicleRegs && row.vehicleRegs.includes(qu); // vehicle plate
      if (phoneMatch || nameMatch || regMatch || (q.length >= 4 && emailMatch)) {
        matches.push(row);
      }
      if (matches.length >= 20) break;
    }
    // Set cache-control so browser won't re-send identical requests
    res.set("Cache-Control", "private, max-age=30");
    return ok(res, { data: matches });
  }
);

// ── Register customer ──────────────────────────────────────────────────────────
router.post(
  "/register",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const { type, region, source, segment, notes, accountManagerId, individual, corporate, contacts, affiliatePartnerId, secondaryPartnerId, overrideDuplicate } = req.body;

    if (!type || !["individual", "corporate"].includes(type)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "type must be 'individual' or 'corporate'");
    }
    if (type === "individual" && !individual?.fullName) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "individual.fullName is required");
    }
    if (type === "corporate" && !corporate?.companyName) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "corporate.companyName is required");
    }

    // Duplicate check (name + phone, or name + email) — a human is filling
    // this form, so unlike the automated lead-submission/conversion flows
    // this blocks with the match details and requires an explicit
    // overrideDuplicate=true to proceed, rather than silently linking to the
    // existing customer (the operator may genuinely mean two different
    // people who happen to share a name and number, e.g. a shared office line).
    if (!overrideDuplicate) {
      const dupMatches = await findDuplicateCustomersLive({
        name: type === "individual" ? individual?.fullName : corporate?.companyName,
        phone: type === "individual" ? individual?.phone : corporate?.phone,
        email: type === "individual" ? individual?.email : corporate?.email,
      });
      if (dupMatches.length) {
        return errorResponse(res, 409, "DUPLICATE_CUSTOMER", "A customer with this name and phone/email already exists.", { matches: dupMatches });
      }
    }

    const now = new Date().toISOString();
    const customerId = uuidv4();
    const accountNo = nextAccountNo(type);

    // Resolve primary affiliate partner name
    let affiliatePartnerName: string | null = null;
    if (affiliatePartnerId) {
      const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [affiliatePartnerId]);
      affiliatePartnerName = p?.name ?? null;
    }
    // Resolve secondary partner name
    let secondaryPartnerName: string | null = null;
    if (secondaryPartnerId) {
      const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [secondaryPartnerId]);
      secondaryPartnerName = p?.name ?? null;
    }

    await pgRun(
      `INSERT INTO crm_customers (id, account_no, type, status, segment, account_manager_id, region, source, notes, affiliate_partner_id, affiliate_partner_name, secondary_partner_id, secondary_partner_name, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [customerId, accountNo, type, segment || null, accountManagerId || req.user!.id, region || null, source || null, notes || null,
       affiliatePartnerId || null, affiliatePartnerName, secondaryPartnerId || null, secondaryPartnerName, req.user!.id, now, now]
    );

    if (type === "individual" && individual) {
      const { fullName, nationalId, passportNo, kraPin, phone, email, address, industry, dateOfBirth, gender } = individual;
      await pgRun(
        `INSERT INTO crm_individual_profiles
           (id, customer_id, full_name, full_name_enc, national_id_enc, passport_no_enc, kra_pin_enc, phone_enc, email_enc, address_enc, industry, date_of_birth, gender, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), customerId, fullName,
          encryptField(fullName),
          encryptField(nationalId),
          encryptField(passportNo),
          encryptField(kraPin),
          encryptField(phone),
          encryptField(email),
          encryptField(address),
          industry || null, dateOfBirth || null, gender || null, now, now,
        ]
      );
    }

    if (type === "corporate" && corporate) {
      const { companyName, regNumber, kraPin, industry, physicalAddress, website, phone, email } = corporate;
      await pgRun(
        `INSERT INTO crm_corporate_profiles
           (id, customer_id, company_name, reg_number_enc, kra_pin_enc, industry, physical_address, website, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), customerId, companyName,
          encryptField(regNumber),
          encryptField(kraPin),
          industry || null, physicalAddress || null, website || null, now, now,
        ]
      );
      // crm_corporate_profiles has no phone/email columns — contact info always
      // lives in crm_contact_persons. Without this, the Phone/Email fields
      // already shown on this form are silently discarded. Skipped when the
      // caller separately supplied their own primary contact, to avoid a
      // duplicate-primary conflict.
      const hasManualPrimary = Array.isArray(contacts) && contacts.some((c: any) => c.isPrimary);
      if (!hasManualPrimary && (phone || email)) {
        await pgRun(
          `INSERT INTO crm_contact_persons (id, customer_id, name, phone_enc, email_enc, is_primary, is_billing, is_operations, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
          [uuidv4(), customerId, companyName, encryptField(phone), encryptField(email), now, now]
        );
      }
    }

    // Insert contact persons (works for both types)
    if (Array.isArray(contacts) && contacts.length > 0) {
      for (const c of contacts) {
        await pgRun(
          `INSERT INTO crm_contact_persons (id, customer_id, name, role_label, phone_enc, email_enc, is_primary, is_billing, is_operations, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), customerId, c.name, c.roleLabel || null,
            encryptField(c.phone), encryptField(c.email),
            c.isPrimary ? 1 : 0, c.isBilling ? 1 : 0, c.isOperations ? 1 : 0,
            now, now,
          ]
        );
      }
    }

    invalidateCustomerCaches();

    const customer = await pgGet("SELECT * FROM crm_customers WHERE id = ?", [customerId]);
    auditLog(req, "CRM_CUSTOMER_REGISTERED", `crm_customer:${customerId}`, "Info", { accountNo, type }).catch(console.error);
    return created(res, { customer: mapCustomer({ ...customer, display_name: individual?.fullName || corporate?.companyName }) }, "Customer registered");
  }
);

// ── Vehicle lookup by registration plate ──────────────────────────────────────
router.get(
  "/vehicles/lookup",
  requireAuth,
    requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "Technical", "Technician", "InstallOffice"]),
  async (req: AuthRequest, res) => {
    // Find a registered vehicle by registration, chassis, or both (either identifier
    // locates the same physical vehicle). Used by the certificate flow to enforce
    // registry-only generation and to detect duplicate vehicle records.
    const rawReg     = (req.query.registration as string || "").trim();
    const rawChassis = (req.query.chassis as string || "").trim();
    if (!rawReg && !rawChassis) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "registration or chassis query param required");
    }
    const normReg     = rawReg     ? rawReg.toUpperCase().replace(/[\s-]/g, "")  : null;
    const normChassis = rawChassis ? rawChassis.toUpperCase().replace(/\s+/g, "") : null;

    const conds: string[] = [];
    const params: any[] = [];
    if (normReg)     { conds.push("UPPER(REPLACE(REPLACE(v.registration,' ',''),'-','')) = ?"); params.push(normReg); }
    if (normChassis) { conds.push("UPPER(REPLACE(v.chassis_number,' ','')) = ?");               params.push(normChassis); }

    const row = await pgGet(
      `SELECT v.*,
              c.id AS cust_id, c.account_no, c.type AS cust_type,
              ind.full_name, ind.phone_enc, ind.email_enc,
              corp.company_name,
              p.name AS partner_name
       FROM crm_customer_vehicles v
       JOIN crm_customers c ON c.id = v.customer_id AND c.deleted_at IS NULL
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles  corp ON corp.customer_id = c.id
       LEFT JOIN partners p ON p.id::text = v.partner_id::text AND p.deleted_at IS NULL
       WHERE (${conds.join(" OR ")})
         AND v.deleted_at IS NULL
       ORDER BY v.created_at DESC
       LIMIT 1`,
      params
    );

    if (!row) return ok(res, { found: false });

    return ok(res, {
      found: true,
      vehicle: {
        id: row.id,
        vehicleNo: row.vehicle_no,
        registration: row.registration,
        make: row.make,
        model: row.model,
        modelNumber: row.model_number,
        bodyType: row.body_type,
        color: row.color,
        yearOfManufacture: row.year_of_manufacture,
        chassisNumber: row.chassis_number,
        engineNumber: row.engine_number,
        vehicleCategory: row.vehicle_category,
        partnerId: row.partner_id != null ? String(row.partner_id) : null,
        partnerName: row.partner_name || null,
      },
      customer: {
        id: row.cust_id,
        accountNo: row.account_no,
        type: row.cust_type,
        name: row.full_name || row.company_name || "—",
        phone: decryptField(row.phone_enc) || "—",
        email: decryptField(row.email_enc) || "—",
      },
    });
  }
);

// ── Account managers list (for filter dropdown) ────────────────────────────────
router.get(
  "/account-managers",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate"]),
  async (_req: AuthRequest, res) => {
    const rows = await pgAll(
      `SELECT DISTINCT u.id, u.email, u.name
       FROM users u
       INNER JOIN crm_customers c ON c.account_manager_id = u.id
       WHERE c.deleted_at IS NULL
       ORDER BY u.name ASC`,
      []
    );
    return ok(res, { data: rows.map(r => ({ id: r.id, name: r.name || r.email, email: r.email })) });
  }
);

// ── Get single customer ────────────────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "Technical", "TeamLead", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const abac = buildAbacFilter(req.user!);
    const row = await pgGet(
      `SELECT c.*, u.email AS account_manager_email,
              COALESCE(ind.full_name, corp.company_name) AS display_name
       FROM crm_customers c
       LEFT JOIN users u ON u.id = c.account_manager_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       WHERE c.id = ? AND c.deleted_at IS NULL ${abac.clause ? "AND " + abac.clause : ""}`,
      [req.params.id, ...abac.params]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");
    return ok(res, mapCustomer(row));
  }
);

// ── 360° view ─────────────────────────────────────────────────────────────────
router.get(
  "/:id/360",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "Technical", "TeamLead", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const customerId = req.params.id;
    const abac = buildAbacFilter(req.user!);
    const isMasked = req.user!.role === "Support"; // Support sees masked PII

    const customer = await pgGet(
      `SELECT c.*, u.email AS account_manager_email
       FROM crm_customers c
       LEFT JOIN users u ON u.id = c.account_manager_id
       WHERE c.id = ? AND c.deleted_at IS NULL ${abac.clause ? "AND " + abac.clause : ""}`,
      [customerId, ...abac.params]
    );
    if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");

    const [
      individualProfile, corporateProfile, contacts,
      subscriptions, devices, tickets, commLogs,
      invoices, certificates, campaignMemberships, vehicleRows,
    ] = await Promise.all([
      pgGet("SELECT * FROM crm_individual_profiles WHERE customer_id = ?", [customerId]),
      pgGet("SELECT * FROM crm_corporate_profiles WHERE customer_id = ?", [customerId]),
      pgAll("SELECT * FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at", [customerId]),
      pgAll("SELECT * FROM crm_subscriptions WHERE customer_id = ? ORDER BY created_at DESC", [customerId]),
      pgAll("SELECT * FROM crm_devices WHERE customer_id = ? ORDER BY created_at DESC", [customerId]),
      pgAll("SELECT t.*, u.email AS assignee_email FROM crm_tickets t LEFT JOIN users u ON u.id = t.assigned_to_user_id WHERE t.customer_id = ? ORDER BY t.created_at DESC LIMIT 20", [customerId]),
      pgAll("SELECT * FROM crm_communication_logs WHERE customer_id = ? ORDER BY contacted_at DESC LIMIT 20", [customerId]),
      pgAll("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20", [customerId]),
      pgAll(
        // Certificates for this customer — linked by the certificate's own customer /
        // vehicle FK (populated at generation), or matched to any of the customer's
        // vehicles by registration or chassis for older records.
        `SELECT DISTINCT c.id, c.serial_no, c.system_type, c.car_registration, c.model,
                c.date, c.name, c.color, c.phone, c.start_date, c.end_date,
                c.loan_duration_years, c.imei_1, c.imei_2, c.tracker_no_1, c.tracker_no_2,
                c.created_by_email, c.created_at,
                c.is_extension, c.extension_no, c.root_cert_id, c.extended_from_cert_id,
                c.prior_start_date, c.prior_end_date, c.extended_at
         FROM certificates c
         WHERE c.deleted_at IS NULL
           AND ( c.customer_id = ?
              OR c.crm_vehicle_id IN (SELECT id FROM crm_customer_vehicles WHERE customer_id = ? AND deleted_at IS NULL)
              OR EXISTS (
                   SELECT 1 FROM crm_customer_vehicles v
                    WHERE v.customer_id = ? AND v.deleted_at IS NULL
                      AND ( NULLIF(REPLACE(UPPER(TRIM(c.car_registration)),' ',''),'') = NULLIF(REPLACE(UPPER(TRIM(v.registration)),' ',''),'')
                         OR NULLIF(REPLACE(UPPER(TRIM(c.chassis_number)),' ',''),'')   = NULLIF(REPLACE(UPPER(TRIM(v.chassis_number)),' ',''),'') ) ) )
         ORDER BY c.created_at DESC LIMIT 50`,
        [customerId, customerId, customerId]
      ),
      pgAll("SELECT cm.*, ca.name AS campaign_name, ca.type AS campaign_type FROM crm_campaign_members cm JOIN crm_campaigns ca ON ca.id = cm.campaign_id WHERE cm.customer_id = ? ORDER BY cm.created_at DESC LIMIT 10", [customerId]),
      pgAll(`SELECT v.*, p.name AS partner_name FROM crm_customer_vehicles v LEFT JOIN partners p ON p.id = v.partner_id WHERE v.customer_id = ? AND v.deleted_at IS NULL ORDER BY v.created_at DESC`, [customerId]),
    ]);

    // installedDevices must run after profiles resolve so we can also match by customer_name
    // (installation_tickets.customer_id may differ from crm_customers.id across identity spaces)
    const customerDisplayName = individualProfile?.full_name || corporateProfile?.company_name || '';
    const installedDeviceRows = await pgAll(
      `SELECT DISTINCT
         i.id, i.serial_number, i.imei, i.sim_phone, i.status AS item_status, i.deployed_at,
         p.product_name, p.device_model, p.product_code,
         t.id AS ticket_id, t.ticket_no, t.vehicle_registration, t.vehicle_id,
         t.status AS ticket_status, t.vi_installation_id, t.created_at AS ticket_created_at
       FROM installation_tickets t
       JOIN inv_items i ON (t.assigned_device_id = i.id OR t.id = i.installation_id)
       JOIN inv_product_catalog p ON p.id = i.product_id
       WHERE (t.customer_id = ? OR (? <> '' AND t.customer_name = ?))
         AND t.deleted_at IS NULL AND i.deleted_at IS NULL
       ORDER BY i.deployed_at DESC NULLS LAST, t.created_at DESC`,
      [customerId, customerDisplayName, customerDisplayName]
    );

    const profile = individualProfile
      ? decryptIndividual(individualProfile, isMasked)
      : corporateProfile
        ? decryptCorporate(corporateProfile, isMasked)
        : null;

    return ok(res, {
      customer: mapCustomer({ ...customer, display_name: individualProfile?.full_name || corporateProfile?.company_name }),
      profile,
      contacts: contacts.map((c: any) => decryptContact(c, isMasked)),
      subscriptions: subscriptions.map((s: any) => ({
        id: s.id, serviceType: s.service_type, planName: s.plan_name,
        status: s.status, startDate: s.start_date, endDate: s.end_date,
        monthlyFee: s.monthly_fee, currency: s.currency,
        renewalReminderDays: s.renewal_reminder_days, notes: s.notes,
        createdAt: s.created_at,
      })),
      devices: devices.map((d: any) => ({
        id: d.id, imei: d.imei, serialNo: d.serial_no, deviceType: d.device_type,
        model: d.model, status: d.status, location: d.location, installedAt: d.installed_at,
        linkedCertificateId: d.linked_certificate_id, notes: d.notes, createdAt: d.created_at,
      })),
      installedDevices: installedDeviceRows.map((r: any) => ({
        id: r.id, serialNumber: r.serial_number, imei: r.imei, simPhone: r.sim_phone,
        status: r.item_status, deployedAt: r.deployed_at,
        productName: r.product_name, deviceModel: r.device_model, productCode: r.product_code,
        ticketId: r.ticket_id, ticketNo: r.ticket_no,
        vehicleRegistration: r.vehicle_registration, vehicleId: r.vehicle_id,
        ticketStatus: r.ticket_status, viInstallationId: r.vi_installation_id,
      })),
      tickets: tickets.map((t: any) => ({
        id: t.id, ticketNo: t.ticket_no, subject: t.subject, category: t.category,
        priority: t.priority, status: t.status, assigneeEmail: t.assignee_email,
        openedAt: t.opened_at, resolvedAt: t.resolved_at, closedAt: t.closed_at,
      })),
      communicationLogs: commLogs.map((l: any) => ({
        id: l.id, channel: l.channel, direction: l.direction, subject: l.subject,
        body: isMasked ? "[restricted]" : decryptField(l.body_enc),
        byEmail: l.by_user_email, contactName: l.contact_name, contactedAt: l.contacted_at,
      })),
      invoices: invoices.map((i: any) => ({
        id: i.id, invoiceNumber: i.invoice_number, amount: i.amount,
        currency: i.currency, status: i.status, issuedOn: i.issued_on, dueOn: i.due_on,
      })),
      certificates: certificates.map((c: any) => {
        const today = new Date().toISOString().slice(0, 10);
        const in60 = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);
        const status = !c.end_date ? "Unknown"
          : c.end_date < today ? "Expired"
          : c.end_date <= in60 ? "NearingExpiry"
          : "Active";
        return {
          id: c.id, serialNo: c.serial_no, systemType: c.system_type,
          carRegistration: c.car_registration, model: c.model, date: c.date,
          name: c.name, color: c.color, phone: c.phone,
          startDate: c.start_date, endDate: c.end_date,
          loanDurationYears: c.loan_duration_years,
          imei1: c.imei_1, imei2: c.imei_2,
          trackerNo1: c.tracker_no_1, trackerNo2: c.tracker_no_2,
          createdByEmail: c.created_by_email, createdAt: c.created_at, status,
          isExtension: !!c.is_extension,
          extensionNo: Number(c.extension_no || 0),
          rootCertId: c.root_cert_id || null,
          extendedFromCertId: c.extended_from_cert_id || null,
          priorStartDate: c.prior_start_date || null,
          priorEndDate: c.prior_end_date || null,
          extendedAt: c.extended_at || null,
        };
      }),
      campaignMemberships: campaignMemberships.map((cm: any) => ({
        campaignId: cm.campaign_id, campaignName: cm.campaign_name,
        campaignType: cm.campaign_type, status: cm.status, sentAt: cm.sent_at, outcome: cm.outcome,
      })),      vehicles: vehicleRows.map((v: any) => ({
        id: v.id, vehicleNo: v.vehicle_no, registration: v.registration, registrationKnown: v.registration_known !== false, make: v.make, model: v.model,
        modelNumber: v.model_number, bodyType: v.body_type, color: v.color,
        yearOfManufacture: v.year_of_manufacture, chassisNumber: v.chassis_number,
        engineNumber: v.engine_number, notes: v.notes, createdAt: v.created_at,
        partnerId: v.partner_id, partnerName: v.partner_name || null,
        loanTenureMonths: v.loan_tenure_months, loanStartDate: v.loan_start_date,
        vehicleCategory: v.vehicle_category,
      })),    });
  }
);

// ── Update customer ────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const now = new Date().toISOString();
    const { status, region, source, notes, accountManagerId, individual, corporate, affiliatePartnerId, secondaryPartnerId, segment } = req.body;
    const row = await pgGet("SELECT * FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");

    // ABAC: individual-contributor sales reps can only update their own assigned customers
    if (isIndividualSalesRole(req.user!.role) && row.account_manager_id !== req.user!.id) {
      return errorResponse(res, 403, "FORBIDDEN", "Not your assigned customer");
    }

    // Resolve affiliate partner name when partnerId provided
    let affiliatePartnerName: string | null | undefined = undefined;
    if (affiliatePartnerId !== undefined) {
      if (affiliatePartnerId) {
        const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [affiliatePartnerId]);
        affiliatePartnerName = p?.name ?? null;
      } else {
        affiliatePartnerName = null; // clearing the partner
      }
    }
    // Resolve secondary partner name
    let secondaryPartnerName: string | null | undefined = undefined;
    if (secondaryPartnerId !== undefined) {
      if (secondaryPartnerId) {
        const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [secondaryPartnerId]);
        secondaryPartnerName = p?.name ?? null;
      } else {
        secondaryPartnerName = null;
      }
    }

    const setClauses: string[] = [
      "status = COALESCE(?, status)",
      "region = COALESCE(?, region)",
      "source = COALESCE(?, source)",
      "notes = COALESCE(?, notes)",
      "account_manager_id = COALESCE(?, account_manager_id)",
    ];
    const updateParams: any[] = [status || null, region || null, source || null, notes || null, accountManagerId || null];

    if (segment !== undefined) {
      setClauses.push("segment = ?::text");
      updateParams.push(segment || null);
    }
    if (affiliatePartnerId !== undefined) {
      setClauses.push("affiliate_partner_id = ?::text", "affiliate_partner_name = ?::text");
      updateParams.push(affiliatePartnerId || null, affiliatePartnerName ?? null);
    }
    if (secondaryPartnerId !== undefined) {
      setClauses.push("secondary_partner_id = ?::text", "secondary_partner_name = ?::text");
      updateParams.push(secondaryPartnerId || null, secondaryPartnerName ?? null);
    }

    setClauses.push("updated_at = ?");
    updateParams.push(now, req.params.id);

    await pgRun(
      `UPDATE crm_customers SET ${setClauses.join(", ")} WHERE id = ?`,
      updateParams
    );

    if (individual && row.type === "individual") {
      const { fullName, nationalId, passportNo, kraPin, phone, email, address, industry, dateOfBirth, gender } = individual;
      await pgRun(
        `UPDATE crm_individual_profiles SET
         full_name = COALESCE(?, full_name),
         full_name_enc = COALESCE(?, full_name_enc),
         national_id_enc = COALESCE(?, national_id_enc),
         passport_no_enc = COALESCE(?, passport_no_enc),
         kra_pin_enc = COALESCE(?, kra_pin_enc),
         phone_enc = COALESCE(?, phone_enc),
         email_enc = COALESCE(?, email_enc),
         address_enc = COALESCE(?, address_enc),
         industry = COALESCE(?, industry),
         date_of_birth = COALESCE(?, date_of_birth),
         gender = COALESCE(?, gender),
         updated_at = ?
         WHERE customer_id = ?`,
        [
          fullName || null, fullName ? encryptField(fullName) : null,
          nationalId ? encryptField(nationalId) : null,
          passportNo ? encryptField(passportNo) : null,
          kraPin ? encryptField(kraPin) : null,
          phone ? encryptField(phone) : null,
          email ? encryptField(email) : null,
          address ? encryptField(address) : null,
          industry || null, dateOfBirth || null, gender || null, now, req.params.id,
        ]
      );
    }

    if (corporate && row.type === "corporate") {
      const { companyName, regNumber, kraPin, industry, physicalAddress, website, phone, email } = corporate;
      await pgRun(
        `UPDATE crm_corporate_profiles SET
         company_name = COALESCE(?, company_name),
         reg_number_enc = COALESCE(?, reg_number_enc),
         kra_pin_enc = COALESCE(?, kra_pin_enc),
         industry = COALESCE(?, industry),
         physical_address = COALESCE(?, physical_address),
         website = COALESCE(?, website),
         updated_at = ?
         WHERE customer_id = ?`,
        [
          companyName || null,
          regNumber ? encryptField(regNumber) : null,
          kraPin ? encryptField(kraPin) : null,
          industry || null, physicalAddress || null, website || null, now, req.params.id,
        ]
      );
      // Upsert primary contact phone/email if provided
      if (phone || email) {
        const existing = await pgGet(
          "SELECT id, name FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at LIMIT 1",
          [req.params.id]
        ).catch(() => null);
        if (existing) {
          await pgRun(
            `UPDATE crm_contact_persons SET
             phone_enc = COALESCE(?, phone_enc),
             email_enc = COALESCE(?, email_enc),
             is_primary = 1, updated_at = ?
             WHERE id = ?`,
            [phone ? encryptField(phone) : null, email ? encryptField(email) : null, now, existing.id]
          );
        } else {
          const corp = await pgGet("SELECT company_name FROM crm_corporate_profiles WHERE customer_id = ?", [req.params.id]).catch(() => null);
          await pgRun(
            `INSERT INTO crm_contact_persons (id, customer_id, name, role_label, phone_enc, email_enc, is_primary, is_billing, is_operations, created_at, updated_at)
             VALUES (?,?,?,?,?,?,1,1,0,?,?)`,
            [uuidv4(), req.params.id,
             corp?.company_name || "Primary Contact",
             "Primary Contact",
             encryptField(phone || null),
             encryptField(email || null),
             now, now]
          );
        }
      }
    }

    // Propagate a renamed customer to the denormalized name copies on operational
    // records (retail leads + installation tickets), so lists that read those stay in
    // sync with the profile. Documents (quotes/proformas/invoices) are intentionally
    // left as issued.
    const newName = (individual && row.type === "individual" ? individual.fullName : null)
                 || (corporate && row.type === "corporate" ? corporate.companyName : null);
    if (newName && String(newName).trim()) {
      const nm = String(newName).trim();
      await pgRun(`UPDATE retail_leads SET customer_name = ?, updated_at = ? WHERE customer_id = ?`, [nm, now, req.params.id]).catch(() => {});
      await pgRun(`UPDATE installation_tickets SET customer_name = ?, updated_at = ? WHERE customer_id = ? AND deleted_at IS NULL`, [nm, now, req.params.id]).catch(() => {});
    }

    // Same rationale for the contact phone/email: the retail leads grid, its search,
    // and reports read the denormalized retail_leads.customer_phone / customer_email,
    // so an edited profile phone/email must be mirrored there or those lists go stale.
    // (installation_tickets.installation_contact_phone is the on-site contact — a
    // potentially different person — and is deliberately NOT overwritten here.)
    const newPhone = (individual && row.type === "individual" ? individual.phone : null)
                  || (corporate && row.type === "corporate" ? corporate.phone : null);
    if (newPhone && String(newPhone).trim()) {
      await pgRun(`UPDATE retail_leads SET customer_phone = ?, updated_at = ? WHERE customer_id = ?`, [String(newPhone).trim(), now, req.params.id]).catch(() => {});
    }
    const newEmail = (individual && row.type === "individual" ? individual.email : null)
                  || (corporate && row.type === "corporate" ? corporate.email : null);
    if (newEmail && String(newEmail).trim()) {
      await pgRun(`UPDATE retail_leads SET customer_email = ?, updated_at = ? WHERE customer_id = ?`, [String(newEmail).trim(), now, req.params.id]).catch(() => {});
    }

    auditLog(req, "CRM_CUSTOMER_UPDATED", `crm_customer:${req.params.id}`, "Info", { status, region }).catch(console.error);
    invalidateCustomerCaches();
    const updated = await pgGet("SELECT * FROM crm_customers WHERE id = ?", [req.params.id]);
    return ok(res, mapCustomer(updated), "Customer updated");
  }
);

// ── Soft delete customer ───────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const now = new Date().toISOString();
    const row = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");
    await pgRun(
      "UPDATE crm_customers SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?",
      [now, req.user!.id, now, req.params.id]
    );
    invalidateCustomerCaches();
    auditLog(req, "CRM_CUSTOMER_DELETED", `crm_customer:${req.params.id}`, "Warning", {}).catch(console.error);
    return ok(res, { id: req.params.id }, "Customer deleted");
  }
);

// ── Contacts ───────────────────────────────────────────────────────────────────
router.get("/:id/contacts", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const isMasked = req.user!.role === "Support";
  const rows = await pgAll("SELECT * FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC", [req.params.id]);
  return ok(res, rows.map((r: any) => decryptContact(r, isMasked)));
});

router.post("/:id/contacts", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  const { name, roleLabel, phone, email, isPrimary, isBilling, isOperations, isConcierge } = req.body;
  if (!name) return errorResponse(res, 400, "VALIDATION_ERROR", "name is required");
  const cust = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");
  const id = uuidv4();
  await pgRun(
    `INSERT INTO crm_contact_persons (id, customer_id, name, role_label, phone_enc, email_enc, is_primary, is_billing, is_operations, is_concierge, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.params.id, name, roleLabel || null, encryptField(phone), encryptField(email),
     isPrimary ? 1 : 0, isBilling ? 1 : 0, isOperations ? 1 : 0, isConcierge ? 1 : 0, now, now]
  );
  invalidateCustomerCaches();
  const row = await pgGet("SELECT * FROM crm_contact_persons WHERE id = ?", [id]);
  auditLog(req, "CRM_CONTACT_ADDED", `crm_contact:${id}`, "Info", { name, isConcierge }).catch(console.error);
  return created(res, decryptContact(row, false), "Contact added");
});

router.patch("/:id/contacts/:contactId", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  const { name, roleLabel, phone, email, isPrimary, isBilling, isOperations, isConcierge } = req.body;
  const row = await pgGet("SELECT * FROM crm_contact_persons WHERE id = ? AND customer_id = ?", [req.params.contactId, req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Contact not found");
  await pgRun(
    `UPDATE crm_contact_persons SET
       name            = COALESCE(?, name),
       role_label      = COALESCE(?, role_label),
       phone_enc       = COALESCE(?, phone_enc),
       email_enc       = COALESCE(?, email_enc),
       is_primary      = COALESCE(?, is_primary),
       is_billing      = COALESCE(?, is_billing),
       is_operations   = COALESCE(?, is_operations),
       is_concierge    = COALESCE(?, is_concierge),
       updated_at      = ?
     WHERE id = ?`,
    [
      name ?? null, roleLabel ?? null,
      phone !== undefined ? encryptField(phone) : null,
      email !== undefined ? encryptField(email) : null,
      isPrimary  !== undefined ? (isPrimary  ? 1 : 0) : null,
      isBilling  !== undefined ? (isBilling  ? 1 : 0) : null,
      isOperations !== undefined ? (isOperations ? 1 : 0) : null,
      isConcierge  !== undefined ? (isConcierge  ? 1 : 0) : null,
      now, req.params.contactId,
    ]
  );
  invalidateCustomerCaches();
  const updated = await pgGet("SELECT * FROM crm_contact_persons WHERE id = ?", [req.params.contactId]);
  auditLog(req, "CRM_CONTACT_UPDATED", `crm_contact:${req.params.contactId}`, "Info", { isConcierge }).catch(console.error);
  return ok(res, decryptContact(updated, false), "Contact updated");
});

router.delete("/:id/contacts/:contactId", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT id FROM crm_contact_persons WHERE id = ? AND customer_id = ?", [req.params.contactId, req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Contact not found");
  await pgRun("DELETE FROM crm_contact_persons WHERE id = ?", [req.params.contactId]);
  invalidateCustomerCaches();
  auditLog(req, "CRM_CONTACT_DELETED", `crm_contact:${req.params.contactId}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Contact removed");
});

// ── Subscriptions ──────────────────────────────────────────────────────────────
router.get("/:id/subscriptions", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Finance", "Operations", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const rows = await pgAll("SELECT * FROM crm_subscriptions WHERE customer_id = ? ORDER BY created_at DESC", [req.params.id]);
  return ok(res, rows.map((s: any) => ({
    id: s.id, serviceType: s.service_type, planName: s.plan_name, status: s.status,
    startDate: s.start_date, endDate: s.end_date, monthlyFee: s.monthly_fee, currency: s.currency,
    renewalReminderDays: s.renewal_reminder_days, notes: s.notes, createdAt: s.created_at,
  })));
});

router.post("/:id/subscriptions", requireAuth, requireRole(["Admin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Finance", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  const { serviceType, planName, startDate, endDate, monthlyFee, currency, linkedInstallationId, linkedCertificateId, renewalReminderDays, notes } = req.body;
  if (!serviceType || !planName || !startDate) return errorResponse(res, 400, "VALIDATION_ERROR", "serviceType, planName and startDate are required");
  const id = uuidv4();
  await pgRun(
    `INSERT INTO crm_subscriptions (id, customer_id, service_type, plan_name, status, start_date, end_date, monthly_fee, currency, linked_installation_id, linked_certificate_id, renewal_reminder_days, notes, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.params.id, serviceType, planName, startDate, endDate || null, monthlyFee || null, currency || "KES", linkedInstallationId || null, linkedCertificateId || null, renewalReminderDays || 30, notes || null, req.user!.id, now, now]
  );
  const row = await pgGet("SELECT * FROM crm_subscriptions WHERE id = ?", [id]);
  auditLog(req, "CRM_SUBSCRIPTION_ADDED", `crm_subscription:${id}`, "Info", { serviceType, planName }).catch(console.error);
  return created(res, { id: row.id, serviceType: row.service_type, planName: row.plan_name, status: row.status }, "Subscription added");
});

// ── Devices ────────────────────────────────────────────────────────────────────
router.get("/:id/devices", requireAuth, requireRole(["Admin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Operations"]), async (req: AuthRequest, res) => {
  const rows = await pgAll("SELECT * FROM crm_devices WHERE customer_id = ? ORDER BY created_at DESC", [req.params.id]);
  return ok(res, rows.map((d: any) => ({
    id: d.id, imei: d.imei, serialNo: d.serial_no, deviceType: d.device_type, model: d.model,
    status: d.status, installedAt: d.installed_at, location: d.location,
    linkedCertificateId: d.linked_certificate_id, notes: d.notes, createdAt: d.created_at,
  })));
});

router.post("/:id/devices", requireAuth, requireRole(["Admin", "Sales", "CorporateSales", "Operations"]), async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  const { imei, serialNo, deviceType, model, installedAt, location, linkedCertificateId, linkedInstallationId, notes } = req.body;
  if (!deviceType) return errorResponse(res, 400, "VALIDATION_ERROR", "deviceType is required");
  const id = uuidv4();
  await pgRun(
    `INSERT INTO crm_devices (id, customer_id, imei, serial_no, device_type, model, status, linked_certificate_id, linked_installation_id, installed_at, location, notes, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.params.id, imei || null, serialNo || null, deviceType, model || null, linkedCertificateId || null, linkedInstallationId || null, installedAt || null, location || null, notes || null, req.user!.id, now, now]
  );
  auditLog(req, "CRM_DEVICE_ADDED", `crm_device:${id}`, "Info", { imei, deviceType }).catch(console.error);
  const row = await pgGet("SELECT * FROM crm_devices WHERE id = ?", [id]);
  return created(res, { id: row.id, imei: row.imei, deviceType: row.device_type, status: row.status }, "Device added");
});

// ── Vehicle CRUD ──────────────────────────────────────────────────────────────
// List vehicles
router.get("/:id/vehicles", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate", "Technical"]), async (req: AuthRequest, res) => {
  const rows = await pgAll(
    `SELECT v.*, p.name AS partner_name
     FROM crm_customer_vehicles v
     LEFT JOIN partners p ON p.id = v.partner_id
     WHERE v.customer_id = ? AND v.deleted_at IS NULL
     ORDER BY v.created_at DESC`,
    [req.params.id]
  );
  return ok(res, rows.map((v: any) => ({
    id: v.id, registration: v.registration, registrationKnown: v.registration_known !== false,
    make: v.make, model: v.model,
    modelNumber: v.model_number, bodyType: v.body_type, color: v.color,
    yearOfManufacture: v.year_of_manufacture, chassisNumber: v.chassis_number,
    engineNumber: v.engine_number, notes: v.notes, createdAt: v.created_at,
    partnerId: v.partner_id, partnerName: v.partner_name || null,
    loanTenureMonths: v.loan_tenure_months, loanStartDate: v.loan_start_date,
    vehicleCategory: v.vehicle_category,
  })));
});

// Add vehicle
router.post("/:id/vehicles", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate", "Operations"]), async (req: AuthRequest, res) => {
  const { registration, registrationKnown, make, model, modelNumber, bodyType, color, yearOfManufacture, chassisNumber, engineNumber, notes, partnerId, loanTenureMonths, loanStartDate, vehicleCategory } = req.body;
  // A registered vehicle is identified by its number plate (registration required);
  // an unregistered one by its chassis/VIN (chassis required, no plate stored yet).
  const isRegistered = registrationKnown !== false;
  const normReg = registration ? String(registration).replace(/\s+/g, '').toUpperCase() : null;
  const normChassis = chassisNumber ? String(chassisNumber).trim().toUpperCase() : null;
  if (isRegistered && !normReg) return errorResponse(res, 400, "VALIDATION_ERROR", "Registration is required for a registered vehicle");
  if (!isRegistered && !normChassis) return errorResponse(res, 400, "VALIDATION_ERROR", "Chassis number is required for an unregistered vehicle");
  const customer = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");

  // Duplicate guard — never create a second vehicle record for a plate/chassis that
  // already exists (any customer). One canonical vehicle per plate is what stops the
  // duplicate-vehicle problem (and duplicate certificates) from recurring.
  const dupConds: string[] = [];
  const dupParams: any[] = [];
  if (normReg)     { dupConds.push("UPPER(REPLACE(REPLACE(registration,' ',''),'-','')) = ?"); dupParams.push(normReg); }
  if (normChassis) { dupConds.push("UPPER(REPLACE(chassis_number,' ','')) = ?");               dupParams.push(normChassis); }
  if (dupConds.length) {
    const existing = await pgGet(
      `SELECT id, vehicle_no, registration, chassis_number, customer_id
         FROM crm_customer_vehicles WHERE (${dupConds.join(" OR ")}) AND deleted_at IS NULL LIMIT 1`,
      dupParams
    );
    if (existing) {
      const byReg = !!(normReg && String(existing.registration || "").replace(/[\s-]/g, "").toUpperCase() === normReg);
      const sameCustomer = existing.customer_id === req.params.id;
      return errorResponse(res, 409, "DUPLICATE_VEHICLE",
        `A vehicle with this ${byReg ? "registration" : "chassis number"} is already registered${sameCustomer ? " under this customer" : " (under a different customer)"}.`,
        { existingVehicleId: existing.id, existingCustomerId: existing.customer_id, sameCustomer });
    }
  }

  const now = new Date().toISOString();
  const id = uuidv4();
  const vehicleNo = IdGenerator.generateId("vehicle");
  await pgRun(
    `INSERT INTO crm_customer_vehicles
       (id, vehicle_no, customer_id, registration, registration_known, make, model, model_number, body_type, color, year_of_manufacture, chassis_number, engine_number, notes, partner_id, loan_tenure_months, loan_start_date, vehicle_category, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, vehicleNo, req.params.id, isRegistered ? normReg : null, isRegistered, make || null, model || null, modelNumber || null, bodyType || null, color || null, yearOfManufacture || null, normChassis, engineNumber || null, notes || null, partnerId || null, loanTenureMonths ? Number(loanTenureMonths) : null, loanStartDate || null, vehicleCategory || "motor_vehicle", req.user!.id, now, now]
  );
  invalidateCustomerCaches();
  auditLog(req, "CRM_VEHICLE_ADDED", `crm_vehicle:${id}`, "Info", { registration, make, model }).catch(console.error);
  const row = await pgGet("SELECT * FROM crm_customer_vehicles WHERE id = ?", [id]);
  return created(res, { id: row.id, vehicleNo: row.vehicle_no, registration: row.registration, make: row.make, model: row.model }, "Vehicle added");
});

// ─── BULK VEHICLE REGISTRATION (CSV) ─────────────────────────────────────────
// Registering vehicles one form at a time does not scale for a customer bringing
// in a fleet. The template below is the contract: the same columns the import
// reads, with the rules written into the file itself so whoever fills it in
// doesn't have to be told them separately.

const VEHICLE_CSV_COLUMNS = [
  "registration", "chassis_number", "make", "model", "model_number", "body_type",
  "color", "year_of_manufacture", "engine_number", "vehicle_category",
  "partner_name", "loan_tenure_months", "loan_start_date", "notes",
] as const;

const VEHICLE_CATEGORIES = ["motor_vehicle", "motorcycle", "tractor", "trailers", "tuktuk", "special_equipment"];

/** GET /crm/customers/vehicles/template.csv — the fill-in guide + examples. */
router.get("/vehicles/template.csv", requireAuth, async (_req: AuthRequest, res) => {
  const rows = [
    // Two worked examples: a registered vehicle and one still on chassis only.
    { registration: "KDA123A", chassis_number: "JTEHA20V500123456", make: "Toyota", model: "Land Cruiser",
      model_number: "VDJ76", body_type: "SUV", color: "White", year_of_manufacture: "2019",
      engine_number: "1VD0012345", vehicle_category: "motor_vehicle", partner_name: "NCBA BANK KENYA PLC",
      loan_tenure_months: "36", loan_start_date: "2026-01-15", notes: "Example row — delete before uploading" },
    { registration: "", chassis_number: "MR0HA3CD900234567", make: "Isuzu", model: "D-Max",
      model_number: "", body_type: "PICK UP", color: "Silver", year_of_manufacture: "2024",
      engine_number: "", vehicle_category: "motor_vehicle", partner_name: "",
      loan_tenure_months: "", loan_start_date: "", notes: "Not yet plated — chassis only. Delete before uploading" },
  ];
  const guide = [
    "# HOW TO FILL THIS TEMPLATE",
    "# 1. Delete the two example rows below the header before uploading.",
    "# 2. One vehicle per row. Only registration OR chassis_number is required:",
    "#    - plated vehicle  -> put the number plate in registration (spaces are ignored)",
    "#    - not yet plated  -> leave registration empty and fill chassis_number",
    "# 3. A plate or chassis already in the system is skipped and reported back, never duplicated.",
    `# 4. vehicle_category must be one of: ${VEHICLE_CATEGORIES.join(", ")} (blank = motor_vehicle).`,
    "# 5. partner_name must match a partner already on file (blank = Private / none).",
    "# 6. loan_start_date format YYYY-MM-DD. loan_tenure_months is a whole number of months.",
    "# 7. Keep the header row exactly as it is. Extra columns are ignored.",
    "# Lines starting with # are ignored by the importer.",
  ].join("\n");
  const csv = `${guide}\n${buildCsv([...VEHICLE_CSV_COLUMNS], rows as any)}`;
  return sendCsv(res, "vehicle-registration-template.csv", csv);
});

/**
 * POST /crm/customers/:id/vehicles/import — register many vehicles for one
 * customer from the filled-in template. Every row is checked the same way the
 * single-vehicle form checks it (plate-or-chassis required, duplicate guard
 * across ALL customers), and each row's outcome is reported back: a bad row
 * never stops the good ones.
 */
router.post("/:id/vehicles/import", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate", "Operations"]), async (req: AuthRequest, res) => {
  const csvText = String((req.body || {}).csv || "");
  if (!csvText.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "Upload the filled-in CSV template.");
  const customer = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");

  // Minimal CSV reader: quoted fields, embedded commas, CRLF, and '#' guide lines.
  const parseLine = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  if (lines.length < 2) return errorResponse(res, 400, "EMPTY_CSV", "The file has a header but no vehicle rows.");
  const header = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  if (!header.includes("registration") && !header.includes("chassis_number")) {
    return errorResponse(res, 400, "BAD_HEADER", "The header row must keep the template's column names (registration, chassis_number, …).");
  }
  const dataLines = lines.slice(1);
  if (dataLines.length > 500) return errorResponse(res, 400, "TOO_MANY_ROWS", `${dataLines.length} rows — upload 500 or fewer at a time.`);

  const partners = await pgAll<any>("SELECT id, name FROM partners").catch(() => []);
  const partnerByName = new Map(partners.map((p) => [String(p.name).trim().toLowerCase(), p.id]));
  const results: any[] = [];
  const seen = new Set<string>();   // catches duplicates WITHIN the file too
  let added = 0;

  for (let n = 0; n < dataLines.length; n++) {
    const cells = parseLine(dataLines[n]);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    const line = n + 2;   // the row number as the person sees it in their editor
    const rawReg = row.registration || "";
    const normReg = rawReg ? rawReg.replace(/\s+/g, "").toUpperCase() : null;
    const normChassis = row.chassis_number ? row.chassis_number.trim().toUpperCase() : null;
    const label = normReg || normChassis || "(blank row)";
    const fail = (reason: string) => results.push({ line, vehicle: label, status: "Skipped", reason });

    if (!normReg && !normChassis) { fail("No registration and no chassis number — one is required."); continue; }
    const category = (row.vehicle_category || "").trim().toLowerCase() || "motor_vehicle";
    if (!VEHICLE_CATEGORIES.includes(category)) { fail(`vehicle_category "${row.vehicle_category}" is not one of: ${VEHICLE_CATEGORIES.join(", ")}`); continue; }
    let partnerId: string | null = null;
    if (row.partner_name && row.partner_name.trim()) {
      partnerId = partnerByName.get(row.partner_name.trim().toLowerCase()) ?? null;
      if (!partnerId) { fail(`partner_name "${row.partner_name}" does not match any partner on file.`); continue; }
    }
    const year = row.year_of_manufacture && row.year_of_manufacture.trim() ? Number(row.year_of_manufacture) : null;
    if (year !== null && (!Number.isFinite(year) || year < 1950 || year > new Date().getFullYear() + 1)) { fail(`year_of_manufacture "${row.year_of_manufacture}" is not a sensible year.`); continue; }
    const tenure = row.loan_tenure_months && row.loan_tenure_months.trim() ? Number(row.loan_tenure_months) : null;
    if (tenure !== null && (!Number.isInteger(tenure) || tenure <= 0)) { fail(`loan_tenure_months "${row.loan_tenure_months}" must be a whole number of months.`); continue; }
    if (row.loan_start_date && row.loan_start_date.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(row.loan_start_date.trim())) { fail(`loan_start_date "${row.loan_start_date}" must be YYYY-MM-DD.`); continue; }

    const key = normReg ? `R:${normReg}` : `C:${normChassis}`;
    if (seen.has(key)) { fail("The same vehicle appears earlier in this file."); continue; }
    seen.add(key);

    // Same duplicate guard as the single-vehicle form: one canonical vehicle per plate.
    const dupConds: string[] = []; const dupParams: any[] = [];
    if (normReg)     { dupConds.push("UPPER(REPLACE(REPLACE(registration,' ',''),'-','')) = ?"); dupParams.push(normReg); }
    if (normChassis) { dupConds.push("UPPER(REPLACE(chassis_number,' ','')) = ?");               dupParams.push(normChassis); }
    const existing = await pgGet<any>(
      `SELECT id, registration, customer_id FROM crm_customer_vehicles WHERE (${dupConds.join(" OR ")}) AND deleted_at IS NULL LIMIT 1`,
      dupParams
    );
    if (existing) {
      results.push({ line, vehicle: label, status: "Skipped",
        reason: existing.customer_id === req.params.id ? "Already registered under this customer." : "Already registered under a different customer.",
        existingVehicleId: existing.id });
      continue;
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const vehicleNo = IdGenerator.generateId("vehicle");
    await pgRun(
      `INSERT INTO crm_customer_vehicles
         (id, vehicle_no, customer_id, registration, registration_known, make, model, model_number, body_type, color, year_of_manufacture, chassis_number, engine_number, notes, partner_id, loan_tenure_months, loan_start_date, vehicle_category, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, vehicleNo, req.params.id, normReg, !!normReg, row.make || null, row.model || null, row.model_number || null,
       row.body_type || null, row.color || null, year, normChassis, row.engine_number || null, row.notes || null,
       partnerId, tenure, row.loan_start_date?.trim() || null, category, req.user!.id, now, now]
    );
    added++;
    results.push({ line, vehicle: label, status: "Registered", vehicleId: id, vehicleNo });
  }

  if (added) invalidateCustomerCaches();
  auditLog(req, "CRM_VEHICLES_IMPORTED", `crm_customer:${req.params.id}`, "Info",
    { rows: dataLines.length, added, skipped: dataLines.length - added }).catch(console.error);
  // ok(res, data, message) already wraps as { data, message } — wrapping again
  // here buried the counts one level deeper and the UI summary read zeros.
  return ok(res, { added, skipped: dataLines.length - added, total: dataLines.length, results },
    `${added} of ${dataLines.length} vehicle(s) registered.`);
});

// Update vehicle
router.put("/:id/vehicles/:vid", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate", "Operations"]), async (req: AuthRequest, res) => {
  const { registration, registrationKnown, make, model, modelNumber, bodyType, color, yearOfManufacture, chassisNumber, engineNumber, notes, partnerId, loanTenureMonths, loanStartDate, vehicleCategory } = req.body;
  const row = await pgGet("SELECT id, vehicle_category, registration, chassis_number, registration_known FROM crm_customer_vehicles WHERE id = ? AND customer_id = ? AND deleted_at IS NULL", [req.params.vid, req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found");
  // Registered → keyed on plate (registration required); unregistered → keyed on chassis.
  // When the client omits registrationKnown, keep the vehicle's existing status.
  const isRegistered = registrationKnown === undefined ? (row.registration_known !== false) : (registrationKnown !== false);
  const normReg = registration ? String(registration).replace(/\s+/g, '').toUpperCase() : null;
  const normChassis = chassisNumber ? String(chassisNumber).trim().toUpperCase() : null;
  const effReg = isRegistered ? (normReg || row.registration) : null;
  const effChassis = normChassis !== null ? normChassis : row.chassis_number;
  if (isRegistered && !effReg) return errorResponse(res, 400, "VALIDATION_ERROR", "Registration is required for a registered vehicle");
  if (!isRegistered && !effChassis) return errorResponse(res, 400, "VALIDATION_ERROR", "Chassis number is required for an unregistered vehicle");
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE crm_customer_vehicles SET
       registration=?, registration_known=?, make=?, model=?, model_number=?, body_type=?, color=?,
       year_of_manufacture=?, chassis_number=?, engine_number=?, notes=?,
       partner_id=?, loan_tenure_months=?, loan_start_date=?, vehicle_category=?, updated_at=?
     WHERE id=?`,
    [effReg, isRegistered,
     make || null, model || null, modelNumber || null, bodyType || null, color || null,
     yearOfManufacture || null, effChassis, engineNumber || null, notes || null,
     partnerId || null, loanTenureMonths ? Number(loanTenureMonths) : null, loanStartDate || null,
     vehicleCategory || row.vehicle_category || "motor_vehicle",
     now, req.params.vid]
  );
  // Harmonize the loan term end-to-end: the retail lead's captured vehicle (which the
  // Retail Leads list reads) is kept aligned with the customer vehicle registration.
  await pgRun(
    `UPDATE retail_lead_vehicles SET loan_term_months = ? WHERE vehicle_id = ?`,
    [loanTenureMonths != null && loanTenureMonths !== "" ? Number(loanTenureMonths) : null, req.params.vid]
  ).catch(() => {});
  // Loan term changed → re-price any bank-financed quote (+ proforma + UNPAID invoice)
  // for leads on this vehicle, so the price follows the new term instead of staying
  // frozen at the original. Fire-and-forget; never blocks the vehicle save.
  if (loanTenureMonths != null && loanTenureMonths !== "") {
    (async () => {
      const leadsForVeh = await pgAll<any>(`SELECT DISTINCT lead_id FROM retail_lead_vehicles WHERE vehicle_id = ? AND lead_id IS NOT NULL`, [req.params.vid]).catch(() => [] as any[]);
      for (const l of leadsForVeh) {
        const r = await repriceBankFinancedForLead(l.lead_id).catch((e) => { console.error("[reprice] failed:", e?.message); return null; });
        if (r?.repriced) console.log(`[reprice] ${r.quoteNo}: ${r.oldTotal} → ${r.newTotal} @ ${r.term}mo`);
      }
    })();
  }
  // Harmonize the registration end-to-end: a vehicle first captured as "Not Registered"
  // (chassis only) shows its chassis on the Retail Leads list until the plate is added.
  // Propagate the newly-entered plate to the lead's vehicle + the installation ticket
  // (normReg computed above). Only runs when a plate was actually provided.
  if (normReg) {
    await pgRun(
      `UPDATE retail_lead_vehicles SET registration = ?, registration_known = TRUE WHERE vehicle_id = ?`,
      [normReg, req.params.vid]
    ).catch(() => {});
    await pgRun(
      `UPDATE installation_tickets SET vehicle_registration = ?, updated_at = ? WHERE vehicle_id = ? AND deleted_at IS NULL`,
      [normReg, now, req.params.vid]
    ).catch(() => {});
  }
  invalidateCustomerCaches();
  auditLog(req, "CRM_VEHICLE_UPDATED", `crm_vehicle:${req.params.vid}`, "Info", { registration, make, model }).catch(console.error);
  return ok(res, null, "Vehicle updated");
});

// Remove vehicle (soft delete)
router.delete("/:id/vehicles/:vid", requireAuth, requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "BDM", "BDMCorporate", "Operations"]), async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  const row = await pgGet("SELECT id FROM crm_customer_vehicles WHERE id = ? AND customer_id = ? AND deleted_at IS NULL", [req.params.vid, req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found");
  await pgRun("UPDATE crm_customer_vehicles SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, req.params.vid]);
  invalidateCustomerCaches();
  auditLog(req, "CRM_VEHICLE_REMOVED", `crm_vehicle:${req.params.vid}`, "Info", {}).catch(console.error);
  return ok(res, null, "Vehicle removed");
});

// ── Summary stats ──────────────────────────────────────────────────────────────
router.get("/stats/summary", requireAuth, requireRole(["Admin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Finance", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const abac = buildAbacFilter(req.user!);
  const abacWhere = abac.clause ? `AND ${abac.clause}` : "";
  const abacParams = abac.params;
  const [total, indv, corp, active, expiringSoon] = await Promise.all([
    pgGet(`SELECT COUNT(*) AS n FROM crm_customers c WHERE c.deleted_at IS NULL ${abacWhere}`, abacParams),
    pgGet(`SELECT COUNT(*) AS n FROM crm_customers c WHERE c.type='individual' AND c.deleted_at IS NULL ${abacWhere}`, abacParams),
    pgGet(`SELECT COUNT(*) AS n FROM crm_customers c WHERE c.type='corporate' AND c.deleted_at IS NULL ${abacWhere}`, abacParams),
    pgGet(`SELECT COUNT(*) AS n FROM crm_customers c WHERE c.status='Active' AND c.deleted_at IS NULL ${abacWhere}`, abacParams),
    pgGet(`SELECT COUNT(*) AS n FROM crm_subscriptions WHERE status='Active' AND end_date IS NOT NULL AND end_date <= ?`, [new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)]),
  ]);
  return ok(res, {
    total: Number(total?.n ?? 0),
    individual: Number(indv?.n ?? 0),
    corporate: Number(corp?.n ?? 0),
    active: Number(active?.n ?? 0),
    subscriptionsExpiringSoon: Number(expiringSoon?.n ?? 0),
  });
});

// ── Analytics dashboard ───────────────────────────────────────────────────────
router.get("/stats/analytics", requireAuth, requireRole(["Admin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Finance", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const abac = buildAbacFilter(req.user!);
  const abacWhere = abac.clause ? `AND ${abac.clause}` : "";
  const abacParams = abac.params;
  const [byRegion, byMonth, byIndustry, vehicleLeaderboard] = await Promise.all([
    pgAll(
      `SELECT COALESCE(c.region,'Unknown') AS label, COUNT(*) AS n
       FROM crm_customers c WHERE c.deleted_at IS NULL ${abacWhere}
       GROUP BY label ORDER BY n DESC LIMIT 20`,
      abacParams
    ),
    pgAll(
      `SELECT SUBSTRING(c.created_at, 1, 7) AS label, COUNT(*) AS n
       FROM crm_customers c WHERE c.deleted_at IS NULL AND c.created_at IS NOT NULL ${abacWhere}
       GROUP BY label ORDER BY label ASC`,
      abacParams
    ),
    pgAll(
      `SELECT COALESCE(i.industry, corp.industry, 'Unknown') AS label, COUNT(*) AS n
       FROM crm_customers c
       LEFT JOIN crm_individual_profiles  i    ON i.customer_id    = c.id
       LEFT JOIN crm_corporate_profiles   corp ON corp.customer_id = c.id
       WHERE c.deleted_at IS NULL ${abacWhere}
       GROUP BY label ORDER BY n DESC LIMIT 15`,
      abacParams
    ),
    pgAll(
      `SELECT c.id, c.account_no,
              COALESCE(i.full_name, corp.company_name) AS name,
              COUNT(v.id) AS n
       FROM crm_customer_vehicles v
       JOIN  crm_customers c              ON c.id = v.customer_id
                                         AND c.deleted_at IS NULL
                                         AND v.deleted_at IS NULL
       LEFT JOIN crm_individual_profiles  i    ON i.customer_id    = c.id
       LEFT JOIN crm_corporate_profiles   corp ON corp.customer_id = c.id
       WHERE 1=1 ${abacWhere}
       GROUP BY c.id, c.account_no, name
       ORDER BY n DESC LIMIT 10`,
      abacParams
    ),
  ]);

  return ok(res, {
    byRegion:           byRegion.map(r => ({ label: r.label, count: Number(r.n) })),
    byMonth:            byMonth.map(r => ({ label: r.label, count: Number(r.n) })),
    byIndustry:         byIndustry.map(r => ({ label: r.label, count: Number(r.n) })),
    vehicleLeaderboard: vehicleLeaderboard.map(r => ({
      id:       r.id,
      accountNo: r.account_no,
      name:     r.name || r.account_no,
      count:    Number(r.n),
    })),
  });
});

// ── Customer document upload setup ───────────────────────────────────────────
const CUST_DOCS_DIR = path.resolve(process.cwd(), "uploads/lead-attachments");
fs.mkdirSync(CUST_DOCS_DIR, { recursive: true });

const custDocStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CUST_DOCS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const custDocUpload = multer({
  storage: custDocStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type ${file.mimetype} not allowed`));
  },
});

pgRun(`
  CREATE TABLE IF NOT EXISTS customer_documents (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    doc_type    TEXT NOT NULL,
    label       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    notes       TEXT,
    file_name   TEXT,
    file_path   TEXT,
    file_size   INTEGER,
    mime_type   TEXT,
    uploaded_by TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )
`).catch(console.error);
// Vehicle-specific documents (Log Book, Loan Offer Letter, NTSA Form) carry the
// crm_customer_vehicles id they belong to; customer-level docs leave it NULL.
pgRun(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS vehicle_id TEXT`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_customer_documents_vehicle ON customer_documents(vehicle_id)`, []).catch(() => {});

// ── GET /:id/documents ────────────────────────────────────────────────────────
router.get(
  "/:id/documents",
  requireAuth,
  async (req: AuthRequest, res) => {
    const cust = await pgGet(`SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");
    const rows = await pgAll(
      `SELECT * FROM customer_documents WHERE customer_id = ? ORDER BY created_at ASC`,
      [req.params.id]
    );
    return ok(res, {
      data: rows.map((r: any) => ({
        id: r.id,
        customerId: r.customer_id,
        vehicleId: r.vehicle_id || null,
        docType: r.doc_type,
        label: r.label,
        status: r.status,
        notes: r.notes,
        fileName: r.file_name,
        filePath: r.file_path,
        fileSize: r.file_size,
        mimeType: r.mime_type,
        uploadedBy: r.uploaded_by,
        createdAt: r.created_at,
      })),
    });
  }
);

// ── GET /:id/certificates ─────────────────────────────────────────────────────
// Certificates generated for this customer — linked via certificates.customer_id, or
// via any of the customer's registered vehicles (crm_vehicle_id) for completeness.
router.get(
  "/:id/certificates",
  requireAuth,
  requireRole(["Admin", "CertAdmin", "Sales", "CorporateSales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const cust = await pgGet(`SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");
    const rows = await pgAll(
      `SELECT c.id, c.serial_no, c.template, c.system_type, c.car_registration, c.chassis_number,
              c.model, c.name, c.start_date, c.end_date, c.created_at
         FROM certificates c
        WHERE c.deleted_at IS NULL
          AND ( c.customer_id = ?
             OR c.crm_vehicle_id IN (SELECT id FROM crm_customer_vehicles WHERE customer_id = ? AND deleted_at IS NULL) )
        ORDER BY c.created_at DESC`,
      [req.params.id, req.params.id]
    );
    return ok(res, rows.map((r: any) => ({
      id: r.id, serialNo: r.serial_no, template: r.template || "finemark", systemType: r.system_type,
      carRegistration: r.car_registration, chassisNumber: r.chassis_number, model: r.model, name: r.name,
      startDate: r.start_date, endDate: r.end_date, createdAt: r.created_at,
    })));
  }
);

// ── POST /:id/documents ───────────────────────────────────────────────────────
router.post(
  "/:id/documents",
  requireAuth,
  requireRole(["Admin", "Sales", "CorporateSales", "BDM", "BDMCorporate", "Finance", "FieldSales", "Telesales"]),
  custDocUpload.single("file") as any,
  async (req: AuthRequest, res) => {
    const cust = await pgGet(`SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");

    const { docType, label, notes, status, vehicleId } = req.body;
    if (!docType?.trim() || !label?.trim())
      return errorResponse(res, 400, "VALIDATION_ERROR", "docType and label are required");

    // Vehicle-specific documents must reference a real vehicle belonging to this customer.
    let vehId: string | null = null;
    if (vehicleId?.trim()) {
      const veh = await pgGet(
        `SELECT id FROM crm_customer_vehicles WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [vehicleId.trim(), req.params.id]
      );
      if (!veh) return errorResponse(res, 400, "VALIDATION_ERROR", "vehicleId does not belong to this customer.");
      vehId = veh.id;
    }

    const file = req.file as Express.Multer.File | undefined;
    const id   = uuidv4();
    const now  = new Date().toISOString();
    const docStatus = file ? "attached" : (status?.trim() || "collected");

    await pgRun(
      `INSERT INTO customer_documents
         (id, customer_id, vehicle_id, doc_type, label, status, notes, file_name, file_path, file_size, mime_type, uploaded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.params.id, vehId, docType.trim(), label.trim(), docStatus,
        notes?.trim() || null,
        file?.originalname || null,
        file ? `/uploads/lead-attachments/${file.filename}` : null,
        file?.size || null,
        file?.mimetype || null,
        req.user!.email, now, now,
      ]
    );

    auditLog(req, "CUSTOMER_DOCUMENT_UPLOADED", `customer:${req.params.id}`, "Info", { docType, label }).catch(console.error);
    // A Log Book / NTSA attach changes certificate readiness — refresh the cert dashboard.
    cacheDeleteByPrefix("certificates:dashboard:");
    const row = await pgGet("SELECT * FROM customer_documents WHERE id = ?", [id]);
    return created(res, { data: row }, "Document recorded");
  }
);

// ── DELETE /:id/documents/:docId ──────────────────────────────────────────────
router.delete(
  "/:id/documents/:docId",
  requireAuth,
  requireRole(["Admin", "Sales", "CorporateSales", "BDM", "BDMCorporate"]),
  async (req: AuthRequest, res) => {
    const doc = await pgGet(
      `SELECT * FROM customer_documents WHERE id = ? AND customer_id = ?`,
      [req.params.docId, req.params.id]
    );
    if (!doc) return errorResponse(res, 404, "NOT_FOUND", "Document not found.");
    // Delete physical file if present
    if (doc.file_path) {
      const abs = path.resolve(process.cwd(), doc.file_path.replace(/^\//, ""));
      fs.unlink(abs, () => {});
    }
    await pgRun(`DELETE FROM customer_documents WHERE id = ?`, [req.params.docId]);
    cacheDeleteByPrefix("certificates:dashboard:");
    auditLog(req, "CUSTOMER_DOCUMENT_DELETED", `customer:${req.params.id}`, "Info", { docId: req.params.docId }).catch(console.error);
    return ok(res, { message: "Document deleted." });
  }
);

export default router;
