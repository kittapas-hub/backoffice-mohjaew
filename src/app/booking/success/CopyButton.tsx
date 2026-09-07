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
      className="checkout-copy"
      data-copied={copied ? "true" : undefined}
      aria-label={copied ? "คัดลอกแล้ว" : `${label}`}
    >
      {copied ? "✓ คัดลอกแล้ว" : label}
    </button>
  );
}
