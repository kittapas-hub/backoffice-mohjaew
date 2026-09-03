export default function AdminLoading() {
  return <div aria-busy="true" aria-label="กำลังโหลดข้อมูล" className="animate-pulse">
    <div className="mb-8 h-4 w-28 rounded bg-rose-100" />
    <div className="mb-3 h-9 w-64 rounded-lg bg-gray-200" />
    <div className="mb-7 h-4 w-96 max-w-full rounded bg-gray-200" />
    <div className="admin-card mb-5 h-32 bg-white" />
    <div className="admin-card overflow-hidden bg-white"><div className="h-16 border-b border-gray-100" />{Array.from({ length: 7 }, (_, index) => <div key={index} className="h-16 border-b border-gray-100 px-5 py-5"><div className="h-4 rounded bg-gray-100" style={{ width: `${72 - index * 3}%` }} /></div>)}</div>
  </div>;
}
