export type WebhookPaymentStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export interface PaymentWebhookDto {
  eventId: string;
  eventType: string;
  organizationId: string;
  invoiceId: string;
  tenantId: string;
  providerReference: string;

  /*
   * Money is sent as a string because large integers should
   * not pass through JavaScript floating-point conversion.
   */
  amountMinor: string;

  currencyCode: string;
  status: WebhookPaymentStatus;
  occurredAt: string;
}
