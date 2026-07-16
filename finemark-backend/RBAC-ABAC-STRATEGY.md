# Finemark Access Control Strategy: RBAC + ABAC

## 1. Overview

Finemark uses a two-layer access control system:

- **RBAC (Role-Based Access Control)** — controls which modules and pages a role can reach.
  Enforced server-side via `requireRole()` middleware on every API route, and client-side via
  page guards that redirect to `/unauthorized.html`.

- **ABAC (Attribute-Based Access Control)** — applies row-level data filtering *within* an
  allowed module. The user's `id`, their assigned customers/partners/leads, and their position
  in the org hierarchy determine which specific records they can see or mutate.

The single source of truth for all role constants, role groups, and ABAC helpers is
`src/middleware/rbac.ts`.

---

## 2. Role Definitions

| Role key (users.role)  | Display Name                   | Status         | Notes                                   |
|------------------------|--------------------------------|----------------|-----------------------------------------|
| `Admin`                | System Administrator           | Existing       | Full unrestricted access                |
| `Executive`            | Executive / Director           | **New**        | Full read + transaction; no sys config  |
| `BDM`                  | Business Development Manager   | **New**        | Full CRM, partners, campaigns           |
| `CorporateSales`       | Corporate Sales                | **New**        | Own customers & leads only (ABAC)       |
| `KAM`                  | Key Account Manager            | **New**        | Partner-scoped CRM visibility (ABAC)    |
| `Telesales`            | Telesales Agent                | Existing       | Assigned leads, quotes, campaigns       |
| `InventoryManager`     | Inventory Manager              | **New**        | Full inventory + device issuance        |
| `Technician`           | Field Technician               | Existing       | Leads to qualification + own tickets    |
| `Technical`            | Installation Support Officer   | Existing       | Technical pipeline + ticket management  |
| `CertAdmin`            | Certificate Administrator      | **New**        | Cert pipeline: generate, edit, deliver  |
| `Finance`              | Finance Team Member            | Existing       | Dashboards, invoices, procurement       |
| `HR`                   | HR Manager                     | Existing       | Full HR module administration           |

### Legacy Role Mapping

| Legacy value  | Maps to (new)      | Action required                                    |
|---------------|--------------------|----------------------------------------------------|
| `Sales`       | `CorporateSales`   | Re-assign after confirming CS vs BDM vs KAM        |
| `Inventory`   | `InventoryManager` | Run migration after confirming with Inventory team |
| `Operations`  | n/a                | Audit existing users; assign closest new role      |
| `CRM`         | n/a                | Audit; likely becomes `BDM` or `CorporateSales`    |
| `Manager`     | Role-specific      | Assign specific functional role                    |
| `Driver`      | n/a                | Not in current role spec; retain or deprecate      |

---

## 3. Module & Page Access Matrix (RBAC)

Legend: `✅` Full access · `✏️` Create/edit own records · `👁` Read-only · `⬛` No access

Module-level ABAC qualifiers are shown in parentheses and detailed in §4.

### 3.1 Admin & System Configuration

| Page                         | Admin | Executive | BDM | CorpSales | KAM | Telesales | InvMgr | Technician | Technical | CertAdmin | Finance | HR  |
|------------------------------|:-----:|:---------:|:---:|:---------:|:---:|:---------:|:------:|:----------:|:---------:|:---------:|:-------:|:---:|
| admin.html                   | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |
| admin-users.html             | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |
| admin-audit-logs.html        | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |
| admin-verification.html      | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |
| settings.html                | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |
| admin-add-speed-governor.html| ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |
| admin-speed-governor-reports | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ⬛         | ⬛       | ⬛   |

### 3.2 Executive Dashboard

| Page                        | Admin | Executive | All others |
|-----------------------------|:-----:|:---------:|:----------:|
| executive-dashboard.html    | ✅    | ✅         | ⬛          |

### 3.3 CRM — Leads & Customers

