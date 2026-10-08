// マップと差分操作。語彙と規則は GLOSSARY.md / docs/adr/0001-map-is-a-tree.md に従う。
// 型は Schema を正本にして導き、値は普通のオブジェクトのままにする（ADR 0007）。
import { Schema } from "effect";

export const KINDS = ["議題", "論点", "案", "決定", "課題", "TODO", "要点"] as const;
export type Kind = (typeof KINDS)[number];
const KindSchema = Schema.Literals(KINDS);

export const PLAN_STATUSES = ["検討中", "却下"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number]; // 案の状態
const PlanStatusSchema = Schema.Literals(PLAN_STATUSES);
export type PointStatus = "未決" | "決定済み"; // 論点の状態（保存せず導く）

export const ROOT_ID = "root";

export const MapNode = Schema.Struct({
  id: Schema.String,
  parent: Schema.mutableKey(Schema.NullOr(Schema.String)), // null はルート（会議）だけ
  kind: Schema.Literals([...KINDS, "会議"]),
  text: Schema.mutableKey(Schema.String),
  planStatus: Schema.optionalKey(Schema.mutableKey(PlanStatusSchema)), // 案だけ
  assignee: Schema.optionalKey(Schema.String), // TODO だけ
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
    due: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("update"),
    node: NodeRef,
    text: Schema.optionalKey(Schema.String),
    evidence: Evidence,
    planStatus: Schema.optionalKey(PlanStatusSchema),
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
  add.mapFields((fields) => ({ ...fields, evidence: fields.evidence.check(Schema.isMinLength(1)) })),
  update.mapFields((fields) => ({ ...fields, evidence: fields.evidence.check(Schema.isMinLength(1)) })),
  ...rest,
]);
export const DiffOutput = Schema.Struct({ ops: Schema.mutable(Schema.Array(DiffOps)) });
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

