import * as React from "react";

/**
 * Mono-truth wrapper. EVERY machine fact — ids, timestamps, confidence/salience/retention
 * floats, event verbs, payloads — must render through this (JetBrains Mono, tabular nums).
 * Belief `statement` prose stays in Inter (do NOT wrap that in <Mono>).
 */
export function Mono({
  children,
  className = "",
  dim = false,
  faint = false,
  style,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  dim?: boolean;
  faint?: boolean;
  style?: React.CSSProperties;
  title?: string;
}) {
  const tone = faint ? "text-ink-faint" : dim ? "text-ink-dim" : "";
  return (
    <span className={`mono ${tone} ${className}`.trim()} style={style} title={title}>
      {children}
    </span>
  );
}
