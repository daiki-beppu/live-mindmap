import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { reviewSnapshot } from "../src/core/index.ts";
import { largestGroup } from "../bench/mapShape.ts";
import { formatRow, judgeSiblings } from "../bench/siblingJudgement.ts";
import { build, bigGroup, childText, kids, parentText, REMARK_TEXT, TITLE, type Built, type Spec } from "./fixtures/siblingJudgement.ts";

// order.md が外部スクリプト siblingJudge.ts と同じプロンプトを指定しているため、転送値を検証する。モデルの判断品質は証明しない。
const PROMPT = `会議のマインドマップで、1 つの親の下に並んだ兄弟（子）を判定してください。最初の行が親、続く各行が「番号. [種別] 本文」の子です。
兄弟は「同じ親について並ぶ、別々の中身（同じ論点への別の案、同じ議題の別の紹介、同じ要点の別の具体例）」であるべきです。
各子が次のどれに当たるかを、1 つだけ選んでください。
- 別: 親について、ほかの兄弟とは別の中身を述べている
- 具体化: ほかの兄弟のどれかを具体化している（例・数字・内訳・経緯）。兄弟ではなく、その兄弟の子に置くべきもの
- 重なり: ほかの兄弟のどれかとほぼ同じ中身の言い換え・繰り返し
- 外れ: 親についての中身ではない（別の話題、親との関係が言えない）
番号の順に、ラベルだけの JSON 配列を返してください（例: ["別","具体化"]）。説明は書かないでください。`;

const SECRETS = (refs: readonly string[]) => [TITLE, REMARK_TEXT, ...refs.map(parentText), ...refs.map(childText)];

// 親の本文ごとに「その親への n 回目の呼び出し」へ返す応答を決める偽の判定器。未登録の親（ルートなど）が渡されたら失敗させる。
type Handler = (call: number, children: number) => string;
function fakeJudge(handlers: Record<string, Handler>) {
  const calls = new Map<string, number>();
  const prompts: string[] = [];
  const judge = (prompt: string) => Effect.sync(() => {
    prompts.push(prompt);
    const [head, ...lines] = prompt.slice(PROMPT.length + 2).split("\n");
    const key = /^親 \[[^\]]*\] (.*)$/.exec(head!)![1]!;
    const handler = handlers[key];
    if (handler === undefined) throw new Error("判定対象でない親が渡された");
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    return handler(n, lines.length);
  });
  return { judge, prompts, calls: (ref: string) => calls.get(parentText(ref)) ?? 0, total: () => prompts.length };
}
const labels = (...values: string[]) => JSON.stringify(values);
// 先頭から notSeparate 個を「具体化」、残りを「別」にした n 件の応答
const withNotSeparate = (notSeparate: number, n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => (i < notSeparate ? "具体化" : "別")));

// ルートに議題 5 個。T1 の下に論点 A（案 4 + 済みの論点 1）と論点 B（案 4）。
function baseMap(): Built {
  const specs: Spec[] = [
    ...["T1", "T2", "T3", "T4", "T5"].map((ref): Spec => ({ ref, parent: "root", kind: "議題" })),
    { ref: "A", parent: "T1", kind: "論点" },
    { ref: "B", parent: "T1", kind: "論点" },
    ...kids("A", "案", 4),
    { ref: "A_done", parent: "A", kind: "論点" },
    ...kids("B", "案", 4),
  ];
  return build(specs, ["A_done"]);
}
const A_LABELS = ["別", "別", "具体化", "重なり", "外れ"];

