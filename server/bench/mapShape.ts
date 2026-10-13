import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { childrenByParent, groupSize, RemarkEvent, reviewSnapshot, type SnapshotNode } from "../src/core/index.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { benchProgram, InvalidInputFile, MissingSessionDir, readInputText, write } from "./entry.ts";

export type MapShape = {
  minutes: number;
  nodes: number;
  topics: number;
  nested: number;
  topicsPerHour: number;
  maxTopic: number;
  maxGroup: number;
  derived: number;
  oneChild: number;
  oneChildRatio: number;
  longestChain: number;
  longestSameKindChain: number;
  maxDepth: number;
  childDistribution: number[];
};

// 最大のまとまり（#840 の数え方。議題・論点・案・課題・要点が対象）。同じ大きさなら snapshot で先のノード。
export function largestGroup(nodes: readonly SnapshotNode[]): { id: string; size: number } | undefined {
  let best: { id: string; size: number } | undefined;
  for (const n of nodes) {
    if (n.kind !== "議題" && n.kind !== "論点" && n.kind !== "案" && n.kind !== "課題" && n.kind !== "要点") continue;
    const size = groupSize(nodes, n.id).size;
    if (best === undefined || size > best.size) best = { id: n.id, size };
  }
  return best;
}

export function mapShape(events: readonly unknown[]): MapShape {
  const nodes = reviewSnapshot(events).nodes;
  let end = 0;
  for (const event of events) {
    if (Schema.is(RemarkEvent)(event)) end = Math.max(end, event.remark.end);
  }
  const minutes = end / 60;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = childrenByParent(nodes);
  let topics = 0, nested = 0, derived = 0, maxTopic = 0;
  const maxGroup = largestGroup(nodes)?.size ?? 0;
  let oneChild = 0, longestChain = 0, longestSameKindChain = 0, maxDepth = 0;
  const childDistribution = [0, 0, 0, 0, 0, 0, 0];
  for (const n of nodes) {
    const parent = n.parent === null ? undefined : byId.get(n.parent);
    if (n.kind === "議題") {
      topics++;
      if (parent?.kind === "議題") nested++;
    }
    if (n.kind === "論点" && parent?.kind === "論点") derived++;
    if (n.kind === "議題") maxTopic = Math.max(maxTopic, groupSize(nodes, n.id).size);
    const count = kids.get(n.id)?.length ?? 0;
    childDistribution[Math.min(6, count)]!++;
    if (count === 1) oneChild++;
    let chain = 0, same = 0;
    let current = n;
    let matching = true;
    while (kids.get(current.id)?.length === 1) {
      const child = kids.get(current.id)![0]!;
      chain++;
      matching = matching && child.kind === current.kind;
      if (matching) same++;
      current = child;
    }
    longestChain = Math.max(longestChain, chain);
    longestSameKindChain = Math.max(longestSameKindChain, same);
    let depth = 0;
    for (let current = n; current.parent !== null; current = byId.get(current.parent)!) depth++;
    maxDepth = Math.max(maxDepth, depth);
  }
  return {
    minutes, nodes: nodes.length, topics, nested,
    topicsPerHour: minutes === 0 ? 0 : topics / (minutes / 60),
    maxTopic, maxGroup, derived, oneChild, oneChildRatio: oneChild / nodes.length,
    longestChain, longestSameKindChain, maxDepth, childDistribution,
  };
}

const columns = ["セッション", "分", "ノード", "議題（入れ子）", "議題/時", "最大の議題", "最大のまとまり", "派生の論点", "子が 1 つ", "鎖の最長", "同じ種別の鎖の最長", "最大の深さ", "子の数の分布（0/1/2/3/4/5/6+）"];
const tableRow = (cells: readonly (string | number)[]) => `| ${cells.join(" | ")} |`;

function formatRow(dir: string, s: MapShape): string {
  const label = dir.replace(/\/$/, "").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
  return tableRow([
    label, s.minutes.toFixed(0), s.nodes, `${s.topics}（${s.nested}）`, s.topicsPerHour.toFixed(1),
    s.maxTopic, s.maxGroup, s.derived, `${s.oneChild}（${Math.round(s.oneChildRatio * 100)}%）`,
    s.longestChain, s.longestSameKindChain, s.maxDepth, s.childDistribution.join("/"),
  ]);
}

const readEvents = Effect.fn("readEvents")(function* (path: string) {
  const text = yield* readInputText(path);
  const events: unknown[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    events.push(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
      Effect.mapError(() => new InvalidInputFile({ path, reason: `${i + 1} 行目の JSON が不正です` })),
    ));
  }
  return events;
});

export const command = Command.make("mapShape", {
  paths: Argument.String("session").pipe(Argument.withDescription("log.jsonl のあるセッションフォルダ（1 つ以上）"), Argument.atLeast(1)),
}, Effect.fn("mapShape")(function* ({ paths }) {
  const fs = yield* FileSystem.FileSystem;
  const inputs = yield* Effect.forEach(paths, (dir) => Effect.gen(function* () {
    const info = yield* fs.stat(dir).pipe(Effect.mapError(() => new MissingSessionDir({ path: dir, reason: "フォルダを読めません" })));
    if (info.type !== "Directory") return yield* new MissingSessionDir({ path: dir, reason: "フォルダではありません" });
    const path = join(dir, "log.jsonl");
    const log = yield* fs.stat(path).pipe(Effect.mapError(() => new InvalidInputFile({ path, reason: "ログを読めません" })));
    if (log.type !== "File") return yield* new InvalidInputFile({ path, reason: "通常のファイルではありません" });
    return { dir, path };
  }));
  yield* write(tableRow(columns));
  yield* write(tableRow(columns.map(() => "---")));
  for (const { dir, path } of inputs) {
    const events = yield* readEvents(path);
    // 復元エラーには発言参照や schema の実値が含まれるので、本文を持たない診断へ変換する。
    const shape = yield* Effect.try({ try: () => mapShape(events), catch: () => new InvalidInputFile({ path, reason: "イベントの形が不正か、マップを復元できません" }) });
    yield* write(formatRow(dir, shape));
  }
})).pipe(Command.withDescription("保存したセッションのマップを復元し、本文を出さずに形の数だけを Markdown 表で比較する"));

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
