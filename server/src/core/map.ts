// マップと差分操作。語彙と規則は CONTEXT.md / docs/adr/0001-map-is-a-tree.md に従う。

export const KINDS = ["議題", "論点", "案", "決定", "課題", "TODO", "要点"] as const;
export type Kind = (typeof KINDS)[number];

export const PLAN_STATUSES = ["検討中", "却下"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number]; // 案の状態
export type PointStatus = "未決" | "決定済み"; // 論点の状態（保存せず導く）

export const ROOT_ID = "root";

export type MapNode = {
  id: string;
  parent: string | null; // null はルート（会議）だけ
  kind: Kind | "会議";
  text: string;
  planStatus?: PlanStatus; // 案だけ
  assignee?: string; // TODO だけ
  due?: string; // TODO だけ
  evidence: string[]; // 発言の ID。ルート以外は 1 つ以上
};

// ノードは作られた順に order に並ぶ。兄弟の並びはこの順で決まる。
export type MeetingMap = { nodes: Record<string, MapNode>; order: string[]; nextId: number };

// AI が出す差分操作。`ref` は、同じ応答の後続の操作から親として指すための仮 ID。
export type Op =
  | { op: "add"; ref: string; parent: string; kind: Kind; text: string; evidence: string[]; assignee?: string; due?: string }
  | { op: "update"; node: string; text?: string; evidence: string[]; planStatus?: PlanStatus }
  | { op: "combine"; from: string; into: string }
  | { op: "move"; node: string; parent: string }
  | { op: "delete"; node: string }
  | { op: "noop"; reason: string };

export type Dropped = { op: Op; reason: string };

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

function removeNode(map: MeetingMap, id: string) {
  delete map.nodes[id];
  map.order = map.order.filter((k) => k !== id);
}

// マップの変更はすべてここを通す。操作は適用する時点のマップに対して検証し、
// 成り立たない操作は捨てて理由を返し、残りは適用を続ける。
// known は根拠に使える発言の ID。知らない発言を根拠に挙げた操作は捨てる。
export function applyOps(input: MeetingMap, ops: Op[], known: ReadonlySet<string>): { map: MeetingMap; dropped: Dropped[] } {
  const map = cloneMap(input);
  const dropped: Dropped[] = [];
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
          ...(op.kind === "案" ? { planStatus: "検討中" as const } : {}),
          ...(op.kind === "TODO" && op.assignee ? { assignee: op.assignee } : {}),
          ...(op.kind === "TODO" && op.due ? { due: op.due } : {}),
        };
        map.order.push(id);
        refs.set(op.ref, id);
        break;
      }
      case "update": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (op.planStatus && n.kind !== "案") { drop(op, "状態を持つのは案だけ"); break; }
        const err = evidenceError(op.evidence);
        if (err) { drop(op, err); break; }
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
        n.parent = parentId;
        break;
      }
      case "combine": {
        const from = map.nodes[resolve(op.from)], into = map.nodes[resolve(op.into)];
        if (!from || !into || from.id === ROOT_ID || into.id === ROOT_ID || from.id === into.id) { drop(op, "対象が無い"); break; }
        if (from.kind !== into.kind) { drop(op, "統合は同じ種別どうしに限る"); break; }
        if (isDescendant(map, into.id, from.id)) { drop(op, "子孫へは統合できない"); break; }
        const kids = children(map, from.id);
        if (kids.length && isLeafKind(into.kind)) { drop(op, `${into.kind} は子を持てない`); break; }
        for (const k of kids) k.parent = into.id;
        for (const u of from.evidence) if (!into.evidence.includes(u)) into.evidence.push(u);
        removeNode(map, from.id);
        break;
      }
      case "delete": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (children(map, n.id).length) { drop(op, "子を持つノードは削除できない"); break; }
        removeNode(map, n.id);
        break;
      }
    }
  }
  return { map, dropped };
}
