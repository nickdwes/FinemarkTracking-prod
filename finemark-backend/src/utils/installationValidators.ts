import { z } from "zod";

const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
const installationStatusEnum = z.enum([
  "Requested",
  "Assigned",
  "InProgress",
  "AwaitingConfirmation",
  "Completed",
  "Rescheduled",
  "Failed",
]);

export const assignSchema = z.object({
  technicianId: z.string().min(1),
  scheduledDate: z
    .string()
    .min(1)
    .refine((value) => isoDateRegex.test(value), { message: "Invalid date format." }),
});

export const statusSchema = z.object({
  status: installationStatusEnum,
});
