# LedgerYard Backend

A partial implementation of LedgerYard, a multi tenant property rental and payment platform.

This project focuses on the financially sensitive parts of the system: recurring rent invoice generation, payment webhook processing, idempotency and auditability.

## Implemented Scope

The implementation includes:

- Core PostgreSQL models for organisations, properties, units, leases, invoices and payments
- Invoice lines, payment allocations and append only ledger entries
- BullMQ based rent invoice scheduling and processing
- Idempotent invoice generation
- Mock payment provider webhook endpoint
- Webhook signature verification
- Duplicate and out-of-order webhook protection
- Partial payment allocation
- Handling of payments received after an invoice is settled
- Integration tests for the main financial edge cases

## Technology

- NestJS
- TypeScript
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ
- Jest

## Project Structure

```text
src/
├── billing/
│   ├── billing.module.ts
│   ├── invoice.constants.ts
│   ├── invoice.processor.ts
│   ├── invoice.scheduler.ts
│   └── invoice.service.ts
├── database/
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── payments/
│   ├── dto/
│   │   └── payment-webhook.dto.ts
│   ├── payment-webhook.controller.ts
│   ├── payment-webhook.service.ts
│   └── payments.module.ts
├── app.module.ts
└── main.ts

prisma/
├── migrations/
├── schema.prisma
└── seed.ts

scripts/
└── test-payment-webhook.ts

test/
├── billing-payment.integration.spec.ts
└── jest-e2e.json
```

## Main Design Decisions

### Tenant Isolation

Each organisation owned financial record contains an `organization_id`. Queries validate the organisation before processing leases, invoices or payments.

Authentication is outside the implementation scope, so the sample webhook contains an organisation ID. In a complete application, the organisation context for user requests would come from the authenticated membership rather than the request body.

### Money Representation

Money is stored as integer minor units rather than floating point values.

For example:

```text
₦250,000 = 25,000,000 kobo
```

Each lease, invoice, payment and ledger entry also stores its currency code.

### Invoice Idempotency

The invoice scheduler creates a deterministic BullMQ job ID from the organisation, lease and billing period.

PostgreSQL also enforces:

```sql
UNIQUE (organization_id, lease_id, period_start, period_end)
```

The invoice processor locks the lease row and creates the invoice, invoice line and ledger entry in one transaction. If the job is retried after a restart, the existing invoice is returned.

A recurring scan finds active leases with overdue `next_invoice_date` values and enqueues missing invoice jobs.

### Payment Idempotency

Webhook events are protected by:

```sql
UNIQUE (provider, provider_event_id)
```

Payments are protected by:

```sql
UNIQUE (provider, provider_reference)
```

Payment recording, allocation, invoice updates, ledger creation and webhook completion happen inside a PostgreSQL transaction.

A successful payment cannot move backwards to `PENDING` or `FAILED`. Events older than the payment’s latest provider timestamp are stored as ignored events.

If an invoice is already settled, a new payment is recorded but not allocated to that invoice. The unallocated amount can later be reviewed, refunded or applied as tenant credit.

## Requirements

Install the following:

- Node.js
- npm
- PostgreSQL
- Docker Desktop

Docker is used to run Redis locally. PostgreSQL may run locally or through any accessible PostgreSQL instance.

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/khairatAA/ledger-yard-backend
cd ledger-yard-backend
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

Update `DATABASE_URL` in `.env` with your PostgreSQL username, password and database name.

Create an empty PostgreSQL database named:

```text
ledgeryard_db
```

## Start Redis

Ensure Docker Desktop is running, then start Redis:

```bash
docker compose up -d
```

Verify the container:

```bash
docker compose ps
```

Test Redis:

```bash
docker exec -it ledgeryard-redis redis-cli ping
```

Expected response:

```text
PONG
```

## Database Setup

Apply the committed migrations:

```bash
npx prisma migrate deploy
```

Generate the Prisma client:

```bash
npx prisma generate
```

Seed an organisation, tenant, property, unit and active lease:

```bash
npx prisma db seed
```

The sample lease has a due `next_invoice_date`, so the startup reconciliation scan will enqueue its first invoice.

## Run the Application

Start in development mode:

```bash
npm run start:dev
```

The application runs at:

```text
http://localhost:3000
```

On startup, the invoice queue scans for leases that are due for invoicing.

## Payment Webhook

The mock provider endpoint is:

```http
POST /payments/webhooks/mock-provider
```

Required header:

```http
x-mock-signature: <HMAC-SHA256 signature>
```

The signature is calculated from the raw request body using `PAYMENT_WEBHOOK_SECRET`.

Example payload:

```json
{
  "eventId": "event-123",
  "eventType": "payment.successful",
  "organizationId": "organization-uuid",
  "invoiceId": "invoice-uuid",
  "tenantId": "tenant-uuid",
  "providerReference": "payment-reference-123",
  "amountMinor": "10000000",
  "currencyCode": "NGN",
  "status": "SUCCESSFUL",
  "occurredAt": "2026-07-14T10:00:00.000Z"
}
```

The included script finds an unpaid invoice, signs the request and verifies successful, duplicate and out-of-order webhook delivery:

```bash
npm run test:webhook
```

The application must be running before using this command.

## Tests

PostgreSQL must be running and migrated before running the integration tests.

Run:

```bash
npm run test:integration
```

The test suite covers:

- Concurrent processing of the same invoice period
- Duplicate payment webhook delivery
- Out-of-order payment events
- Payment received after an invoice is already settled

The tests create isolated records and clean them up afterward.

## Known Limitations

- The payment provider is mocked.
- Security deposits are not yet posted to a separate liability account.
- Cross-currency payment allocation is not supported.
- Prorated rent is not implemented.
- Refund and reversal ledger flows are left for a future phase.
- Authentication and PostgreSQL Row-Level Security are not implemented in this partial code sample.
