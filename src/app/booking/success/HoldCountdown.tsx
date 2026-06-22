"use client";

import { useEffect, useState } from "react";

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "หมดเวลาแล้ว";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m} นาที ${s.toString().padStart(2, "0")} วินาที`;
}

export function HoldCountdown({ expiresAt }: { expiresAt: string }) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    setLabel(formatRemaining(expiresAt));
    const id = setInterval(() => setLabel(formatRemaining(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // suppressHydrationWarning: server renders "" (blank), client fills in on mount.
  return <span suppressHydrationWarning>{label}</span>;
}
