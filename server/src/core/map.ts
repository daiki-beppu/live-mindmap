import { Schema } from "effect";
import { earliestRemark, type Remark } from "./remark.ts";
import { InferredSpeakerName } from "./speakerNames.ts";

export const KINDS = ["議題", "論点", "案", "決定", "課題", "TODO", "要点"] as const;
export type Kind = (typeof KINDS)[number];
const KindSchema = Schema.Literals(KINDS);

export const PLAN_STATUSES = ["検討中", "却下"] as const;
const PlanStatusSchema = Schema.Literals(PLAN_STATUSES);
export const PointStatus = Schema.Literals(["未決", "決定済み"]);
export type PointStatus = typeof PointStatus["Type"];

export const ROOT_ID = "root";

export const MapNode = Schema.Struct({
  id: Schema.String,
  parent: Schema.mutableKey(Schema.NullOr(Schema.String)),
  kind: Schema.Literals([...KINDS, "会議"]),
  text: Schema.mutableKey(Schema.String),
  planStatus: Schema.optionalKey(Schema.mutableKey(PlanStatusSchema)),
  assignee: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  assigneeSpeaker: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  proposer: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  criteria: Schema.optionalKey(Schema.mutableKey(Schema.Array(Schema.String))),
  due: Schema.optionalKey(Schema.String),
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  touchedAt: Schema.optionalKey(Schema.mutableKey(Schema.Finite)),
  evidenceRound: Schema.optionalKey(Schema.mutableKey(Schema.Finite)),
  talkStatus: Schema.optionalKey(Schema.mutableKey(Schema.Literal("済み"))),
});
export type MapNode = typeof MapNode["Type"];

export const MeetingMap = Schema.Struct({
  nodes: Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(MapNode))),
  order: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  nextId: Schema.mutableKey(Schema.Finite),
});
export type MeetingMap = typeof MeetingMap["Type"];

const Evidence = Schema.mutable(Schema.Array(Schema.String)).annotate({ description: "根拠の発言 id（例 r12）" });
const AssigneeSpeaker = Schema.String.annotate({ description: "担当の話者（例 相手 A / 自分）。名前が出ないまま、話者が自分から引き受けたとき（「私がやります」）だけ書く。頼まれた側を話者から推し量って書かない" });
const NodeRef = Schema.String.annotate({ description: "既存ノードの id（例 n3）か、同じ応答で add した ref" });

export const Op = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    ref: Schema.String,
    parent: NodeRef,
    kind: KindSchema,
    text: Schema.String,
    evidence: Evidence,
    assignee: Schema.optionalKey(Schema.String),
    assigneeSpeaker: Schema.optionalKey(AssigneeSpeaker),
    proposer: Schema.optionalKey(Schema.String),
    criteria: Schema.optionalKey(Schema.Array(Schema.String)),
    due: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("update"),
    node: NodeRef,
    text: Schema.optionalKey(Schema.String),
    evidence: Evidence,
    planStatus: Schema.optionalKey(PlanStatusSchema),
    criteria: Schema.optionalKey(Schema.Array(Schema.String)),
    assignee: Schema.optionalKey(Schema.String),
    assigneeSpeaker: Schema.optionalKey(AssigneeSpeaker),
  }),
  Schema.Struct({ op: Schema.Literal("combine"), from: NodeRef, into: NodeRef }),
  Schema.Struct({ op: Schema.Literal("move"), node: NodeRef, parent: NodeRef }),
  Schema.Struct({ op: Schema.Literal("delete"), node: NodeRef }),
  Schema.Struct({ op: Schema.Literal("noop"), reason: Schema.String }),
  Schema.Struct({ op: Schema.Literal("close"), node: NodeRef }),
]);
export type Op = typeof Op["Type"];

export const Dropped = Schema.Struct({ op: Op, reason: Schema.String });
export type Dropped = typeof Dropped["Type"];

