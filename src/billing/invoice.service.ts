import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  BillingCycle,
  InvoiceLineType,
  LedgerDirection,
  LedgerEntryType,
  LeaseStatus,
} from '../../generated/prisma/client';

@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  async generateRentInvoice(leaseId: string, periodStartInput: string | Date) {
    const periodStart = this.toUtcDate(periodStartInput);

    return this.prisma.$transaction(async (tx) => {
      // Only one transaction can generate an invoice for this lease at a time.
      await tx.$queryRaw`
        SELECT "id"
        FROM "leases"
        WHERE "id" = ${leaseId}::uuid
        FOR UPDATE
      `;

      const lease = await tx.lease.findUnique({
        where: { id: leaseId },
      });

      if (!lease) {
        throw new NotFoundException(`Lease ${leaseId} was not found`);
      }

      const nextPeriodStart = this.calculateNextBillingDate(
        periodStart,
        lease.billingCycle,
      );

      const periodEnd = this.minimumDate(
        this.subtractOneDay(nextPeriodStart),
        lease.endDate,
      );

      // Return the existing invoice if this lease period was already processed.
      const existingInvoice = await tx.invoice.findUnique({
        where: {
          organizationId_leaseId_periodStart_periodEnd: {
            organizationId: lease.organizationId,
            leaseId: lease.id,
            periodStart,
            periodEnd,
          },
        },
        include: {
          lines: true,
          ledgerEntries: true,
        },
      });

      if (existingInvoice) {
        return existingInvoice;
      }

      if (lease.status !== LeaseStatus.ACTIVE) {
        throw new BadRequestException('Only active leases can be invoiced');
      }

      if (periodStart < lease.startDate || periodStart > lease.endDate) {
        throw new BadRequestException(
          'The billing period is outside the lease dates',
        );
      }

      if (
        !lease.nextInvoiceDate ||
        !this.isSameDate(lease.nextInvoiceDate, periodStart)
      ) {
        throw new BadRequestException(
          'The requested period does not match the lease billing schedule',
        );
      }

      const dueDate = this.addDays(periodStart, 5);
      const idempotencyKey = `rent-invoice:${lease.id}:${this.dateKey(periodStart)}`;

      const invoice = await tx.invoice.create({
        data: {
          organizationId: lease.organizationId,
          leaseId: lease.id,
          periodStart,
          periodEnd,
          issueDate: periodStart,
          dueDate,
          totalMinor: lease.rentAmountMinor,
          amountPaidMinor: BigInt(0),
          currencyCode: lease.currencyCode,

          lines: {
            create: {
              type: InvoiceLineType.RENT,
              description: `Rent for ${this.dateKey(periodStart)} to ${this.dateKey(periodEnd)}`,
              amountMinor: lease.rentAmountMinor,
            },
          },

          ledgerEntries: {
            create: {
              organizationId: lease.organizationId,
              entryType: LedgerEntryType.INVOICE,
              direction: LedgerDirection.DEBIT,
              amountMinor: lease.rentAmountMinor,
              currencyCode: lease.currencyCode,
              idempotencyKey,
              description: 'Rent invoice generated',
              metadata: {
                leaseId: lease.id,
                periodStart: this.dateKey(periodStart),
                periodEnd: this.dateKey(periodEnd),
              },
            },
          },
        },
        include: {
          lines: true,
          ledgerEntries: true,
        },
      });

      const followingInvoiceDate =
        nextPeriodStart <= lease.endDate ? nextPeriodStart : null;

      await tx.lease.update({
        where: { id: lease.id },
        data: {
          nextInvoiceDate: followingInvoiceDate,
        },
      });

      return invoice;
    });
  }

  private calculateNextBillingDate(
    date: Date,
    billingCycle: BillingCycle,
  ): Date {
    switch (billingCycle) {
      case BillingCycle.MONTHLY:
        return this.addMonths(date, 1);

      case BillingCycle.QUARTERLY:
        return this.addMonths(date, 3);

      case BillingCycle.ANNUAL:
        return this.addMonths(date, 12);
    }
  }

  private addMonths(date: Date, months: number): Date {
    const result = new Date(date);
    const originalDay = result.getUTCDate();

    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);

    const lastDayOfTargetMonth = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();

    result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));

    return result;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private subtractOneDay(date: Date): Date {
    return this.addDays(date, -1);
  }

  private minimumDate(first: Date, second: Date): Date {
    return first <= second ? first : second;
  }

  private toUtcDate(value: string | Date): Date {
    if (value instanceof Date) {
      return new Date(
        Date.UTC(
          value.getUTCFullYear(),
          value.getUTCMonth(),
          value.getUTCDate(),
        ),
      );
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid period start date');
    }

    return date;
  }

  private isSameDate(first: Date, second: Date): boolean {
    return this.dateKey(first) === this.dateKey(second);
  }

  private dateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