describe("兄弟の意味の判定: 全体とラベル件数", () => {
  it.effect("C1: 子が 5 以上の非ルート親だけを判定し、指定プロンプトで渡し、件数と割合を出す", () => Effect.gen(function* () {
    const map = baseMap();
    const fake = fakeJudge({ [parentText("A")]: () => JSON.stringify(A_LABELS) });
    const result = yield* judgeSiblings(map.events, fake.judge);
    // ルート（子 5）、子 4 の論点 B、子 2 の T1 は判定器に渡らない。子の数に済みの論点を含む 5 件の A だけ。
    expect(fake.prompts).toEqual([[
      PROMPT, "",
      `親 [論点] ${parentText("A")}`,
      ...[0, 1, 2, 3].map((i) => `${i + 1}. [案] ${childText(`A_${i}`)}`),
      `5. [論点] ${parentText("A_done")}`,
    ].join("\n")]);
    expect(result.parents).toEqual([{
      parent: map.id("A"),
      children: A_LABELS.map((label, i) => ({ id: i < 4 ? map.id(`A_${i}`) : map.id("A_done"), label })),
    }]);
    expect(result).toMatchObject({
      total: 5, counts: { 別: 2, 具体化: 1, 重なり: 1, 外れ: 1 }, notSeparate: 3,
    });
    expect(result.notSeparateRatio).toBeCloseTo(3 / 5);
    expect(result.target).toBeNull();
  }));

  it.effect("C1: 判定対象が 0 件なら判定器を呼ばず、割合は有限な 0 になる", () => Effect.gen(function* () {
    const map = build(kids("root", "議題", 6, "T"));
    const fake = fakeJudge({});
    const result = yield* judgeSiblings(map.events, fake.judge);
    expect(fake.total()).toBe(0);
    expect(result.parents).toEqual([]);
    expect(result).toMatchObject({ total: 0, counts: { 別: 0, 具体化: 0, 重なり: 0, 外れ: 0 }, notSeparate: 0, notSeparateRatio: 0 });
  }));
});

describe("兄弟の意味の判定: 指定した親の直下", () => {
  it.effect("C2: 子が 5 未満の親も判定し、全体の件数・割合へは加えない", () => Effect.gen(function* () {
    const map = baseMap();
    const fake = fakeJudge({
      [parentText("A")]: () => JSON.stringify(A_LABELS),
      [parentText("B")]: () => labels("別", "重なり", "外れ", "別"),
    });
    const result = yield* judgeSiblings(map.events, fake.judge, { parent: map.id("B") });
    expect(fake.calls("B")).toBe(1);
    expect(result.target).toMatchObject({
      parent: map.id("B"), total: 4, counts: { 別: 2, 具体化: 0, 重なり: 1, 外れ: 1 }, notSeparate: 2,
    });
    expect(result.target!.notSeparateRatio).toBeCloseTo(2 / 4);
    expect(result).toMatchObject({ total: 5, notSeparate: 3 });
    expect(result.parents.map((p) => p.parent)).toEqual([map.id("A")]);
  }));

  it.effect("C2: 全体の対象にも入る親は、同じラベルを使い判定器を余分に呼ばない", () => Effect.gen(function* () {
    const map = baseMap();
    const fake = fakeJudge({ [parentText("A")]: () => JSON.stringify(A_LABELS) });
    const result = yield* judgeSiblings(map.events, fake.judge, { parent: map.id("A") });
    expect(fake.calls("A")).toBe(1);
    expect(result.target).toMatchObject({ parent: map.id("A"), total: 5, counts: { 別: 2, 具体化: 1, 重なり: 1, 外れ: 1 }, notSeparate: 3 });
  }));

  it.effect("C2: 子のない親は判定器を呼ばず、件数 0・割合 0 にする", () => Effect.gen(function* () {
    const map = baseMap();
    const fake = fakeJudge({ [parentText("A")]: () => JSON.stringify(A_LABELS) });
    const result = yield* judgeSiblings(map.events, fake.judge, { parent: map.id("B_0") });
    expect(fake.total()).toBe(1);
    expect(result.target).toMatchObject({ total: 0, counts: { 別: 0, 具体化: 0, 重なり: 0, 外れ: 0 }, notSeparate: 0, notSeparateRatio: 0 });
  }));

  it.effect.each([
    { name: "ルート", parent: () => "root" },
    { name: "存在しない id", parent: () => "n9999" },
  ])("C2: 指定した親が $name なら判定器を呼ばず失敗し、本文を出さない", ({ parent }) => Effect.gen(function* () {
    const fake = fakeJudge({});
    const result = yield* Effect.result(judgeSiblings(baseMap().events, fake.judge, { parent: parent() }));
    expect(Result.isFailure(result)).toBe(true);
    expect(fake.total()).toBe(0);
    if (Result.isFailure(result)) {
      for (const secret of SECRETS(["A", "A_0", "T1"])) expect(JSON.stringify(result.failure) + String(result.failure)).not.toContain(secret);
    }
  }));
});