const DiffOps = Op.mapMembers(([add, update, ...rest]) => [
  add.mapFields(({ proposer: _proposer, ...fields }) => ({ ...fields, evidence: fields.evidence.check(Schema.isMinLength(1)) })),
  update.mapFields((fields) => ({ ...fields, evidence: fields.evidence.check(Schema.isMinLength(1)) })),
  ...rest,
] as const);
export const DiffOperations = Schema.Struct({ ops: Schema.mutable(Schema.Array(DiffOps)), names: Schema.optionalKey(Schema.mutable(Schema.Array(InferredSpeakerName))) });
export const PlainDiffOperations = Schema.Struct({
  ...DiffOperations.fields,
  ops: Schema.mutable(Schema.Array(DiffOps.mapMembers(([add, update, ...rest]) => [
    add.mapFields(({ criteria: _criteria, ...fields }) => fields),
    update.mapFields(({ criteria: _criteria, ...fields }) => fields),
    ...rest,
  ]))),
});
export const DiffOutput = Schema.Struct({ ...DiffOperations.fields, processedRemarks: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))) });
export type DiffOutput = typeof DiffOutput["Type"];

export function emptyMap(title: string): MeetingMap {
  return {
    nodes: { [ROOT_ID]: { id: ROOT_ID, parent: null, kind: "会議", text: title, evidence: [] } },
    order: [ROOT_ID],
    nextId: 1,
  };
}

export const cloneNode = (n: MapNode): MapNode => ({ ...n, evidence: [...n.evidence], ...(n.criteria ? { criteria: [...n.criteria] } : {}) });

export const supportsCriteria = (kind: MapNode["kind"]): boolean => kind === "案" || kind === "論点" || kind === "決定";

function normalizedCriteria(kind: MapNode["kind"], names: readonly string[], allowed: readonly string[]): string[] {
  return supportsCriteria(kind) ? [...new Set(allowed)].filter((name) => names.includes(name)) : [];
}

function cloneMap(map: MeetingMap): MeetingMap {
  const nodes: Record<string, MapNode> = {};
  for (const [id, n] of Object.entries(map.nodes)) nodes[id] = cloneNode(n);
  return { nodes, order: [...map.order], nextId: map.nextId };
}

export function children(map: MeetingMap, id: string): MapNode[] {
  return map.order.map((k) => map.nodes[k]!).filter((n) => n.parent === id);
}

export function pointStatus(map: MeetingMap, id: string): PointStatus {
  return children(map, id).some((c) => c.kind === "決定") ? "決定済み" : "未決";
}

function isDescendant(map: MeetingMap, id: string, ancestor: string): boolean {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    if (cur.id === ancestor) return true;
  }
  return false;
}

const isLeafKind = (kind: MapNode["kind"]) => kind === "決定" || kind === "TODO";

function parentError(parent: MapNode | undefined, kind: MapNode["kind"]): string | null {
  if (!parent) return "親が存在しない";
  if (isLeafKind(parent.kind)) return `${parent.kind} は子を持てない`;
  if (kind === "決定" && parent.kind !== "論点") return "決定の親は論点に限る";
  return null;
}

function touchUp(map: MeetingMap, id: string | null, at: number) {
  for (let cur = id ? map.nodes[id] : undefined; cur && cur.id !== ROOT_ID; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    cur.touchedAt = at;
  }
}

function reopenUp(map: MeetingMap, id: string) {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    delete cur.talkStatus;
  }
}

function removeNode(map: MeetingMap, id: string) {
  delete map.nodes[id];
  map.order = map.order.filter((k) => k !== id);
}

type ApplyState = {
  criteria: readonly string[];
  map: MeetingMap;
  refs: Map<string, string>;
  known: ReadonlySet<string>;
  round: number;
  at: number;
  changeOrder: string[];
  remarks: ReadonlyMap<string, Remark>;
  combined: Map<string, string[]>;
};

type OpOf<K extends Op["op"]> = Extract<Op, { op: K }>;

type Applied = string | null;

const resolveId = (s: ApplyState, id: string) => s.refs.get(id) ?? id;

function target(s: ApplyState, id: string): MapNode | undefined {
  const n = s.map.nodes[resolveId(s, id)];
  return n && n.id !== ROOT_ID ? n : undefined;
}

function evidenceError(known: ReadonlySet<string>, evidence: string[]): string | null {
  const unknown = evidence.filter((u) => !known.has(u));
  if (unknown.length) return `根拠に知らない発言がある: ${unknown.join(", ")}`;
  if (evidence.length === 0) return "根拠が無い";
  return null;
}

