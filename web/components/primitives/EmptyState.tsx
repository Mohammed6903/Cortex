import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Mono } from "./Mono";

/**
 * Honest empty / loading / error state. Used for formed-only and pruned beliefs, empty
 * sessions, network failures, etc. Never fakes data — says exactly what is (or isn't) there.
 */
export function EmptyState({
  icon: Icon,
  title,
  detail,
  tone = "neutral",
  action,
  className = "",
}: {
  icon?: LucideIcon;
  title: string;
  detail?: React.ReactNode;
  tone?: "neutral" | "error" | "loading";
  action?: React.ReactNode;
  className?: string;
}) {
  const toneColor =
    tone === "error" ? "#D86A6A" : tone === "loading" ? "#4ED8C4" : "#5B6470";
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-surface-0 px-6 py-10 text-center ${className}`.trim()}
    >
      {Icon ? <Icon size={22} style={{ color: toneColor }} aria-hidden /> : null}
      <div className="space-y-1">
        <p className="text-sm text-ink">{title}</p>
        {detail ? (
          <div className="max-w-sm text-xs text-ink-dim">
            {typeof detail === "string" ? <Mono faint>{detail}</Mono> : detail}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
