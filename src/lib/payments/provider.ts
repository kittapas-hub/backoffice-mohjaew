// Provider contract interface. Implement one of these per real payment provider.
// No KBank / KGP / Omise / Stripe implementation lives here.
// No secrets, no HTTP calls, no provider-specific fields.
//
// Add the first implementation when a payment provider is approved:
//   src/lib/payments/providers/kbank.ts   (KBank KGP)
//   src/lib/payments/providers/omise.ts   (Omise)
//   etc.

import type { PaymentOrder } from "./types.ts";

export type CheckoutResult =
  | { ok: true; providerOrderId: string; checkoutUrl: string }
  | { ok: false; error: string };

export type WebhookVerifyResult =
  | { ok: true; eventId: string; eventType: string; payload: Record<string, unknown> }
  | { ok: false; error: string };

export type InquireResult =
  | {
      ok: true;
      paid: boolean;
      amountSatang: number;
      paidAt: Date | null;
      payload: Record<string, unknown>;
    }
  | { ok: false; error: string };

// Future provider implementations must satisfy this interface.
export interface PaymentProvider {
  /** Short identifier stored in payment_orders.provider. */
  readonly name: string;

  /** Create a checkout session / payment link / dynamic QR at the provider.
   *  Called after create_payment_order succeeds. */
  createCheckout(order: PaymentOrder): Promise<CheckoutResult>;

  /** Verify the provider's webhook signature and extract the event.
   *  Must be called before process_payment_paid_event.
   *  Never trust a webhook payload that fails this check. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): Promise<WebhookVerifyResult>;

  /** Pull payment status from the provider (for reconciliation / polling). */
  inquirePayment(providerOrderId: string): Promise<InquireResult>;
}

// Placeholder name used when no real provider is connected.
// Any payment order with this provider name was created in test/dev mode.
export const PROVIDER_PLACEHOLDER = "placeholder" as const;
