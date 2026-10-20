import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { DiffUpdater, emptyMap, type DiffInput, type DiffResult, type DiffUpdateError, type KatakanaAnswer, type PreviousResponse, type Remark } from "../src/core/index.ts";
import { HAIKU, routedUpdater, SONNET } from "../src/routedDiffUpdater.ts";
import type { JudgeAsk, JudgeOutcome } from "../src/systemOne.ts";

// 振り分け（DiffUpdater の口の 1 段）。偽の判定と偽の Sonnet / Haiku の差分更新で、行き先・質問・state・
// query ごとの前回の応答の持ち主・判定の記録を固定する。


const remark = (n: number, text = `発言${n}`): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text });
const response = (label: string): PreviousResponse => ({ refs: { [label]: `n-${label}` }, dropped: [{ op: { op: "noop", reason: label }, reason: label }] });

// p は「含む」の確からしさ（distribution.yes）。confidence は選んだ側の確からしさ（p<0.5 では 1-p）
const answered = (p: number): JudgeOutcome => ({
  ok: true, usage: { input_tokens: 1 },
  answers: { route: { distribution: { yes: p, no: 1 - p }, chosen: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p) } },
});
type Scripted = number | "fail";
// ask は呼ばれるたびに script の次の値を返す。質問名は送られた質問の名前をそのまま使う
const fakeAsk = (script: readonly Scripted[], delay = 0) => {
  const calls: { state: string; questions: Record<string, { type: string; instructions: string }> }[] = [];
  const ask: JudgeAsk = (state, questions) => Effect.gen(function* () {
    calls.push({ state, questions: { ...questions } });
    if (delay > 0) yield* Effect.sleep(delay);
    const next = script[calls.length - 1] ?? "fail";
    const name = Object.keys(questions)[0]!;
    if (next === "fail") return { ok: false as const, reason: "時間切れ" };
    const base = answered(next);
    return base.ok ? { ...base, answers: { [name]: base.answers.route! } } : base;
  });
  return { ask, calls };
};

// 偽の差分更新。渡された入力を記録し、台本どおり成功（応答 label）か失敗を返す
const fakeUpdater = (label: string, failures: ReadonlySet<number> = new Set()) => {
  const inputs: DiffInput[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffResult, DiffUpdateError> => Effect.suspend(() => {
    inputs.push(input);
    return failures.has(inputs.length) ? Effect.fail({ _tag: "Fake", message: `${label}の失敗` }) : Effect.succeed({
      ops: [{ op: "noop" as const, reason: `${label}${inputs.length}` }],
      usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, model: label },
    });
  });
  return { inputs, service: DiffUpdater.of({ update }) };
};

const setup = (script: readonly Scripted[], options: { sonnetFails?: Set<number>; haikuFails?: Set<number>; delay?: number } = {}) =>
  Effect.gen(function* () {
    const judge = fakeAsk(script, options.delay);
    const sonnet = fakeUpdater("sonnet", options.sonnetFails);
    const haiku = fakeUpdater("haiku", options.haikuFails);
    const router = yield* routedUpdater({ ask: judge.ask, sonnet: sonnet.service, haiku: haiku.service });
    return { router, judge, sonnet, haiku };
  });

const input = (fresh: readonly Remark[], extra: Partial<DiffInput> = {}): DiffInput => ({ map: emptyMap("定例"), recent: [], fresh: [...fresh], ...extra });

