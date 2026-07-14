import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { LeaseStatus } from '../../generated/prisma/client';
import {
  GENERATE_RENT_INVOICE_JOB,
  RENT_INVOICE_QUEUE,
  SCAN_DUE_LEASES_JOB,
} from './invoice.constants';

@Injectable()
export class InvoiceScheduler implements OnModuleInit {
  private readonly logger = new Logger(InvoiceScheduler.name);

  constructor(
    @InjectQueue(RENT_INVOICE_QUEUE)
    private readonly invoiceQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Run the reconciliation scan every day at midnight.
    await this.invoiceQueue.upsertJobScheduler(
      'daily-rent-invoice-scan',
      {
        pattern: '0 0 * * *',
        tz: 'Africa/Lagos',
      },
      {
        name: SCAN_DUE_LEASES_JOB,
        data: {},
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5_000,
          },
          removeOnComplete: {
            age: 86_400,
            count: 100,
          },
          removeOnFail: {
            age: 604_800,
          },
        },
      },
    );

    // Also run once when the application starts.
    // const today = this.dateKey(new Date());

    await this.invoiceQueue.add(
      SCAN_DUE_LEASES_JOB,
      {},
      {
        // jobId: `invoice-scan-${today}`, // restarting the application on the same day may not enqueue another scan.
        jobId: `invoice-scan-startup-${Date.now()}`, // unique job ID to ensure it runs on every startup
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5_000,
        },
        removeOnComplete: {
          age: 86_400,
        },
        removeOnFail: {
          age: 604_800,
        },
      },
    );
  }

  async enqueueDueInvoiceJobs() {
    const today = this.startOfUtcDay(new Date());

    const dueLeases = await this.prisma.lease.findMany({
      where: {
        status: LeaseStatus.ACTIVE,
        nextInvoiceDate: {
          not: null,
          lte: today,
        },
      },
      select: {
        id: true,
        organizationId: true,
        nextInvoiceDate: true,
      },
    });

    if (dueLeases.length === 0) {
      this.logger.log('No leases are currently due for invoicing');
      return 0;
    }

    await this.invoiceQueue.addBulk(
      dueLeases.map((lease) => {
        const periodStart = this.dateKey(lease.nextInvoiceDate!);

        return {
          name: GENERATE_RENT_INVOICE_JOB,
          data: {
            leaseId: lease.id,
            periodStart,
          },
          opts: {
            jobId: [
              'rent-invoice',
              lease.organizationId,
              lease.id,
              periodStart,
            ].join('-'),
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: 5_000,
            },
            removeOnComplete: {
              age: 86_400,
              count: 1_000,
            },
            removeOnFail: {
              age: 604_800,
            },
          },
        };
      }),
    );

    this.logger.log(`Queued ${dueLeases.length} rent invoice job(s)`);

    return dueLeases.length;
  }

  async enqueueNextInvoiceIfOverdue(leaseId: string) {
    const lease = await this.prisma.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        nextInvoiceDate: true,
      },
    });

    if (
      !lease ||
      lease.status !== LeaseStatus.ACTIVE ||
      !lease.nextInvoiceDate
    ) {
      return;
    }

    const today = this.startOfUtcDay(new Date());

    if (lease.nextInvoiceDate > today) {
      return;
    }

    const periodStart = this.dateKey(lease.nextInvoiceDate);

    await this.invoiceQueue.add(
      GENERATE_RENT_INVOICE_JOB,
      {
        leaseId: lease.id,
        periodStart,
      },
      {
        jobId: [
          'rent-invoice',
          lease.organizationId,
          lease.id,
          periodStart,
        ].join('-'),
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5_000,
        },
        removeOnComplete: {
          age: 86_400,
          count: 1_000,
        },
        removeOnFail: {
          age: 604_800,
        },
      },
    );
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private dateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
