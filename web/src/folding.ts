import { Schema } from "effect";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { changedNodeIds } from "./changes.ts";

export const STALE_SECONDS = 900;

type Fold = { hint: string | null; hidden: number };

export type Openness =
  | { state: "folded"; hint: string | null; hidden: number }
  | { state: "open"; byHuman: boolean }
  | { state: "bundle"; hint: string | null; hidden: number }
  | { state: "fixed" };

export type FoldView = {
  nodes: SnapshotNode[];
  openness: Readonly<Record<string, Openness>>;
  blink: ReadonlySet<string>;
  shownAs: Record<string, string>;
};

export const HumanFolds = Schema.Struct({
  opened: Schema.ReadonlySet(Schema.String),
  folded: Schema.ReadonlySet(Schema.String),
  unbundled: Schema.ReadonlySet(Schema.String),
});
export type HumanFolds = typeof HumanFolds.Type;

export type FoldAction =
  | { type: "toggle"; id: string }
  | { type: "point"; id: string }
  | { type: "reflect" };

type Basis = {
  snapshot: Snapshot;
  human: HumanFolds | undefined;
  selectedId: string | null;
  members: ReadonlyMap<string, readonly string[]>;
};
const basisByView = new WeakMap<FoldView, Basis>();
const NO_HUMAN: HumanFolds = { opened: new Set(), folded: new Set(), unbundled: new Set() };

function humanOrUndefined(human: HumanFolds): HumanFolds | undefined {
  return human.opened.size + human.folded.size + human.unbundled.size === 0 ? undefined : human;
}

function runStartOf(id: string): string | null {
  return id.startsWith("run:") ? id.slice("run:".length) : null;
}

type NodeIndex = { byId: ReadonlyMap<string, SnapshotNode>; children: ReadonlyMap<string, SnapshotNode[]> };

function indexNodes(nodes: readonly SnapshotNode[]): NodeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  return { byId, children };
}

function chainIds(byId: ReadonlyMap<string, SnapshotNode>, start: SnapshotNode | undefined): Set<string> {
  const ids = new Set<string>();
  for (let cur = start; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) ids.add(cur.id);
  return ids;
}

type FoldRule = {
  currentChain: ReadonlySet<string>;
  selectionAncestors: ReadonlySet<string>;
  opened: ReadonlySet<string>;
  humanFolded: ReadonlySet<string>;
  now: number | undefined;
};

function isFolded(n: SnapshotNode, rule: FoldRule): boolean {
  if (rule.currentChain.has(n.id)) return false;
  if (n.kind !== "議題" && n.kind !== "論点") return false;
  if (rule.opened.has(n.id)) return false;
  if (rule.humanFolded.has(n.id)) return true;
  if (rule.selectionAncestors.has(n.id)) return false;
  if (n.talkStatus === "済み") return true;
  return n.kind === "議題" && rule.now !== undefined && n.touchedAt !== undefined && rule.now - n.touchedAt >= STALE_SECONDS;
}

function foldAndHide(nodes: readonly SnapshotNode[], index: NodeIndex, rule: FoldRule): { folded: Set<string>; hidden: Set<string> } {
  const folded = new Set<string>();
  const hidden = new Set<string>();
  const walk = (n: SnapshotNode, covered: boolean) => {
    const foldedNow = !covered && isFolded(n, rule);
    if (covered) hidden.add(n.id);
    if (foldedNow) folded.add(n.id);
    for (const c of index.children.get(n.id) ?? []) walk(c, covered || foldedNow);
  };
  for (const n of nodes) if (!n.parent || !index.byId.has(n.parent)) walk(n, false);
  return { folded, hidden };
}

function descendantsOf(children: ReadonlyMap<string, SnapshotNode[]>, id: string): SnapshotNode[] {
  return (children.get(id) ?? []).flatMap((c) => [c, ...descendantsOf(children, c.id)]);
}

type RunCondition = { folded: ReadonlySet<string>; unbundled: ReadonlySet<string>; selectedId: string | null; selectedRunStart: string | null };

function runsUnder(kids: readonly SnapshotNode[], cond: RunCondition): SnapshotNode[][] {
  const found: SnapshotNode[][] = [];
  let run: SnapshotNode[] = [];
  const close = () => {
    if (run.length >= 2) found.push(run);
    run = [];
  };
  for (const kid of kids) {
    if (kid.id === cond.selectedRunStart) close();
    if (cond.folded.has(kid.id) && kid.kind === "議題" && kid.id !== cond.selectedId && !cond.unbundled.has(kid.id)) run.push(kid);
    else close();
  }
  close();
  return found;
}

