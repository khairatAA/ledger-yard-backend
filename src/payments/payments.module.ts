import { Module } from '@nestjs/common';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';

@Module({
  controllers: [PaymentWebhookController],
  providers: [PaymentWebhookService],
  exports: [PaymentWebhookService],
})
export class PaymentsModule {}
