"use client";

import Link from "next/link";

export function SearchForm({
  defaultValue,
  clearHref,
  status,
}: {
  defaultValue: string;
  clearHref: string;
  status: string | null;
}) {
  return (
    <form method="get" action="/admin" className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {status && <input type="hidden" name="status" value={status} />}
      <div className="relative flex-1">
        <input
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder="ค้นหาชื่อเล่น / เบอร์โทร / เลขอ้างอิง"
          autoComplete="off"
          className="admin-focus w-full rounded-xl border border-[#dfd3d0] bg-white py-2.5 pl-10 pr-3 text-sm placeholder:text-gray-400 focus:border-rose-400 focus:outline-none"
        />
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400 text-sm">
          🔍
        </span>
      </div>
      <button
        type="submit"
        className="admin-focus rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
      >
        ค้นหา
      </button>
      {defaultValue && (
        <Link
          href={clearHref}
          className="admin-focus rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-center text-sm text-gray-600 hover:bg-gray-50"
        >
          ล้าง
        </Link>
      )}
    </form>
  );
}
