/**
 * Helpers that enforce the honesty constraints around the event grammar.
 *
 *  - A branch == a `contradicted` event with detail.kind === "branch".
 *  - A supersede emits BOTH `contradicted` AND `superseded` for one act — these must
 *    collapse to a SINGLE stream/timeline row.
 *  - PRUNED has no event; reconstruct it via snapshot-diff (see diffPruned).
 */

import type { Belief, BeliefEvent } from "./api";

export function isBranch(e: BeliefEvent): boolean {
  return e.event_type === "contradicted" && e.detail?.kind === "branch";
}

/**
 * Is this `contradicted` event the first half of a supersede pair? True when a
 * `superseded` event exists at the same instant for the same belief and this is NOT a
 * branch. Used to drop the redundant `contradicted` row.
 */
function isSupersedePartner(e: BeliefEvent, all: BeliefEvent[]): boolean {
  if (e.event_type !== "contradicted" || isBranch(e)) return false;
  return all.some(
    (o) =>
      o !== e &&
      o.event_type === "superseded" &&
      o.belief_id === e.belief_id &&
      o.at === e.at,
  );
}

/**
 * Collapse a raw timeline into display rows: a supersede's paired `contradicted` +
 * `superseded` become one `superseded` row; branches stay as their `contradicted` row.
 * Preserves original order, keeps the surviving event's detail (merging the dropped
 * partner's detail so nothing is lost).
 */
export function collapseSupersede(events: BeliefEvent[]): BeliefEvent[] {
  const out: BeliefEvent[] = [];
  for (const e of events) {
    if (isSupersedePartner(e, events)) {
      // fold this contradicted into the matching superseded row's detail
      const partner = events.find(
        (o) =>
          o.event_type === "superseded" &&
          o.belief_id === e.belief_id &&
          o.at === e.at,
      );
      if (partner) {
        partner.detail = { ...e.detail, ...partner.detail };
      }
      continue; // drop the redundant contradicted row
    }
    out.push(e);
  }
  return out;
}

export type EventKind =
  | "formed"
  | "reinforced"
  | "branch"
  | "superseded"
  | "merged"
  | "demoted"
  | "promoted"
  | "pruned";

/** The display kind for a (possibly collapsed) event — branch is surfaced explicitly. */
export function displayKind(e: BeliefEvent): EventKind {
  if (isBranch(e)) return "branch";
  switch (e.event_type) {
    case "contradicted":
      // a lone contradicted that isn't a branch and wasn't collapsed; show as superseded-like
      return "superseded";
    default:
      return e.event_type as EventKind;
  }
}

/**
 * Reconstruct PRUNED tombstones by snapshot-diffing two GET /beliefs?all=true reads
 * taken before and after a maintain. The maintain hard-deletes pruned rows, so they are
 * simply absent in `after`. This is the ONLY honest source of a prune (no event exists).
 */
export function diffPruned(before: Belief[], after: Belief[]): Belief[] {
  const afterIds = new Set(after.map((b) => b.id));
  return before.filter((b) => !afterIds.has(b.id));
}