| Page                    | Admin | Executive | BDM | CorpSales        | KAM                  | Telesales        | InvMgr      | Technician          | Technical | CertAdmin           | Finance             | HR  |
|-------------------------|:-----:|:---------:|:---:|:----------------:|:--------------------:|:----------------:|:-----------:|:-------------------:|:---------:|:-------------------:|:-------------------:|:---:|
| crm-leads.html          | ✅    | 👁         | ✅   | ✏️ (own)         | ✏️ (partner-linked) | ✏️ (own)        | ✏️ (own)    | ✏️ (qual. only)    | ⬛         | ✏️ (qual. only)    | ✏️ (qual. only)    | ⬛   |
| crm-lead-detail.html    | ✅    | 👁         | ✅   | ✏️ (own)         | ✏️ (partner-linked) | ✏️ (own)        | ✏️ (own)    | ✏️ (qual. only)    | ⬛         | ✏️ (qual. only)    | ✏️ (qual. only)    | ⬛   |
| crm-customers.html      | ✅    | 👁         | ✅   | ✏️ (own)         | 👁 (partner-linked) | ⬛               | ⬛           | ⬛                   | ⬛         | ⬛                   | 👁                  | ⬛   |
| crm-customer-360.html   | ✅    | 👁         | ✅   | ✏️ (own)         | 👁 (partner-linked) | ⬛               | ⬛           | ⬛                   | ⬛         | ⬛                   | 👁                  | ⬛   |
| crm-records.html        | ✅    | 👁         | ✅   | 👁 (own)         | 👁 (partner-linked) | ⬛               | ⬛           | ⬛                   | ⬛         | ⬛                   | ⬛                   | ⬛   |

### 3.4 CRM — Quotes, Proforma & Tickets

| Page                    | Admin | Executive | BDM | CorpSales     | KAM               | Telesales     | InvMgr | Technician | Technical | CertAdmin | Finance  | HR  |
|-------------------------|:-----:|:---------:|:---:|:-------------:|:-----------------:|:-------------:|:------:|:----------:|:---------:|:---------:|:--------:|:---:|
| crm-quotes.html         | ✅    | 👁         | ✅   | 👁 (own)      | 👁 (partner)      | 👁 (own)      | ⬛      | ⬛          | ⬛         | ⬛         | ✏️        | ⬛   |
| crm-quote-detail.html   | ✅    | 👁         | ✅   | 👁 (own)      | 👁 (partner)      | 👁 (own)      | ⬛      | ⬛          | ⬛         | ⬛         | ✏️        | ⬛   |
| crm-proforma.html       | ✅    | 👁         | ✅   | 👁 (own)      | 👁 (partner)      | 👁 (own)      | ⬛      | ⬛          | ⬛         | ⬛         | ✏️        | ⬛   |
| crm-tickets.html        | ✅    | ✅ (raise) | ✅   | ✅ (raise)    | ✅ (raise)        | ✅ (raise)    | ⬛      | ⬛          | ⬛         | ⬛         | ⬛         | ⬛   |
| crm-communications.html | ✅    | 👁         | ✅   | ⬛             | ⬛                 | ⬛             | ⬛      | ⬛          | ⬛         | ⬛         | ⬛         | ⬛   |

### 3.5 CRM — Campaigns

| Page                    | Admin | Executive | BDM | CorpSales | KAM | Telesales | All others |
|-------------------------|:-----:|:---------:|:---:|:---------:|:---:|:---------:|:----------:|
| crm-campaigns.html      | ✅    | ⬛         | ✅   | ⬛         | ⬛   | ✅         | ⬛          |
| campaigns-mass-sms.html | ✅    | ⬛         | ✅   | ⬛         | ⬛   | ✅         | ⬛          |

### 3.6 Partners

| Page                    | Admin | Executive | BDM | CorpSales | KAM              | All others |
|-------------------------|:-----:|:---------:|:---:|:---------:|:----------------:|:----------:|
| partners.html           | ✅    | 👁         | ✅   | ⬛         | ✏️ (own only)   | ⬛          |
| partner-detail.html     | ✅    | 👁         | ✅   | ⬛         | ✏️ (own only)   | ⬛          |

### 3.7 Invoices

