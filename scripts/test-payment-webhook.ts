import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { InvoiceStatus, PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';

const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error('PAYMENT_WEBHOOK_SECRET is missing from .env');
}

interface WebhookPayload {
  eventId: string;
  eventType: string;
  organizationId: string;
  invoiceId: string;
  tenantId: string;
  providerReference: string;
  amountMinor: string;
  currencyCode: string;
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  occurredAt: string;
}

async function sendWebhook(payload: WebhookPayload) {
  const rawBody = JSON.stringify(payload);

  const signature = createHmac('sha256', webhookSecret!)
    .update(rawBody)
    .digest('hex');

  const response = await fetch(`${baseUrl}/payments/webhooks/mock-provider`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signature,
    },
    body: rawBody,
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const responseBody = await response.json();

  return {
    statusCode: response.status,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    body: responseBody,
  };
}

async function main() {
  const invoice = await prisma.invoice.findFirst({
    where: {
      status: {
        in: [InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID],
      },
    },
    include: {
      lease: {
        select: {
          tenantId: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!invoice) {
    throw new Error(
      'No unpaid invoice was found. Ensure the seed and invoice job have run.',
    );
  }

  const outstandingMinor = invoice.totalMinor - invoice.amountPaidMinor;

  /*
   * Pay ₦100,000 or the remaining balance if it is lower.
   */
  const preferredPartialAmount = BigInt(10_000_000);

  const paymentAmount =
    outstandingMinor < preferredPartialAmount
      ? outstandingMinor
      : preferredPartialAmount;

  if (paymentAmount <= BigInt(0)) {
    throw new Error('The selected invoice is already paid');
  }

  const runId = Date.now().toString();
  const successfulTime = new Date();
  const olderTime = new Date(successfulTime.getTime() - 60 * 60 * 1000);

  const successfulPayload: WebhookPayload = {
    eventId: `event-success-${runId}`,
    eventType: 'payment.successful',
    organizationId: invoice.organizationId,
    invoiceId: invoice.id,
    tenantId: invoice.lease.tenantId,
    providerReference: `mock-payment-${runId}`,
    amountMinor: paymentAmount.toString(),
    currencyCode: invoice.currencyCode,
    status: 'SUCCESSFUL',
    occurredAt: successfulTime.toISOString(),
  };

  console.log('\n1. Sending successful webhook');

  const successfulResult = await sendWebhook(successfulPayload);

  console.log(successfulResult);

  console.log('\n2. Sending the same webhook again');

  const duplicateResult = await sendWebhook(successfulPayload);

  console.log(duplicateResult);

  const olderPayload: WebhookPayload = {
    ...successfulPayload,
    eventId: `event-old-pending-${runId}`,
    eventType: 'payment.pending',
    status: 'PENDING',
    occurredAt: olderTime.toISOString(),
  };

  console.log('\n3. Sending an older PENDING webhook');

  const olderResult = await sendWebhook(olderPayload);

  console.log(olderResult);

  const payment = await prisma.payment.findUnique({
    where: {
      provider_providerReference: {
        provider: 'MOCK_PROVIDER',
        providerReference: successfulPayload.providerReference,
      },
    },
    include: {
      allocations: true,
      ledgerEntries: true,
    },
  });

  const updatedInvoice = await prisma.invoice.findUnique({
    where: {
      id: invoice.id,
    },
  });

  const webhookEvents = await prisma.webhookEvent.findMany({
    where: {
      provider: 'MOCK_PROVIDER',
      providerEventId: {
        in: [successfulPayload.eventId, olderPayload.eventId],
      },
    },
    orderBy: {
      receivedAt: 'asc',
    },
  });

  console.log('\n4. Database result');

  console.log({
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          amountMinor: payment.amountMinor.toString(),
          allocationCount: payment.allocations.length,
          allocatedMinor: payment.allocations[0]?.amountMinor.toString() ?? '0',
          ledgerEntryCount: payment.ledgerEntries.length,
        }
      : null,

    invoice: updatedInvoice
      ? {
          id: updatedInvoice.id,
          status: updatedInvoice.status,
          totalMinor: updatedInvoice.totalMinor.toString(),
          amountPaidMinor: updatedInvoice.amountPaidMinor.toString(),
          outstandingMinor: (
            updatedInvoice.totalMinor - updatedInvoice.amountPaidMinor
          ).toString(),
        }
      : null,

    webhookEvents: webhookEvents.map((event) => ({
      eventId: event.providerEventId,
      status: event.processingStatus,
    })),
  });
}

main()
  .catch((error) => {
    console.error('\nWebhook test failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
