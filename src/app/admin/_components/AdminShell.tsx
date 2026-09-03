"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "../actions";
import { AdminNav } from "./AdminNav";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/admin/login") {
    return <>{children}</>;
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link href="/admin" className="admin-brand">
          <span className="admin-brand-mark">ม</span>
          <span>
            หมอแจว
            <small>Backoffice</small>
          </span>
        </Link>
        <p className="admin-nav-label">จัดการระบบ</p>
        <AdminNav />
        <form action={signOut} className="admin-signout">
          <button type="submit">ออกจากระบบ</button>
        </form>
      </aside>

      <header className="admin-mobile-header">
        <Link href="/admin" className="admin-brand">
          <span className="admin-brand-mark">ม</span>
          <span>
            หมอแจว <small>Backoffice</small>
          </span>
        </Link>
        <AdminNav />
      </header>

      <main className="admin-main">{children}</main>
    </div>
  );
}