| Page                    | Admin | Executive | BDM | CorpSales | KAM               | Telesales         | Finance | All others |
|-------------------------|:-----:|:---------:|:---:|:---------:|:-----------------:|:-----------------:|:-------:|:----------:|
| create-invoice.html     | ✅    | 👁         | 👁   | ⬛         | 👁 (partner)      | 👁 (own leads)   | ✅       | ⬛          |
| invoice-detail.html     | ✅    | 👁         | 👁   | ⬛         | 👁 (partner)      | 👁 (own leads)   | ✅       | ⬛          |
| invoice-inventory.html  | ✅    | 👁         | ⬛   | ⬛         | ⬛                 | ⬛                 | ✅       | ⬛          |

### 3.8 Technical & Installations

| Page                       | Admin | Executive | BDM | CorpSales | KAM | Telesales | InvMgr | Technician           | Technical | CertAdmin          | Finance | HR  |
|----------------------------|:-----:|:---------:|:---:|:---------:|:---:|:---------:|:------:|:--------------------:|:---------:|:------------------:|:-------:|:---:|
| technical-dashboard.html   | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛                    | ✅         | ⬛                  | ⬛       | ⬛   |
| technical.html             | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛                    | ✅         | ⬛                  | ⬛       | ⬛   |
| technician.html            | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ✅ (own)             | ✅         | ⬛                  | ⬛       | ⬛   |
| technician-jobs.html       | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ✅ (assigned only)   | ✅         | ⬛                  | ⬛       | ⬛   |
| technician-custody.html    | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ✅      | ✅ (own)             | ⬛         | ⬛                  | ⬛       | ⬛   |
| installation-ticket.html   | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | 👁 (assigned only)  | ✅         | ⬛                  | ⬛       | ⬛   |
| job-card.html              | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ✏️ (own)            | ✅ (close) | ⬛                 | ⬛       | ⬛   |
| job-details.html           | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | 👁 (own)            | ✅         | 👁 (awaiting cert) | ⬛       | ⬛   |
| vehicle-installation.html  | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ✅ (own)             | ✅         | ⬛                  | ⬛       | ⬛   |
| installation-complete.html | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ✅ (own)             | ✅         | ⬛                  | ⬛       | ⬛   |

### 3.9 Certificates

| Page                       | Admin | Executive | BDM | CorpSales | KAM | Telesales | InvMgr | Technician | Technical | CertAdmin | Finance | HR  |
|----------------------------|:-----:|:---------:|:---:|:---------:|:---:|:---------:|:------:|:----------:|:---------:|:---------:|:-------:|:---:|
| certificate-dashboard.html | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| certificate-queue.html     | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| certificate-package.html   | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| certificate-printing.html  | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| certificate-inventory.html | ✅    | 👁         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| certificate-validation.html| ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| create-certificate.html    | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |
| deliver-certificate.html   | ✅    | ⬛         | ⬛   | ⬛         | ⬛   | ⬛         | ⬛      | ⬛          | ⬛         | ✅         | ⬛       | ⬛   |

### 3.10 Inventory

| Page                        | Admin | Executive | BDM | InvMgr | Technician | Technical | Finance      | All others |
|-----------------------------|:-----:|:---------:|:---:|:------:|:----------:|:---------:|:------------:|:----------:|
| inventory-dashboard.html    | ✅    | 👁         | ⬛   | ✅      | ⬛          | 👁         | 👁            | ⬛          |
| inventory-items.html        | ✅    | ⬛         | ⬛   | ✅      | ⬛          | 👁         | 👁 (stock)   | ⬛          |
| inventory-catalog.html      | ✅    | ⬛         | ⬛   | ✅      | ⬛          | ⬛         | 👁 + ✏️ (prices) | ⬛      |
| inventory-procurement.html  | ✅    | ⬛         | ⬛   | ✅      | ⬛          | ⬛         | ✏️ (POs + reqs) | ⬛        |
| inventory-warranty.html     | ✅    | 👁         | ⬛   | ✅      | ⬛          | 👁         | ⬛             | ⬛          |
| admin-gadget-inventory.html | ✅    | ⬛         | ⬛   | ✅      | ⬛          | ⬛         | ⬛             | ⬛          |
| admin-assign-gadgets.html   | ✅    | ⬛         | ⬛   | ✅      | ⬛          | ⬛         | ⬛             | ⬛          |