type Bundles = {
  runOf: Map<string, string>;
  summaryNodes: Map<string, SnapshotNode>;
  folds: Record<string, Fold>;
  runs: Record<string, readonly string[]>;
};

function bundleRuns(
  nodes: readonly SnapshotNode[],
  index: NodeIndex,
  state: { folded: ReadonlySet<string>; hidden: ReadonlySet<string> },
  cond: RunCondition,
): Bundles {
  const bundles: Bundles = { runOf: new Map(), summaryNodes: new Map(), folds: {}, runs: {} };
  const parents = new Set(nodes.flatMap((n) => (n.parent ? [n.parent] : [])));
  for (const parent of parents) {
    if (state.hidden.has(parent) || state.folded.has(parent)) continue;
    for (const run of runsUnder(index.children.get(parent) ?? [], cond)) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const id = `run:${first.id}`;
      for (const m of run) bundles.runOf.set(m.id, id);
      bundles.summaryNodes.set(first.id, { id, parent, kind: "議題", text: `議題 ${run.length} 件`, evidence: [] });
      bundles.runs[id] = run.map((m) => m.id);
      bundles.folds[id] = { hint: `${first.text} 〜 ${last.text}`, hidden: run.reduce((sum, m) => sum + 1 + descendantsOf(index.children, m.id).length, 0) };
    }
  }
  return bundles;
}

function shownNodes(nodes: readonly SnapshotNode[], hidden: ReadonlySet<string>, bundles: Bundles): SnapshotNode[] {
  const shown: SnapshotNode[] = [];
  for (const n of nodes) {
    if (hidden.has(n.id)) continue;
    const summary = bundles.summaryNodes.get(n.id);
    if (summary) shown.push(summary);
    else if (!bundles.runOf.has(n.id)) shown.push(n);
  }
  return shown;
}

function addFoldedHints(folds: Record<string, Fold>, folded: ReadonlySet<string>, runOf: ReadonlyMap<string, string>, children: ReadonlyMap<string, SnapshotNode[]>): void {
  for (const id of folded) {
    if (runOf.has(id)) continue;
    const below = descendantsOf(children, id);
    folds[id] = { hint: hintOf(below), hidden: below.length };
  }
}

function shownAsOf(nodes: readonly SnapshotNode[], index: NodeIndex, shownIds: ReadonlySet<string>, runOf: ReadonlyMap<string, string>): Record<string, string> {
  const shownAs: Record<string, string> = {};
  for (const n of nodes) {
    if (shownIds.has(n.id)) continue;
    for (let cur: SnapshotNode | undefined = n; cur; cur = cur.parent ? index.byId.get(cur.parent) : undefined) {
      const target = runOf.get(cur.id) ?? (shownIds.has(cur.id) ? cur.id : undefined);
      if (target) {
        shownAs[n.id] = target;
        break;
      }
    }
  }
  return shownAs;
}

function blinkOf(snapshot: Snapshot, shownIds: ReadonlySet<string>, shownAs: Readonly<Record<string, string>>): Set<string> {
  const blink = new Set<string>();
  for (const id of changedNodeIds(snapshot)) {
    if (shownIds.has(id)) blink.add(id);
    else if (shownAs[id]) blink.add(shownAs[id]);
  }
  return blink;
}

function opennessOf(nodes: readonly SnapshotNode[], bundles: Bundles, currentChain: ReadonlySet<string>, opened: ReadonlySet<string>): Record<string, Openness> {
  return Object.fromEntries(nodes.map((node): [string, Openness] => {
    if (Object.hasOwn(bundles.runs, node.id)) return [node.id, { state: "bundle", ...bundles.folds[node.id]! }];
    if (Object.hasOwn(bundles.folds, node.id)) return [node.id, { state: "folded", ...bundles.folds[node.id]! }];
    if (currentChain.has(node.id) || (node.kind !== "議題" && node.kind !== "論点")) return [node.id, { state: "fixed" }];
    return [node.id, { state: "open", byHuman: opened.has(node.id) }];
  }));
}