// ルートに議題 T の下へ論点 P（案 cases 個。うち withPoints 個に要点 4 個ずつ）と、判定対象の論点 Q（案 5 個）。
function groupMap(cases: number, withPoints: number): Built {
  return build([...bigGroup({ cases, withPoints }), { ref: "Q", parent: "T", kind: "論点" }, ...kids("Q", "案", 5)]);
}
// P への 1 回目は全体用（別でない 2 件）、2 回目以降が合否用の 5 回。Q の別でないは 1 件（全体 15 件中 3 件 = 1/5）。
function passFake(runs: readonly number[]) {
  return fakeJudge({
    [parentText("P")]: (call, n) => withNotSeparate(call === 0 ? 2 : runs[call - 1] ?? 0, n),
    [parentText("Q")]: (_, n) => withNotSeparate(1, n),
  });
}

describe("最大のまとまりの合否の補助", () => {
  it.effect("C3: 40 を超えたら直下の子を 5 回判定し、中央値が閾値（全体の割合 × 子の数 + 1）ちょうどなら通す", () => Effect.gen(function* () {
    const map = groupMap(10, 10); // P は 案 10 + 要点 40 = 50
    const fake = passFake([1, 4, 2, 5, 3]);
    const result = yield* judgeSiblings(map.events, fake.judge);
    expect(result).toMatchObject({ total: 15, notSeparate: 3 });
    expect(fake.calls("P")).toBe(6);
    expect(fake.calls("Q")).toBe(1);
    expect(result.maxGroup).toMatchObject({ parent: map.id("P"), size: 50 });
    const check = result.maxGroup!.check!;
    expect(check.childCount).toBe(10);
    expect(check.runs.map((run) => run.notSeparate)).toEqual([1, 4, 2, 5, 3]);
    expect(check.runs.every((run) => run.children.length === 10 && run.children.every((c) => c.id.startsWith("n")))).toBe(true);
    expect(check.median).toBe(3);
    expect(check.threshold).toBeCloseTo(3);
    expect(check.pass).toBe(true);
  }));

  it.effect.each([
    { name: "閾値を 1 件超える（中央値 4）", runs: [4, 4, 4, 0, 0], pass: false },
    { name: "平均では通るが中央値は 1 件超え", runs: [1, 1, 4, 4, 4], pass: false },
    { name: "平均では落ちるが中央値は境目ちょうど", runs: [0, 0, 3, 9, 10], pass: true },
    { name: "すべて閾値より下", runs: [0, 1, 0, 1, 2], pass: true },
  ])("C3: $name", ({ runs, pass }) => Effect.gen(function* () {
    const result = yield* judgeSiblings(groupMap(10, 10).events, passFake(runs).judge);
    expect(result.maxGroup!.check!.pass).toBe(pass);
  }));

  it.effect("C3: 最大のまとまりがちょうど 40 なら 5 回の判定をせず、合否は不要", () => Effect.gen(function* () {
    const map = groupMap(8, 8); // P は 案 8 + 要点 32 = 40
    const fake = passFake([]);
    const result = yield* judgeSiblings(map.events, fake.judge);
    expect(fake.calls("P")).toBe(1);
    expect(result.maxGroup).toMatchObject({ parent: map.id("P"), size: 40, check: null });
  }));

  it.effect("C3: 41 なら 5 回の判定をする", () => Effect.gen(function* () {
    const fake = passFake([0, 0, 0, 0, 0]);
    const result = yield* judgeSiblings(groupMap(9, 8).events, fake.judge); // 案 9 + 要点 32 = 41
    expect(fake.calls("P")).toBe(6);
    expect(result.maxGroup).toMatchObject({ size: 41 });
    expect(result.maxGroup!.check!.runs).toHaveLength(5);
  }));

  it.effect.each([
    { name: "別でない 1 件（境目ちょうど）", perRun: 1, pass: true },
    { name: "別でない 2 件（1 件超え）", perRun: 2, pass: false },
  ])("C3: 全体の判定対象が 0 件なら閾値は 1 件。$name", ({ perRun, pass }) => Effect.gen(function* () {
    // 議題 T の下に案 X（要点 4 個 × 4 個 × 4 個）と案 Y。子が 5 以上の親は無く、T が最大（2 + 4 + 16 + 64 = 86）。
    const specs: Spec[] = [{ ref: "T", parent: "root", kind: "議題" }, { ref: "X", parent: "T", kind: "案" }, { ref: "Y", parent: "T", kind: "案" }];
    const level1 = kids("X", "要点", 4);
    const level2 = level1.flatMap((s) => kids(s.ref, "要点", 4));
    const level3 = level2.flatMap((s) => kids(s.ref, "要点", 4));
    const map = build([...specs, ...level1, ...level2, ...level3]);
    const fake = fakeJudge({ [parentText("T")]: (_, n) => withNotSeparate(perRun, n) });
    const result = yield* judgeSiblings(map.events, fake.judge);
    expect(result).toMatchObject({ total: 0, notSeparate: 0, notSeparateRatio: 0 });
    expect(fake.calls("T")).toBe(5);
    expect(fake.total()).toBe(5);
    expect(result.maxGroup).toMatchObject({ parent: map.id("T"), size: 86 });
    expect(result.maxGroup!.check).toMatchObject({ childCount: 2, median: perRun, pass });
    expect(result.maxGroup!.check!.threshold).toBeCloseTo(1);
  }));
});

