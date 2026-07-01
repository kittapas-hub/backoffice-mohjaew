import { NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LINE OA no longer runs a conversational booking flow. The one booking CTA
// (https://backoffice-mohjaew.vercel.app/booking?source=line) is configured
// directly in LINE OA Manager — Rich Menu / auto-reply / keyword reply —
// entirely outside this repo, so it never depends on this webhook or on a
// reply being delivered. This endpoint exists only because LINE requires a
// registered webhook URL: it verifies the signature and acknowledges receipt.
// It creates no bookings, sessions, image records, or storage objects, and
// has nothing left to retry.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!verifyLineSignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
