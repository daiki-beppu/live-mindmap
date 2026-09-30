// PROTOTYPE — 差分更新エンジンの試作（issue #6）。本番コードではない。
// マップと差分操作の純粋モジュール。DOM も I/O も持たず、本実装へそのまま持ち上げられる形にしている。
// 語彙と規則は CONTEXT.md / docs/adr/0001-map-is-a-tree.md に従う。

export const KINDS = ["議題", "論点", "案", "決定", "課題", "TODO"] as const;
export type Kind = (typeof KINDS)[number];

export type Segment = { id: string; start: number; end: number; track: string; text: string };

export type MapNode = {
  id: string;
  parent: string | null; // null はルート（会議）だけ
  kind: Kind | "会議";
  text: string;
  proposalStatus?: "検討中" | "却下"; // 案だけ
  assignee?: string; // TODO だけ
  due?: string; // TODO だけ
  evidence: string[]; // 発言 id。ルート以外は 1 つ以上
  createdAt: number; // 会議内の秒。表示と評価用
  updatedAt: number;
};

export type MindMap = { nodes: Record<string, MapNode>; order: string[]; nextId: number };

// AI が出す差分操作。`ref` は同じ呼び出しの中で追加したノードを後続の操作から指すための仮 id。
export type Op =
  | { op: "add"; ref: string; parent: string; kind: Kind; text: string; evidence: string[]; assignee?: string; due?: string }
  | { op: "update"; node: string; text?: string; evidence: string[]; proposalStatus?: "検討中" | "却下" }
  | { op: "merge"; from: string; into: string }
  | { op: "move"; node: string; parent: string }
  | { op: "delete"; node: string }
  | { op: "noop"; reason: string };

export type Applied = { op: Op; ok: true; nodeId?: string } | { op: Op; ok: false; error: string };

export const ROOT = "root";

export function emptyMap(title = "会議"): MindMap {
  return {
    nodes: { [ROOT]: { id: ROOT, parent: null, kind: "会議", text: title, evidence: [], createdAt: 0, updatedAt: 0 } },
    order: [ROOT],
    nextId: 1,
  };
}

export function children(map: MindMap, id: string): MapNode[] {
  return map.order.map((k) => map.nodes[k]!).filter((n) => n.parent === id);
}

// 論点の状態は保存せず、決定の子を持つかで導く（「解決」は決定の追加で表す）
export function issueStatus(map: MindMap, id: string): "未決" | "決定済み" {
  return children(map, id).some((c) => c.kind === "決定") ? "決定済み" : "未決";
}

function isDescendant(map: MindMap, id: string, ancestor: string): boolean {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    if (cur.id === ancestor) return true;
  }
  return false;
}

// 親子の規則: 決定の親は論点に限る。決定と TODO は子を持たない。
function parentError(parent: MapNode | undefined, kind: MapNode["kind"]): string | null {
  if (!parent) return "親が存在しない";
  if (parent.kind === "決定" || parent.kind === "TODO") return `${parent.kind} は子を持てない`;
  if (kind === "決定" && parent.kind !== "論点") return "決定の親は論点に限る";
  return null;
}