describe("振り分け: 行き先（しきい値 0.3）", () => {
  it.effect("確からしさが 0.3 ちょうど・0.9 なら Sonnet だけを呼ぶ", () => Effect.gen(function* () {
    const { router, sonnet, haiku, judge } = yield* setup([0.3, 0.9]);
    yield* router.update(input([remark(1)]));
    yield* router.update(input([remark(2)]));
    expect(sonnet.inputs).toHaveLength(2);
    expect(haiku.inputs).toHaveLength(0);
    expect(judge.calls).toHaveLength(2);
  }));

  it.effect("確からしさが 0.3 未満なら Haiku だけを呼ぶ", () => Effect.gen(function* () {
    const { router, sonnet, haiku } = yield* setup([0.299, 0]);
    yield* router.update(input([remark(1)]));
    yield* router.update(input([remark(2)]));
    expect(haiku.inputs).toHaveLength(2);
    expect(sonnet.inputs).toHaveLength(0);
  }));

  it.effect("0.1 は「含まない」を 0.9 の確からしさで選んだ答え。しきい値は yes の確率と比べるので Haiku に回る", () => Effect.gen(function* () {
    const { router, sonnet, haiku } = yield* setup([0.1]);
    yield* router.update(input([remark(1)]));
    expect(haiku.inputs).toHaveLength(1);
    expect(sonnet.inputs).toHaveLength(0);
  }));

  it.effect("判定できなかった回は Sonnet で差分更新し、Haiku は呼ばない", () => Effect.gen(function* () {
    const { router, sonnet, haiku } = yield* setup(["fail"]);
    const result = yield* router.update(input([remark(1)]));
    expect(sonnet.inputs).toHaveLength(1);
    expect(haiku.inputs).toHaveLength(0);
    expect(result.ops).toEqual([{ op: "noop", reason: "sonnet1" }]);
  }));

  it.effect("判定は 1 回の update につき 1 回、毎回呼ぶ（前回の行き先を使い回さない）", () => Effect.gen(function* () {
    const { router, haiku, sonnet, judge } = yield* setup([0.9, 0.1, 0.9, 0.1]);
    for (const n of [1, 2, 3, 4]) yield* router.update(input([remark(n)]));
    expect(judge.calls).toHaveLength(4);
    expect([sonnet.inputs.length, haiku.inputs.length]).toEqual([2, 2]);
  }));

  it.effect("選んだ側の差分更新の失敗はそのまま伝わり、もう一方では再試行しない", () => Effect.gen(function* () {
    const { router, sonnet, haiku } = yield* setup([0.1], { haikuFails: new Set([1]) });
    const error = yield* Effect.flip(router.update(input([remark(1)])));
    expect(error).toEqual({ _tag: "Fake", message: "haikuの失敗", judge: { model: HAIKU, ms: 0, confidence: 0.1 } });
    expect(sonnet.inputs).toHaveLength(0);
    expect(haiku.inputs).toHaveLength(1);
  }));

  it.effect("Sonnet の失敗にも判定の記録（行き先と確からしさ）が付く", () => Effect.gen(function* () {
    const { router, haiku } = yield* setup([0.9], { sonnetFails: new Set([1]) });
    const error = yield* Effect.flip(router.update(input([remark(1)])));
    expect(error).toEqual({ _tag: "Fake", message: "sonnetの失敗", judge: { model: SONNET, ms: 0, confidence: 0.9 } });
    expect(haiku.inputs).toHaveLength(0);
  }));

  it.effect("判定できず Sonnet が失敗した回の失敗には、failure が付き confidence は付かない", () => Effect.gen(function* () {
    const { router } = yield* setup(["fail"], { sonnetFails: new Set([1]) });
    const error = yield* Effect.flip(router.update(input([remark(1)])));
    expect(error).toEqual({ _tag: "Fake", message: "sonnetの失敗", judge: { model: SONNET, ms: 0, failure: "時間切れ" } });
    expect(error.judge).not.toHaveProperty("confidence");
  }));

  it.effect("katakana は Sonnet 側の口へ入力を渡し、その結果を返す", () => Effect.gen(function* () {
    const judge = fakeAsk([]);
    const asked: ReadonlyArray<string>[] = [];
    const answer: ReadonlyArray<KatakanaAnswer> = [{ surface: "API", katakana: "エーピーアイ" }];
    const katakana: NonNullable<DiffUpdater["Service"]["katakana"]> = (words) => Effect.suspend(() => {
      asked.push(words);
      return Effect.succeed(answer);
    });
    const sonnet = DiffUpdater.of({ update: fakeUpdater("sonnet").service.update, katakana });
    const router = yield* routedUpdater({ ask: judge.ask, sonnet, haiku: fakeUpdater("haiku").service });
    const answers = yield* router.katakana!(["API"]);
    expect(asked).toEqual([["API"]]);
    expect(answers).toEqual(answer);
    expect(judge.calls).toHaveLength(0);
  }));
});

