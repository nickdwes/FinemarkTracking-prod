import { z } from "zod";

// ── Organisation Units ────────────────────────────────────────────────────────
export const createOrgUnitSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["Division", "Department", "Team", "Unit"]),
  parentId: z.string().uuid().optional(),
  headEmployeeId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
});
export const updateOrgUnitSchema = createOrgUnitSchema.partial();

// ── Job Roles ─────────────────────────────────────────────────────────────────
export const createJobRoleSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  responsibilities: z.string().max(2000).optional(),
  gradeLevel: z.string().max(50).optional(),
  salaryBandMin: z.number().nonnegative().optional(),
  salaryBandMax: z.number().nonnegative().optional(),
});
export const updateJobRoleSchema = createJobRoleSchema.partial();

// ── Cadres ────────────────────────────────────────────────────────────────────
export const createCadreSchema = z.object({
  name: z.enum(["Permanent", "Contractor", "Casual", "Intern"]),
  description: z.string().max(500).optional(),
});

// ── Benefit Plans ─────────────────────────────────────────────────────────────
export const createBenefitPlanSchema = z.object({
  cadreId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(120),
  annualLeaveDays: z.coerce.number().int().nonnegative().default(0),
  sickLeaveDays: z.coerce.number().int().nonnegative().default(0),
  medicalCover: z.string().max(500).optional().nullable(),
  pension: z.string().max(500).optional().nullable(),
  otherBenefits: z.string().max(1000).optional().nullable(),
});
export const updateBenefitPlanSchema = createBenefitPlanSchema.partial();

// ── Employees ─────────────────────────────────────────────────────────────────
const kenyaPhone = z
  .string()
  .regex(/^(?:\+254|0)[17]\d{8}$/, "Invalid Kenyan phone number");

const kraPin = z
  .string()
  .regex(/^[A-Z]\d{9}[A-Z]$/, "KRA PIN must be in format A999999999Z");

export const createEmployeeSchema = z.object({
  fullName: z.string().min(2).max(200),
  nationalId: z.string().min(5).max(20).optional(),
  kraPin: kraPin.optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  phone: kenyaPhone,
  email: z.string().email(),
  residentialAddress: z.string().max(300).optional(),
  jobRoleId: z.string().uuid().optional(),
  orgUnitId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  cadreId: z.string().uuid().optional(),
  benefitPlanId: z.string().uuid().optional(),
  employmentType: z.enum(["Permanent", "Contractor", "Casual", "Intern"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  salary: z.number().nonnegative().optional(),
  status: z.enum(["Active", "Inactive", "Terminated"]).default("Active"),
  workEmail: z.string().email().optional().or(z.literal("")).transform(v => v || undefined),
  privacyNoticeAcknowledged: z.number().int().min(0).max(1).default(0),
  emergencyContactConsent: z.number().int().min(0).max(1).default(0),
  userAccountId: z.string().uuid().optional(),
});
export const updateEmployeeSchema = createEmployeeSchema.partial();
export const listEmployeesQuerySchema = z.object({
  search: z.string().optional(),
  status: z.enum(["Active", "Inactive", "Terminated"]).optional(),
  orgUnitId: z.string().uuid().optional(),
  cadreId: z.string().uuid().optional(),
  employmentType: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

// ── Emergency Contacts ────────────────────────────────────────────────────────
export const createEmergencyContactSchema = z.object({
  name: z.string().min(2).max(200),
  relationship: z.string().min(2).max(80),
  phone: kenyaPhone,
  consentGiven: z.number().int().min(0).max(1).default(0),
});
export const updateEmergencyContactSchema = createEmergencyContactSchema.partial();

// ── Documents ─────────────────────────────────────────────────────────────────
export const uploadDocumentSchema = z.object({
  documentType: z.enum(["CV", "Certificate", "Contract", "ID", "Other"]),
  fileName: z.string().min(1).max(200),
  fileBase64: z.string().min(1),
});

// ── Promotion History ─────────────────────────────────────────────────────────
export const createPromotionSchema = z.object({
  fromRoleId: z.string().uuid().optional(),
  toRoleId: z.string().uuid(),
  fromCadreId: z.string().uuid().optional(),
  toCadreId: z.string().uuid().optional(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  notes: z.string().max(1000).optional(),
});

// ── Training Records ──────────────────────────────────────────────────────────
export const createTrainingSchema = z.object({
  courseName: z.string().min(1).max(200),
  provider: z.string().max(200).optional(),
  completionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  certificationNo: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
});

// ── Performance Records ───────────────────────────────────────────────────────
export const createPerformanceSchema = z.object({
  employeeId: z.string().uuid(),
  reviewCycle: z.string().min(1).max(50),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  rating: z.enum(["Outstanding", "Exceeds Expectations", "Meets Expectations", "Needs Improvement", "Unsatisfactory"]),
  goals: z.string().max(2000).optional(),
  comments: z.string().max(2000).optional(),
  outcomes: z.string().max(2000).optional(),
});
export const updatePerformanceSchema = createPerformanceSchema.omit({ employeeId: true }).partial();