describe("応答の読み取りと失敗", () => {
  const single = (respond: Handler) => ({ map: baseMap(), fake: fakeJudge({ [parentText("A")]: respond }) });

  it.effect("C4: 「外」は「外れ」として扱い、断り書きに配列が混じっても最後の配列を使う", () => Effect.gen(function* () {
    const { map, fake } = single(() => `例: ["別"]\n${labels("別", "別", "具体化", "重なり", "外")}`);
    const result = yield* judgeSiblings(map.events, fake.judge);
    expect(result.counts).toEqual({ 別: 2, 具体化: 1, 重なり: 1, 外れ: 1 });
  }));

  it.effect.each([
    { name: "JSON がない", invalid: "not-json" },
    { name: "壊れた JSON", invalid: '["別",]' },
    { name: "件数不足", invalid: labels("別") },
    { name: "件数超過", invalid: labels("別", "別", "別", "別", "別", "別") },
    { name: "未知ラベル", invalid: labels("別", "別", "別", "別", "答え") },
  ])("C4: $name は成功として集計せず、同じ親で 5 回目までに正常応答を得たら採用する", ({ invalid }) => Effect.gen(function* () {
    const { map, fake } = single((call) => (call < 4 ? invalid : JSON.stringify(A_LABELS)));
    const result = yield* judgeSiblings(map.events, fake.judge);
    expect(fake.calls("A")).toBe(5);
    expect(result.counts).toEqual({ 別: 2, 具体化: 1, 重なり: 1, 外れ: 1 });
  }));

  it.effect("C4・C5: 不正な応答が 5 回続くと失敗し、生の応答・本文を失敗に含めない", () => Effect.gen(function* () {
    const { map, fake } = single(() => `${REMARK_TEXT} ["${childText("A_0")}"]`);
    const result = yield* Effect.result(judgeSiblings(map.events, fake.judge));
    expect(fake.calls("A")).toBe(5);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const text = JSON.stringify(result.failure) + String(result.failure);
      for (const secret of SECRETS(["A", "A_0", "A_1", "A_done"])) expect(text).not.toContain(secret);
    }
  }));

  it.effect("C5: 判定器そのものの失敗は判定し直さず、判定器のエラーの中身を失敗に含めない", () => Effect.gen(function* () {
    let calls = 0;
    const result = yield* Effect.result(judgeSiblings(baseMap().events, (prompt: string) => {
      calls++;
      return Effect.fail({ message: prompt, stderr: childText("A_0") });
    }));
    expect(calls).toBe(1);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const text = JSON.stringify(result.failure) + String(result.failure);
      for (const secret of SECRETS(["A", "A_0", "A_done"])) expect(text).not.toContain(secret);
    }
  }));

  it.effect("C5: 復元できないイベント列は本文を含めず失敗する", () => Effect.gen(function* () {
    const result = yield* Effect.result(judgeSiblings([{ type: "start", title: { text: "SYNTHETIC_INVALID_BODY" } }], () => Effect.die("呼ばない")));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(JSON.stringify(result.failure) + String(result.failure)).not.toContain("SYNTHETIC_INVALID_BODY");
  }));
});

