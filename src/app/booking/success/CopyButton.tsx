"use client";

import { useState } from "react";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — silent fail
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-md border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 active:bg-gray-100"
    >
      {copied ? "✓ คัดลอกแล้ว" : label}
    </button>
  );
}
