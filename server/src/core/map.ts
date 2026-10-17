// マップと差分操作。語彙と規則は GLOSSARY.md / docs/adr/0001-map-is-a-tree.md に従う。
// 型は Schema を正本にして導き、値は普通のオブジェクトのままにする（ADR 0007）。
import { Schema } from "effect";
import { earliestRemark, type Remark } from "./remark.ts";
import { InferredSpeakerName } from "./speakerNames.ts";

export const KINDS = ["議題", "論点", "案", "決定", "課題", "TODO", "要点"] as const;
export type Kind = (typeof KINDS)[number];
const KindSchema = Schema.Literals(KINDS);

export const PLAN_STATUSES = ["検討中", "却下"] as const;
const PlanStatusSchema = Schema.Literals(PLAN_STATUSES);
export const PointStatus = Schema.Literals(["未決", "決定済み"]); // 論点の状態（保存せず導く）
export type PointStatus = typeof PointStatus["Type"];

export const ROOT_ID = "root";

export const MapNode = Schema.Struct({
  id: Schema.String,
  parent: Schema.mutableKey(Schema.NullOr(Schema.String)), // null はルート（会議）だけ
  kind: Schema.Literals([...KINDS, "会議"]),
  text: Schema.mutableKey(Schema.String),
  planStatus: Schema.optionalKey(Schema.mutableKey(PlanStatusSchema)), // 案だけ
  assignee: Schema.optionalKey(Schema.mutableKey(Schema.String)), // TODO だけ。会話に出た名前
  // 名前が出ないまま話者が自分から引き受けたときの担当の話者（"自分" か振ったラベル）。TODO だけ。名前が分かったら消す
  assigneeSpeaker: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  // 案を最初に言った話者。案だけ。サーバーが根拠の発言から決める（AI は書かない）。話者なしの相手は "相手"
  proposer: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  due: Schema.optionalKey(Schema.String), // TODO だけ
  // 発言の ID。ルート以外は 1 つ以上（ルートは emptyMap が空で作るので、要素数は検査しない）
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  // 最後に触れた時刻（その反映に渡した新しい発言の end の最大値）。触れたノードとルートを除く祖先に付く
  touchedAt: Schema.optionalKey(Schema.mutableKey(Schema.Finite)),
  // 最後に根拠が足された反映の番号。根拠が足されたノード自身だけに付く
  evidenceRound: Schema.optionalKey(Schema.mutableKey(Schema.Finite)),
  // 議題・論点が済みのときだけ付く。キーが無ければ話し中（作られたときも付けない）
  talkStatus: Schema.optionalKey(Schema.mutableKey(Schema.Literal("済み"))),
});
export type MapNode = typeof MapNode["Type"];

// ノードは作られた順に order に並ぶ。兄弟の並びはこの順で決まる。
export const MeetingMap = Schema.Struct({
  nodes: Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(MapNode))),
  order: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  nextId: Schema.mutableKey(Schema.Finite),
});
export type MeetingMap = typeof MeetingMap["Type"];

// 根拠とノード参照の説明はドメインの説明なので Schema の注釈に置く（claude.ts がここから Claude に渡す JSON Schema を作る）。
// 要素数は検査しない: ログの保存形式（Op・Dropped・LogEvent）は、根拠が空のまま捨てた add / update も
// 元の形で残す（session.ts の log）。根拠 1 件以上という制約は Claude への出力契約（DiffOutput）だけが持つ。
const Evidence = Schema.mutable(Schema.Array(Schema.String)).annotate({ description: "根拠の発言 id（例 r12）" });
// TODO の担当の話者の説明（claude.ts がここから Claude に渡す JSON Schema を作る）
const AssigneeSpeaker = Schema.String.annotate({ description: "担当の話者（例 相手 A / 自分）。名前が出ないまま、話者が自分から引き受けたとき（「私がやります」）だけ書く。頼まれた側を話者から推し量って書かない" });
const NodeRef = Schema.String.annotate({ description: "既存ノードの id（例 n3）か、同じ応答で add した ref" });

// AI が出す差分操作。`ref` は、同じ応答の後続の操作から親として指すための仮 ID。
export const Op = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    ref: Schema.String,
    parent: NodeRef,
    kind: KindSchema,
    text: Schema.String,
    evidence: Evidence,
    assignee: Schema.optionalKey(Schema.String),
    assigneeSpeaker: Schema.optionalKey(AssigneeSpeaker), // サーバーがセッションの話者か確かめる
    proposer: Schema.optionalKey(Schema.String), // サーバーが決める出した人（ログに残す）。AI の出力の契約には出さない（DiffOps で外す）
    due: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("update"),
    node: NodeRef,
    text: Schema.optionalKey(Schema.String),
    evidence: Evidence,
    planStatus: Schema.optionalKey(PlanStatusSchema),
    assignee: Schema.optionalKey(Schema.String),
    assigneeSpeaker: Schema.optionalKey(AssigneeSpeaker),
  }),
  Schema.Struct({ op: Schema.Literal("combine"), from: NodeRef, into: NodeRef }),
  Schema.Struct({ op: Schema.Literal("move"), node: NodeRef, parent: NodeRef }),
  Schema.Struct({ op: Schema.Literal("delete"), node: NodeRef }),
  Schema.Struct({ op: Schema.Literal("noop"), reason: Schema.String }),
  Schema.Struct({ op: Schema.Literal("close"), node: NodeRef }), // 議題か論点を済みにする。根拠は持たない
]);
export type Op = typeof Op["Type"];