### 3.11 Finance

| Page                                          | Admin | Executive | Finance | All others |
|-----------------------------------------------|:-----:|:---------:|:-------:|:----------:|
| pages/finance/finance-dashboard.html          | ✅    | 👁         | ✅       | ⬛          |
| pages/finance/finance-invoice-dashboard.html  | ✅    | 👁         | ✅       | ⬛          |
| pages/finance/invoice-followup.html           | ✅    | ⬛         | ✅       | ⬛          |
| pages/finance/financial-reports.html          | ✅    | 👁         | ✅       | ⬛          |
| pages/finance/payment-processing.html         | ✅    | ⬛         | ✅       | ⬛          |
| maker-checker.html                            | ✅    | ⬛         | ✅       | ⬛          |

### 3.12 HR

| Page                       | Admin | Executive | HR  | All (self-service) | Manager (ABAC)          |
|----------------------------|:-----:|:---------:|:---:|:------------------:|:-----------------------:|
| hr-dashboard.html          | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |
| hr-employees.html          | ✅    | 👁         | ✅   | ⬛                  | ⬛                       |
| hr-employee-profile.html   | ✅    | ⬛         | ✅   | 👁 (own profile)  | ⬛                       |
| hr-employee-users.html     | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |
| hr-onboarding.html         | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |
| hr-org.html                | ✅    | 👁         | ✅   | 👁 (read-only)    | ⬛                       |
| hr-benefits.html           | ✅    | ⬛         | ✅   | 👁 (own)          | ⬛                       |
| hr-performance.html        | ✅    | ⬛         | ✅   | 👁 (own)          | 👁 (direct reports)     |
| hr-leave-apply.html        | ✅    | ✅          | ✅   | ✅ (own leave)    | ✅                       |
| hr-leave-approvals.html    | ✅    | ⬛         | ✅   | ⬛                  | ✅ (direct reports only) |
| hr-manager-leave.html      | ✅    | ⬛         | ✅   | ⬛                  | ✅ (direct reports only) |
| hr-leave-calendar.html     | ✅    | ⬛         | ✅   | 👁 (own)          | 👁 (team)               |
| hr-leave-balances.html     | ✅    | ⬛         | ✅   | 👁 (own)          | ⬛                       |
| hr-leave-types.html        | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |
| hr-leave-reports.html      | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |
| hr-reports.html            | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |
| hr-emp-no-config.html      | ✅    | ⬛         | ✅   | ⬛                  | ⬛                       |

### 3.13 Reports

| Page                      | Admin | Executive | Finance | BDM | Technical | All others |
|---------------------------|:-----:|:---------:|:-------:|:---:|:---------:|:----------:|
| report-sales.html         | ✅    | ✅         | 👁       | ✅   | ⬛         | ⬛          |
| report-technical.html     | ✅    | ✅         | ⬛       | ⬛   | ✅         | ⬛          |
| report-gadget-batches.html| ✅    | 👁         | ⬛       | ⬛   | ⬛         | ⬛          |
| report-used-gadgets.html  | ✅    | 👁         | ⬛       | ⬛   | ⬛         | ⬛          |
| report-sim-cards.html     | ✅    | 👁         | ⬛       | ⬛   | ⬛         | ⬛          |

---

## 4. Attribute-Based Access Rules (ABAC)

### 4.1 CRM — Lead & Customer Row-Level Filter

| Role              | SQL filter applied to leads / customers                                                    |
|-------------------|--------------------------------------------------------------------------------------------|
| `Admin`           | None — sees everything                                                                     |
| `Executive`       | None — read-only across all                                                                |
| `BDM`             | None — sees everything                                                                     |
| `Finance`         | None — read-only across all                                                                |
| `CorporateSales`  | `assigned_to = :userId`                                                                    |
| `Telesales`       | `assigned_to = :userId`                                                                    |
| `KAM`             | `partner_id IN (SELECT id FROM partners WHERE key_account_manager_id = :userId)`          |
| `InventoryManager`| `created_by = :userId OR assigned_to = :userId`                                           |
| `Technician`      | `(created_by = :userId OR assigned_to = :userId) AND stage IN ('New','Contacted','Qualified')` |
| `CertAdmin`       | Same as Technician                                                                         |
| `Finance` (create)| Same stage restriction as Technician when creating leads                                  |