describe("振り分け: 質問と state", () => {
  it.effect("質問は noul の 1 問", () => Effect.gen(function* () {
    const { router, judge } = yield* setup([0.5]);
    yield* router.update(input([remark(1)]));
    const questions = Object.values(judge.calls[0]!.questions);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: "noul" });
  }));

  it.effect("直前の発言が無いと「（なし）」、新しい発言は複数なら改行でつなぐ", () => Effect.gen(function* () {
    const { router, judge } = yield* setup([0.5]);
    yield* router.update(input([remark(1, "来週までにやります"), remark(2, "お願いします")]));
    expect(judge.calls[0]!.state).toBe(["# 直前の発言（文脈）", "（なし）", "# 新しい発言", "来週までにやります\nお願いします"].join("\n"));
  }));

  it.effect("直前の発言は末尾 6 件だけで、7 件以上あっても古い分は入れない", () => Effect.gen(function* () {
    const { router, judge } = yield* setup([0.5]);
    const recent = [1, 2, 3, 4, 5, 6, 7].map((n) => remark(n));
    yield* router.update(input([remark(8)], { recent }));
    expect(judge.calls[0]!.state).toBe(["# 直前の発言（文脈）", "発言2\n発言3\n発言4\n発言5\n発言6\n発言7", "# 新しい発言", "発言8"].join("\n"));
  }));

  it.effect("新しい発言は文脈に入れない（recent に同じ id が重なっていても）", () => Effect.gen(function* () {
    const { router, judge } = yield* setup([0.5]);
    yield* router.update(input([remark(2)], { recent: [remark(1), remark(2)] }));
    expect(judge.calls[0]!.state).toBe(["# 直前の発言（文脈）", "発言1", "# 新しい発言", "発言2"].join("\n"));
  }));

  it.effect("前の呼び出しの新しい発言は、次の呼び出しの文脈に入る（recent が 3 件までしか渡らなくても 6 件まで保つ）", () => Effect.gen(function* () {
    const { router, judge } = yield* setup([0.5, 0.5, 0.5]);
    yield* router.update(input([remark(1), remark(2), remark(3), remark(4)]));
    yield* router.update(input([remark(5)], { recent: [remark(2), remark(3), remark(4)] }));
    yield* router.update(input([remark(6)], { recent: [remark(3), remark(4), remark(5)] }));
    expect(judge.calls[1]!.state).toBe(["# 直前の発言（文脈）", "発言1\n発言2\n発言3\n発言4", "# 新しい発言", "発言5"].join("\n"));
    expect(judge.calls[2]!.state).toBe(["# 直前の発言（文脈）", "発言1\n発言2\n発言3\n発言4\n発言5", "# 新しい発言", "発言6"].join("\n"));
  }));
});

