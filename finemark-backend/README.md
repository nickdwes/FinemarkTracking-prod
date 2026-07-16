# Finemark Backend (Slice A: Auth + RBAC)

## Setup
```bash
cd finemark-backend
npm install
```

## Run in dev
```bash
npm run dev
```

## Seed demo users
```bash
npm run seed
```

## Environment
Copy `.env.example` to `.env` and update values.

## Example curl
```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"adonijahjuma@gmail.com","password":"Admin123!"}'

# Me
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <accessToken>"
```

## Notes
- CORS is enabled (default `http://localhost:5500`) so the static UI can call the API.
- Access tokens are short-lived JWTs. Refresh tokens are stored hashed in SQLite.
- Run the UI via a local static server (e.g. VSCode Live Server) to avoid CORS issues.

## Slice B API examples

### Create installation request
```bash
ACCESS="<accessToken>"

curl -X POST http://localhost:3000/api/crm/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS" \
  -d '{"type":"installation","customer":"Acme Ltd","location":"Nairobi","status":"Submitted","customerPhone":"+254700000000","customerEmail":"acme@example.com","details":{"notes":"Priority","source":"sales-ui"}}'
```

### Assign technician
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/assign \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS" \
  -d '{"technicianId":"<techUserId>","scheduledDate":"2026-02-04"}'
```

### Update status
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS" \
  -d '{"status":"InProgress"}'
```

### Submit job card
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/job-card \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS" \
  -d '{"checklist":["Installed"],"photos":["photo1.jpg"],"notes":"All good"}'
```

### Confirm signature
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/confirm/signature \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS" \
  -d '{"signedBy":"John Doe","signatureData":"base64..."}'
```

### Request OTP + verify
```bash
curl -X POST http://localhost:3000/api/installations/<jobId>/confirm/otp/request \
  -H "Authorization: Bearer $ACCESS"

curl -X POST http://localhost:3000/api/installations/<jobId>/confirm/otp/verify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS" \
  -d '{"otp":"123456"}'
```

## UI integration note
Slice B endpoints are now available. Keep `MOCK_MODE=true` for other modules, but you can switch to live for these endpoints once ready.

## Slice C API examples

### Admin login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"adonijahjuma@gmail.com","password":"Admin123!"}'
```

### List users
```bash
curl http://localhost:3000/api/users?role=Sales&page=1&pageSize=10 \
  -H "Authorization: Bearer <accessToken>"
```

### Create user
```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"name":"Jane Doe","email":"jane@finemark.com","role":"Sales","tempPassword":"Sales123!","forcePasswordReset":true}'
```

### Disable user
```bash
curl -X PATCH http://localhost:3000/api/users/<userId> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"status":"Disabled"}'
```

### Reset password
```bash
curl -X POST http://localhost:3000/api/users/<userId>/reset-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"tempPassword":"Temp123!","forcePasswordReset":true}'
```

### Audit logs
```bash
curl "http://localhost:3000/api/audit-logs?from=2026-01-01&to=2026-01-31&severity=Info" \
  -H "Authorization: Bearer <accessToken>"
```

### Admin login (for audit logs)
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"adonijahjuma@gmail.com","password":"Admin123!"}'
```

### Fetch audit logs (paged)
```bash
curl "http://localhost:3000/api/audit-logs?page=1&pageSize=25" \
  -H "Authorization: Bearer <accessToken>"
```

### Filter by severity
```bash
curl "http://localhost:3000/api/audit-logs?severity=Warning" \
  -H "Authorization: Bearer <accessToken>"
```

### Search by action/target
```bash
curl "http://localhost:3000/api/audit-logs?search=INSTALLATION" \
  -H "Authorization: Bearer <accessToken>"
```

### Finance summary
```bash
curl "http://localhost:3000/api/finance/summary" \
  -H "Authorization: Bearer <accessToken>"
```

Outstanding = SUM(invoice.amount − completed payments) for all invoices that are not Paid/Cancelled.

## Slice D API examples
## CRM records (Sales)

### Login as sales
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sales@finemark.com","password":"Sales123!"}'
```

### Create CRM record
```bash
curl -X POST http://localhost:3000/api/crm/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"type":"quotation","customer":"Northstar Ltd","location":"Nakuru","status":"Submitted","customerPhone":"+254700000000","customerEmail":"northstar@example.com","details":{"notes":"Pricing review","source":"sales-ui"}}'
```

### Create installation request (auto-creates installation job)
```bash
curl -X POST http://localhost:3000/api/crm/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"type":"installation","customer":"Acme Logistics","location":"Nairobi","customerPhone":"+254700000111","details":{"notes":"Priority install","priority":"High","preferredDate":"2026-02-05"}}'
```

### List CRM records (last 7 days)
```bash
curl "http://localhost:3000/api/crm/records?range=7d" \
  -H "Authorization: Bearer <accessToken>"
```

### Technical login -> list installation jobs
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"technical@finemark.com","password":"Tech123!"}'
```

```bash
curl "http://localhost:3000/api/installations?status=Requested" \
  -H "Authorization: Bearer <accessToken>"
```

### Assign technician to installation job
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/assign \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"technicianId":"<technicianUserId>","scheduledDate":"2026-02-05"}'
```

### Technician start job (InProgress)
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"status":"InProgress"}'
```

### Technician submit for confirmation (AwaitingConfirmation)
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"status":"AwaitingConfirmation"}'
```

### Technical reschedule
```bash
curl -X PATCH http://localhost:3000/api/installations/<jobId>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"status":"Rescheduled"}'
```

Completion requires confirmation endpoints:
- PATCH /api/installations/:id/confirm/signature
- POST /api/installations/:id/confirm/otp/request + /verify

### Finance login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"finance@finemark.com","password":"Finance123!"}'
```

### List invoices
```bash
curl "http://localhost:3000/api/invoices?status=Issued&page=1&pageSize=10" \
  -H "Authorization: Bearer <accessToken>"
```

### Create payment and update invoice status
```bash
curl -X POST http://localhost:3000/api/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"invoiceId":"<invoiceId>","amount":25000,"method":"Bank Transfer","status":"Completed"}'
```

### Sales login -> report JSON
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sales@finemark.com","password":"Sales123!"}'
```

```bash
curl "http://localhost:3000/api/reports/sales-by-bank?startDate=2026-01-01&endDate=2026-03-31" \
  -H "Authorization: Bearer <accessToken>"
```

### Export sales-by-bank CSV
```bash
curl "http://localhost:3000/api/reports/sales-by-bank.csv?startDate=2026-01-01&endDate=2026-03-31" \
  -H "Authorization: Bearer <accessToken>" \
  -o sales-by-bank.csv
```
