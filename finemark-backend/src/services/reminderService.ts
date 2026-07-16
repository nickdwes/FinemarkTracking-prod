import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { sendMail } from "../utils/mailer.js";
import { buildInvoiceReminderEmail } from "../utils/emailTemplates.js";
import { sendSms, isAtConfigured } from "./smsService.js";
import { decryptField } from "./cryptoService.js";

export interface ReminderStage {
  key: string; // 'pre7d' | 'ondue' | 'overdue3d' | 'overdue7d' | 'overdue14d' | 'overdue30d'
  label: string;
  tone: 'gentle' | 'firm' | 'urgent';
}

const REMINDER_STAGES: Record<string, ReminderStage> = {
  pre7d: { key: 'pre7d', label: '7 days before due', tone: 'gentle' },
  ondue: { key: 'ondue', label: 'On due date', tone: 'gentle' },
  overdue3d: { key: 'overdue3d', label: '3 days overdue', tone: 'firm' },
  overdue7d: { key: 'overdue7d', label: '7 days overdue', tone: 'firm' },
  overdue14d: { key: 'overdue14d', label: '14 days overdue', tone: 'urgent' },
  overdue30d: { key: 'overdue30d', label: '30 days overdue', tone: 'urgent' },
};

export const buildReminderMessage = (
  invoice: any,
  stage: string,
  channel: 'email' | 'sms'
): { subject?: string; body: string } => {
  const st = REMINDER_STAGES[stage];
  const tone = st?.tone || 'gentle';
  const days = invoice.daysOverdue || 0;
  const isOverdue = days > 0;

  let subject = '';
  let body = '';

  if (channel === 'email') {
    if (!isOverdue) {
      subject = `Invoice ${invoice.invoiceNumber} due on ${new Date(invoice.dueOn).toLocaleDateString('en-KE')}`;
      body = `Dear ${invoice.customer},\n\nThis is a friendly reminder that Invoice ${invoice.invoiceNumber} is due on ${new Date(invoice.dueOn).toLocaleDateString('en-KE')}.\n\nAmount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}\n\nPlease arrange payment at your earliest convenience.\n\nThank you for your business!\n\nFinemark Tracking`;
    } else if (tone === 'gentle') {
      subject = `Payment reminder: Invoice ${invoice.invoiceNumber} (${days} days overdue)`;
      body = `Dear ${invoice.customer},\n\nWe hope you're well. Invoice ${invoice.invoiceNumber} is now ${days} days overdue.\n\nAmount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}\nDue Date: ${new Date(invoice.dueOn).toLocaleDateString('en-KE')}\n\nPlease settle this invoice to keep your account in good standing.\n\nThank you,\nFinemark Tracking`;
    } else if (tone === 'firm') {
      subject = `Urgent: Payment due on Invoice ${invoice.invoiceNumber} (${days} days overdue)`;
      body = `Dear ${invoice.customer},\n\nInvoice ${invoice.invoiceNumber} is now ${days} days overdue and payment is required.\n\nAmount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}\nDue Date: ${new Date(invoice.dueOn).toLocaleDateString('en-KE')}\n\nPlease settle this invoice immediately to avoid further action.\n\nThank you,\nFinemark Tracking`;
    } else {
      subject = `CRITICAL: Invoice ${invoice.invoiceNumber} – Immediate Payment Required (${days} days overdue)`;
      body = `Dear ${invoice.customer},\n\nInvoice ${invoice.invoiceNumber} is CRITICAL and overdue by ${days} days.\n\nAmount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}\nDue Date: ${new Date(invoice.dueOn).toLocaleDateString('en-KE')}\n\nImmediate payment is required. Continued non-payment may result in service suspension.\n\nPlease contact us today.\n\nFinemark Tracking`;
    }
  } else if (channel === 'sms') {
    if (!isOverdue) {
      body = `Reminder: Invoice ${invoice.invoiceNumber} is due ${new Date(invoice.dueOn).toLocaleDateString('en-KE')}. Amount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}. Please arrange payment. -Finemark`;
    } else if (tone === 'gentle') {
      body = `${invoice.invoiceNumber} is ${days}d overdue. Amount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}. Please pay. -Finemark`;
    } else if (tone === 'firm') {
      body = `URGENT: ${invoice.invoiceNumber} is ${days}d overdue (KES ${Number(invoice.total || invoice.amount).toLocaleString()}). Pay now. -Finemark`;
    } else {
      body = `CRITICAL: ${invoice.invoiceNumber} overdue ${days}d. Amount: KES ${Number(invoice.total || invoice.amount).toLocaleString()}. Immediate payment required. -Finemark`;
    }
  }

  return { subject, body };
};

export const checkRecentReminder = async (
  invoiceId: string,
  segmentKey: string,
  withinHours: number = 24
): Promise<boolean> => {
  const cutoff = new Date(Date.now() - withinHours * 3600000).toISOString();
  const row = await pgGet(
    `SELECT id FROM invoice_reminders WHERE invoice_id = ? AND segment_key = ? AND sent_at > ? LIMIT 1`,
    [invoiceId, segmentKey, cutoff]
  ).catch(() => null);
  return !!row;
};