export const Dropped = Schema.Struct({ op: Op, reason: Schema.String });
export type Dropped = typeof Dropped["Type"];

// Claude の structured_output の形。claude.ts がここから Claude に渡す JSON Schema を作り、受け取った値を検証する。
// add / update の根拠だけ、Op の構造定義を再利用したまま 1 件以上を要求する（Claude に渡す JSON Schema では minItems: 1 になる）。
const DiffOps = Op.mapMembers(([add, update, ...rest]) => [
  add.mapFields(({ proposer: _proposer, ...fields }) => ({ ...fields, evidence: fields.evidence.check(Schema.isMinLength(1)) })),
  update.mapFields((fields) => ({ ...fields, evidence: fields.evidence.check(Schema.isMinLength(1)) })),
  ...rest,
]);
// names は名前の無い回には省く。サーバーが根拠を確かめてから使う（speakerNames.ts）
export const DiffOperations = Schema.Struct({ ops: Schema.mutable(Schema.Array(DiffOps)), names: Schema.optionalKey(Schema.mutable(Schema.Array(InferredSpeakerName))) });
export const DiffOutput = Schema.Struct({ ...DiffOperations.fields, processedRemarks: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))) });
export type DiffOutput = typeof DiffOutput["Type"];

export function emptyMap(title: string): MeetingMap {
  return {
    nodes: { [ROOT_ID]: { id: ROOT_ID, parent: null, kind: "会議", text: title, evidence: [] } },
    order: [ROOT_ID],
    nextId: 1,
  };
}

// 中核は Node の実行環境に依存しない（ADR 0003）ので structuredClone を使わない
export const cloneNode = (n: MapNode): MapNode => ({ ...n, evidence: [...n.evidence] });

function cloneMap(map: MeetingMap): MeetingMap {
  const nodes: Record<string, MapNode> = {};
  for (const [id, n] of Object.entries(map.nodes)) nodes[id] = cloneNode(n);
  return { nodes, order: [...map.order], nextId: map.nextId };
}

export function children(map: MeetingMap, id: string): MapNode[] {
  return map.order.map((k) => map.nodes[k]!).filter((n) => n.parent === id);
}

// 論点の状態は保存せず、子に決定を持つかで導く
export function pointStatus(map: MeetingMap, id: string): PointStatus {
  return children(map, id).some((c) => c.kind === "決定") ? "決定済み" : "未決";
}

function isDescendant(map: MeetingMap, id: string, ancestor: string): boolean {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    if (cur.id === ancestor) return true;
  }
  return false;
}

// 木の制約: 決定と TODO は子を持たない。
const isLeafKind = (kind: MapNode["kind"]) => kind === "決定" || kind === "TODO";

// 木の制約: 決定の親は論点だけ。決定と TODO は子を持たない。
function parentError(parent: MapNode | undefined, kind: MapNode["kind"]): string | null {
  if (!parent) return "親が存在しない";
  if (isLeafKind(parent.kind)) return `${parent.kind} は子を持てない`;
  if (kind === "決定" && parent.kind !== "論点") return "決定の親は論点に限る";
  return null;
}

// id のノードから親をたどり、ルートを除く各ノードに触れた時刻を書く。id が null・存在しないときは何もしない。
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

// 1 回の反映の間だけ使う状態。仮 ID は refs で実 ID に解決する。
type ApplyState = {
  map: MeetingMap;
  refs: Map<string, string>;
  known: ReadonlySet<string>;
  round: number;
  at: number;
  changeOrder: string[];
  remarks: ReadonlyMap<string, Remark>;
};

type OpOf<K extends Op["op"]> = Extract<Op, { op: K }>;

// 捨てるときは理由を、適用したときは null を返す。
type Applied = string | null;

const resolveId = (s: ApplyState, id: string) => s.refs.get(id) ?? id;

// 対象のノード。無いかルートなら undefined。
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

