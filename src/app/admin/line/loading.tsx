export default function LineLoading() {
  return <div aria-busy="true" className="animate-pulse"><div className="mb-7 h-10 w-64 rounded bg-gray-200"/><div className="grid gap-4 md:grid-cols-2"><div className="admin-card h-40"/><div className="admin-card h-40"/></div><div className="mt-5 grid gap-4 sm:grid-cols-3"><div className="admin-card h-28"/><div className="admin-card h-28"/><div className="admin-card h-28"/></div></div>;
}