describe("出力に本文を含めない", () => {
  it.effect("C5: 判定に本文を渡しても、返り値の JSON と表の行には id・ラベル・数だけが残る", () => Effect.gen(function* () {
    const map = groupMap(10, 10);
    const fake = fakeJudge({
      [parentText("P")]: (call, n) => `${REMARK_TEXT}\n${withNotSeparate(call === 0 ? 2 : 3, n)}`,
      [parentText("Q")]: (_, n) => withNotSeparate(1, n),
    });
    const result = yield* judgeSiblings(map.events, fake.judge, { parent: map.id("P") });
    expect(fake.prompts.some((p) => p.includes(parentText("P")) && p.includes(childText("P_0")))).toBe(true);
    const json = JSON.stringify(result);
    const row = formatRow("session", result);
    expect(row).toContain("session");
    for (const secret of SECRETS(["T", "P", "Q", "P_0", "P_0_0", "Q_0"])) {
      expect(json).not.toContain(secret);
      expect(row).not.toContain(secret);
    }
    expect(json).not.toMatch(/SYNTHETIC/);
    expect(row).not.toMatch(/SYNTHETIC/);
    expect(row.split("\n")).toHaveLength(1);
  }));

  it.effect("C1・C3: 表の行に別でないの件数と割合、合否（通す・通さない・不要）が出る", () => Effect.gen(function* () {
    const pass = formatRow("s", yield* judgeSiblings(groupMap(10, 10).events, passFake([3, 3, 3, 3, 3]).judge));
    const fail = formatRow("s", yield* judgeSiblings(groupMap(10, 10).events, passFake([4, 4, 4, 4, 4]).judge));
    const none = formatRow("s", yield* judgeSiblings(groupMap(8, 8).events, passFake([]).judge));
    expect(pass).toContain("20.0%");
    expect(pass).toContain("通す");
    expect(fail).toContain("通さない");
    expect(fail).not.toContain("通す");
    expect(none).toContain("不要");
  }));
});

describe("最大のまとまりの求め方（mapShape と共有）", () => {
  const nodesOf = (built: Built) => reviewSnapshot(built.events).nodes;

  it("議題・論点・案・課題・要点の中で最大のものの id と大きさを返す", () => {
    const map = build(bigGroup({ cases: 10, withPoints: 10 }));
    expect(largestGroup(nodesOf(map))).toEqual({ id: map.id("P"), size: 50 });
  });

  it("同じ大きさなら snapshot で先に作られたノードを返す", () => {
    const map = build([
      { ref: "T", parent: "root", kind: "議題" },
      { ref: "P1", parent: "T", kind: "論点" }, ...kids("P1", "案", 3),
      { ref: "P2", parent: "T", kind: "論点" }, ...kids("P2", "案", 3),
    ]);
    // 議題 T は論点を 1 と数え、論点の配下は数えないので 2。P1・P2 は 3 で同点。
    expect(largestGroup(nodesOf(map))).toEqual({ id: map.id("P1"), size: 3 });
  });

  it("議題以外の案・課題・要点も対象にする", () => {
    const map = build([
      { ref: "X", parent: "root", kind: "案" }, ...kids("X", "課題", 3),
      { ref: "Y", parent: "root", kind: "要点" }, ...kids("Y", "要点", 2),
    ]);
    expect(largestGroup(nodesOf(map))).toEqual({ id: map.id("X"), size: 3 });
  });

  it("対象の種別のノードが無ければ undefined", () => {
    expect(largestGroup(nodesOf(build([])))).toBeUndefined();
  });
});
