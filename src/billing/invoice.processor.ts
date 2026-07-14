import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InvoiceService } from './invoice.service';
import { InvoiceScheduler } from './invoice.scheduler';
import {
  GENERATE_RENT_INVOICE_JOB,
  RENT_INVOICE_QUEUE,
  SCAN_DUE_LEASES_JOB,
} from './invoice.constants';

interface GenerateInvoiceJobData {
  leaseId: string;
  periodStart: string;
}

@Processor(RENT_INVOICE_QUEUE, {
  concurrency: 5,
})
export class InvoiceProcessor extends WorkerHost {
  private readonly logger = new Logger(InvoiceProcessor.name);

  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly invoiceScheduler: InvoiceScheduler,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case SCAN_DUE_LEASES_JOB:
        return this.processDueLeaseScan(job);

      case GENERATE_RENT_INVOICE_JOB:
        return this.processInvoiceGeneration(
          job as Job<GenerateInvoiceJobData>,
        );

      default:
        throw new Error(`Unsupported invoice job: ${job.name}`);
    }
  }

  private async processDueLeaseScan(job: Job) {
    this.logger.log(`Scanning for due leases. Job ID: ${job.id}`);

    const queuedJobs = await this.invoiceScheduler.enqueueDueInvoiceJobs();

    return {
      queuedJobs,
    };
  }

  private async processInvoiceGeneration(job: Job<GenerateInvoiceJobData>) {
    const { leaseId, periodStart } = job.data;

    if (!leaseId || !periodStart) {
      throw new Error('Invoice job requires leaseId and periodStart');
    }

    this.logger.log(
      `Generating invoice for lease ${leaseId}, period ${periodStart}`,
    );

    const invoice = await this.invoiceService.generateRentInvoice(
      leaseId,
      periodStart,
    );

    /*
     * If the application was unavailable for several billing
     * periods, enqueue the next overdue period immediately.
     */
    await this.invoiceScheduler.enqueueNextInvoiceIfOverdue(leaseId);

    this.logger.log(`Invoice ${invoice.id} processed for lease ${leaseId}`);

    return {
      invoiceId: invoice.id,
      leaseId,
      periodStart,
    };
  }
}
