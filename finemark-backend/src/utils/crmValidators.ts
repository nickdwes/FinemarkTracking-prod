import { z } from "zod";

const crmTypeEnum = z.enum(["installation", "quotation", "invoice"]);
const crmStatusEnum = z.enum([
  "Draft",
  "Submitted",
  "Approved",
  "Rejected",
  "Paid",
  "Issued",
  "PartiallyPaid",
  "Overdue",
  "Cancelled",
]);

export const createCRMRecordSchema = z.object({
  type: crmTypeEnum,
  customer: z.string().min(1),
  location: z.string().min(1),
  status: crmStatusEnum.optional().default("Submitted"),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional(),
  bank: z.string().optional(),
  salesPerson: z.string().optional(),
  issuedOn: z.string().optional(),
  dueOn: z.string().optional(),
  currency: z.string().optional(),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        qty: z.number().positive(),
        unitPrice: z.number().positive(),
      })
    )
    .optional(),
  notes: z.string().optional(),
  details: z.record(z.any()).optional().default({}),
});

export const listCRMRecordsQuerySchema = z.object({
  search: z.string().optional(),
  type: crmTypeEnum.optional(),
  status: crmStatusEnum.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  range: z.enum(["7d", "30d", "90d"]).optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});