// マップの変更はすべてここを通す。操作は適用する時点のマップに対して検証し、
// 成り立たない操作は捨てて理由を返し、残りは適用を続ける。
// known は根拠に使える発言の ID。知らない発言を根拠に挙げた操作は捨てる。
// stamp は、この反映の番号（round）と、渡した新しい発言の end の最大値（at）。触れたノードの touchedAt と、根拠が足されたノードの evidenceRound に使う。
// combine の統合先は evidenceRound を進めず、統合元と統合先の大きい方を引き継ぐ（片方が無ければもう片方）。
// close は議題か論点を済みにする。対象かその子孫に同じ応答か直前の反映（round - 1 以降）で根拠が足されていれば捨てる。
// add・update・combine の統合先・move の移したノードは、そのノードと祖先の済みを話し中に戻す（delete・移動元・統合元では戻さない）。
// close と開き直しは changeOrder・touchedAt に影響しない。
// changeOrder は、値が実際に変わったノードの ID を操作の適用順に並べたもの（重複あり。捨てた操作・値を変えない操作・delete は含まない）。
export function applyOps(input: MeetingMap, ops: Op[], known: ReadonlySet<string>, stamp: { round: number; at: number }): { map: MeetingMap; dropped: Dropped[]; changeOrder: string[] } {
  const { round, at } = stamp;
  const map = cloneMap(input);
  const dropped: Dropped[] = [];
  const changeOrder: string[] = [];
  const refs = new Map<string, string>();
  const resolve = (id: string) => refs.get(id) ?? id;
  const drop = (op: Op, reason: string) => dropped.push({ op, reason });
  const evidenceError = (evidence: string[]) => {
    const unknown = evidence.filter((u) => !known.has(u));
    if (unknown.length) return `根拠に知らない発言がある: ${unknown.join(", ")}`;
    if (evidence.length === 0) return "根拠が無い";
    return null;
  };

  for (const op of ops) {
    switch (op.op) {
      case "noop":
        break;
      case "add": {
        if (map.nodes[op.ref] || refs.has(op.ref)) { drop(op, "仮 ID が既存の ID と重なる"); break; }
        const parentId = resolve(op.parent);
        const err = parentError(map.nodes[parentId], op.kind) ?? evidenceError(op.evidence);
        if (err) { drop(op, err); break; }
        const id = `n${map.nextId++}`;
        map.nodes[id] = {
          id, parent: parentId, kind: op.kind, text: op.text, evidence: [...op.evidence],
          evidenceRound: round,
          ...(op.kind === "案" ? { planStatus: "検討中" as const } : {}),
          ...(op.kind === "TODO" && op.assignee ? { assignee: op.assignee } : {}),
          ...(op.kind === "TODO" && op.due ? { due: op.due } : {}),
        };
        map.order.push(id);
        refs.set(op.ref, id);
        reopenUp(map, id);
        changeOrder.push(id);
        touchUp(map, id, at);
        break;
      }
      case "update": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (op.planStatus && n.kind !== "案") { drop(op, "状態を持つのは案だけ"); break; }
        const err = evidenceError(op.evidence);
        if (err) { drop(op, err); break; }
        const evidenceAdded = op.evidence.some((u) => !n.evidence.includes(u));
        const valueChanged = (!!op.text && op.text !== n.text)
          || (!!op.planStatus && op.planStatus !== n.planStatus)
          || evidenceAdded;
        reopenUp(map, n.id);
        if (valueChanged) { changeOrder.push(n.id); touchUp(map, n.id, at); }
        if (evidenceAdded) n.evidenceRound = round;
        if (op.text) n.text = op.text;
        if (op.planStatus) n.planStatus = op.planStatus;
        for (const u of op.evidence) if (!n.evidence.includes(u)) n.evidence.push(u);
        break;
      }
      case "move": {
        const n = map.nodes[resolve(op.node)], parentId = resolve(op.parent);
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (isDescendant(map, parentId, n.id)) { drop(op, "自分の子孫の下へは移せない"); break; }
        const err = parentError(map.nodes[parentId], n.kind);
        if (err) { drop(op, err); break; }
        if (n.parent !== parentId) {
          changeOrder.push(n.id);
          touchUp(map, n.parent, at);
          n.parent = parentId;
          touchUp(map, n.id, at);
        }
        reopenUp(map, n.id);
        break;
      }
      case "combine": {
        const from = map.nodes[resolve(op.from)], into = map.nodes[resolve(op.into)];
        if (!from || !into || from.id === ROOT_ID || into.id === ROOT_ID || from.id === into.id) { drop(op, "対象が無い"); break; }
        if (from.kind !== into.kind) { drop(op, "統合は同じ種別どうしに限る"); break; }
        if (isDescendant(map, into.id, from.id)) { drop(op, "子孫へは統合できない"); break; }
        const kids = children(map, from.id);
        if (kids.length && isLeafKind(into.kind)) { drop(op, `${into.kind} は子を持てない`); break; }
        touchUp(map, from.parent, at);
        for (const k of kids) k.parent = into.id;
        for (const u of from.evidence) if (!into.evidence.includes(u)) into.evidence.push(u);
        const fromRound = from.evidenceRound;
        removeNode(map, from.id);
        changeOrder.push(into.id);
        const mergedRound = fromRound === undefined || into.evidenceRound === undefined
          ? (fromRound ?? into.evidenceRound)
          : Math.max(fromRound, into.evidenceRound);
        if (mergedRound !== undefined) into.evidenceRound = mergedRound;
        touchUp(map, into.id, at);
        reopenUp(map, into.id);
        break;
      }
      case "delete": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (children(map, n.id).length) { drop(op, "子を持つノードは削除できない"); break; }
        touchUp(map, n.parent, at);
        removeNode(map, n.id);
        break;
      }
      case "close": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (n.kind !== "議題" && n.kind !== "論点") { drop(op, "閉じられるのは議題・論点だけ"); break; }
        if (n.talkStatus) { drop(op, "すでに済み"); break; }
        const recentlyEvidenced = Object.values(map.nodes).some((m) => (m.evidenceRound ?? -Infinity) >= round - 1 && isDescendant(map, m.id, n.id));
        if (recentlyEvidenced) { drop(op, "同じ応答か直前の差分更新で根拠が足されている"); break; }
        n.talkStatus = "済み";
        break;
      }
    }
  }
  return { map, dropped, changeOrder };
}
