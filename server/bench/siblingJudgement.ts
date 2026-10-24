import { Effect, Schema } from "effect";
import { childrenByParent } from "../src/core/groupSize.ts";
import type { Judge } from "./claudeJudge.ts";
import { largestGroup } from "./mapShape.ts";
import { restoredNodes } from "./restoredNodes.ts";

const LABELS = ["別", "具体化", "重なり", "外れ"] as const;
const Label = Schema.Literals(LABELS);
type Label = typeof Label["Type"];
const isLabel = Schema.is(Label);
const MIN_CHILDREN = 5;
const ATTEMPTS = 5;
const BIG_GROUP = 40;
const RUNS = 5;

const PROMPT = `会議のマインドマップで、1 つの親の下に並んだ兄弟（子）を判定してください。最初の行が親、続く各行が「番号. [種別] 本文」の子です。
兄弟は「同じ親について並ぶ、別々の中身（同じ論点への別の案、同じ議題の別の紹介、同じ要点の別の具体例）」であるべきです。
各子が次のどれに当たるかを、1 つだけ選んでください。
- 別: 親について、ほかの兄弟とは別の中身を述べている
- 具体化: ほかの兄弟のどれかを具体化している（例・数字・内訳・経緯）。兄弟ではなく、その兄弟の子に置くべきもの
- 重なり: ほかの兄弟のどれかとほぼ同じ中身の言い換え・繰り返し
- 外れ: 親についての中身ではない（別の話題、親との関係が言えない）
番号の順に、ラベルだけの JSON 配列を返してください（例: ["別","具体化"]）。説明は書かないでください。`;

class SiblingJudgementFailed extends Schema.TaggedError<SiblingJudgementFailed>()("SiblingJudgementFailed", {
  message: Schema.String,
}) {}

type Child = { id: string; label: Label };
export type Counts = Record<Label, number>;
export type Tally = { total: number; counts: Counts; notSeparate: number; notSeparateRatio: number };
type Check = {
  childCount: number;
  runs: { children: Child[]; notSeparate: number }[];
  median: number;
  threshold: number;
  pass: boolean;
};
export type SiblingJudgement = Tally & {
  parents: { parent: string; children: Child[] }[];
  target: (Tally & { parent: string; children: Child[] }) | null;
  maxGroup: {
    parent: string;
    size: number;
    check: Check | null;
  } | null;
};

function tally(children: readonly Child[]): Tally {
  const counts: Counts = { 別: 0, 具体化: 0, 重なり: 0, 外れ: 0 };
  for (const child of children) counts[child.label]++;
  const notSeparate = children.length - counts.別;
  return { total: children.length, counts, notSeparate, notSeparateRatio: children.length === 0 ? 0 : notSeparate / children.length };
}

function parseLabels(out: string, want: number): Label[] | undefined {
  const array = out.match(/\[[^\[\]]*\]/g)?.at(-1);
  if (array === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(array);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== want) return undefined;
  const labels = value.map((v) => (v === "外" ? "外れ" : v));
  return labels.every(isLabel) ? labels : undefined;
}

type Node = { id: string; kind: string; text: string };

const judgeChildren = Effect.fnUntraced(function* <E, R>(parent: Node, children: readonly Node[], judge: Judge<E, R>) {
  const lines = [`親 [${parent.kind}] ${parent.text}`, ...children.map((child, i) => `${i + 1}. [${child.kind}] ${child.text}`)];
  const prompt = `${PROMPT}\n\n${lines.join("\n")}`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const out = yield* judge(prompt).pipe(
      Effect.mapError(() => new SiblingJudgementFailed({ message: `親 ${parent.id} の判定器が失敗しました` })),
    );
    const labels = parseLabels(out, children.length);
    if (labels !== undefined) return children.map((child, i): Child => ({ id: child.id, label: labels[i]! }));
  }
  return yield* new SiblingJudgementFailed({ message: `親 ${parent.id} の判定の形が合いません（期待 ${children.length} 件、${ATTEMPTS} 回で終了）` });
});

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

type TreeNode = Node & { parent: string | null };
type Kids = Map<string, TreeNode[]>;

const judgeParents = Effect.fnUntraced(function* <E, R>(nodes: readonly TreeNode[], kids: Kids, judge: Judge<E, R>) {
  const parents: SiblingJudgement["parents"] = [];
  for (const node of nodes) {
    const children = kids.get(node.id) ?? [];
    if (node.parent === null || children.length < MIN_CHILDREN) continue;
    parents.push({ parent: node.id, children: yield* judgeChildren(node, children, judge) });
  }
  return parents;
});

