import type { ChangeEntry, Snapshot } from "../../server/src/core/index.ts";
import type { VisibleTree } from "./viewing.ts";

export type ViewState = { tree: VisibleTree; snapshot: Snapshot };

function combineTargets(changes: readonly ChangeEntry[], since: number, until: number): ReadonlyMap<string, string> {
  const step = new Map<string, string>();
  for (const c of changes) if (c.change === "統合" && since < c.round && c.round <= until) for (const f of c.from) step.set(f, c.node);
  const resolved = new Map<string, string>();
  for (const [from, into] of step) {
    let target = into;
    for (let hops = 0; step.has(target) && hops < step.size; hops++) target = step.get(target)!;
    resolved.set(from, target);
  }
  return resolved;
}

export type PreviousView = ViewState & { selectedId: string | null };

export function relocations(before: PreviousView, after: ViewState): Record<string, string> {
  const exists = new Set([...after.snapshot.nodes.map((n) => n.id), ...after.tree.ids]);
  const parents = new Map<string, string | null>(before.snapshot.nodes.map((n) => [n.id, n.parent]));
  for (const [id, parent] of Object.entries(before.tree.parents)) parents.set(id, parent);
  const into = combineTargets(after.snapshot.changes, before.snapshot.round, after.snapshot.round);
  const out: Record<string, string> = {};
  const candidates = new Set(before.tree.ids);
  if (before.selectedId !== null) candidates.add(before.selectedId);
  for (const id of candidates) {
    if (exists.has(id)) continue;
    const target = into.get(id);
    if (target !== undefined && exists.has(target)) {
      out[id] = target;
      continue;
    }
    for (let cur = parents.get(id); cur != null; cur = parents.get(cur)) {
      if (exists.has(cur)) {
        out[id] = cur;
        break;
      }
    }
  }
  return out;
}
