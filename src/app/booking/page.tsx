import { isAllowedSource } from "@/lib/slots";
import BookingForm from "./BookingForm";

export const dynamic = "force-dynamic";

// Source comes from the link the channel uses, e.g. /booking?source=line.
// Validated against the allowlist; anything else falls back to "website".
export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  const validSource = isAllowedSource(source) ? source : "website";

  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-8">
      <header className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-rose-700">จองคิวปรึกษาหมอแจว</h1>
        <p className="mt-1 text-sm text-gray-500">
          เลือกวันและรอบเวลาที่สะดวก แล้วกรอกข้อมูลเพื่อจองคิว
        </p>
      </header>
      <BookingForm source={validSource} />
    </main>
  );
}
