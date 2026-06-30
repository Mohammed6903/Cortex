"use client";

/**
 * Brain — the daily second brain (`/brain`).
 *
 * Two loops over the PERSISTENT brain store (real Qwen, survives restarts):
 *   - Journal: write what's on your mind → it distills beliefs (adds/revises, never deletes).
 *   - Ask: a decision suited to your situation, or a draft in your voice — grounded only in
 *     your beliefs + voice, with citations resolved inline from the recalled context.
 * Plus a "what I know about you" panel and a voice/values profile editor.
 */

import * as React from "react";
import {
  Brain,
  Loader2,
  PenLine,
  Send,
  Sparkles,
  TriangleAlert,
  User,
} from "lucide-react";

import {
  api,
  ApiError,
  type AskMode,
  type AskResponse,
  type Belief,
  type BrainStats,
  type JournalResponse,
  type Profile,
  type RecalledBelief,
} from "@/lib/api";
import { TYPE_LABEL, fmtFloat } from "@/lib/tokens";
import { Mono, EmptyState } from "@/components/primitives";

export default function BrainPage() {
  const [stats, setStats] = React.useState<BrainStats | null>(null);
  const [beliefs, setBeliefs] = React.useState<Belief[]>([]);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [s, b, p] = await Promise.all([
        api.brain.stats(),
        api.brain.beliefs(true),
        api.brain.getProfile(),
      ]);
      setStats(s);
      setBeliefs(b);
      setProfile(p);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? `${e.status} · ${e.message}` : String(e));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-accent" />
          <Mono className="text-xs uppercase tracking-widest text-ink">Your second brain</Mono>
        </div>
        <ProviderChip stats={stats} />
      </header>

      {loadError && (
        <div className="rounded-md border border-event-contradicted/40 bg-surface-1 px-3 py-2">
          <Mono faint className="text-2xs">
            {loadError} — is the API running at {api.base}?
          </Mono>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <AskPanel beliefs={beliefs} />
          <JournalPanel onLearned={refresh} />
        </div>
        <aside className="flex flex-col gap-4">
          <KnowsPanel beliefs={beliefs} stats={stats} />
          <ProfilePanel profile={profile} onChange={refresh} />
        </aside>
      </div>
    </div>
  );
}

function ProviderChip({ stats }: { stats: BrainStats | null }) {
  const live = stats && !stats.degraded;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5"
      style={{
        borderColor: live ? "#4ED8C455" : "#E0A45855",
        backgroundColor: live ? "#4ED8C414" : "#E0A45814",
      }}
      title={stats?.degrade_reason ?? "The brain's LLM provider"}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: live ? "#4ED8C4" : "#E0A458" }}
      />
      <Mono className="text-2xs" style={{ color: live ? "#4ED8C4" : "#E0A458" }}>
        {stats ? (stats.degraded ? "mock — set Qwen key" : stats.provider) : "…"}
      </Mono>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

function AskPanel({ beliefs }: { beliefs: Belief[] }) {
  const [q, setQ] = React.useState("");
  const [mode, setMode] = React.useState<AskMode>("auto");
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState<AskResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const byId = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const b of beliefs) m.set(b.id, b.statement);
    return m;
  }, [beliefs]);

  async function ask() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.brain.ask(q.trim(), mode));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  function resolve(ids: string[], recalled: RecalledBelief[]): string[] {
    const fromRecall = new Map(recalled.map((r) => [r.id, r.statement]));
    return ids.map((id) => byId.get(id) ?? fromRecall.get(id) ?? id);
  }

  return (
    <section className="rounded-md border border-border bg-surface-1 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <Mono className="text-2xs uppercase tracking-widest text-ink">Ask yourself</Mono>
      </div>

      <textarea
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask();
        }}
        rows={3}
        placeholder="A situation or question — e.g. 'Should I take the evening run club?' or 'Draft a reply declining this meeting.'"
        className="w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 font-sans text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/50"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border" role="group">
          {(["auto", "decide", "draft"] as AskMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`px-2.5 py-1 ${mode === m ? "bg-surface-2 text-accent" : "text-ink-dim hover:bg-surface-1 hover:text-ink"}`}
            >
              <Mono className="text-2xs">{m}</Mono>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void ask()}
          disabled={busy || !q.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1 text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          <Mono className="text-2xs">ask · ⌘⏎</Mono>
        </button>
      </div>

      {err && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-event-contradicted/40 bg-surface-0 px-3 py-2">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-event-contradicted" />
          <Mono faint className="text-2xs">{err}</Mono>
        </div>
      )}

      {res && (
        <div className="mt-3 rounded-md border border-border bg-surface-0 p-3">
          {res.mode === "decide" ? (
            <DecideView res={res} resolve={resolve} />
          ) : (
            <DraftView res={res} resolve={resolve} />
          )}
        </div>
      )}
    </section>
  );
}