export function foldView(
  snapshot: Snapshot,
  human: HumanFolds | undefined,
  selectedId: string | null,
): FoldView {
  const { opened, folded: humanFolded, unbundled } = human ?? NO_HUMAN;
  const { nodes, now, currentTopic } = snapshot;
  const index = indexNodes(nodes);

  const currentChain = chainIds(index.byId, currentTopic === undefined ? undefined : index.byId.get(currentTopic));
  const selectedRunStart = selectedId === null ? null : runStartOf(selectedId);
  const selected = selectedId === null ? undefined : index.byId.get(selectedRunStart ?? selectedId);
  const selectionAncestors = chainIds(index.byId, selected?.parent ? index.byId.get(selected.parent) : undefined);

  const { folded, hidden } = foldAndHide(nodes, index, { currentChain, selectionAncestors, opened, humanFolded, now });
  const bundles = bundleRuns(nodes, index, { folded, hidden }, { folded, unbundled, selectedId, selectedRunStart });
  const shown = shownNodes(nodes, hidden, bundles);
  const shownIds = new Set(shown.map((n) => n.id));
  addFoldedHints(bundles.folds, folded, bundles.runOf, index.children);
  const shownAs = shownAsOf(nodes, index, shownIds, bundles.runOf);

  const view: FoldView = {
    nodes: shown,
    openness: opennessOf(shown, bundles, currentChain, opened),
    blink: blinkOf(snapshot, shownIds, shownAs),
    shownAs,
  };
  basisByView.set(view, { snapshot, human, selectedId, members: new Map(Object.entries(bundles.runs)) });
  return view;
}

export function keepTargetOf(view: FoldView | null, id: string): string {
  if (view === null) return id;
  return view.shownAs[id] ?? (view.nodes.some((n) => n.id === id) ? id : (runStartOf(id) ?? id));
}

type Refolded = { human: HumanFolds | undefined; select?: string };

function toggle(view: FoldView, basis: Basis, id: string): Refolded | null {
  const openness = Object.hasOwn(view.openness, id) ? view.openness[id] : undefined;
  if (openness === undefined || openness.state === "fixed") return null;
  const human = basis.human ?? NO_HUMAN;
  if (openness.state === "bundle") {
    const members = basis.members.get(id)!;
    return { human: { ...human, unbundled: new Set([...human.unbundled, ...members]) }, select: members[0]! };
  }
  const opened = new Set(human.opened);
  const folded = new Set(human.folded);
  if (openness.state === "folded") {
    opened.add(id);
    folded.delete(id);
  } else {
    opened.delete(id);
    folded.add(id);
  }
  const byId = new Map(basis.snapshot.nodes.map((n) => [n.id, n]));
  const selected = basis.selectedId === null ? undefined : byId.get(runStartOf(basis.selectedId) ?? basis.selectedId);
  const ancestors = chainIds(byId, selected?.parent ? byId.get(selected.parent) : undefined);
  return {
    human: humanOrUndefined({ ...human, opened, folded }),
    ...(openness.state === "open" && ancestors.has(id) ? { select: id } : {}),
  };
}

function point(basis: Basis, id: string): Refolded | null {
  const byId = new Map(basis.snapshot.nodes.map((n) => [n.id, n]));
  const target = byId.get(id);
  if (!target) return null;
  const human = basis.human ?? NO_HUMAN;
  const folded = new Set(human.folded);
  for (const ancestor of chainIds(byId, target)) folded.delete(ancestor);
  const released = humanOrUndefined({ ...human, folded });
  const view = foldView(basis.snapshot, released, id);
  const opened = view.openness[id]?.state === "folded" ? new Set([...human.opened, id]) : human.opened;
  return { human: humanOrUndefined({ ...human, opened, folded }), select: id };
}

export function refold(view: FoldView, action: FoldAction): Refolded | null {
  const basis = basisByView.get(view);
  if (!basis) return null;
  switch (action.type) {
    case "toggle": return toggle(view, basis, action.id);
    case "point": return point(basis, action.id);
    case "reflect": {
      const human = basis.human;
      const current = basis.snapshot.currentTopic;
      if (human === undefined || current === undefined || !human.folded.has(current)) return null;
      const folded = new Set(human.folded);
      folded.delete(current);
      return { human: humanOrUndefined({ ...human, folded }) };
    }
  }
}

function hintOf(below: SnapshotNode[]): string | null {
  const parts = [
    ["決定", below.filter((n) => n.kind === "決定").length],
    ["TODO", below.filter((n) => n.kind === "TODO").length],
    ["未決", below.filter((n) => n.kind === "論点" && n.pointStatus === "未決").length],
  ] as const;
  const text = parts.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  return text.length > 0 ? text.join("・") : null;
}