### 4.2 Partner Scope (KAM)

KAM users are scoped to partners where `partners.key_account_manager_id = :userId`.

Data that cascades through this scope:

```
partners → leads (via leads.partner_id)
partners → customers (via customers.partner_id)
partners → invoices (via invoices.partner_id)
partners → crm_quotes (via crm_quotes.partner_id)
partners → certificates (via installation_tickets → job → partner)
```

### 4.3 Technician Job & Ticket Scope

| Role        | Filter                                                                  |
|-------------|-------------------------------------------------------------------------|
| `Technician`| `installation_tickets.assigned_to = :userId`                            |
| `Technical` | All tickets visible; can assign to any technician in the roster         |

Technicians access `job-card.html` and `job-details.html` **only** for their own assigned tickets.

### 4.4 Device Custody Scope

| Role              | Filter                                          |
|-------------------|-------------------------------------------------|
| `Technician`      | `device_custody.assigned_to = :userId`          |
| `InventoryManager`| All records                                     |

### 4.5 Certificate Scope

CertAdmin sees:
- All certificates they generated (`certificates.created_by = :userId`)
- All completed jobs awaiting certification: `installation_tickets.status = 'Completed'` with no linked certificate

### 4.6 Finance — Amendment & Pricing Scope

Finance can:
- `GET` all quotes, proforma, and invoices (no row filter)
- `PUT` (amend) any quote, proforma, or invoice
- `PUT` purchase price / sales price on `inventory_catalog`
- `PATCH` / `PUT` purchase orders in `inventory_procurement`
- `GET` requisitions (read-only)

Finance **cannot** advance leads beyond `Qualified` stage.

### 4.7 Leave Approval — Manager ABAC (Cross-Role)

The leave-approval right is **not tied to a specific role**. Any authenticated user who is listed
as a manager in the HR org hierarchy may approve or reject leave for their direct reports.

Backend check pattern:

```sql
-- Is this user a manager?
SELECT COUNT(*) FROM hr_employees
WHERE manager_id = (SELECT id FROM hr_employees WHERE user_account_id = :requestorId);

-- Fetch only direct-report leave requests
SELECT l.*
FROM hr_leave_requests l
JOIN hr_employees e ON e.id = l.employee_id
WHERE e.manager_id = (SELECT id FROM hr_employees WHERE user_account_id = :requestorId);
```

A manager has access to:
- `hr-leave-approvals.html` — approve/reject (direct reports only, enforced by above query)
- `hr-manager-leave.html` — team leave calendar (direct reports only)

Frontend: after login, call `GET /hr/org/direct-reports`. If the response is non-empty, show
the manager navigation items.

---

## 5. DB Data Model Requirements for ABAC

The following columns must exist for all ABAC rules to function. Add migration files for any
that are missing.

| Table                   | Column                        | Type          | Purpose                                   |
|-------------------------|-------------------------------|---------------|-------------------------------------------|
| `leads`                 | `assigned_to`                 | `UUID → users`| CRM ownership scoping                     |
| `leads`                 | `partner_id`                  | `UUID → partners` | KAM partner-based scoping             |
| `customers`             | `assigned_to`                 | `UUID → users`| CorporateSales customer scoping           |
| `customers`             | `partner_id`                  | `UUID → partners` | KAM customer scoping                  |
| `crm_quotes`            | `assigned_to`                 | `UUID → users`| Sales quote scoping                       |
| `crm_proforma`          | `assigned_to`                 | `UUID → users`| Sales proforma scoping                    |
| `invoices`              | `partner_id`                  | `UUID → partners` | KAM invoice scoping                   |
| `partners`              | `key_account_manager_id`      | `UUID → users`| KAM partner assignment (**exists**)       |
| `installation_tickets`  | `assigned_to`                 | `UUID → users`| Technician ticket scoping                 |
| `device_custody`        | `assigned_to`                 | `UUID → users`| Technician custody scoping                |
| `hr_employees`          | `manager_id`                  | `UUID → hr_employees` | Leave approval chain              |
| `hr_leave_requests`     | `employee_id`                 | `UUID → hr_employees` | Leave approval scoping            |