function newNode(op: OpOf<"add">, id: string, parent: string, round: number, allowed: readonly string[]): MapNode {
  const criteria = normalizedCriteria(op.kind, op.criteria ?? [], allowed);
  return {
    id, parent, kind: op.kind, text: op.text, evidence: [...op.evidence],
    evidenceRound: round,
    ...(criteria.length ? { criteria } : {}),
    ...(op.kind === "案" ? { planStatus: "検討中" as const } : {}),
    ...(op.kind === "案" && op.proposer ? { proposer: op.proposer } : {}),
    ...(op.kind === "TODO" && op.assignee ? { assignee: op.assignee } : {}),
    ...(op.kind === "TODO" && !op.assignee && op.assigneeSpeaker ? { assigneeSpeaker: op.assigneeSpeaker } : {}),
    ...(op.kind === "TODO" && op.due ? { due: op.due } : {}),
  };
}

function applyAdd(s: ApplyState, op: OpOf<"add">): Applied {
  const { map } = s;
  if (map.nodes[op.ref] || s.refs.has(op.ref)) return "仮 ID が既存の ID と重なる";
  const parentId = resolveId(s, op.parent);
  const err = parentError(map.nodes[parentId], op.kind) ?? evidenceError(s.known, op.evidence);
  if (err) return err;
  const id = `n${map.nextId++}`;
  map.nodes[id] = newNode(op, id, parentId, s.round, s.criteria);
  map.order.push(id);
  s.refs.set(op.ref, id);
  reopenUp(map, id);
  s.changeOrder.push(id);
  touchUp(map, id, s.at);
  return null;
}

function assignmentOf(n: MapNode, op: OpOf<"update">): { changed: boolean; apply: () => void } {
  if (n.kind !== "TODO") return { changed: false, apply: () => {} };
  if (op.assignee) {
    const name = op.assignee;
    return {
      changed: name !== n.assignee || n.assigneeSpeaker !== undefined,
      apply: () => { n.assignee = name; delete n.assigneeSpeaker; },
    };
  }
  if (op.assigneeSpeaker && !n.assignee) {
    const speaker = op.assigneeSpeaker;
    return { changed: speaker !== n.assigneeSpeaker, apply: () => { n.assigneeSpeaker = speaker; } };
  }
  return { changed: false, apply: () => {} };
}

function updateCriteria(node: MapNode, requested: readonly string[] | undefined, allowed: readonly string[]): boolean {
  if (requested === undefined) return false;
  const criteria = normalizedCriteria(node.kind, requested, allowed);
  const changed = JSON.stringify(criteria) !== JSON.stringify(node.criteria ?? []);
  if (criteria.length) node.criteria = criteria; else delete node.criteria;
  return changed;
}

function applyUpdate(s: ApplyState, op: OpOf<"update">): Applied {
  const n = target(s, op.node);
  if (!n) return "対象が無い";
  if (op.planStatus && n.kind !== "案") return "状態を持つのは案だけ";
  const err = evidenceError(s.known, op.evidence);
  if (err) return err;
  const evidenceAdded = op.evidence.some((u) => !n.evidence.includes(u));
  const assigned = assignmentOf(n, op);
  const criteriaChanged = updateCriteria(n, op.criteria, s.criteria);
  const valueChanged = (!!op.text && op.text !== n.text)
    || (!!op.planStatus && op.planStatus !== n.planStatus)
    || evidenceAdded
    || assigned.changed || criteriaChanged;
  reopenUp(s.map, n.id);
  if (valueChanged) { s.changeOrder.push(n.id); touchUp(s.map, n.id, s.at); }
  if (evidenceAdded) n.evidenceRound = s.round;
  if (op.text) n.text = op.text;
  if (op.planStatus) n.planStatus = op.planStatus;
  assigned.apply();
  for (const u of op.evidence) if (!n.evidence.includes(u)) n.evidence.push(u);
  return null;
}

function applyMove(s: ApplyState, op: OpOf<"move">): Applied {
  const n = target(s, op.node);
  const parentId = resolveId(s, op.parent);
  if (!n) return "対象が無い";
  if (isDescendant(s.map, parentId, n.id)) return "自分の子孫の下へは移せない";
  const err = parentError(s.map.nodes[parentId], n.kind);
  if (err) return err;
  if (n.parent !== parentId) {
    s.changeOrder.push(n.id);
    touchUp(s.map, n.parent, s.at);
    n.parent = parentId;
    touchUp(s.map, n.id, s.at);
  }
  reopenUp(s.map, n.id);
  return null;
}

