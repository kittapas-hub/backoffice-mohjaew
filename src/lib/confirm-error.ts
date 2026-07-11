// Maps transition_slot_booking() RPC errors to UI codes + Thai messages.
// Pure (no imports) so it's shared by server actions, pages, and tests.

export type TransitionErrorCode =
  | "slot_full"
  | "invalid_transition"
  | "not_found"
  | "hold_expired"
  | "server_error";

export function mapTransitionError(message?: string | null): TransitionErrorCode {
  const m = message ?? "";
  if (m.includes("hold_expired")) return "hold_expired";
  if (m.includes("slot_full")) return "slot_full";
  if (m.includes("invalid_transition") || m.includes("not_slot_booking")) {
    return "invalid_transition";
  }
  if (m.includes("booking_not_found")) return "not_found";
  return "server_error";
}

export const TRANSITION_ERROR_TH: Record<TransitionErrorCode, string> = {
  slot_full: "ทำรายการไม่สำเร็จ: รอบนี้เต็มแล้ว",
  invalid_transition: "ทำรายการไม่สำเร็จ: เปลี่ยนสถานะนี้ไม่ได้",
  not_found: "ทำรายการไม่สำเร็จ: ไม่พบรายการจอง",
  hold_expired:
    "ทำรายการไม่สำเร็จ: หมดเวลาถือคิวแล้ว ไม่สามารถยืนยันการชำระเงินนี้ได้ กรุณาให้ลูกค้าจองคิวใหม่",
  server_error: "ทำรายการไม่สำเร็จ: เกิดข้อผิดพลาด กรุณาลองใหม่",
};
