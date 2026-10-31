import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { judgeEdges, formatRow } from "../bench/edgeJudgement.ts";
import { childText, edgeEvents, PARENT_TEXT, REMARK_TEXT, TITLE } from "./fixtures/edgeJudgement.ts";

// order.md が外部スクリプトと同じプロンプトを指定しているため、転送値を検証する。モデルの判断品質は証明しない。
const PROMPT = `会議のマインドマップの親子の辺を判定してください。各行は「番号. 親 [種別] 本文 → 子 [種別] 本文」です。
子が親に対して次のどれに当たるかを、1 つだけ選んでください。
- 具体化: 子が親の中身を具体化する（例・数字・手順・経緯・内訳）
- 答え: 子が親（問い・論点・質問）に答える、または親への答えの候補である
- 派生: 子が親から派生した別の主張（理由・懸念・反応・関連する案・下位の話題）で、親との関係を一言で言える
- なし: 親との意味のつながりが言えない（話の順で続いただけ、別の話題）
番号の順に、ラベルだけの JSON 配列を返してください（例: ["具体化","なし"]）。説明は書かないでください。`;

describe("辺の意味の判定", () => {
  it.effect("補足を40辺のバッチ境界から除き、本文に補足とある通常の辺は判定する", () => Effect.gen(function* () {
    const events = [...edgeEvents(40), {
      type: "diff", input: { recent: [], fresh: [], nodeCount: 41 }, dropped: [],
      ops: [{ op: "update", node: "n2", text: "補足の方法", evidence: ["r1"] }],
    }, {
      type: "supplement", category: "背景", ms: 1, reflectedAt: 1,
      op: { op: "add", parent: "n2", text: "判定対象外の説明", evidence: ["r1"], origin: "会議の外" },
    }];
    const prompts: string[] = [];
    const result = yield* judgeEdges(events, (prompt) => Effect.sync(() => {
      prompts.push(prompt);
      const lines = prompt.split("\n\n")[1]!.split("\n");
      expect(lines).toHaveLength(40);
      expect(lines[0]).toContain("[論点] 補足の方法");
      expect(lines.every((line) => !line.includes("[補足]"))).toBe(true);
      return JSON.stringify(lines.map(() => "答え"));
    }));
    expect(prompts).toHaveLength(1);
    expect(result.total).toBe(40);
    expect(result.edges.map((edge) => edge.id)).toEqual(Array.from({ length: 40 }, (_, i) => `n${i + 2}`));
  }));

  it.effect("C1・C2: ルート直下を除き、引数の判定器へ指定プロンプトを渡し、なしの分母を対象辺にする", () => Effect.gen(function* () {
    const prompts: string[] = [];
    const labels = ["具体化", "答え", "派生", "なし", "なし"];
    const result = yield* judgeEdges(edgeEvents(5), (prompt: string) => Effect.sync(() => {
      prompts.push(prompt);
      return JSON.stringify(labels);
    }));
    expect(prompts).toEqual([`${PROMPT}\n\n${Array.from({ length: 5 }, (_, i) =>
      `${i + 1}. 親 [議題] ${PARENT_TEXT} → 子 [論点] ${childText(i)}`).join("\n")}`]);
    expect(result.edges).toEqual(labels.map((label, i) => ({ id: `n${i + 2}`, parent: "n1", label })));
    expect(result).toMatchObject({ total: 5, counts: { 具体化: 1, 答え: 1, 派生: 1, なし: 2 }, none: 2 });
    expect(result.noneRatio).toBeCloseTo(2 / 5);
  }));

  it.effect("C3: 判定に本文を渡して成功した後、返却値・JSON・表には id・ラベル・数だけを残す", () => Effect.gen(function* () {
    let received = "";
    const result = yield* judgeEdges(edgeEvents(1), (prompt: string) => Effect.sync(() => {
      received = prompt;
      return `${REMARK_TEXT}\n["なし"]`;
    }));
    expect(received).toContain(PARENT_TEXT);
    expect(received).toContain(childText(0));
    expect(result.edges).toEqual([{ id: "n2", parent: "n1", label: "なし" }]);
    expect(result).toEqual({
      edges: [{ id: "n2", parent: "n1", label: "なし" }],
      total: 1, counts: { 具体化: 0, 答え: 0, 派生: 0, なし: 1 }, none: 1, noneRatio: 1,
    });
    const json = JSON.stringify(result);
    const row = formatRow("session", result);
    expect(row).toContain("100.0%");
    expect(row).toContain("| 1 |");
    expect(row).not.toMatch(/synthetic|secret/i);
    for (const secret of [TITLE, PARENT_TEXT, childText(0), REMARK_TEXT]) {
      expect(json).not.toContain(secret);
      expect(row).not.toContain(secret);
    }
  }));

  it.effect("C1: 41辺を40辺と1辺に分け、番号を再開し、最後の辺も対応付ける", () => Effect.gen(function* () {
    const prompts: string[] = [];
    const result = yield* judgeEdges(edgeEvents(41), (prompt: string) => Effect.sync(() => {
      prompts.push(prompt);
      return JSON.stringify(Array.from({ length: prompts.length === 1 ? 40 : 1 }, () => prompts.length === 1 ? "答え" : "なし"));
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.split("\n\n")[1]!.split("\n")).toEqual(Array.from({ length: 40 }, (_, i) =>
      `${i + 1}. 親 [議題] ${PARENT_TEXT} → 子 [論点] ${childText(i)}`));
    expect(prompts[1]).toBe(`${PROMPT}\n\n1. 親 [議題] ${PARENT_TEXT} → 子 [論点] ${childText(40)}`);
    expect(result.edges).toHaveLength(41);
    expect(result.edges.at(-1)).toEqual({ id: "n42", parent: "n1", label: "なし" });
    expect(result.counts).toEqual({ 具体化: 0, 答え: 40, 派生: 0, なし: 1 });
    expect(result.noneRatio).toBeCloseTo(1 / 41);
  }));

  it.effect("C1: 対象が0辺なら判定器を呼ばず、有限な0を返す", () => Effect.gen(function* () {
    const result = yield* judgeEdges(edgeEvents(0), () => Effect.die("0辺で判定器を呼んだ"));
    expect(result).toEqual({ edges: [], total: 0, counts: { 具体化: 0, 答え: 0, 派生: 0, なし: 0 }, none: 0, noneRatio: 0 });
  }));

  it.effect("C1: 更新・移動後の最終マップを判定し、旧本文や旧親を使わない", () => Effect.gen(function* () {
    const events = [...edgeEvents(2), {
      type: "diff", input: { recent: [], fresh: [], nodeCount: 3 }, dropped: [], ops: [
        { op: "update", node: "n2", text: "UPDATED_CHILD", evidence: ["r1"] },
        { op: "move", node: "n3", parent: "n2" },
      ],
    }];
    const prompts: string[] = [];
    const result = yield* judgeEdges(events, (prompt: string) => Effect.sync(() => {
      prompts.push(prompt);
      return '["具体化","派生"]';
    }));
    expect(prompts).toEqual([`${PROMPT}\n\n1. 親 [議題] ${PARENT_TEXT} → 子 [論点] UPDATED_CHILD\n2. 親 [論点] UPDATED_CHILD → 子 [論点] ${childText(1)}`]);
    expect(result.edges).toEqual([{ id: "n2", parent: "n1", label: "具体化" }, { id: "n3", parent: "n2", label: "派生" }]);
  }));

  it.effect("C1: 断り書きに配列が混じっても最後の有効なJSON配列を使う", () => Effect.gen(function* () {
    const result = yield* judgeEdges(edgeEvents(1), () => Effect.succeed('例: ["なし"]\n```json\n["答え"]\n```'));
    expect(result.edges).toEqual([{ id: "n2", parent: "n1", label: "答え" }]);
    expect(result.none).toBe(0);
  }));

  it.effect.each([
    { name: "JSONがない", invalid: "not-json" },
    { name: "壊れたJSON", invalid: '["なし",]' },
    { name: "件数不足", invalid: "[]" },
    { name: "件数超過", invalid: '["なし","答え"]' },
    { name: "未知ラベル", invalid: '["外れ"]' },
    { name: "文字列以外", invalid: "[42]" },
  ])("C1: $name は成功として集計せず、3回目までに正常応答を得たら採用する", ({ invalid }) => Effect.gen(function* () {
    let calls = 0;
    const result = yield* judgeEdges(edgeEvents(1), () => Effect.sync(() => ++calls < 3 ? invalid : '["具体化"]'));
    expect(calls).toBe(3);
    expect(result.edges).toEqual([{ id: "n2", parent: "n1", label: "具体化" }]);
    expect(result.none).toBe(0);
  }));

  it.effect("C1・C3: 不正応答が続くと3回で失敗し、生応答を返さない", () => Effect.gen(function* () {
    let calls = 0;
    const result = yield* Effect.result(judgeEdges(edgeEvents(1), () => Effect.sync(() => {
      calls++;
      return `["${childText(0)}"]`;
    })));
    expect(calls).toBe(3);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).not.toContain(childText(0));
      expect(JSON.stringify(result.failure)).not.toContain(childText(0));
    }
  }));

  it.effect("C3: 注入した判定器の失敗にも本文を残さず、応答形式の再試行と混同しない", () => Effect.gen(function* () {
    let calls = 0;
    const result = yield* Effect.result(judgeEdges(edgeEvents(1), (prompt) => Effect.gen(function* () {
      calls++;
      expect(prompt).toContain(PARENT_TEXT);
      expect(prompt).toContain(childText(0));
      return yield* Effect.fail({ message: prompt });
    })));
    expect(calls).toBe(1);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      for (const secret of [PARENT_TEXT, childText(0)]) {
        expect(String(result.failure)).not.toContain(secret);
        expect(JSON.stringify(result.failure)).not.toContain(secret);
      }
    }
  }));
});
