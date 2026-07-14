import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  InvoiceStatus,
  LedgerDirection,
  LedgerEntryType,
  PaymentMethod,
  PaymentStatus,
  WebhookProcessingStatus,
} from '../../generated/prisma/client';
import {
  PaymentWebhookDto,
  WebhookPaymentStatus,
} from './dto/payment-webhook.dto';

export interface PaymentWebhookResult {
  processed: boolean;
  duplicate: boolean;
  ignored: boolean;
  reason?: string;
  paymentId?: string;
  allocatedMinor?: string;
  unallocatedMinor?: string;
}

@Injectable()
export class PaymentWebhookService {
  private readonly provider = 'MOCK_PROVIDER';

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async handleWebhook(
    payload: PaymentWebhookDto,
    rawBody: Buffer,
    signature?: string,
  ): Promise<PaymentWebhookResult> {
    this.verifySignature(rawBody, signature);
    this.validatePayload(payload);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const webhookEvent = await tx.webhookEvent.create({
          data: {
            organizationId: payload.organizationId,
            provider: this.provider,
            providerEventId: payload.eventId,
            eventType: payload.eventType,
            payload: { ...payload },
            processingStatus: WebhookProcessingStatus.RECEIVED,
          },
        });

        /*
         * Serialise payment allocations made against the same
         * invoice.
         */
        await tx.$queryRaw`
          SELECT "id"
          FROM "invoices"
          WHERE "id" = ${payload.invoiceId}::uuid
          FOR UPDATE
        `;

        const invoice = await tx.invoice.findUnique({
          where: {
            id: payload.invoiceId,
          },
          include: {
            lease: {
              select: {
                tenantId: true,
              },
            },
          },
        });

        if (!invoice) {
          throw new BadRequestException('Invoice was not found');
        }

        if (invoice.organizationId !== payload.organizationId) {
          throw new BadRequestException(
            'Invoice does not belong to the organization',
          );
        }

        if (invoice.lease.tenantId !== payload.tenantId) {
          throw new BadRequestException(
            'Invoice does not belong to the tenant',
          );
        }

        const amountMinor = this.parseAmount(payload.amountMinor);

        if (invoice.currencyCode !== payload.currencyCode) {
          throw new BadRequestException(
            'Payment and invoice currencies do not match',
          );
        }

        const incomingStatus = this.mapPaymentStatus(payload.status);

        const occurredAt = new Date(payload.occurredAt);

        if (Number.isNaN(occurredAt.getTime())) {
          throw new BadRequestException('occurredAt must be a valid date');
        }

        let payment = await tx.payment.findUnique({
          where: {
            provider_providerReference: {
              provider: this.provider,
              providerReference: payload.providerReference,
            },
          },
        });

        if (!payment) {
          payment = await tx.payment.create({
            data: {
              organizationId: payload.organizationId,
              tenantId: payload.tenantId,
              provider: this.provider,
              providerReference: payload.providerReference,
              paymentMethod: PaymentMethod.CARD,
              amountMinor,
              currencyCode: payload.currencyCode,
              status: PaymentStatus.PENDING,
            },
          });
        } else {
          this.validateExistingPayment(payment, {
            organizationId: payload.organizationId,
            tenantId: payload.tenantId,
            amountMinor,
            currencyCode: payload.currencyCode,
          });
        }

        if (
          this.shouldIgnoreEvent(
            payment.status,
            payment.providerUpdatedAt,
            incomingStatus,
            occurredAt,
          )
        ) {
          await tx.webhookEvent.update({
            where: {
              id: webhookEvent.id,
            },
            data: {
              processingStatus: WebhookProcessingStatus.IGNORED,
              processedAt: new Date(),
            },
          });

          return {
            processed: false,
            duplicate: false,
            ignored: true,
            reason: 'Out-of-order or invalid status change',
          };
        }

        payment = await tx.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: incomingStatus,
            providerUpdatedAt: occurredAt,
            paidAt:
              incomingStatus === PaymentStatus.SUCCESSFUL
                ? occurredAt
                : payment.paidAt,
          },
        });

        let allocatedMinor = BigInt(0);

        if (incomingStatus === PaymentStatus.SUCCESSFUL) {
          allocatedMinor = await this.applySuccessfulPayment(tx, {
            paymentId: payment.id,
            organizationId: payload.organizationId,
            invoiceId: invoice.id,
            paymentAmountMinor: amountMinor,
            invoiceTotalMinor: invoice.totalMinor,
            invoiceAmountPaidMinor: invoice.amountPaidMinor,
            currencyCode: payload.currencyCode,
            providerReference: payload.providerReference,
          });
        }

        await tx.webhookEvent.update({
          where: {
            id: webhookEvent.id,
          },
          data: {
            processingStatus: WebhookProcessingStatus.PROCESSED,
            processedAt: new Date(),
          },
        });

        return {
          processed: true,
          duplicate: false,
          ignored: false,
          paymentId: payment.id,
          allocatedMinor: allocatedMinor.toString(),
          unallocatedMinor:
            incomingStatus === PaymentStatus.SUCCESSFUL
              ? (amountMinor - allocatedMinor).toString()
              : '0',
        };
      });
    } catch (error) {
      /*
       * P2002 is Prisma's unique-constraint error. In this
       * flow it means the provider event was already stored.
       */
      if (this.isUniqueConstraintError(error)) {
        return {
          processed: false,
          duplicate: true,
          ignored: false,
        };
      }

      throw error;
    }
  }

  private async applySuccessfulPayment(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    input: {
      paymentId: string;
      organizationId: string;
      invoiceId: string;
      paymentAmountMinor: bigint;
      invoiceTotalMinor: bigint;
      invoiceAmountPaidMinor: bigint;
      currencyCode: string;
      providerReference: string;
    },
  ): Promise<bigint> {
    /*
     * The full successful payment is recorded in the ledger,
     * even when part of it remains unallocated.
     */
    await tx.ledgerEntry.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: `payment-${input.providerReference}-received`,
        },
      },
      update: {},
      create: {
        organizationId: input.organizationId,
        paymentId: input.paymentId,
        entryType: LedgerEntryType.PAYMENT,
        direction: LedgerDirection.CREDIT,
        amountMinor: input.paymentAmountMinor,
        currencyCode: input.currencyCode,
        idempotencyKey: `payment-${input.providerReference}-received`,
        description: 'Payment received',
      },
    });

    const outstandingMinor =
      input.invoiceTotalMinor - input.invoiceAmountPaidMinor;

    /*
     * A fully settled invoice receives no further allocation.
     * The new payment remains available as tenant credit.
     */
    if (outstandingMinor <= BigInt(0)) {
      return BigInt(0);
    }

    const allocationAmount =
      input.paymentAmountMinor < outstandingMinor
        ? input.paymentAmountMinor
        : outstandingMinor;

    const existingAllocation = await tx.paymentAllocation.findUnique({
      where: {
        paymentId_invoiceId: {
          paymentId: input.paymentId,
          invoiceId: input.invoiceId,
        },
      },
    });

    if (existingAllocation) {
      return existingAllocation.amountMinor;
    }

    await tx.paymentAllocation.create({
      data: {
        paymentId: input.paymentId,
        invoiceId: input.invoiceId,
        amountMinor: allocationAmount,
      },
    });

    const updatedAmountPaid = input.invoiceAmountPaidMinor + allocationAmount;

    const newInvoiceStatus =
      updatedAmountPaid >= input.invoiceTotalMinor
        ? InvoiceStatus.PAID
        : InvoiceStatus.PARTIALLY_PAID;

    await tx.invoice.update({
      where: {
        id: input.invoiceId,
      },
      data: {
        amountPaidMinor: updatedAmountPaid,
        status: newInvoiceStatus,
      },
    });

    return allocationAmount;
  }

  private shouldIgnoreEvent(
    currentStatus: PaymentStatus,
    providerUpdatedAt: Date | null,
    incomingStatus: PaymentStatus,
    occurredAt: Date,
  ): boolean {
    if (providerUpdatedAt && occurredAt <= providerUpdatedAt) {
      return true;
    }

    // A completed payment must not move back to pending or failed.
    if (
      currentStatus === PaymentStatus.SUCCESSFUL &&
      incomingStatus !== PaymentStatus.SUCCESSFUL
    ) {
      return true;
    }

    // A failed payment should not move backwards to pending.
    if (
      currentStatus === PaymentStatus.FAILED &&
      incomingStatus === PaymentStatus.PENDING
    ) {
      return true;
    }

    return false;
  }

  private validateExistingPayment(
    payment: {
      organizationId: string;
      tenantId: string;
      amountMinor: bigint;
      currencyCode: string;
    },
    expected: {
      organizationId: string;
      tenantId: string;
      amountMinor: bigint;
      currencyCode: string;
    },
  ) {
    const doesNotMatch =
      payment.organizationId !== expected.organizationId ||
      payment.tenantId !== expected.tenantId ||
      payment.amountMinor !== expected.amountMinor ||
      payment.currencyCode !== expected.currencyCode;

    if (doesNotMatch) {
      throw new BadRequestException(
        'Webhook details do not match the existing payment',
      );
    }
  }

  private verifySignature(rawBody: Buffer, receivedSignature?: string) {
    if (!receivedSignature) {
      throw new UnauthorizedException('Webhook signature is missing');
    }

    const secret = this.configService.getOrThrow<string>(
      'PAYMENT_WEBHOOK_SECRET',
    );

    const expectedSignature = createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const receivedBuffer = Buffer.from(receivedSignature, 'utf8');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Webhook signature is invalid');
    }
  }

  private validatePayload(payload: PaymentWebhookDto) {
    const requiredValues = [
      payload.eventId,
      payload.eventType,
      payload.organizationId,
      payload.invoiceId,
      payload.tenantId,
      payload.providerReference,
      payload.amountMinor,
      payload.currencyCode,
      payload.status,
      payload.occurredAt,
    ];

    if (requiredValues.some((value) => !value)) {
      throw new BadRequestException('Webhook payload is incomplete');
    }
  }

  private parseAmount(value: string): bigint {
    try {
      const amount = BigInt(value);

      if (amount <= BigInt(0)) {
        throw new Error();
      }

      return amount;
    } catch {
      throw new BadRequestException(
        'amountMinor must be a positive integer string',
      );
    }
  }

  private mapPaymentStatus(status: WebhookPaymentStatus): PaymentStatus {
    switch (status) {
      case 'PENDING':
        return PaymentStatus.PENDING;

      case 'SUCCESSFUL':
        return PaymentStatus.SUCCESSFUL;

      case 'FAILED':
        return PaymentStatus.FAILED;

      default:
        throw new BadRequestException(
          `Unsupported payment status: ${String(status)}`,
        );
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