function combineError(map: MeetingMap, from: MapNode, into: MapNode): string | null {
  if (from.kind !== into.kind) return "統合は同じ種別どうしに限る";
  if (isDescendant(map, into.id, from.id)) return "子孫へは統合できない";
  if (isLeafKind(into.kind) && children(map, from.id).length) return `${into.kind} は子を持てない`;
  return null;
}

function mergedEvidenceRound(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return Math.max(a, b);
}

function mergedProposer(s: ApplyState, src: MapNode, dst: MapNode): string | undefined {
  const from = earliestRemark(src.evidence, s.remarks);
  const into = earliestRemark(dst.evidence, s.remarks);
  return from && into && from.start < into.start ? src.proposer : dst.proposer;
}

function applyCombine(s: ApplyState, op: OpOf<"combine">): Applied {
  const src = target(s, op.from), dst = target(s, op.into);
  if (!src || !dst || src.id === dst.id) return "対象が無い";
  const err = combineError(s.map, src, dst);
  if (err) return err;
  touchUp(s.map, src.parent, s.at);
  for (const k of children(s.map, src.id)) k.parent = dst.id;
  if (dst.kind === "案") {
    const proposer = mergedProposer(s, src, dst);
    if (proposer === undefined) delete dst.proposer; else dst.proposer = proposer;
  }
  for (const u of src.evidence) if (!dst.evidence.includes(u)) dst.evidence.push(u);
  const fromRound = src.evidenceRound;
  removeNode(s.map, src.id);
  s.combined.set(dst.id, [...(s.combined.get(dst.id) ?? []), ...(s.combined.get(src.id) ?? []), src.id]);
  s.combined.delete(src.id);
  s.changeOrder.push(dst.id);
  const merged = mergedEvidenceRound(fromRound, dst.evidenceRound);
  if (merged !== undefined) dst.evidenceRound = merged;
  touchUp(s.map, dst.id, s.at);
  reopenUp(s.map, dst.id);
  return null;
}

function applyDelete(s: ApplyState, op: OpOf<"delete">): Applied {
  const n = target(s, op.node);
  if (!n) return "対象が無い";
  if (children(s.map, n.id).length) return "子を持つノードは削除できない";
  touchUp(s.map, n.parent, s.at);
  removeNode(s.map, n.id);
  s.combined.delete(n.id);
  return null;
}

function closeError(s: ApplyState, n: MapNode): string | null {
  if (n.kind !== "議題" && n.kind !== "論点") return "閉じられるのは議題・論点だけ";
  if (n.talkStatus) return "すでに済み";
  const recentlyEvidenced = Object.values(s.map.nodes).some((m) => (m.evidenceRound ?? -Infinity) >= s.round - 1 && isDescendant(s.map, m.id, n.id));
  if (recentlyEvidenced) return "同じ応答か直前の差分更新で根拠が足されている";
  return null;
}

function applyClose(s: ApplyState, op: OpOf<"close">): Applied {
  const n = target(s, op.node);
  if (!n) return "対象が無い";
  const err = closeError(s, n);
  if (err) return err;
  n.talkStatus = "済み";
  return null;
}

function applyOp(s: ApplyState, op: Op): Applied {
  switch (op.op) {
    case "noop": return null;
    case "add": return applyAdd(s, op);
    case "update": return applyUpdate(s, op);
    case "move": return applyMove(s, op);
    case "combine": return applyCombine(s, op);
    case "delete": return applyDelete(s, op);
    case "close": return applyClose(s, op);
  }
}


export type AppliedOps = { map: MeetingMap; dropped: Dropped[]; changeOrder: string[]; refs: Record<string, string>; combined: ReadonlyMap<string, readonly string[]> };

export function applyOps(input: MeetingMap, ops: Op[], known: ReadonlySet<string>, stamp: { round: number; at: number }, remarks: ReadonlyMap<string, Remark>, criteria: readonly string[] = []): AppliedOps {
  const s: ApplyState = { map: cloneMap(input), refs: new Map(), known, round: stamp.round, at: stamp.at, changeOrder: [], remarks, combined: new Map(), criteria };
  const dropped: Dropped[] = [];
  for (const op of ops) {
    const reason = applyOp(s, op);
    if (reason) dropped.push({ op, reason });
  }
  return { map: s.map, dropped, changeOrder: s.changeOrder, refs: Object.fromEntries(s.refs), combined: s.combined };
}
