"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/admin", label: "การจอง", exact: true, icon: "▦" },
  { href: "/admin/day", label: "ตารางคิว", icon: "◫" },
  { href: "/admin/line", label: "LINE Marketing", icon: "◉" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="admin-nav" aria-label="เมนูผู้ดูแล">
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className="admin-nav-link" data-active={active || undefined} aria-current={active ? "page" : undefined}>
            <span aria-hidden="true" className="admin-nav-icon">{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