// 操作列を順に適用する。不正な操作は飛ばしてエラーとして記録し、残りは適用を続ける。
export function applyOps(input: MindMap, ops: Op[], now: number, knownSegments: Set<string>): { map: MindMap; results: Applied[] } {
  const map: MindMap = structuredClone(input);
  const refs = new Map<string, string>();
  const resolve = (id: string) => refs.get(id) ?? id;
  const results: Applied[] = [];
  const fail = (op: Op, error: string) => results.push({ op, ok: false, error });

  for (const op of ops) {
    switch (op.op) {
      case "noop":
        results.push({ op, ok: true });
        break;
      case "add": {
        const parentId = resolve(op.parent);
        const err = parentError(map.nodes[parentId], op.kind);
        if (err) { fail(op, err); break; }
        const evidence = op.evidence.filter((s) => knownSegments.has(s));
        if (evidence.length === 0) { fail(op, "根拠が無い"); break; }
        const id = `n${map.nextId++}`;
        map.nodes[id] = {
          id, parent: parentId, kind: op.kind, text: op.text, evidence, createdAt: now, updatedAt: now,
          ...(op.kind === "案" ? { proposalStatus: "検討中" as const } : {}),
          ...(op.kind === "TODO" ? { assignee: op.assignee, due: op.due } : {}),
        };
        map.order.push(id);
        refs.set(op.ref, id);
        results.push({ op, ok: true, nodeId: id });
        break;
      }
      case "update": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT) { fail(op, "対象が無い"); break; }
        if (op.proposalStatus && n.kind !== "案") { fail(op, "状態を持つのは案だけ"); break; }
        if (op.text) n.text = op.text;
        if (op.proposalStatus) n.proposalStatus = op.proposalStatus;
        for (const s of op.evidence) if (knownSegments.has(s) && !n.evidence.includes(s)) n.evidence.push(s);
        n.updatedAt = now;
        results.push({ op, ok: true, nodeId: n.id });
        break;
      }
      case "merge": {
        const a = map.nodes[resolve(op.from)], b = map.nodes[resolve(op.into)];
        if (!a || !b || a.id === ROOT || b.id === ROOT || a.id === b.id) { fail(op, "対象が無い"); break; }
        if (a.kind !== b.kind) { fail(op, "統合は同じ種別どうしに限る"); break; }
        if (isDescendant(map, b.id, a.id)) { fail(op, "子孫へは統合できない"); break; }
        const kids = children(map, a.id);
        if (kids.length && (b.kind === "決定" || b.kind === "TODO")) { fail(op, `${b.kind} は子を持てない`); break; }
        for (const k of kids) k.parent = b.id;
        for (const s of a.evidence) if (!b.evidence.includes(s)) b.evidence.push(s);
        b.updatedAt = now;
        delete map.nodes[a.id];
        map.order = map.order.filter((k) => k !== a.id);
        results.push({ op, ok: true, nodeId: b.id });
        break;
      }
      case "move": {
        const n = map.nodes[resolve(op.node)], parentId = resolve(op.parent);
        if (!n || n.id === ROOT) { fail(op, "対象が無い"); break; }
        if (isDescendant(map, parentId, n.id)) { fail(op, "自分の子孫の下へは移せない"); break; }
        const err = parentError(map.nodes[parentId], n.kind);
        if (err) { fail(op, err); break; }
        n.parent = parentId;
        n.updatedAt = now;
        results.push({ op, ok: true, nodeId: n.id });
        break;
      }
      case "delete": {
        const n = map.nodes[resolve(op.node)];
        if (!n || n.id === ROOT) { fail(op, "対象が無い"); break; }
        if (children(map, n.id).length) { fail(op, "子を持つノードは削除できない"); break; }
        delete map.nodes[n.id];
        map.order = map.order.filter((k) => k !== n.id);
        results.push({ op, ok: true });
        break;
      }
    }
  }
  return { map, results };
}

// プロンプトに渡すマップの表現。根拠は渡さず、id・種別・状態・本文だけを字下げした木で出す。
export function renderOutline(map: MindMap): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = map.nodes[id]!;
    const status = n.kind === "論点" ? `(${issueStatus(map, id)})` : n.proposalStatus === "却下" ? "(却下)" : "";
    const todo = n.kind === "TODO" && (n.assignee || n.due) ? ` [${[n.assignee, n.due].filter(Boolean).join(" / ")}]` : "";
    lines.push(`${"  ".repeat(depth)}- ${n.id} ${n.kind}${status}: ${n.text}${todo}`);
    for (const c of children(map, id)) walk(c.id, depth + 1);
  };
  walk(ROOT, 0);
  return lines.join("\n");
}