const judgeTarget = Effect.fnUntraced(function* <E, R>(
  target: TreeNode,
  parents: SiblingJudgement["parents"],
  kids: Kids,
  judge: Judge<E, R>,
) {
  const reused = parents.find((p) => p.parent === target.id);
  const children = reused?.children ?? (kids.has(target.id) ? yield* judgeChildren(target, kids.get(target.id)!, judge) : []);
  return { parent: target.id, children, ...tally(children) } satisfies NonNullable<SiblingJudgement["target"]>;
});

function checkOf(runs: Check["runs"], overall: Tally, childCount: number): Check {
  const mid = median(runs.map((run) => run.notSeparate));
  const pass = overall.total === 0
    ? mid <= 1
    : mid * overall.total <= overall.notSeparate * childCount + overall.total;
  const threshold = overall.total === 0 ? 1 : overall.notSeparateRatio * childCount + 1;
  return { childCount, runs, median: mid, threshold, pass };
}

const judgeLargest = Effect.fnUntraced(function* <E, R>(
  largest: { id: string; size: number },
  byId: Map<string, TreeNode>,
  kids: Kids,
  overall: Tally,
  judge: Judge<E, R>,
) {
  let check: Check | null = null;
  if (largest.size > BIG_GROUP) {
    const parent = byId.get(largest.id)!;
    const children = kids.get(largest.id) ?? [];
    const runs: Check["runs"] = [];
    for (let i = 0; i < RUNS; i++) {
      const labelled = yield* judgeChildren(parent, children, judge);
      runs.push({ children: labelled, notSeparate: tally(labelled).notSeparate });
    }
    check = checkOf(runs, overall, children.length);
  }
  return { parent: largest.id, size: largest.size, check } satisfies NonNullable<SiblingJudgement["maxGroup"]>;
});

export const judgeSiblings = Effect.fnUntraced(function* <E, R>(
  events: Iterable<unknown>,
  judge: Judge<E, R>,
  options: { parent?: string } = {},
) {
  const { nodes, byId } = yield* restoredNodes(events).pipe(
    Effect.mapError((error) => new SiblingJudgementFailed({ message: `イベント ${error.index + 1} を復元できません` })),
  );
  const kids = childrenByParent(nodes);
  const target = options.parent === undefined ? undefined : byId.get(options.parent);
  if (options.parent !== undefined && (target === undefined || target.parent === null)) {
    return yield* new SiblingJudgementFailed({ message: "指定した親が最終マップにないか、ルートです" });
  }

  const parents = yield* judgeParents(nodes, kids, judge);
  const overall = tally(parents.flatMap((p) => p.children));
  const targetResult: SiblingJudgement["target"] = target === undefined ? null : yield* judgeTarget(target, parents, kids, judge);
  const largest = largestGroup(nodes);
  const maxGroup: SiblingJudgement["maxGroup"] = largest === undefined ? null : yield* judgeLargest(largest, byId, kids, overall, judge);

  return { parents, ...overall, target: targetResult, maxGroup } satisfies SiblingJudgement;
});

export const HEADER = "| セッション | 子が 5 以上の親 | 判定した子 | 別 / 具体化 / 重なり / 外れ | 別でない | 指定した親 | 最大のまとまり | 5 回の別でない | 中央値 / 閾値 | 合否 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
const countsText = (c: Counts) => `${c.別} / ${c.具体化} / ${c.重なり} / ${c.外れ}`;

export function formatRow(name: string, result: SiblingJudgement): string {
  const { target, maxGroup } = result;
  const check = maxGroup?.check ?? null;
  const targetCell = target === null ? "-" : `${target.parent}（${countsText(target.counts)}、別でない ${target.notSeparate}（${percent(target.notSeparateRatio)}））`;
  return [
    name, result.parents.length, result.total, countsText(result.counts), `${result.notSeparate}（${percent(result.notSeparateRatio)}）`,
    targetCell,
    maxGroup === null ? "-" : `${maxGroup.parent}（${maxGroup.size}）`,
    check === null ? "-" : check.runs.map((run) => run.notSeparate).join(" / "),
    check === null ? "-" : `${check.median} / ${check.threshold.toFixed(1)}`,
    check === null ? "不要" : check.pass ? "通す" : "通さない",
  ].reduce<string>((row, cell) => `${row} ${cell} |`, "|");
}
