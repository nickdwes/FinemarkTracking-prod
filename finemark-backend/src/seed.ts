import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "./db.js";
import { hashPassword } from "./utils/password.js";
import { initSchema } from "./schema.js";

const now = new Date();
const nowIso = () => new Date().toISOString();
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(arr: T[]) => arr[rand(0, arr.length - 1)];

const seedUsers = async () => {
  const users = [
    { email: "adonijahjuma@gmail.com", name: "Admin User", role: "Admin", password: "Admin123!" },
    { email: "sales@finemark.com", name: "Sales User", role: "Sales", password: "Sales123!" },
    { email: "technical@finemark.com", name: "Technical User", role: "Technical", password: "Tech123!" },
    { email: "tech@finemark.com", name: "Technician User", role: "Technician", password: "Techie123!" },
    { email: "finance@finemark.com", name: "Finance User", role: "Finance", password: "Finance123!" },
  ];
  for (const user of users) {
    const exists = await pgGet("SELECT id FROM users WHERE email = ?", [user.email]);
    if (exists) continue;
    const hash = await hashPassword(user.password);
    await pgRun(
      `INSERT INTO users (id, name, email, role, status, password_hash, force_password_reset, last_login_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), user.name, user.email, user.role, "Active", hash, 0, null, nowIso(), nowIso()]
    );
  }
};

const seedCRMRecords = async () => {
  const existing = await pgGet("SELECT COUNT(*) as total FROM crm_records", []);
  if (Number(existing?.total) > 0) return;
  const types = ["installation", "quotation", "invoice"];
  const statuses = ["Draft", "Submitted", "Approved", "Rejected", "Paid"];
  const jobStatuses = ["Requested", "Assigned", "InProgress", "AwaitingConfirmation", "Completed"];
  const owners = ["sales@finemark.com", "adonijahjuma@gmail.com"];
  for (let i = 1; i <= 20; i++) {
    const createdAt = new Date(now.getTime() - i * 3 * 86400000).toISOString();
    const id = uuidv4();
    const type = types[i % types.length];
    const status = statuses[i % statuses.length];
    const owner = owners[i % owners.length];
    await pgRun(
      `INSERT INTO crm_records (id, type, customer, location, status, owner_email, created_by_user_id, customer_phone, customer_email, details_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, type, `Customer ${i}`, "Nairobi", status, owner, owner, "+254700000000", `customer${i}@example.com`, JSON.stringify({ notes: "Seeded CRM record", source: "seed" }), createdAt, createdAt]
    );
    if (type === "installation") {
      const jobId = uuidv4();
      const jobStatus = jobStatuses[i % jobStatuses.length];
      await pgRun(
        `INSERT INTO installation_jobs (id, request_id, customer_name, customer_phone, location, scheduled_date, assigned_technician_id, assigned_technician_email, status, job_details_json, job_card_json, confirmation_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, id, `Customer ${i}`, "+254700000000", "Nairobi", null, null, null, jobStatus, JSON.stringify({ notes: "Seeded installation", priority: "Medium", preferredDate: null, source: "seed" }), "{}", "{}", createdAt, createdAt]
      );
    }
  }
};

const seedAuditLogs = async () => {
  const existing = await pgGet("SELECT COUNT(*) as total FROM audit_logs", []);
  if (Number(existing?.total) > 0) return;
  const actions = ["LOGIN_SUCCESS","LOGIN_FAILED","TOKEN_REFRESH","LOGOUT","USER_CREATED","USER_UPDATED","USER_DISABLED","USER_ENABLED","ADMIN_PASSWORD_RESET","CRM_RECORD_CREATED","CRM_RECORD_UPDATED","INSTALLATION_CREATED","INSTALLATION_ASSIGNED","INSTALLATION_STATUS_UPDATED","INSTALLATION_FAILED","INSTALLATION_RESCHEDULED","JOB_CARD_UPDATED","INSTALLATION_COMPLETED_SIGNATURE","PAYMENT_CREATED","INVOICE_CREATED","INVOICE_UPDATED","REPORT_VIEWED_SALES_BY_BANK","REPORT_EXPORTED_SALES_BY_BANK"];
  const users = await pgAll("SELECT id, email, role FROM users", []);
  for (let i = 0; i < 45; i++) {
    const timestamp = new Date(now.getTime() - i * 12 * 3600 * 1000).toISOString();
    const action = actions[i % actions.length];
    const actor = users[i % users.length];
    const severity = ["INSTALLATION_FAILED","INSTALLATION_RESCHEDULED","USER_DISABLED","ADMIN_PASSWORD_RESET"].includes(action) ? "Warning" : "Info";
    await pgRun(
      `INSERT INTO audit_logs (id, timestamp, user_id, user_email, role, action, target, severity, ip_address, user_agent, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), timestamp, actor?.id || null, actor?.email || "adonijahjuma@gmail.com", actor?.role || "Admin", action, `record:${i}`, severity, "127.0.0.1", "seed", JSON.stringify({ note: "Seeded log", action }), timestamp]
    );
  }
};

