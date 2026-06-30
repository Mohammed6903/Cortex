"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { Mono } from "./Mono";

/**
 * A right-side (or inline) drawer for the diff / state-as-of panes. Hand-rolled — no
 * Radix. Unfolds 160ms ease-out (diegetic). prefers-reduced-motion is honored globally
 * via globals.css (transition durations collapse to ~0).
 */
export function Drawer({
  open,
  onClose,
  title,
  side = "right",
  width = 460,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  side?: "right" | "left";
  width?: number;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const fromX = side === "right" ? width : -width;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            className={`absolute top-0 h-full border-border bg-surface-1 shadow-2xl ${
              side === "right" ? "right-0 border-l" : "left-0 border-r"
            }`}
            style={{ width }}
            initial={{ x: fromX }}
            animate={{ x: 0 }}
            exit={{ x: fromX }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <Mono dim className="text-xs uppercase tracking-wide">
                {title}
              </Mono>
              <button
                onClick={onClose}
                className="rounded p-1 text-ink-dim hover:bg-surface-2 hover:text-ink"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </header>
            <div className="h-[calc(100%-49px)] overflow-y-auto px-4 py-3">
              {children}
            </div>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