export const sendReminderForInvoice = async (
  invoiceId: string,
  channels: ('email' | 'sms')[],
  segmentKey: string,
  options: {
    stage?: string;
    messageOverride?: string;
    subjectOverride?: string;
    sentBy?: string;
    auto?: boolean;
  } = {}
): Promise<{ [channel: string]: { success: boolean; error?: string } }> => {
  const invoice = await pgGet('SELECT * FROM invoices WHERE id = ?', [invoiceId]).catch(() => null);
  if (!invoice) {
    return { error: { success: false, error: 'Invoice not found' } as any };
  }

  // Skip if already paid or cancelled (e.g. resolved via a billing credit note)
  if (['paid', 'cancelled'].includes((invoice.status || '').toLowerCase())) {
    return { skipped: { success: false, error: `Invoice is ${invoice.status}` } as any };
  }

  const customerId = invoice.customer_id;
  let customerEmail: string | null = null;
  let customerPhone: string | null = null;

  // Fetch customer contact info
  if (customerId) {
    const cust = await pgGet('SELECT type FROM crm_customers WHERE id = ? AND deleted_at IS NULL', [customerId]).catch(() => null);
    if (cust?.type === 'individual') {
      const ip = await pgGet('SELECT email_enc, phone_enc FROM crm_individual_profiles WHERE customer_id = ?', [customerId]).catch(() => null);
      if (ip) {
        customerEmail = decryptField(ip.email_enc) || null;
        customerPhone = decryptField(ip.phone_enc) || null;
      }
    } else if (cust?.type === 'corporate') {
      const cp = await pgGet('SELECT email_enc, phone_enc FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at LIMIT 1', [customerId]).catch(() => null);
      if (cp) {
        customerEmail = decryptField(cp.email_enc) || null;
        customerPhone = decryptField(cp.phone_enc) || null;
      }
    }
  }

  const results: { [channel: string]: { success: boolean; error?: string } } = {};

  for (const channel of channels) {
    const reminderId = uuidv4();

    try {
      if (channel === 'email') {
        if (!customerEmail) {
          results[channel] = { success: false, error: 'No email on file' };
          continue;
        }

        const { subject, body } = buildReminderMessage(invoice, options.stage || 'pre7d', 'email');
        const finalSubject = options.subjectOverride || subject || `Invoice ${invoice.invoice_number}`;
        const finalBody = options.messageOverride || body;
        const htmlBody = buildInvoiceReminderEmail({
          customerName: invoice.customer || 'Valued Customer',
          invoiceNo: invoice.invoice_number,
          total: Number(invoice.total || invoice.amount),
          dueOn: invoice.due_on,
          message: finalBody,
        });

        await sendMail({
          to: customerEmail,
          subject: finalSubject,
          text: finalBody,
          html: htmlBody,
        });

        // Log success
        await pgRun(
          `INSERT INTO invoice_reminders (id, invoice_id, channel, segment_key, recipient, subject, body, status, sent_by, auto, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [reminderId, invoiceId, 'email', segmentKey, customerEmail, finalSubject, finalBody, 'Sent', options.sentBy || null, options.auto ? 1 : 0, new Date().toISOString()]
        );

        // Update invoice
        await pgRun(`UPDATE invoices SET sent_email_at = ? WHERE id = ?`, [new Date().toISOString(), invoiceId]);

        results[channel] = { success: true };
      } else if (channel === 'sms') {
        if (!customerPhone) {
          results[channel] = { success: false, error: 'No phone on file' };
          continue;
        }

        if (!isAtConfigured()) {
          results[channel] = { success: false, error: 'SMS service not configured' };
          continue;
        }

        const { body } = buildReminderMessage(invoice, options.stage || 'pre7d', 'sms');
        const finalBody = options.messageOverride || body;

        const smsResults = await sendSms([customerPhone], finalBody);
        const smsResult = smsResults[0];

        if (smsResult.status === 'Success') {
          // Log success
          await pgRun(
            `INSERT INTO invoice_reminders (id, invoice_id, channel, segment_key, recipient, body, status, sent_by, auto, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [reminderId, invoiceId, 'sms', segmentKey, customerPhone, finalBody, 'Sent', options.sentBy || null, options.auto ? 1 : 0, new Date().toISOString()]
          );

          // Update invoice
          await pgRun(`UPDATE invoices SET sent_sms_at = ? WHERE id = ?`, [new Date().toISOString(), invoiceId]);

          results[channel] = { success: true };
        } else {
          // Log failure
          const failureReason = smsResult?.status ? String(smsResult.status) : 'Unknown error';
          await pgRun(
            `INSERT INTO invoice_reminders (id, invoice_id, channel, segment_key, recipient, body, status, error, sent_by, auto, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [reminderId, invoiceId, 'sms', segmentKey, customerPhone, finalBody, 'Failed', failureReason, options.sentBy || null, options.auto ? 1 : 0, new Date().toISOString()]
          );

          results[channel] = { success: false, error: failureReason };
        }
      }
    } catch (err) {
      const error = (err as Error).message;
      await pgRun(
        `INSERT INTO invoice_reminders (id, invoice_id, channel, segment_key, recipient, status, error, sent_by, auto, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [reminderId, invoiceId, channel, segmentKey, channel === 'email' ? customerEmail : customerPhone, 'Failed', error, options.sentBy || null, options.auto ? 1 : 0, new Date().toISOString()]
      );
      results[channel] = { success: false, error };
    }
  }

  return results;
};
