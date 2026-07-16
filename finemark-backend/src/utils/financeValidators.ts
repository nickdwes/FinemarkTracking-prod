import { z } from "zod";

const invoiceStatus = z.enum(["Draft", "Issued", "PartiallyPaid", "Paid", "Overdue", "Cancelled"]);
const paymentStatus = z.enum(["Completed", "Pending", "Failed"]);
const paymentMethod = z.enum(["Bank Transfer", "Cash", "Card", "Mobile Money"]);

export const listInvoicesQuerySchema = z.object({
  search: z.string().optional(),
  status: invoiceStatus.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  bank: z.string().optional(),
  salesPerson: z.string().optional(),
  rep: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const createInvoiceSchema = z
  .object({
    invoiceNumber: z.string().optional(),
    customer: z.string().optional(),
    customerName: z.string().optional(),
    representative: z.string().min(1),
    vatMode: z.enum(["exclusive", "inclusive"]),
    taxDate: z.string().optional(),
    jobCardNo: z.string().optional(),
    pinNo: z.string().optional(),
    subtotal: z.number().optional(),
    vatTotal: z.number().optional(),
    total: z.number().optional(),
    paymentPaybill: z.string().optional(),
    paymentAccountHint: z.string().optional(),
    bankName: z.string().optional(),
    bankAccountNo: z.string().optional(),
    amount: z.number().int().positive(),
    currency: z.string().optional().default("KES"),
    status: z.enum(["Draft", "Issued"]).optional().default("Draft"),
    issuedOn: z.string().min(1),
    dueOn: z.string().min(1),
    bank: z.string().optional(),
    salesPerson: z.string().optional(),
    details: z.record(z.any()).optional(),
    crmRecordId: z.string().optional(),
    items: z
      .array(
        z.object({
          item: z.string().min(1),
          description: z.string().optional(),
          qty: z.number().positive(),
          rate: z.number().nonnegative(),
          amount: z.number().nonnegative(),
          vat: z.number().nonnegative(),
        })
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.customer && !data.customerName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Customer name is required.", path: ["customerName"] });
    }
  });

export const updateInvoiceSchema = z.object({
  status: invoiceStatus.optional(),
  dueOn: z.string().optional(),
  bank: z.string().optional(),
  salesPerson: z.string().optional(),
  details: z.record(z.any()).optional(),
});

export const listPaymentsQuerySchema = z.object({
  search: z.string().optional(),
  status: paymentStatus.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  method: paymentMethod.optional(),
  bank: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const createPaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().optional().default("KES"),
  method: paymentMethod,
  bank: z.string().optional(),
  status: z.enum(["Completed", "Pending"]).optional().default("Completed"),
  paidAt: z.string().optional(),
  paymentRef: z.string().optional(),
});

export const salesByBankQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  salesPerson: z.string().optional(),
  bank: z.string().optional(),
  paymentStatus: z.enum(["Paid", "Pending"]).optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});
