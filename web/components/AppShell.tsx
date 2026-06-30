"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Brain, Command, Database, ListTree } from "lucide-react";
import { SessionProvider, useSession } from "./SessionContext";
import { Mono } from "./primitives/Mono";

/** Format a Date as the mono `now ▸ YYYY-MM-DD HH:mm UTC` indicator. */
function fmtNow(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const NAV = [
  { href: "/brain", label: "Brain", icon: Brain },
  { href: "/", label: "Sandbox (Vitals)", icon: Activity },
  { href: "/beliefs", label: "Ledger", icon: ListTree },
];

function Sidebar() {
  const pathname = usePathname();
  return (
    <nav className="flex w-14 flex-col items-center gap-1 border-r border-border bg-surface-0 py-3">
      <Link
        href="/brain"
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-surface-2"
        title="Cortex — your second brain"
      >
        <Database size={16} className="text-accent" />
      </Link>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active =
          href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            title={label}
            className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
              active
                ? "bg-surface-2 text-accent"
                : "text-ink-dim hover:bg-surface-1 hover:text-ink"
            }`}
          >
            <Icon size={16} />
          </Link>
        );
      })}
    </nav>
  );
}

function TopBar() {
  const { scenario, isScratch, now, togglePalette } = useSession();
  return (
    <header className="flex h-11 items-center justify-between border-b border-border bg-surface-0 px-4">
      <div className="flex items-center gap-3">
        <Mono className="text-xs uppercase tracking-widest text-ink">CORTEX</Mono>
        <Mono faint className="text-2xs">
          · vitals
        </Mono>
      </div>

      <div className="flex items-center gap-3">
        {/* session-state chip — scratch vs live */}
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
          style={{
            borderColor: isScratch ? "#4ED8C455" : "#2A2F38",
            backgroundColor: isScratch ? "#4ED8C414" : "transparent",
          }}
          title={
            isScratch
              ? "Operating on a server-seeded scratch session — the live store is never mutated."
              : "No scratch session yet — reset a session before running learn/maintain."
          }
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: isScratch ? "#4ED8C4" : "#5B6470" }}
          />
          <Mono className="text-2xs" style={{ color: isScratch ? "#4ED8C4" : "#9AA3AF" }}>
            {scenario ? `scratch·${scenario}` : "no session"}
          </Mono>
        </span>

        {/* now-indicator */}
        <Mono dim className="text-2xs">
          now ▸ {fmtNow(now)}
        </Mono>

        {/* ⌘K trigger */}
        <button
          onClick={togglePalette}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1 text-ink-dim hover:bg-surface-2 hover:text-ink"
          title="Command palette"
        >
          <Command size={12} />
          <Mono className="text-2xs">K</Mono>
        </button>
      </div>
    </header>
  );
}

function Chrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Chrome>{children}</Chrome>
    </SessionProvider>
  );
}
