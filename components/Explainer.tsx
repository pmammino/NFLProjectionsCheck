"use client";

import { useState } from "react";

// A collapsible plain-English panel: what the view shows, how to read it, and
// what you can learn. Open by default; users can collapse once familiar.
export default function Explainer({
  title = "What this shows & how to read it",
  children,
  defaultOpen = true,
}: {
  title?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-sky-900/50 bg-sky-950/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-sky-200">
          <span className="text-sky-400">ℹ</span>
          {title}
        </span>
        <span className="text-xs text-sky-400">{open ? "Hide ▲" : "Show ▼"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-sky-900/40 px-4 py-3 text-sm leading-relaxed text-slate-300 [&_b]:text-slate-100 [&_li]:ml-1">
          {children}
        </div>
      )}
    </div>
  );
}