describe("振り分け: 各 query には自分の前回の応答だけを渡す", () => {
  const handed = (inputs: readonly DiffInput[]) => inputs.map((i) => i.previousResponse);

  it.effect("Sonnet → Haiku → Sonnet → Haiku: 各 query は自分の前回の応答だけを受け取り、相手の分は混ざらない", () => Effect.gen(function* () {
    const { router, sonnet, haiku } = yield* setup([0.9, 0.1, 0.9, 0.1]);
    const r1 = response("s1"), r2 = response("h1"), r3 = response("s2");
    yield* router.update(input([remark(1)]));
    yield* router.update(input([remark(2)], { previousResponse: r1 }));
    yield* router.update(input([remark(3)], { previousResponse: r2 }));
    yield* router.update(input([remark(4)], { previousResponse: r3 }));
    // Sonnet: 1 回目は何も無し、2 回目（全体の 3 回目）は自分の r1。Haiku の r2 は来ない
    expect(handed(sonnet.inputs)).toEqual([undefined, r1]);
    // Haiku: 1 回目（全体の 2 回目）は自分の前回が無いので何も無し（Sonnet の r1 は来ない）、2 回目は自分の r2
    expect(handed(haiku.inputs)).toEqual([undefined, r2]);
    // 受け取らない回はキーごと付けない
    expect(sonnet.inputs[0]).not.toHaveProperty("previousResponse");
    expect(haiku.inputs[0]).not.toHaveProperty("previousResponse");
  }));

  it.effect("同じ query が続く回は、直前の応答（自分の分）をそのまま渡す", () => Effect.gen(function* () {
    const { router, sonnet } = yield* setup([0.9, 0.9, 0.9]);
    const r1 = response("s1"), r2 = response("s2");
    yield* router.update(input([remark(1)]));
    yield* router.update(input([remark(2)], { previousResponse: r1 }));
    yield* router.update(input([remark(3)], { previousResponse: r2 }));
    expect(handed(sonnet.inputs)).toEqual([undefined, r1, r2]);
  }));

  it.effect("query の回が失敗した後は、その query に前回の応答を渡さない", () => Effect.gen(function* () {
    // Haiku が 1 回目は成功（r1）、2 回目に失敗。3 回目はセッションがキーを外した入力で、Haiku に渡さない
    const { router, haiku } = yield* setup([0.1, 0.1, 0.1], { haikuFails: new Set([2]) });
    const r1 = response("h1");
    yield* router.update(input([remark(1)]));
    yield* Effect.flip(router.update(input([remark(2)], { previousResponse: r1 })));
    yield* router.update(input([remark(3)]));
    expect(handed(haiku.inputs)).toEqual([undefined, r1, undefined]);
    expect(haiku.inputs[2]).not.toHaveProperty("previousResponse");
  }));

  it.effect("どの query を回したか分からない最初の呼び出しの previousResponse は、誰の分でもないので渡さない", () => Effect.gen(function* () {
    for (const [p, which] of [[0.9, "sonnet"], [0.1, "haiku"]] as const) {
      const ctx = yield* setup([p]);
      yield* ctx.router.update(input([remark(1)], { previousResponse: response("resume") }));
      expect(ctx[which].inputs[0]).not.toHaveProperty("previousResponse");
    }
  }));

  it.effect("入力の他の項目（マップ・発言・画面）は変えずに渡す", () => Effect.gen(function* () {
    const { router, sonnet } = yield* setup([0.9]);
    const original = input([remark(1)], { recent: [remark(0)] });
    yield* router.update(original);
    expect(sonnet.inputs[0]).toEqual(original);
  }));
});

describe("振り分け: 判定の記録", () => {
  it.effect("成功時は差分更新の結果に judge（回した先・確からしさ・ms）を足し、usage はそのまま残す", () => Effect.gen(function* () {
    const { router } = yield* setup([0.9, 0.1], { delay: 25 });
    const fiber = yield* Effect.forkChild(router.update(input([remark(1)])));
    yield* TestClock.adjust(25);
    const high = yield* Fiber.join(fiber);
    expect(high.judge).toEqual({ model: SONNET, ms: 25, confidence: 0.9 });
    expect(high.usage).toEqual({ input: 1, cacheWrite: 0, cacheRead: 0, output: 1, model: "sonnet" });

    const second = yield* Effect.forkChild(router.update(input([remark(2)])));
    yield* TestClock.adjust(25);
    const low = yield* Fiber.join(second);
    // confidence は「含む」の確からしさ（p）。選んだ側（0.9）ではない
    expect(low.judge).toEqual({ model: HAIKU, ms: 25, confidence: 0.1 });
  }));

  it.effect("判定できなかった回は、回した先（Sonnet）と理由を残し、確からしさのキーは付けない", () => Effect.gen(function* () {
    const { router } = yield* setup(["fail"]);
    const result = yield* router.update(input([remark(1)]));
    expect(result.judge).toMatchObject({ model: SONNET, ms: expect.any(Number), failure: "時間切れ" });
    expect(result.judge).not.toHaveProperty("confidence");
  }));
});

