import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { signOut } from "./actions";
import { AdminNav } from "./_components/AdminNav";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link href="/admin" className="admin-brand"><span className="admin-brand-mark">ม</span><span>หมอแจว<small>Backoffice</small></span></Link>
        <p className="admin-nav-label">จัดการระบบ</p>
        <AdminNav />
        <form action={signOut} className="admin-signout"><button type="submit">ออกจากระบบ</button></form>
      </aside>
      <header className="admin-mobile-header">
        <Link href="/admin" className="admin-brand"><span className="admin-brand-mark">ม</span><span>หมอแจว <small>Backoffice</small></span></Link>
        <AdminNav />
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
