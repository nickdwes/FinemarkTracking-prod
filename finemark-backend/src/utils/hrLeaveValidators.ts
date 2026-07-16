import { z } from "zod";

// ── LEAVE TYPES ───────────────────────────────────────────────────────────────
export const createLeaveTypeSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  statutory: z.boolean().default(false),
  genderRestricted: z.enum(["M", "F"]).optional(),
  maxDaysPerYear: z.number().positive().optional(),
  entitlementModel: z.enum(["fixed", "accrual"]).default("fixed"),
  carryForwardAllowed: z.boolean().default(false),
  carryForwardCap: z.number().nonnegative().optional(),
  isActive: z.boolean().default(true),
});

export const updateLeaveTypeSchema = createLeaveTypeSchema.partial();

// ── LEAVE ENTITLEMENTS ────────────────────────────────────────────────────────
export const createLeaveEntitlementSchema = z.object({
  leaveTypeId: z.string().uuid(),
  cadreId: z.string().uuid().optional(),
  daysPerYear: z.number().positive(),
  accrualRate: z.number().positive().optional(),       // days accrued per month
  minServiceDays: z.number().int().nonnegative().default(0),
});

export const updateLeaveEntitlementSchema = createLeaveEntitlementSchema.partial().omit({ leaveTypeId: true });

// ── LEAVE APPLICATIONS ────────────────────────────────────────────────────────
const leaveSegmentSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  halfDay: z.enum(["morning", "afternoon"]).optional(),
}).refine(d => d.endDate >= d.startDate, { message: "End date must be on or after start date", path: ["endDate"] })
  .refine(d => !d.halfDay || d.startDate === d.endDate, { message: "Half-day is only valid for single-day segments", path: ["halfDay"] });

export const createLeaveApplicationSchema = z.object({
  leaveTypeId: z.string().uuid(),
  // New: segments array (mandatory going forward)
  segments: z.array(leaveSegmentSchema).min(1, "At least one date segment is required").optional(),
  // Legacy single-range fields (kept for backward compat; ignored if segments provided)
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().max(1000).optional(),
  notes: z.string().max(500).optional(),
}).refine(d => d.segments?.length || (d.startDate && d.endDate), {
  message: "Either segments or startDate+endDate are required",
});

export const approveLeaveSchema = z.object({
  action: z.enum(["Approved", "Rejected"]),
  notes: z.string().max(500).optional(),
  rejectionReason: z.string().max(500).optional(),
});

export const hrOverrideLeaveSchema = z.object({
  action: z.enum(["Approved", "Rejected", "Cancelled"]),
  notes: z.string().max(500).optional(),
});

// ── BALANCE RECALCULATE ───────────────────────────────────────────────────────
export const recalculateBalanceSchema = z.object({
  employeeId: z.string().uuid(),
  year: z.number().int().min(2020).max(2099).optional(),
});

// ── QUERIES ───────────────────────────────────────────────────────────────────
export const listApplicationsQuerySchema = z.object({
  status: z.enum(["Pending", "Approved", "Rejected", "Cancelled"]).optional(),
  employeeId: z.string().optional(),
  leaveTypeId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  year: z.string().optional(),
  limit: z.string().optional().transform((v) => (v ? Math.min(parseInt(v, 10) || 50, 200) : 50)),
  offset: z.string().optional().transform((v) => (v ? parseInt(v, 10) || 0 : 0)),
});
