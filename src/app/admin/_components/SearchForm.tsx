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
    <form method="get" action="/admin" className="flex items-center gap-2">
      {status && <input type="hidden" name="status" value={status} />}
      <div className="relative flex-1">
        <input
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder="ค้นหาชื่อเล่น / เบอร์โทร / เลขอ้างอิง"
          autoComplete="off"
          className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
        />
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400 text-sm">
          🔍
        </span>
      </div>
      <button
        type="submit"
        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50"
      >
        ค้นหา
      </button>
      {defaultValue && (
        <Link
          href={clearHref}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
        >
          ล้าง
        </Link>
      )}
    </form>
  );
}