describe("振り分け: 共有画面", () => {
  const shot = (start: number, id = `img${start}`) => ({ start, image: { id, bytes: new Uint8Array([start]) } });
  const starts = (screens: DiffInput["screens"]) => screens?.map((c) => c.start);

  for (const destination of ["sonnet", "haiku"] satisfies ReadonlyArray<"sonnet" | "haiku">) {
    const likelihood = destination === "sonnet" ? 0.9 : 0.1;
    const otherLikelihood = destination === "sonnet" ? 0.1 : 0.9;

    it.effect(`今回の共有画面が4件あっても、${destination} に全件を順序どおり渡す`, () => Effect.gen(function* () {
      const ctx = yield* setup([likelihood]);
      const screens = [shot(10), shot(20), shot(30), shot(40)];

      yield* ctx.router.update(input([remark(1)], { screens }));

      expect(ctx[destination].inputs[0]?.screens).toEqual(screens);
    }));

    it.effect(`${destination} に戻ると、未送の最新3件の後に今回の4件を全件渡す`, () => Effect.gen(function* () {
      const ctx = yield* setup([likelihood, otherLikelihood, otherLikelihood, likelihood]);
      yield* ctx.router.update(input([remark(1)], { screens: [shot(0)] }));
      expect(ctx[destination].inputs[0]?.screens).toEqual([shot(0)]);
      yield* ctx.router.update(input([remark(2)], { screens: [shot(10), shot(20)] }));
      yield* ctx.router.update(input([remark(3)], { screens: [shot(30), shot(40)] }));
      const screens = [shot(50), shot(60), shot(70), shot(80)];

      yield* ctx.router.update(input([remark(4)], { screens }));

      expect(ctx[destination].inputs[1]?.screens).toEqual([shot(20), shot(30), shot(40), ...screens]);
    }));
  }

  it.effect("core が 1 度しか添えない画面の変化も、各 query が自分の未受信分を受け取る（Sonnet に A → Haiku に B → 画面なしで Sonnet）", () => Effect.gen(function* () {
    const { router, sonnet, haiku } = yield* setup([0.9, 0.1, 0.9]);
    yield* router.update(input([remark(1)], { screens: [shot(10)] }));
    yield* router.update(input([remark(2)], { screens: [shot(20)], previousScreens: [shot(10)] }));
    yield* router.update(input([remark(3)], { previousScreens: [shot(10), shot(20)] }));
    // Haiku の最初の回: A と B の両方（A は previousScreens と重ならない）
    expect(starts(haiku.inputs[0]!.screens)).toEqual([10, 20]);
    expect(haiku.inputs[0]!.previousScreens).toBeUndefined();
    // Sonnet の 2 回目: 自分がまだ受け取っていない B。送り直しの A・B のうち、B は重ねない
    expect(starts(sonnet.inputs[1]!.screens)).toEqual([20]);
    expect(starts(sonnet.inputs[1]!.previousScreens)).toEqual([10]);
  }));

  it.effect("画面が変わらない同じ query の続きには、画面を渡さない", () => Effect.gen(function* () {
    const { router, sonnet } = yield* setup([0.9, 0.9]);
    yield* router.update(input([remark(1)], { screens: [shot(10)] }));
    yield* router.update(input([remark(2)]));
    expect(starts(sonnet.inputs[0]!.screens)).toEqual([10]);
    expect(sonnet.inputs[1]).not.toHaveProperty("screens");
    expect(sonnet.inputs[1]).not.toHaveProperty("previousScreens");
  }));

  it.effect("共有終了（image が null）の変化も、もう一方の query へ届く", () => Effect.gen(function* () {
    const { router, haiku } = yield* setup([0.9, 0.1]);
    yield* router.update(input([remark(1)], { screens: [shot(10)] }));
    yield* router.update(input([remark(2)], { screens: [{ start: 30, image: null }] }));
    expect(haiku.inputs[0]!.screens?.map((c) => c.image === null)).toEqual([false, true]);
  }));
});
