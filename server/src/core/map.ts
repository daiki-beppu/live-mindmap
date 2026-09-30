// マップと差分操作。語彙と規則は CONTEXT.md / docs/adr/0001-map-is-a-tree.md に従う。

export const KINDS = ["議題", "論点", "案", "決定", "課題", "TODO"] as const;
export type Kind = (typeof KINDS)[number];

export const ROOT_ID = "root";

export type MapNode = {
  id: string;
  parent: string | null; // null はルート（会議）だけ
  kind: Kind | "会議";
  text: string;
  proposalStatus?: "検討中" | "却下"; // 案だけ
  assignee?: string; // TODO だけ
  due?: string; // TODO だけ
  evidence: string[]; // 発言の ID。ルート以外は 1 つ以上
};

// ノードは作られた順に order に並ぶ。兄弟の並びはこの順で決まる。
export type MindMap = { nodes: Record<string, MapNode>; order: string[]; nextId: number };

// AI が出す差分操作。`ref` は、同じ応答の後続の操作から親として指すための仮 ID。
export type Op =
  | { op: "add"; ref: string; parent: string; kind: Kind; text: string; evidence: string[]; assignee?: string; due?: string }
  | { op: "update"; node: string; text?: string; evidence: string[]; proposalStatus?: "検討中" | "却下" }
  | { op: "merge"; from: string; into: string }
  | { op: "move"; node: string; parent: string }
  | { op: "delete"; node: string }
  | { op: "noop"; reason: string };

export type Dropped = { op: Op; reason: string };

export function emptyMap(title: string): MindMap {
  return {
    nodes: { [ROOT_ID]: { id: ROOT_ID, parent: null, kind: "会議", text: title, evidence: [] } },
    order: [ROOT_ID],
    nextId: 1,
  };
}

export function children(map: MindMap, id: string): MapNode[] {
  return map.order.map((k) => map.nodes[k]!).filter((n) => n.parent === id);
}

// 論点の状態は保存せず、子に決定を持つかで導く
export function issueStatus(map: MindMap, id: string): "未決" | "決定済み" {
  return children(map, id).some((c) => c.kind === "決定") ? "決定済み" : "未決";
}

function isDescendant(map: MindMap, id: string, ancestor: string): boolean {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    if (cur.id === ancestor) return true;
  }
  return false;
}

// 木の制約: 決定の親は論点だけ。決定と TODO は子を持たない。
function parentError(parent: MapNode | undefined, kind: MapNode["kind"]): string | null {
  if (!parent) return "親が存在しない";
  if (parent.kind === "決定" || parent.kind === "TODO") return `${parent.kind} は子を持てない`;
  if (kind === "決定" && parent.kind !== "論点") return "決定の親は論点に限る";
  return null;
}

// マップの変更はすべてここを通す。操作は適用する時点のマップに対して検証し、
// 成り立たない操作は捨てて理由を返し、残りは適用を続ける。
// known は根拠に使える発言の ID。知らない発言の ID は根拠から外す。
export function applyOps(input: MindMap, ops: Op[], known: ReadonlySet<string>): { map: MindMap; dropped: Dropped[] } {
  const map: MindMap = structuredClone(input);
  const dropped: Dropped[] = [];
  const refs = new Map<string, string>();
  const resolve = (id: string) => refs.get(id) ?? id;
  const drop = (op: Op, reason: string) => dropped.push({ op, reason });

  for (const op of ops) {
    switch (op.op) {
      case "noop":
        break;
      case "add": {
        const parentId = resolve(op.parent);
        const err = parentError(map.nodes[parentId], op.kind);
        if (err) { drop(op, err); break; }
        const evidence = op.evidence.filter((u) => known.has(u));
        if (evidence.length === 0) { drop(op, "根拠に既知の発言が無い"); break; }
        const id = `n${map.nextId++}`;
        map.nodes[id] = {
          id, parent: parentId, kind: op.kind, text: op.text, evidence,
          ...(op.kind === "案" ? { proposalStatus: "検討中" as const } : {}),
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
        if (op.proposalStatus && n.kind !== "案") { drop(op, "状態を持つのは案だけ"); break; }
        if (op.text) n.text = op.text;
        if (op.proposalStatus) n.proposalStatus = op.proposalStatus;
        for (const u of op.evidence) if (known.has(u) && !n.evidence.includes(u)) n.evidence.push(u);
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
      case "merge": {
        const a = map.nodes[resolve(op.from)], b = map.nodes[resolve(op.into)];
        if (!a || !b || a.id === ROOT_ID || b.id === ROOT_ID || a.id === b.id) { drop(op, "対象が無い"); break; }
        if (a.kind !== b.kind) { drop(op, "統合は同じ種別どうしに限る"); break; }
        if (isDescendant(map, b.id, a.id)) { drop(op, "子孫へは統合できない"); break; }
        const kids = children(map, a.id);
        if (kids.length && (b.kind === "決定" || b.kind === "TODO")) { drop(op, `${b.kind} は子を持てない`); break; }
        for (const k of kids) k.parent = b.id;
        for (const u of a.evidence) if (!b.evidence.includes(u)) b.evidence.push(u);
        delete map.nodes[a.id];
        map.order = map.order.filter((k) => k !== a.id);
        break;
      }
      case "delete": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT_ID) { drop(op, "対象が無い"); break; }
        if (children(map, n.id).length) { drop(op, "子を持つノードは削除できない"); break; }
        delete map.nodes[n.id];
        map.order = map.order.filter((k) => k !== n.id);
        break;
      }
    }
  }
  return { map, dropped };
}
