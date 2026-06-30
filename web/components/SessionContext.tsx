"use client";

import * as React from "react";

/**
 * Global UI state: the scratch session label, the `now` time-cursor, and the ⌘K palette
 * open flag. Plain React Context — NO Redux/Zustand/React-Query (stack rule). Later phases
 * wire the actual session/reset + now-scrubber + palette into this.
 */
export interface SessionState {
  /** label of the active scratch session, e.g. "scratch·02_branch", or null if live/unseeded */
  scenario: string | null;
  /** whether the engine is operating on a server-seeded scratch db (never the live store) */
  isScratch: boolean;
  /** the time cursor bound to optional `now` on /learn /maintain /retrieve */
  now: Date;
  /** ⌘K command palette visibility */
  paletteOpen: boolean;
}

export interface SessionApi extends SessionState {
  setScenario: (scenario: string | null, isScratch: boolean) => void;
  setNow: (now: Date) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
}

const SessionCtx = React.createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [scenario, setScenarioState] = React.useState<string | null>(null);
  const [isScratch, setIsScratch] = React.useState(false);
  const [now, setNow] = React.useState<Date>(() => new Date());
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const setScenario = React.useCallback(
    (s: string | null, scratch: boolean) => {
      setScenarioState(s);
      setIsScratch(scratch);
    },
    [],
  );

  // ⌘K / Ctrl+K toggles the palette anywhere.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value: SessionApi = {
    scenario,
    isScratch,
    now,
    paletteOpen,
    setScenario,
    setNow,
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
    togglePalette: () => setPaletteOpen((v) => !v),
  };

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): SessionApi {
  const ctx = React.useContext(SessionCtx);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}