const seedInvoicesAndPayments = async () => {
  const existing = await pgGet("SELECT COUNT(*) as total FROM invoices", []);
  if (Number(existing?.total) > 0) return;
  const banks = ["KCB", "Equity", "Co-op", "NCBA", "Absa"];
  const salesPeople = ["Jane Wanjiku","Daniel Otieno","Faith Mwangi","Peter Kariuki","Mercy Njeri","Allan Mutiso"];
  const invoiceIds: string[] = [];
  const year = new Date().getFullYear();
  for (let i = 1; i <= 30; i++) {
    const issued = new Date(now.getTime() - rand(0, 90) * 86400000);
    const due = new Date(issued.getTime() + rand(7, 30) * 86400000);
    const status = pick(["Draft","Issued","PartiallyPaid","Paid","Overdue"]);
    const amount = rand(25000, 450000);
    const id = uuidv4();
    await pgRun(
      `INSERT INTO invoices (id, invoice_number, crm_record_id, customer, amount, currency, status, issued_on, due_on, bank, sales_person, details_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, `INV-${year}-${String(i).padStart(4, "0")}`, null, `Customer ${i}`, amount, "KES", status, issued.toISOString().slice(0, 10), due.toISOString().slice(0, 10), pick(banks), pick(salesPeople), JSON.stringify({ notes: "Seeded invoice" }), nowIso(), nowIso()]
    );
    invoiceIds.push(id);
  }
  const paymentCount = rand(30, 60);
  for (let i = 1; i <= paymentCount; i++) {
    const invoiceId = pick(invoiceIds);
    const invoice = await pgGet("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
    const amount = rand(5000, Math.max(5000, invoice.amount));
    const status = pick(["Completed","Pending"]);
    const paidAt = new Date(now.getTime() - rand(0, 60) * 86400000).toISOString();
    await pgRun(
      `INSERT INTO payments (id, payment_ref, invoice_id, customer, amount, currency, method, bank, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), `PAY-${year}-${String(i).padStart(4, "0")}`, invoiceId, invoice.customer, amount, "KES", pick(["Bank Transfer","Cash","Card","Mobile Money"]), invoice.bank, status, paidAt, nowIso()]
    );
  }
};

const seedSalesTransactions = async () => {
  const existing = await pgGet("SELECT COUNT(*) as total FROM sales_transactions", []);
  if (Number(existing?.total) > 0) return;
  const banks = ["KCB","Equity","Co-op","NCBA","Absa"];
  const salesPeople = ["Jane Wanjiku","Daniel Otieno","Faith Mwangi","Peter Kariuki","Mercy Njeri","Allan Mutiso","Sharon Wanyoike"];
  const models = ["Toyota Hiace","Nissan NV350","Isuzu NMR","Mitsubishi Fuso","Toyota Hilux"];
  for (let i = 1; i <= 35; i++) {
    const saleDate = new Date(now.getTime() - rand(0, 90) * 86400000).toISOString().slice(0, 10);
    await pgRun(
      `INSERT INTO sales_transactions (id, sale_id, sale_date, sales_person, bank, vehicle_id, vehicle_plate, vehicle_model, customer_name, amount, currency, payment_status, invoice_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), `SALE-${now.getFullYear()}-${String(i).padStart(3, "0")}`, saleDate, pick(salesPeople), pick(banks), `VH-${String(i).padStart(3, "0")}`, `KDA ${rand(100, 999)}${String.fromCharCode(65 + rand(0, 25))}`, pick(models), `Customer ${i}`, rand(200000, 900000), "KES", pick(["Paid","Pending"]), null, nowIso(), nowIso()]
    );
  }
};

(async () => {
  await initSchema();
  await seedUsers();
  await seedCRMRecords();
  await seedAuditLogs();
  await seedInvoicesAndPayments();
  await seedSalesTransactions();
  console.log("Seed complete.");
  process.exit(0);
})().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
