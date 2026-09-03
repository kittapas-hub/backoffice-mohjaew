import Link from "next/link";
import { requireAdmin } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/admin" className="font-bold">
            หมอแจว Backoffice
          </Link>
          <nav className="flex flex-wrap items-center gap-4 text-sm" aria-label="เมนูผู้ดูแล">
            <Link href="/admin" className="text-gray-600 hover:text-gray-950">การจอง</Link>
            <Link href="/admin/day" className="text-gray-600 hover:text-gray-950">ตารางคิว</Link>
            <Link href="/admin/line" className="font-medium text-rose-600 hover:text-rose-800">LINE Marketing</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