---

## 6. Backend Implementation Guide

### 6.1 requireRole() — RBAC middleware

Import role groups from `rbac.ts` rather than hard-coding strings in route files:

```typescript
import { requireRole, ROLE_GROUPS, ROLES } from "../middleware/rbac.js";

// HR admins only
router.get("/hr/employees", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), handler);

// Anyone who can raise tickets
router.post("/tickets", requireAuth, requireRole(ROLE_GROUPS.CAN_RAISE_TICKETS), handler);

// All CRM-accessible roles
router.get("/leads", requireAuth, requireRole(ROLE_GROUPS.CRM_ACCESS), handler);
```

### 6.2 ABAC — List Queries

Use `crmOwnershipClause()` to inject the correct SQL fragment:

```typescript
import { crmOwnershipClause } from "../middleware/rbac.js";

router.get("/leads", requireAuth, requireRole(ROLE_GROUPS.CRM_ACCESS), async (req, res) => {
  const { role, id: userId } = req.user!;
  const { clause, params } = crmOwnershipClause(role, userId, "l.");

  const where: string[] = ["l.deleted_at IS NULL"];
  const args: any[] = [];
  if (clause) { where.push(clause); args.push(...params); }

  const rows = await pgAll(`SELECT l.* FROM leads l WHERE ${where.join(" AND ")}`, args);
  return ok(res, rows);
});
```

### 6.3 ABAC — Single-Record Access Check

Use `userCanAccessRecord()` after fetching the row:

```typescript
import { userCanAccessRecord } from "../middleware/rbac.js";

router.get("/leads/:id", requireAuth, requireRole(ROLE_GROUPS.CRM_ACCESS), async (req, res) => {
  const lead = await pgGet(
    `SELECT l.*, p.key_account_manager_id AS kam_id
     FROM leads l
     LEFT JOIN partners p ON p.id = l.partner_id
     WHERE l.id = ?`,
    [req.params.id]
  );
  if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

  const allowed = userCanAccessRecord({
    role:            req.user!.role,
    userId:          req.user!.id,
    recordOwnerId:   lead.assigned_to,
    recordCreatorId: lead.created_by,
    kamId:           lead.kam_id,
  });
  if (!allowed) return errorResponse(res, 403, "FORBIDDEN", "Access denied.");

  return ok(res, lead);
});
```

### 6.4 Lead Stage Restriction

```typescript
const QUALIFICATION_STAGES = ["New", "Contacted", "Qualified"];
const STAGE_RESTRICTED_ROLES = [ROLES.TECHNICIAN, ROLES.CERT_ADMIN, ROLES.FINANCE];

// In the create-lead or update-lead handler:
if (STAGE_RESTRICTED_ROLES.includes(req.user!.role as any)) {
  if (!QUALIFICATION_STAGES.includes(body.stage)) {
    return errorResponse(res, 403, "FORBIDDEN",
      "Your role may only create or edit leads up to the Qualified stage.");
  }
}
```

---

## 7. Frontend Guard Implementation

### 7.1 Page Access Map

Add to `finemark-ui/assets/js/rbac-pages.js` (or inline in `app.js`):

