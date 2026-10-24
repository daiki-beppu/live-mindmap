import { Effect, Result, Schema } from "effect";
import type { Judge } from "./claudeJudge.ts";
import { restoredNodes } from "./restoredNodes.ts";

const Label = Schema.Literals(["具体化", "答え", "派生", "なし"]);
type Label = typeof Label["Type"];
const decodeLabels = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Label)));
const BATCH = 40;
const ATTEMPTS = 3;

const PROMPT = `会議のマインドマップの親子の辺を判定してください。各行は「番号. 親 [種別] 本文 → 子 [種別] 本文」です。
子が親に対して次のどれに当たるかを、1 つだけ選んでください。
- 具体化: 子が親の中身を具体化する（例・数字・手順・経緯・内訳）
- 答え: 子が親（問い・論点・質問）に答える、または親への答えの候補である
- 派生: 子が親から派生した別の主張（理由・懸念・反応・関連する案・下位の話題）で、親との関係を一言で言える
- なし: 親との意味のつながりが言えない（話の順で続いただけ、別の話題）
番号の順に、ラベルだけの JSON 配列を返してください（例: ["具体化","なし"]）。説明は書かないでください。`;

class EdgeJudgementFailed extends Schema.TaggedError<EdgeJudgementFailed>()("EdgeJudgementFailed", {
  message: Schema.String,
}) {}

export type EdgeJudgement = {
  edges: { id: string; parent: string; label: Label }[];
  total: number;
  counts: Record<Label, number>;
  none: number;
  noneRatio: number;
};

const judgeBatch = Effect.fnUntraced(function* <E, R>(prompt: string, want: number, batch: number, judge: Judge<E, R>) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const out = yield* judge(prompt).pipe(
      Effect.mapError(() => new EdgeJudgementFailed({ message: `バッチ ${batch} の判定器が失敗しました` })),
    );
    const array = out.match(/\[[^\[\]]*\]/g)?.at(-1);
    if (array === undefined) continue;
    const decoded = yield* Effect.result(decodeLabels(array));
    if (Result.isSuccess(decoded) && decoded.success.length === want) return decoded.success;
  }
  return yield* new EdgeJudgementFailed({ message: `バッチ ${batch} の判定の形が合いません（期待 ${want} 件、${ATTEMPTS} 回で終了）` });
});

export const judgeEdges = Effect.fnUntraced(function* <E, R>(events: Iterable<unknown>, judge: Judge<E, R>) {
  const { nodes, byId } = yield* restoredNodes(events).pipe(
    Effect.mapError((error) => new EdgeJudgementFailed({ message: `イベント ${error.index + 1} を復元できません` })),
  );
  const targets = nodes.flatMap((child) => {
    if (child.parent === null) return [];
    const parent = byId.get(child.parent)!;
    return parent.parent === null ? [] : [{ child, parent }];
  });
  const edges: EdgeJudgement["edges"] = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const lines = batch.map(({ parent, child }, j) => `${j + 1}. 親 [${parent.kind}] ${parent.text} → 子 [${child.kind}] ${child.text}`);
    const labels = yield* judgeBatch(`${PROMPT}\n\n${lines.join("\n")}`, batch.length, i / BATCH + 1, judge);
    for (const [j, { child, parent }] of batch.entries()) edges.push({ id: child.id, parent: parent.id, label: labels[j]! });
  }
  const counts: Record<Label, number> = { 具体化: 0, 答え: 0, 派生: 0, なし: 0 };
  for (const edge of edges) counts[edge.label]++;
  return { edges, total: edges.length, counts, none: counts.なし, noneRatio: edges.length === 0 ? 0 : counts.なし / edges.length } satisfies EdgeJudgement;
});

export function formatRow(name: string, result: EdgeJudgement): string {
  return `| ${name} | ${result.total} | ${result.counts.具体化} / ${result.counts.答え} / ${result.counts.派生} / ${result.counts.なし} | ${result.none}（${(result.noneRatio * 100).toFixed(1)}%） |`;
}
