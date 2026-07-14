import 'dotenv/config';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { randomUUID, createHmac } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BillingCycle,
  InvoiceStatus,
  LeaseStatus,
  PaymentStatus,
  WebhookProcessingStatus,
} from '../generated/prisma/client';
import { PrismaModule } from '../src/database/prisma.module';
import { PrismaService } from '../src/database/prisma.service';
import { InvoiceService } from '../src/billing/invoice.service';
import { PaymentWebhookService } from '../src/payments/payment-webhook.service';
import { PaymentWebhookDto } from '../src/payments/dto/payment-webhook.dto';

describe('Billing and payment integration', () => {
  let testingModule: TestingModule;
  let prisma: PrismaService;
  let invoiceService: InvoiceService;
  let webhookService: PaymentWebhookService;

  let organizationId: string | undefined;
  let tenantId: string | undefined;

  const webhookSecret =
    process.env.PAYMENT_WEBHOOK_SECRET ?? 'local-test-webhook-secret';

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
        PrismaModule,
      ],
      providers: [InvoiceService, PaymentWebhookService],
    }).compile();

    await testingModule.init();

    prisma = testingModule.get(PrismaService);
    invoiceService = testingModule.get(InvoiceService);
    webhookService = testingModule.get(PaymentWebhookService);
  });

  afterEach(async () => {
    if (!organizationId) {
      return;
    }

    /*
     * Delete dependent financial records first to satisfy
     * foreign-key constraints.
     */
    await prisma.paymentAllocation.deleteMany({
      where: {
        payment: {
          organizationId,
        },
      },
    });

    await prisma.ledgerEntry.deleteMany({
      where: {
        organizationId,
      },
    });

    await prisma.webhookEvent.deleteMany({
      where: {
        organizationId,
      },
    });

    await prisma.payment.deleteMany({
      where: {
        organizationId,
      },
    });

    /*
     * Invoice lines are removed through the invoice's
     * ON DELETE CASCADE relationship.
     */
    await prisma.invoice.deleteMany({
      where: {
        organizationId,
      },
    });

    await prisma.lease.deleteMany({
      where: {
        organizationId,
      },
    });

    await prisma.unit.deleteMany({
      where: {
        property: {
          organizationId,
        },
      },
    });

    await prisma.property.deleteMany({
      where: {
        organizationId,
      },
    });

    await prisma.organization.delete({
      where: {
        id: organizationId,
      },
    });

    if (tenantId) {
      await prisma.user.delete({
        where: {
          id: tenantId,
        },
      });
    }

    organizationId = undefined;
    tenantId = undefined;
  });

  afterAll(async () => {
    await testingModule.close();
  });

  it('creates one invoice when the same period is processed concurrently', async () => {
    const fixture = await createFixture();

    const [firstResult, secondResult] = await Promise.all([
      invoiceService.generateRentInvoice(fixture.leaseId, fixture.periodStart),
      invoiceService.generateRentInvoice(fixture.leaseId, fixture.periodStart),
    ]);

    const invoices = await prisma.invoice.findMany({
      where: {
        organizationId: fixture.organizationId,
        leaseId: fixture.leaseId,
        periodStart: fixture.periodStart,
      },
      include: {
        lines: true,
        ledgerEntries: true,
      },
    });

    expect(firstResult.id).toBe(secondResult.id);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].lines).toHaveLength(1);
    expect(invoices[0].ledgerEntries).toHaveLength(1);
  });

  it('applies a successful payment only once when a webhook is delivered twice', async () => {
    const fixture = await createFixture();

    const invoice = await invoiceService.generateRentInvoice(
      fixture.leaseId,
      fixture.periodStart,
    );

    const payload: PaymentWebhookDto = {
      eventId: `event-${randomUUID()}`,
      eventType: 'payment.successful',
      organizationId: fixture.organizationId,
      invoiceId: invoice.id,
      tenantId: fixture.tenantId,
      providerReference: `payment-${randomUUID()}`,
      amountMinor: '10000000',
      currencyCode: 'NGN',
      status: 'SUCCESSFUL',
      occurredAt: new Date().toISOString(),
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = signWebhook(rawBody);

    const firstResult = await webhookService.handleWebhook(
      payload,
      rawBody,
      signature,
    );

    const duplicateResult = await webhookService.handleWebhook(
      payload,
      rawBody,
      signature,
    );

    const payment = await prisma.payment.findUnique({
      where: {
        provider_providerReference: {
          provider: 'MOCK_PROVIDER',
          providerReference: payload.providerReference,
        },
      },
      include: {
        allocations: true,
        ledgerEntries: true,
      },
    });

    const updatedInvoice = await prisma.invoice.findUniqueOrThrow({
      where: {
        id: invoice.id,
      },
    });

    const eventCount = await prisma.webhookEvent.count({
      where: {
        provider: 'MOCK_PROVIDER',
        providerEventId: payload.eventId,
      },
    });

    expect(firstResult.processed).toBe(true);
    expect(duplicateResult.duplicate).toBe(true);

    expect(eventCount).toBe(1);
    expect(payment?.status).toBe(PaymentStatus.SUCCESSFUL);
    expect(payment?.allocations).toHaveLength(1);
    expect(payment?.ledgerEntries).toHaveLength(1);

    expect(updatedInvoice.status).toBe(InvoiceStatus.PARTIALLY_PAID);

    expect(updatedInvoice.amountPaidMinor).toBe(BigInt(10_000_000));
  });

  it('ignores an older pending event received after a successful payment', async () => {
    const fixture = await createFixture();

    const invoice = await invoiceService.generateRentInvoice(
      fixture.leaseId,
      fixture.periodStart,
    );

    const successfulTime = new Date();
    const olderTime = new Date(successfulTime.getTime() - 60 * 60 * 1000);

    const providerReference = `payment-${randomUUID()}`;

    const successfulPayload: PaymentWebhookDto = {
      eventId: `success-${randomUUID()}`,
      eventType: 'payment.successful',
      organizationId: fixture.organizationId,
      invoiceId: invoice.id,
      tenantId: fixture.tenantId,
      providerReference,
      amountMinor: '10000000',
      currencyCode: 'NGN',
      status: 'SUCCESSFUL',
      occurredAt: successfulTime.toISOString(),
    };

    await sendWebhookToService(successfulPayload);

    const olderPayload: PaymentWebhookDto = {
      ...successfulPayload,
      eventId: `pending-${randomUUID()}`,
      eventType: 'payment.pending',
      status: 'PENDING',
      occurredAt: olderTime.toISOString(),
    };

    const olderResult = await sendWebhookToService(olderPayload);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: {
        provider_providerReference: {
          provider: 'MOCK_PROVIDER',
          providerReference,
        },
      },
      include: {
        allocations: true,
        ledgerEntries: true,
      },
    });

    const olderEvent = await prisma.webhookEvent.findUniqueOrThrow({
      where: {
        provider_providerEventId: {
          provider: 'MOCK_PROVIDER',
          providerEventId: olderPayload.eventId,
        },
      },
    });

    expect(olderResult.ignored).toBe(true);

    expect(payment.status).toBe(PaymentStatus.SUCCESSFUL);

    expect(payment.allocations).toHaveLength(1);
    expect(payment.ledgerEntries).toHaveLength(1);

    expect(olderEvent.processingStatus).toBe(WebhookProcessingStatus.IGNORED);
  });

  it('records a payment as unallocated credit when the invoice is already paid', async () => {
    const fixture = await createFixture();

    const invoice = await invoiceService.generateRentInvoice(
      fixture.leaseId,
      fixture.periodStart,
    );

    const firstPayment: PaymentWebhookDto = {
      eventId: `full-payment-${randomUUID()}`,
      eventType: 'payment.successful',
      organizationId: fixture.organizationId,
      invoiceId: invoice.id,
      tenantId: fixture.tenantId,
      providerReference: `payment-${randomUUID()}`,

      // Pay the complete ₦250,000 invoice.
      amountMinor: '25000000',

      currencyCode: 'NGN',
      status: 'SUCCESSFUL',
      occurredAt: new Date().toISOString(),
    };

    const firstResult = await sendWebhookToService(firstPayment);

    expect(firstResult.processed).toBe(true);
    expect(firstResult.allocatedMinor).toBe('25000000');
    expect(firstResult.unallocatedMinor).toBe('0');

    const secondPayment: PaymentWebhookDto = {
      eventId: `extra-payment-${randomUUID()}`,
      eventType: 'payment.successful',
      organizationId: fixture.organizationId,
      invoiceId: invoice.id,
      tenantId: fixture.tenantId,
      providerReference: `payment-${randomUUID()}`,

      // An additional ₦50,000 received after settlement.
      amountMinor: '5000000',

      currencyCode: 'NGN',
      status: 'SUCCESSFUL',
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
    };

    const secondResult = await sendWebhookToService(secondPayment);

    const updatedInvoice = await prisma.invoice.findUniqueOrThrow({
      where: {
        id: invoice.id,
      },
    });

    const extraPayment = await prisma.payment.findUniqueOrThrow({
      where: {
        provider_providerReference: {
          provider: 'MOCK_PROVIDER',
          providerReference: secondPayment.providerReference,
        },
      },
      include: {
        allocations: true,
        ledgerEntries: true,
      },
    });

    expect(secondResult.processed).toBe(true);
    expect(secondResult.allocatedMinor).toBe('0');
    expect(secondResult.unallocatedMinor).toBe('5000000');

    expect(updatedInvoice.status).toBe(InvoiceStatus.PAID);

    expect(updatedInvoice.amountPaidMinor).toBe(updatedInvoice.totalMinor);

    expect(extraPayment.status).toBe(PaymentStatus.SUCCESSFUL);

    /*
     * The extra payment is recorded and audited, but it is not
     * allocated to the already-settled invoice.
     */
    expect(extraPayment.allocations).toHaveLength(0);
    expect(extraPayment.ledgerEntries).toHaveLength(1);
  });

  async function createFixture() {
    organizationId = randomUUID();
    tenantId = randomUUID();

    const propertyId = randomUUID();
    const unitId = randomUUID();
    const leaseId = randomUUID();

    const periodStart = startOfUtcDay(new Date());
    const endDate = addYears(periodStart, 1);

    await prisma.organization.create({
      data: {
        id: organizationId,
        name: `Test Organization ${organizationId}`,
        status: 'ACTIVE',
      },
    });

    await prisma.user.create({
      data: {
        id: tenantId,
        email: `${tenantId}@ledgeryard.test`,
        fullName: 'Integration Test Tenant',
      },
    });

    await prisma.property.create({
      data: {
        id: propertyId,
        organizationId,
        name: 'Integration Test Property',
        propertyType: 'RESIDENTIAL',
        timezone: 'Africa/Lagos',
      },
    });

    await prisma.unit.create({
      data: {
        id: unitId,
        propertyId,
        name: 'Test Unit',
        baseRentMinor: BigInt(25_000_000),
        securityDepositMinor: BigInt(25_000_000),
        currencyCode: 'NGN',
        billingCycle: BillingCycle.MONTHLY,
        status: 'OCCUPIED',
      },
    });

    await prisma.lease.create({
      data: {
        id: leaseId,
        organizationId,
        unitId,
        tenantId,
        startDate: periodStart,
        endDate,
        rentAmountMinor: BigInt(25_000_000),
        securityDepositMinor: BigInt(25_000_000),
        currencyCode: 'NGN',
        billingCycle: BillingCycle.MONTHLY,
        nextInvoiceDate: periodStart,
        status: LeaseStatus.ACTIVE,
      },
    });

    return {
      organizationId,
      tenantId,
      propertyId,
      unitId,
      leaseId,
      periodStart,
    };
  }

  async function sendWebhookToService(payload: PaymentWebhookDto) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = signWebhook(rawBody);

    return webhookService.handleWebhook(payload, rawBody, signature);
  }

  function signWebhook(rawBody: Buffer): string {
    return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  }

  function startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  function addYears(date: Date, years: number): Date {
    const result = new Date(date);
    result.setUTCFullYear(result.getUTCFullYear() + years);
    return result;
  }
});
