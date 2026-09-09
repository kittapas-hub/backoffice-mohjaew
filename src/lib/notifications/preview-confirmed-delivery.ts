import { APP_URL } from "@/lib/env";
import { pushImageMessage, pushMessage, validateLineGroupId } from "@/lib/line";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  renderBookingConfirmedMessage,
  type ClaimedRow,
} from "@/lib/notifications/delivery-worker";

const IMAGE_URL_TTL_SECONDS = 300;

type PreviewImageRow = {
  id: string;
  image_kind: "face" | "payment_slip";
  storage_path: string;
  line_retry_key: string;
  status: string;
};

function imageBucket(kind: PreviewImageRow["image_kind"]): string {
  return kind === "face" ? "booking-faces" : "payment-slips";
}

async function markDeliverySent(id: string): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("notification_deliveries")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })    .eq("id", id)
    .eq("delivery_scope", "preview");
  if (error) {
    console.error("preview_notification_mark_sent_failed");
    return false;
  }
  return true;
}

async function markImageSent(id: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from("notification_image_deliveries")
    .update({
      status: "sent",
      sent_at: now,
      last_error: null,
      locked_by: null,
      locked_at: null,
      updated_at: now,
    })
    .eq("id", id);
  if (error) console.error("preview_notification_image_mark_sent_failed");
}

export async function deliverPreviewBookingConfirmed(bookingId: string): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const groupId = validateLineGroupId(process.env.LINE_BOOKING_GROUP_ID);
  if (!groupId) return;

  const db = supabaseAdmin();  const { data: delivery, error: deliveryError } = await db
    .from("notification_deliveries")
    .select(
      "id, booking_id, payment_order_id, channel, event_type, payload, idempotency_key, attempt_count, line_retry_key, status",
    )
    .eq("booking_id", bookingId)
    .eq("delivery_scope", "preview")
    .eq("event_type", "booking_confirmed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (deliveryError || !delivery) {
    console.error("preview_notification_delivery_not_found");
    return;
  }

  const row = delivery as ClaimedRow & { status: string };
  if (row.status !== "sent") {
    const textResult = await pushMessage(
      groupId,
      renderBookingConfirmedMessage(row, APP_URL || undefined),
      row.line_retry_key,
    );
    if (!textResult.ok) {
      console.error("preview_notification_text_push_failed");
      return;
    }
    if (!(await markDeliverySent(row.id))) return;
  }

  const { data: images, error: imageError } = await db    .from("notification_image_deliveries")
    .select("id, image_kind, storage_path, line_retry_key, status")
    .eq("notification_delivery_id", row.id)
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true });

  if (imageError) {
    console.error("preview_notification_image_query_failed");
    return;
  }

  for (const image of (images ?? []) as PreviewImageRow[]) {
    const { data: signed, error: signError } = await db.storage
      .from(imageBucket(image.image_kind))
      .createSignedUrl(image.storage_path, IMAGE_URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl) {
      console.error("preview_notification_image_sign_failed");
      continue;
    }

    const push = await pushImageMessage(groupId, signed.signedUrl, image.line_retry_key);
    if (!push.ok) {
      console.error("preview_notification_image_push_failed");
      continue;
    }
    await markImageSent(image.id);
  }
}