function newNode(op: OpOf<"add">, id: string, parent: string, round: number): MapNode {
  return {
    id, parent, kind: op.kind, text: op.text, evidence: [...op.evidence],
    evidenceRound: round,
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
  map.nodes[id] = newNode(op, id, parentId, s.round);
  map.order.push(id);
  s.refs.set(op.ref, id);
  reopenUp(map, id);
  s.changeOrder.push(id);
  touchUp(map, id, s.at);
  return null;
}

// update の担当者。TODO だけが持つ。名前が来たら名前を置いて担当の話者は消し、名前が無いときだけ担当の話者を置く
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

function applyUpdate(s: ApplyState, op: OpOf<"update">): Applied {
  const n = target(s, op.node);
  if (!n) return "対象が無い";
  if (op.planStatus && n.kind !== "案") return "状態を持つのは案だけ";
  const err = evidenceError(s.known, op.evidence);
  if (err) return err;
  const evidenceAdded = op.evidence.some((u) => !n.evidence.includes(u));
  const assigned = assignmentOf(n, op);
  const valueChanged = (!!op.text && op.text !== n.text)
    || (!!op.planStatus && op.planStatus !== n.planStatus)
    || evidenceAdded
    || assigned.changed;
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

function combineError(map: MeetingMap, from: MapNode | undefined, into: MapNode | undefined): string | null {
  if (!from || !into || from.id === into.id) return "対象が無い";
  if (from.kind !== into.kind) return "統合は同じ種別どうしに限る";
  if (isDescendant(map, into.id, from.id)) return "子孫へは統合できない";
  if (isLeafKind(into.kind) && children(map, from.id).length) return `${into.kind} は子を持てない`;
  return null;
}

// 統合元と統合先の evidenceRound の大きい方（片方が無ければもう片方）
function mergedEvidenceRound(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return Math.max(a, b);
}

// 統合後の出した人。根拠の最も早い発言が早いほうの値を残す（同じなら統合先。比べられなければ統合先）。
// 早いほうが出した人を持たなければ、持たない（後の人を残さない）
function mergedProposer(s: ApplyState, src: MapNode, dst: MapNode): string | undefined {
  const from = earliestRemark(src.evidence, s.remarks);
  const into = earliestRemark(dst.evidence, s.remarks);
  return from && into && from.start < into.start ? src.proposer : dst.proposer;
}

function applyCombine(s: ApplyState, op: OpOf<"combine">): Applied {
  const from = target(s, op.from), into = target(s, op.into);
  const err = combineError(s.map, from, into);
  if (err) return err;
  // combineError が通ったので、どちらも存在する
  const src = from!, dst = into!;
  touchUp(s.map, src.parent, s.at);
  for (const k of children(s.map, src.id)) k.parent = dst.id;
  if (dst.kind === "案") {
    const proposer = mergedProposer(s, src, dst);
    if (proposer === undefined) delete dst.proposer; else dst.proposer = proposer;
  }
  for (const u of src.evidence) if (!dst.evidence.includes(u)) dst.evidence.push(u);
  const fromRound = src.evidenceRound;
  removeNode(s.map, src.id);
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


// マップの変更はすべてここを通す。操作は適用する時点のマップに対して検証し、
// 成り立たない操作は捨てて理由を返し、残りは適用を続ける。
// known は根拠に使える発言の ID。知らない発言を根拠に挙げた操作は捨てる。
// stamp は、この反映の番号（round）と、渡した新しい発言の end の最大値（at）。触れたノードの touchedAt と、根拠が足されたノードの evidenceRound に使う。
// combine の統合先は evidenceRound を進めず、統合元と統合先の大きい方を引き継ぐ（片方が無ければもう片方）。
// close は議題か論点を済みにする。対象かその子孫に同じ応答か直前の反映（round - 1 以降）で根拠が足されていれば捨てる。
// add・update・combine の統合先・move の移したノードは、そのノードと祖先の済みを話し中に戻す（delete・移動元・統合元では戻さない）。
// close と開き直しは changeOrder・touchedAt に影響しない。
// changeOrder は、値が実際に変わったノードの ID を操作の適用順に並べたもの（重複あり。捨てた操作・値を変えない操作・delete は含まない）。
// remarks は発言の表（id → 発言）。統合で根拠の最も早い発言を比べるのに使う。
// proposer は add の値をそのまま持たせる（案だけ）。update は変えず、combine は根拠の最も早い発言が早いほうを残す。
// refs は、適用できた add の仮 ID → 作られた n の ID（捨てた add は含まない。同じ応答で後から削除・統合されたノードの add は含む）。
export function applyOps(input: MeetingMap, ops: Op[], known: ReadonlySet<string>, stamp: { round: number; at: number }, remarks: ReadonlyMap<string, Remark>): { map: MeetingMap; dropped: Dropped[]; changeOrder: string[]; refs: Record<string, string> } {
  const s: ApplyState = { map: cloneMap(input), refs: new Map(), known, round: stamp.round, at: stamp.at, changeOrder: [], remarks };
  const dropped: Dropped[] = [];
  for (const op of ops) {
    const reason = applyOp(s, op);
    if (reason) dropped.push({ op, reason });
  }
  return { map: s.map, dropped, changeOrder: s.changeOrder, refs: Object.fromEntries(s.refs) };
}
