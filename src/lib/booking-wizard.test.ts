import assert from "node:assert";
import {
  BOOKING_PHONE_MAX_LENGTH,
  BOOKING_WIZARD_STEPS,
  canContinueWizard,
  canSubmitBooking,
  getWizardStepStatus,
  invalidateSlotSelection,
  nextWizardStep,
  previousWizardStep,
  sanitizeBookingPhone,
  type BookingWizardState,
} from "./booking-wizard.ts";

assert.equal(BOOKING_PHONE_MAX_LENGTH, 15);
assert.equal(sanitizeBookingPhone("081-234-5678 ext. 9"), "08123456789");
assert.equal(sanitizeBookingPhone("phone: (081) 234-5678"), "0812345678");
assert.equal(sanitizeBookingPhone("0abc!@#$%^&*()"), "0", "leading zero must be preserved");
assert.equal(
  sanitizeBookingPhone("01234567890123456789"),
  "012345678901234",
  "controlled phone state must never exceed the server's 15-digit limit",
);

assert.deepEqual(
  BOOKING_WIZARD_STEPS.map((step) => step.label),
  [
    "เลือกวัน",
    "เลือกรอบเวลา",
    "ข้อมูลผู้จอง",
    "รูปหน้าและตรวจสอบ",
    "ยืนยันและชำระเงิน",
  ],
  "the public wizard keeps the approved five semantic stages",
);

const slotId = "11111111-1111-4111-8111-111111111111";
const otherSlotId = "22222222-2222-4222-8222-222222222222";
const base: BookingWizardState = {
  date: "2026-09-10",
  slotId: "",
  availableSlotIds: [slotId],
  nickname: "",
  phone: "",
  birthDateText: "",
  faceReady: false,
};

assert.equal(canContinueWizard(1, base), true, "a selected date can advance");
assert.equal(nextWizardStep(1, base), 2);
assert.equal(canContinueWizard(2, base), false, "slot selection is required");
assert.equal(nextWizardStep(2, base), 2, "blocked steps do not advance");

const withSlot = { ...base, slotId };
assert.equal(canContinueWizard(2, withSlot), true, "a selected slot can advance");
assert.equal(nextWizardStep(2, withSlot), 3);

const withInfo = {
  ...withSlot,
  nickname: "แจว",
  phone: "081-234-5678",
  birthDateText: "1 มกราคม 2540",
};
assert.equal(canContinueWizard(3, withInfo), true);
assert.equal(nextWizardStep(3, withInfo), 4);
assert.equal(canContinueWizard(4, withInfo), false, "face photo is required");

const ready = { ...withInfo, faceReady: true };
assert.equal(canSubmitBooking(ready), true, "all required data enables submit");
assert.equal(nextWizardStep(4, ready), 5);
assert.equal(nextWizardStep(5, ready), 5, "the final step has no next step");

assert.equal(getWizardStepStatus(1, 4, ready), "complete");
assert.equal(getWizardStepStatus(4, 4, ready), "current");
assert.equal(getWizardStepStatus(5, 4, ready), "upcoming");

const beforeDateChange = {
  ...ready,
  slotId: otherSlotId,
  nickname: "ข้อมูลยังอยู่",
};
const afterDateChange = invalidateSlotSelection(beforeDateChange);
assert.equal(afterDateChange.slotId, "", "changing date invalidates the old slot");
assert.equal(afterDateChange.nickname, beforeDateChange.nickname, "other inputs persist");
assert.equal(afterDateChange.faceReady, true, "photo state is not discarded by slot invalidation");
assert.equal(previousWizardStep(4), 3);
assert.equal(previousWizardStep(1), 1);
assert.deepEqual(beforeDateChange, {
  ...afterDateChange,
  slotId: otherSlotId,
}, "state helpers do not mutate the preserved form state");

assert.equal(
  canSubmitBooking({ ...ready, slotId: otherSlotId }),
  false,
  "a slot not in the current server response cannot submit",
);
assert.equal(
  canSubmitBooking({ ...ready, phone: "0812" }),
  false,
  "an invalid phone cannot submit early",
);
