import { AdminShell } from "./_components/AdminShell";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // /admin/login must remain reachable without auth. Every protected admin
  // page and mutation action enforces its own server-side admin guard.
  return <AdminShell>{children}</AdminShell>;
}