```javascript
export const PAGE_ACCESS = {
  // Admin / system
  "admin.html":                   ["Admin"],
  "admin-users.html":             ["Admin"],
  "admin-audit-logs.html":        ["Admin"],
  "settings.html":                ["Admin"],

  // Executive
  "executive-dashboard.html":     ["Admin", "Executive"],

  // CRM
  "crm-leads.html":               ["Admin","Executive","BDM","CorporateSales","KAM",
                                    "Telesales","InventoryManager","Technician","CertAdmin","Finance"],
  "crm-customers.html":           ["Admin","Executive","BDM","CorporateSales","KAM","Finance"],
  "crm-quotes.html":              ["Admin","Executive","BDM","CorporateSales","KAM","Telesales","Finance"],
  "crm-proforma.html":            ["Admin","Executive","BDM","CorporateSales","KAM","Telesales","Finance"],
  "crm-tickets.html":             ["Admin","Executive","BDM","CorporateSales","KAM","Telesales"],
  "crm-campaigns.html":           ["Admin","BDM","Telesales"],
  "campaigns-mass-sms.html":      ["Admin","BDM","Telesales"],

  // Partners
  "partners.html":                ["Admin","Executive","BDM","KAM"],
  "partner-detail.html":          ["Admin","Executive","BDM","KAM"],

  // Invoices
  "create-invoice.html":          ["Admin","Executive","BDM","KAM","Telesales","Finance"],
  "invoice-detail.html":          ["Admin","Executive","BDM","KAM","Telesales","Finance"],
  "invoice-inventory.html":       ["Admin","Executive","Finance"],

  // Technical
  "technical-dashboard.html":     ["Admin","Executive","Technical"],
  "technician-jobs.html":         ["Admin","Technician","Technical"],
  "technician-custody.html":      ["Admin","Technician","InventoryManager"],
  "installation-ticket.html":     ["Admin","Executive","Technician","Technical"],
  "job-card.html":                ["Admin","Executive","Technician","Technical"],
  "job-details.html":             ["Admin","Executive","Technician","Technical","CertAdmin"],

  // Certificates
  "certificate-dashboard.html":   ["Admin","Executive","CertAdmin"],
  "certificate-queue.html":       ["Admin","CertAdmin"],
  "certificate-package.html":     ["Admin","CertAdmin"],
  "certificate-printing.html":    ["Admin","CertAdmin"],
  "certificate-inventory.html":   ["Admin","Executive","CertAdmin"],
  "certificate-validation.html":  ["Admin","CertAdmin"],
  "create-certificate.html":      ["Admin","CertAdmin"],
  "deliver-certificate.html":     ["Admin","CertAdmin"],

  // Inventory
  "inventory-dashboard.html":     ["Admin","Executive","InventoryManager","Finance","Technical"],
  "inventory-items.html":         ["Admin","InventoryManager","Finance","Technical"],
  "inventory-catalog.html":       ["Admin","InventoryManager","Finance"],
  "inventory-procurement.html":   ["Admin","InventoryManager","Finance"],
  "inventory-warranty.html":      ["Admin","Executive","InventoryManager","Technical"],
  "admin-gadget-inventory.html":  ["Admin","InventoryManager"],
  "admin-assign-gadgets.html":    ["Admin","InventoryManager"],

  // Finance
  "finance-dashboard.html":       ["Admin","Executive","Finance"],
  "finance-invoice-dashboard.html": ["Admin","Executive","Finance"],
  "payment-processing.html":      ["Admin","Finance"],
  "maker-checker.html":           ["Admin","Finance"],

  // HR
  "hr-dashboard.html":            ["Admin","HR"],
  "hr-employees.html":            ["Admin","Executive","HR"],
  "hr-onboarding.html":           ["Admin","HR"],
  "hr-leave-types.html":          ["Admin","HR"],
  "hr-leave-reports.html":        ["Admin","HR"],
  "hr-reports.html":              ["Admin","HR"],
  "hr-emp-no-config.html":        ["Admin","HR"],

  // Reports
  "report-sales.html":            ["Admin","Executive","BDM","Finance"],
  "report-technical.html":        ["Admin","Executive","Technical"],
};

export function enforcePageAccess() {
  const page = window.location.pathname.split("/").pop() || "";
  const user = window.FINEMARK_APP?.user;
  if (!user) { window.location.href = "/login.html"; return; }
  const allowedRoles = PAGE_ACCESS[page];
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    window.location.href = "/unauthorized.html";
  }
}
```

### 7.2 UI Element Guards

Hide action buttons that the role cannot use:

