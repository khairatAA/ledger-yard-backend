import * as common from '@nestjs/common';
import { Request } from 'express';
import * as paymentWebhookDto from './dto/payment-webhook.dto';
import { PaymentWebhookService } from './payment-webhook.service';

@common.Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(private readonly webhookService: PaymentWebhookService) {}

  @common.Post('mock-provider')
  @common.HttpCode(common.HttpStatus.OK)
  async handleMockProviderWebhook(
    @common.Req() request: common.RawBodyRequest<Request>,
    @common.Body() payload: paymentWebhookDto.PaymentWebhookDto,
    @common.Headers('x-mock-signature') signature?: string,
  ) {
    if (!request.rawBody) {
      throw new common.BadRequestException('Raw webhook body is unavailable');
    }

    return this.webhookService.handleWebhook(
      payload,
      request.rawBody,
      signature,
    );
  }
}
