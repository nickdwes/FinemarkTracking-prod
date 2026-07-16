import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Phone / email format validation
//
// Kenyan mobile numbers only: local (07XXXXXXXX / 01XXXXXXXX), or with a 254
// country code (254XXXXXXXXX / +254XXXXXXXXX). Whitespace and dashes between
// digits are tolerated (real users type "0713 375281"), but any other stray
// character (a letter, a misplaced symbol) fails validation rather than being
// silently stripped — this is deliberately stricter than normalisePhoneKe()
// (finemark-ui), which only strips/prefixes and never rejects bad input.
export const KE_PHONE_RE = /^(?:\+254|254|0)(?:7\d{8}|1\d{8})$/;

export function isValidKePhone(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return KE_PHONE_RE.test(raw.trim().replace(/[\s-]/g, ""));
}

// Validates first, then normalizes to 254XXXXXXXXX. Returns null for invalid
// input instead of guessing — callers should treat null as a rejection, not
// silently fall back to the raw value.
export function normalizeKePhoneStrict(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[\s-]/g, "");
  if (!KE_PHONE_RE.test(cleaned)) return null;
  const digits = cleaned.replace(/^\+/, "");
  return digits.startsWith("254") ? digits : "254" + digits.slice(1);
}

// Pragmatic email validator (the same pattern browsers use for
// <input type="email">) — strict enough to catch typos/garbage without
// rejecting legitimate addresses on newer or less common TLDs.
export const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isValidEmail(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return EMAIL_RE.test(raw.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Kenyan vehicle registration validation
//
// Checks plate *shape*, not an exhaustive prefix list — NTSA issues new
// special-series prefixes (county government, diplomatic, UN, disability,
// dealer, etc.) faster than any hardcoded list can track, and a previous
// version of this check that enumerated ~15 specific prefixes kept rejecting
// real plates outside that list (e.g. "KTCC212Q"). Whitespace is stripped
// before testing (real plates like "GK A001B" put a letter *after* a space,
// which a single letter-block-then-space pattern can't express) — what's
// left is: an optional leading digit group (older Coast Guard/corps-count
// plates), a short letter prefix, digits, and optional trailing letter(s).
export const KE_REG_STANDARD_RE = /^\d{0,3}[A-Z]{1,6}\d{1,6}[A-Z]{0,2}$/i;
// A handful of fully-alphabetic special plates (Speaker of the National
// Assembly / Senate / Chief Justice) that carry no digits at all.
export const KE_REG_LETTERS_ONLY_RE = /^(SNA|SS|CJ)$/i;
// Tractors, tuktuks, and other special equipment often aren't registered
// under the standard NTSA motor-vehicle plate scheme at all — many carry a
// county or manufacturer serial instead — so for these categories just check
// it looks like a real identifier rather than pattern-matching a format that
// doesn't apply to them.
export const KE_REG_LOOSE_RE = /^[A-Z0-9][A-Z0-9\s-]{2,16}[A-Z0-9]$/i;

const LOOSE_REG_CATEGORIES = new Set(["tractor", "special_equipment", "tuktuk"]);

export function isValidKeRegistration(raw: unknown, category?: string | null): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  const v = raw.trim();
  if (category && LOOSE_REG_CATEGORIES.has(category)) return KE_REG_LOOSE_RE.test(v);
  const compact = v.replace(/\s+/g, "");
  return KE_REG_STANDARD_RE.test(compact) || KE_REG_LETTERS_ONLY_RE.test(compact);
}

// Role membership is validated dynamically in routes/users.ts against role_configs
// (system + custom roles) plus LEGACY_ROLE_MAP — not a static enum here — so that
// custom roles created via admin-access-control.html can actually be assigned.
// This only validates shape; a non-empty string.
const roleEnum = z.string().min(1);
const statusEnum = z.enum(["Active", "Disabled", "Pending"]);
const crmStatusEnum = z.enum(["Draft", "Submitted", "Approved", "Rejected", "Paid"]);
const crmTypeEnum = z.enum(["installation", "quotation", "invoice"]);

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: roleEnum,
  tempPassword: z.string().min(8).regex(/[A-Z]/, "Must include uppercase").regex(/[0-9]/, "Must include number").optional(),
  forcePasswordReset: z.boolean().optional().default(true),
  status: statusEnum.optional().default("Active"),
  sendInvite: z.boolean().optional().default(false),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: roleEnum.optional(),
  status: statusEnum.optional(),
  forcePasswordReset: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({
  tempPassword: z.string().min(8).regex(/[A-Z]/, "Must include uppercase").regex(/[0-9]/, "Must include number"),
  forcePasswordReset: z.boolean(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
  confirmPassword: z.string().min(1),
});

export const listUsersQuerySchema = z.object({
  search: z.string().optional(),
  role: z.string().optional(), // allow any role string for open filtering
  status: statusEnum.optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const auditLogsQuerySchema = z.object({
  search: z.string().optional(),
  severity: z.enum(["Info", "Warning", "Critical"]).optional(),
  action: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchemaAuth = z.object({
  token: z.string().min(1),
  email: z.string().email().optional(),
  newPassword: z.string().min(8).regex(/[A-Z]/, "Must include uppercase").regex(/[0-9]/, "Must include number"),
});

export const jobCardSchema = z.object({
  checklist: z.array(z.any()).optional(),
  photos: z.array(z.any()).optional(),
  notes: z.string().optional(),
});

export const confirmSignatureSchema = z.object({
  signedBy: z.string().min(1),
  signatureData: z.string().min(1),
});

export const otpVerifySchema = z.object({
  otp: z.string().min(6).max(6),
});

export const createCRMRecordSchema = z.object({
  type: crmTypeEnum,
  customer: z.string().min(1),
  location: z.string().min(1),
  status: crmStatusEnum.optional(),
  notes: z.string().optional(),
  customerPhone: z.string().optional(),
  details: z.record(z.any()).optional(),
});

export const updateCRMRecordSchema = z.object({
  status: crmStatusEnum.optional(),
  details: z.record(z.any()).optional(),
  customer: z.string().optional(),
  location: z.string().optional(),
});

export const speedGovernorCreateSchema = z.object({
  customerName: z.string().min(1),
  phoneNumber: z.string().min(1),
  registrationNumber: z.string().min(1),
  model: z.string().min(1),
  deviceType: z.string().min(1),
  technicianId: z.string().min(1),
  salesPersonId: z.string().min(1),
  comments: z.string().optional(),
});

export const listSpeedGovernorsQuerySchema = z.object({
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  technicianId: z.string().optional(),
  salesPersonId: z.string().optional(),
  deviceType: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

const certificateAdditionalDeviceSchema = z.object({
  imei: z.string().optional(),
  trackerNo: z.string().optional(),
});

export const createCertificateSchema = z.object({
  serialNo: z.string().min(1),
  // "unique" (Unique Tracking template) only requires registration; every
  // other field below (including model — vehicle make/model may not be known
  // yet on either template) is enforced by the .superRefine() below, only
  // when template is the default "finemark".
  template: z.enum(["finemark", "unique"]).optional().default("finemark"),
  systemType: z.string().optional(),
  carRegistration: z.string().min(1),
  model: z.string().optional(),
  date: z.string().optional(),
  name: z.string().optional(),
  color: z.string().optional(),
  phone: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  loanDurationYears: z.number().optional(),
  imei1: z.string().optional(),
  imei2: z.string().optional(),
  trackerNo1: z.string().optional(),
  trackerNo2: z.string().optional(),
  additionalDevices: z.array(certificateAdditionalDeviceSchema).optional(),
  chassisNumber: z.string().optional(),
  engineNumber: z.string().optional(),
  partnerBank: z.string().optional(),
  printedByUserId: z.string().optional(),
  printedByName: z.string().optional(),
  printedBySignatureUrl: z.string().optional(),
  authorizedByName: z.string().optional(),
  authorizedByRole: z.string().optional(),
  authorizedBySignatureUrl: z.string().optional(),
  pdfBase64: z.string().min(1),
}).superRefine((data, ctx) => {
  if (data.template === "unique") return;
  // IMEI/Tracker counts vary bank-to-bank (Sidian issues 2 trackers, SMEP 1,
  // DTB 1, the rest 2 — see create-certificate.html's CERT_CATEGORY_POLICY),
  // so neither is ever hard-required here; the frontend still requires
  // Chassis/Engine specifically for the "with Chassis/Engine" bank category.
  const requiredStrings: (keyof typeof data)[] = [
    "systemType", "date", "name", "phone", "startDate", "endDate",
  ];
  for (const key of requiredStrings) {
    if (!data[key]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required` });
    }
  }
  if (data.loanDurationYears === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["loanDurationYears"], message: "loanDurationYears is required" });
  }
});

export const updateCertificateSchema = z.object({
  systemType: z.string().min(1).optional(),
  carRegistration: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  phone: z.string().min(1).optional(),
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
  loanDurationYears: z.number().optional(),
  imei1: z.string().min(1).optional(),
  imei2: z.string().optional(),
  trackerNo1: z.string().min(1).optional(),
  trackerNo2: z.string().optional(),
  chassisNumber: z.string().optional(),
  engineNumber: z.string().optional(),
  partnerBank: z.string().optional(),
  printedByUserId: z.string().optional(),
  printedByName: z.string().optional(),
  printedBySignatureUrl: z.string().optional(),
  authorizedByName: z.string().optional(),
  authorizedByRole: z.string().optional(),
  authorizedBySignatureUrl: z.string().optional(),
  additionalDevices: z.array(certificateAdditionalDeviceSchema).optional(),
  pdfBase64: z.string().min(1).optional(),
});

export const certBankConfigSchema = z.object({
  bankName: z.string().min(1),
  fullName: z.string().min(1),
  template: z.enum(["finemark", "unique"]),
  showChassis: z.boolean(),
  showEngine: z.boolean(),
  showImei: z.boolean(),
  showTracker: z.boolean(),
  maxImei: z.number().int().min(0).max(10),
  maxTracker: z.number().int().min(0).max(10),
  sortOrder: z.number().int().optional(),
});

export const updateCertBankConfigSchema = certBankConfigSchema.partial().extend({
  bankName: z.string().min(1).optional(),
});

export const listCertificatesQuerySchema = z.object({
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const emailCertificateSchema = z.object({
  toEmail: z.string().email(),
  subject: z.string().optional(),
  message: z.string().optional(),
});
