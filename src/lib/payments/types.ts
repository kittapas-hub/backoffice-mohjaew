// Provider-neutral payment domain types.
// No provider-specific fields. No secrets. No HTTP calls.

export type PaymentStatus =
  | "created"
  | "pending"
  | "paid"
  | "expired"
  | "failed"
  | "refunded"
  | "manual_review";

export type PaymentOrder = {
  id: string;
  booking_id: string;
  provider: string;
  provider_order_id: string | null;
  checkout_token: string;
  idempotency_key: string;
  amount_satang: number;
  currency: string;
  status: PaymentStatus;
  expires_at: string;
  paid_at: string | null;
  amount_received_satang: number | null;
  provider_paid_at: string | null;
  provider_payload: Record<string, unknown> | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookEventProcessingStatus =
  | "pending"
  | "processed"
  | "failed"
  | "skipped";

export type PaymentWebhookEvent = {
  id: string;
  provider: string;
  provider_event_id: string;
  payment_order_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  signature_verified: boolean;
  processing_status: WebhookEventProcessingStatus;
  processed_at: string | null;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationChannel = "line" | "facebook" | "sms" | "email";
export type NotificationRecipientType = "customer" | "team";
export type NotificationStatus = "pending" | "sent" | "failed" | "skipped";

export type NotificationDelivery = {
  id: string;
  booking_id: string;
  payment_order_id: string | null;
  channel: NotificationChannel;
  recipient_type: NotificationRecipientType;
  recipient_id: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown> | null;
  status: NotificationStatus;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

// Result type for create_payment_order RPC errors.
export type CreateOrderError =
  | "booking_not_found"
  | "booking_not_pending_payment"
  | "booking_hold_expired"
  | "active_order_exists"
  | "server_error";

// Result type for process_payment_paid_event RPC.
export type PaidEventResult =
  | { result: "ok"; booking_id: string }
  | { result: "already_processed" }
  | { result: "already_paid" }
  | { result: "manual_review"; reason: string }
  | { result: "skipped"; reason: string };
