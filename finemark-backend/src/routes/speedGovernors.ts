import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { errorResponse } from "../utils/responses.js";
import { speedGovernorCreateSchema, listSpeedGovernorsQuerySchema } from "../utils/validators.js";

const router = Router();

const mapRecord = (row: any) => ({
  id: row.id,
  customerName: row.customer_name,
  phoneNumber: row.phone_number,
  registrationNumber: row.registration_number,
  model: row.model,
  deviceType: row.device_type,
  technician: { id: row.technician_id, name: row.technician_name, email: row.technician_email },
  salesPerson: { id: row.sales_person_id, name: row.sales_person_name, email: row.sales_person_email },
  comments: row.comments || "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

router.post("/", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const parsed = speedGovernorCreateSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());

  const { customerName, phoneNumber, registrationNumber, model, deviceType, technicianId, salesPersonId, comments } = parsed.data;

  const technician = await pgGet("SELECT id, name, email, role FROM users WHERE id = ?", [technicianId]);
  if (!technician || technician.role !== "Technician") {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", { fieldErrors: { technicianId: ["Technician is invalid."] } });
  }

  const salesPerson = await pgGet("SELECT id, name, email, role FROM users WHERE id = ?", [salesPersonId]);
  if (!salesPerson || salesPerson.role !== "Sales") {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", { fieldErrors: { salesPersonId: ["Sales person is invalid."] } });
  }

  const now = new Date().toISOString();
  const id = uuidv4();

  await pgRun(
    `INSERT INTO speed_governors (id, customer_name, phone_number, registration_number, model, device_type,
      technician_id, technician_name, technician_email,
      sales_person_id, sales_person_name, sales_person_email,
      comments, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, customerName, phoneNumber, registrationNumber, model, deviceType,
      technician.id, technician.name, technician.email,
      salesPerson.id, salesPerson.name, salesPerson.email,
      comments || null, req.user?.id, now, now]
  );

  auditLog(req, "SPEED_GOVERNOR_CREATED", `speed_governor:${id}`, "Info", { registrationNumber, deviceType, technicianId, salesPersonId }).catch(console.error);

  const created = await pgGet("SELECT * FROM speed_governors WHERE id = ?", [id]);
  return res.status(201).json({ data: mapRecord(created), message: "Speed governor created" });
});

router.get("/", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const parsed = listSpeedGovernorsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());

  const page = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const offset = (page - 1) * pageSize;

  const filters: string[] = [];
  const params: any[] = [];
  const { search, from, to, technicianId, salesPersonId, deviceType } = parsed.data;

  if (search) {
    filters.push("(customer_name ILIKE ? OR registration_number ILIKE ? OR phone_number ILIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (technicianId) { filters.push("technician_id = ?"); params.push(technicianId); }
  if (salesPersonId) { filters.push("sales_person_id = ?"); params.push(salesPersonId); }
  if (deviceType) { filters.push("device_type = ?"); params.push(deviceType); }
  if (from) { filters.push("created_at >= ?"); params.push(new Date(from).toISOString()); }
  if (to) {
    const end = new Date(to as string);
    end.setHours(23, 59, 59, 999);
    filters.push("created_at <= ?");
    params.push(end.toISOString());
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await pgAll(`SELECT * FROM speed_governors ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM speed_governors ${where}`, params);

  return res.status(200).json({ data: rows.map(mapRecord), meta: { total: Number(totalRow?.total ?? 0) } });
});

export default router;
