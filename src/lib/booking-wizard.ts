export const BOOKING_WIZARD_STEPS = [
  { number: 1, label: "เลือกวัน" },
  { number: 2, label: "เลือกรอบเวลา" },
  { number: 3, label: "ข้อมูลผู้จอง" },
  { number: 4, label: "รูปหน้าและตรวจสอบ" },
  { number: 5, label: "ยืนยันและชำระเงิน" },
] as const;

export type WizardStep = (typeof BOOKING_WIZARD_STEPS)[number]["number"];

export type BookingWizardState = {
  date: string;
  slotId: string;
  availableSlotIds: readonly string[];
  nickname: string;
  phone: string;
  birthDateText: string;
  faceReady: boolean;
};

export type WizardStepStatus = "current" | "complete" | "upcoming";

function hasDate(date: string): boolean {
  return date.trim().length > 0;
}

function hasAvailableSlot(state: BookingWizardState): boolean {
  return Boolean(
    state.slotId.trim() && state.availableSlotIds.includes(state.slotId),
  );
}

function hasCustomerInfo(state: BookingWizardState): boolean {
  const phoneDigits = state.phone.replace(/[\s\-()+]/g, "");
  return Boolean(
    state.nickname.trim() &&
      state.birthDateText.trim() &&
      /^\d{9,15}$/.test(phoneDigits),
  );
}

export function isWizardStepComplete(
  step: WizardStep,
  state: BookingWizardState,
): boolean {
  switch (step) {
    case 1:
      return hasDate(state.date);
    case 2:
      return hasAvailableSlot(state);
    case 3:
      return hasCustomerInfo(state);
    case 4:
      return state.faceReady;
    case 5:
      return false;
  }
}

export function canContinueWizard(
  step: WizardStep,
  state: BookingWizardState,
): boolean {
  return step < 5 && isWizardStepComplete(step, state);
}

export function canSubmitBooking(state: BookingWizardState): boolean {
  return [1, 2, 3, 4].every((step) =>
    isWizardStepComplete(step as WizardStep, state),
  );
}

export function getWizardStepStatus(
  step: WizardStep,
  currentStep: WizardStep,
  state: BookingWizardState,
): WizardStepStatus {
  if (step === currentStep) return "current";
  if (step < currentStep && isWizardStepComplete(step, state)) {
    return "complete";
  }
  return "upcoming";
}

export function nextWizardStep(
  step: WizardStep,
  state: BookingWizardState,
): WizardStep {
  if (!canContinueWizard(step, state)) return step;
  return (step + 1) as WizardStep;
}

export function previousWizardStep(step: WizardStep): WizardStep {
  return Math.max(1, step - 1) as WizardStep;
}

/** A date change makes the previous server slot selection stale. */
export function invalidateSlotSelection<T extends { slotId: string }>(
  state: T,
): T {
  return { ...state, slotId: "" };
}