```javascript
function showForRoles(elementId, allowedRoles) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.style.display = allowedRoles.includes(window.FINEMARK_APP?.user?.role) ? "" : "none";
}

// Examples from individual pages:
showForRoles("btn-generate-certificate", ["Admin", "CertAdmin"]);
showForRoles("btn-amend-invoice",        ["Admin", "Finance"]);
showForRoles("btn-assign-ticket",        ["Admin", "Technical"]);
showForRoles("btn-close-job",            ["Admin", "Technical"]);
showForRoles("btn-issue-device",         ["Admin", "InventoryManager"]);
showForRoles("btn-new-campaign",         ["Admin", "BDM", "Telesales"]);
showForRoles("btn-edit-partner",         ["Admin", "BDM", "KAM"]);
showForRoles("nav-executive-dashboard",  ["Admin", "Executive"]);
showForRoles("nav-admin-panel",          ["Admin"]);
```

### 7.3 Sidebar Navigation Filtering

Build the sidebar from a role-keyed nav map so only permitted items render:

```javascript
const NAV_SECTIONS = [
  { label: "Executive Dashboard", href: "executive-dashboard.html",
    roles: ["Admin", "Executive"] },
  { label: "CRM",    href: "crm-leads.html",
    roles: ["Admin","Executive","BDM","CorporateSales","KAM","Telesales","Finance",
            "InventoryManager","Technician","CertAdmin"] },
  { label: "Partners", href: "partners.html",
    roles: ["Admin","Executive","BDM","KAM"] },
  { label: "Campaigns", href: "crm-campaigns.html",
    roles: ["Admin","BDM","Telesales"] },
  { label: "Technical", href: "technical-dashboard.html",
    roles: ["Admin","Executive","Technical","Technician"] },
  { label: "Certificates", href: "certificate-dashboard.html",
    roles: ["Admin","Executive","CertAdmin"] },
  { label: "Inventory", href: "inventory-dashboard.html",
    roles: ["Admin","Executive","InventoryManager","Finance","Technical"] },
  { label: "Finance", href: "finance-dashboard.html",
    roles: ["Admin","Executive","Finance"] },
  { label: "HR",    href: "hr-dashboard.html",
    roles: ["Admin","HR"] },
  { label: "Reports", href: "report-sales.html",
    roles: ["Admin","Executive","BDM","Finance","Technical"] },
  { label: "Admin Panel", href: "admin.html",
    roles: ["Admin"] },
];
```

---

## 8. Migration Plan

### Step 1 — Audit Current Role Distribution

```sql
SELECT role, COUNT(*) AS count FROM users GROUP BY role ORDER BY count DESC;
```

### Step 2 — Reclassify Existing Users

Coordinate with HR to assign the correct new role to each existing user. Then run targeted
`UPDATE` statements — never bulk-update without confirming individuals:

```sql
-- Example (replace UUIDs with real values):
UPDATE users SET role = 'Executive'       WHERE id IN ('<uuid>');
UPDATE users SET role = 'BDM'             WHERE id IN ('<uuid>');
UPDATE users SET role = 'CorporateSales'  WHERE id IN ('<uuid>');
UPDATE users SET role = 'KAM'             WHERE id IN ('<uuid>');
UPDATE users SET role = 'InventoryManager'WHERE role = 'Inventory';
UPDATE users SET role = 'CertAdmin'       WHERE id IN ('<uuid>');
UPDATE users SET role = 'HR'              WHERE id IN ('<uuid>');
```

### Step 3 — Schema Checks

Verify all ABAC columns in §5 exist. Run `\d <table>` in psql for each table and add any
missing `assigned_to`, `partner_id`, or `manager_id` columns via a new migration file.

### Step 4 — Harden Backend Routes

Audit every route file under `src/routes/` and replace any hard-coded role string arrays
with `ROLE_GROUPS.*` constants from `rbac.ts`.

### Step 5 — Deploy Frontend Guards

Add `enforcePageAccess()` to the page-init of every HTML file, and apply `showForRoles()`
to every action button that should be role-restricted.

### Step 6 — Test Matrix

For each role, verify:
- [ ] All permitted pages load successfully
- [ ] All disallowed pages redirect to `/unauthorized.html`
- [ ] API returns `403 FORBIDDEN` for out-of-scope record requests
- [ ] ABAC row filters return only owned / partner-scoped records
- [ ] Lead stage restriction blocks non-permitted stage creation
- [ ] Manager leave approval returns only direct-report requests