function Citations({ statements }: { statements: string[] }) {
  if (!statements.length) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <Mono faint className="text-2xs uppercase tracking-wide">grounded in</Mono>
      <ul className="mt-1 space-y-0.5">
        {statements.map((s, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-accent">·</span>
            <span className="font-sans text-2xs text-ink-dim">{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecideView({
  res,
  resolve,
}: {
  res: AskResponse;
  resolve: (ids: string[], r: RecalledBelief[]) => string[];
}) {
  return (
    <div>
      <p className="font-sans text-sm leading-relaxed text-ink">{res.recommendation}</p>
      {typeof res.confidence === "number" && (
        <Mono faint className="mt-1 block text-2xs">
          confidence {fmtFloat(res.confidence)}
        </Mono>
      )}
      {res.options && res.options.length > 0 && (
        <ul className="mt-3 space-y-2">
          {res.options.map((o, i) => (
            <li key={i} className="rounded-md border border-border/60 bg-surface-1 p-2">
              <div className="font-sans text-xs font-medium text-ink">{o.action}</div>
              <div className="mt-0.5 font-sans text-2xs text-ink-dim">{o.rationale}</div>
              {(o.fit || o.tradeoffs) && (
                <Mono faint className="mt-1 block text-2xs">
                  {o.fit ? `fit: ${o.fit}` : ""}
                  {o.fit && o.tradeoffs ? " · " : ""}
                  {o.tradeoffs ? `tradeoff: ${o.tradeoffs}` : ""}
                </Mono>
              )}
            </li>
          ))}
        </ul>
      )}
      {res.conflicts && res.conflicts.length > 0 && (
        <div className="mt-3">
          <Mono className="text-2xs uppercase tracking-wide text-event-contradicted">conflicts</Mono>
          <ul className="mt-1 space-y-0.5">
            {res.conflicts.map((c, i) => (
              <li key={i} className="font-sans text-2xs text-ink-dim">— {c}</li>
            ))}
          </ul>
        </div>
      )}
      <Citations statements={resolve(res.cited_belief_ids, res.recalled)} />
    </div>
  );
}

function DraftView({
  res,
  resolve,
}: {
  res: AskResponse;
  resolve: (ids: string[], r: RecalledBelief[]) => string[];
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div>
      <p className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">{res.draft}</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(res.draft ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-md border border-border bg-surface-1 px-2 py-0.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
        >
          <Mono className="text-2xs">{copied ? "copied" : "copy"}</Mono>
        </button>
        {res.tone_notes && (
          <Mono faint className="text-2xs">tone: {res.tone_notes}</Mono>
        )}
      </div>
      <Citations statements={resolve(res.cited_belief_ids, res.recalled)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

function JournalPanel({ onLearned }: { onLearned: () => void }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [last, setLast] = React.useState<JournalResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.brain.journal(text.trim());
      setLast(r);
      setText("");
      onLearned();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface-1 p-4">
      <div className="mb-2 flex items-center gap-2">
        <PenLine size={14} className="text-accent" />
        <Mono className="text-2xs uppercase tracking-widest text-ink">Journal — tell it about your day</Mono>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
        rows={3}
        placeholder="What happened, what you're thinking, what you decided… it distills the durable bits into memory."
        className="w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 font-sans text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/50"
      />
      <div className="mt-2 flex items-center justify-between">
        <Mono faint className="text-2xs">adds/revises memory — never deletes</Mono>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1 text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />}
          <Mono className="text-2xs">add to memory</Mono>
        </button>
      </div>

      {err && (
        <Mono faint className="mt-2 block text-2xs text-event-contradicted">{err}</Mono>
      )}
      {last && (
        <div className="mt-3 rounded-md border border-border/60 bg-surface-0 p-2">
          <Mono className="text-2xs text-accent">{last.ack}</Mono>
          <ul className="mt-1 space-y-0.5">
            {last.learned.map((l) => (
              <li key={l.belief_id} className="flex items-center gap-1.5">
                <Mono faint className="text-2xs">{l.action}</Mono>
                <span className="font-sans text-2xs text-ink-dim">{l.statement}</span>
                {l.type && (
                  <Mono faint className="text-2xs">[{TYPE_LABEL[l.type]}]</Mono>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// What I know + Profile
// ---------------------------------------------------------------------------

function KnowsPanel({ beliefs, stats }: { beliefs: Belief[]; stats: BrainStats | null }) {
  const active = beliefs.filter((b) => b.tier === "active" && !b.validity_end);
  const byType = React.useMemo(() => {
    const m = new Map<string, Belief[]>();
    for (const b of active) {
      const arr = m.get(b.type) ?? [];
      arr.push(b);
      m.set(b.type, arr);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [active]);

  return (
    <section className="rounded-md border border-border bg-surface-1 p-4">
      <div className="mb-2 flex items-center justify-between">
        <Mono className="text-2xs uppercase tracking-widest text-ink">What I know about you</Mono>
        <Mono faint className="text-2xs">
          {stats ? `${stats.held} held · ${stats.dormant} dim · ${stats.archived} arch` : "…"}
        </Mono>
      </div>
      {active.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="Nothing yet"
          detail="Journal a few entries and your beliefs will appear here."
        />
      ) : (
        <div className="space-y-3">
          {byType.map(([type, items]) => (
            <div key={type}>
              <Mono faint className="text-2xs uppercase tracking-wide">
                {TYPE_LABEL[type as keyof typeof TYPE_LABEL] ?? type} · {items.length}
              </Mono>
              <ul className="mt-1 space-y-1">
                {items
                  .sort((a, b) => b.salience - a.salience)
                  .slice(0, 6)
                  .map((b) => (
                    <li
                      key={b.id}
                      className="font-sans text-2xs text-ink-dim"
                      style={{ opacity: 0.55 + 0.45 * b.confidence }}
                      title={`conf ${fmtFloat(b.confidence)} · sal ${fmtFloat(b.salience)}`}
                    >
                      {b.statement}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProfilePanel({ profile, onChange }: { profile: Profile | null; onChange: () => void }) {
  const [voice, setVoice] = React.useState("");
  const [values, setValues] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (profile) {
      setVoice(profile.authored_voice);
      setValues(profile.values_card);
    }
  }, [profile]);

  return (
    <section className="rounded-md border border-border bg-surface-1 p-4">
      <div className="mb-2 flex items-center gap-2">
        <User size={13} className="text-accent" />
        <Mono className="text-2xs uppercase tracking-widest text-ink">Your voice</Mono>
      </div>
      <label className="block">
        <Mono faint className="text-2xs">style / voice</Mono>
        <textarea
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          rows={2}
          placeholder="e.g. terse, dry, first-person, minimal fluff"
          className="mt-1 w-full resize-y rounded-md border border-border bg-surface-0 px-2 py-1.5 font-sans text-2xs text-ink outline-none focus:border-accent/50"
        />
      </label>
      <label className="mt-2 block">
        <Mono faint className="text-2xs">values</Mono>
        <textarea
          value={values}
          onChange={(e) => setValues(e.target.value)}
          rows={2}
          placeholder="e.g. ship fast; honesty over politeness; protect deep work"
          className="mt-1 w-full resize-y rounded-md border border-border bg-surface-0 px-2 py-1.5 font-sans text-2xs text-ink outline-none focus:border-accent/50"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.brain.setProfile(voice, values);
              onChange();
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          <Mono className="text-2xs">{busy ? "saving…" : "save"}</Mono>
        </button>
        <button
          type="button"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await api.brain.refreshVoice();
              onChange();
            } finally {
              setRefreshing(false);
            }
          }}
          title="Re-learn your voice from recent journal entries"
          className="rounded-md border border-border bg-surface-1 px-2.5 py-1 text-ink-dim hover:bg-surface-2 hover:text-ink disabled:opacity-40"
        >
          <Mono className="text-2xs">{refreshing ? "learning…" : "↻ learn from writing"}</Mono>
        </button>
      </div>
      {profile?.inferred_voice && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <Mono faint className="text-2xs uppercase tracking-wide">observed voice</Mono>
          <p className="mt-0.5 font-sans text-2xs italic text-ink-dim">{profile.inferred_voice}</p>
        </div>
      )}
    </section>
  );
}
