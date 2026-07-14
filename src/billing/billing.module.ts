import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InvoiceService } from './invoice.service';
import { InvoiceScheduler } from './invoice.scheduler';
import { InvoiceProcessor } from './invoice.processor';
import { RENT_INVOICE_QUEUE } from './invoice.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: RENT_INVOICE_QUEUE,
    }),
  ],
  providers: [InvoiceService, InvoiceScheduler, InvoiceProcessor],
  exports: [InvoiceService],
})
export class BillingModule {}
