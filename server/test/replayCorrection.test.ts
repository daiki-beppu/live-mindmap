import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeSession, type DiffInput, type LogEvent, type Remark, type Session } from "../src/core/index.ts";
import { logReadings, withReplayCorrection } from "../src/replayCorrection.ts";
import { fakeReadings } from "./fixtures/readings.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

type VocabLine = Extract<LogEvent, { type: "vocab" }>;
type Original = NonNullable<Parameters<Session["push"]>[1]>;

const utterance = (...tokens: (readonly [string, string])[]): Original => {
  let location = 0;
  const words = tokens.map(([surface, romaji]) => {
    const word = { surface, romaji, location, length: surface.length };
    location += surface.length;
    return word;
  });
  return { raw: tokens.map(([surface]) => surface).join(""), words };
};
const zendesk = utterance(["今日", "kyou"], ["は", "ha"], ["全", "zen"], ["デスク", "desuku"], ["で", "de"], ["確認", "kakunin"], ["し", "shi"], ["ます", "masu"], ["。", "｡"]);
const notion = utterance(["ノー", "nō"], ["ション", "shon"], ["を", "wo"], ["使う", "tsukau"]);
const corrected = "今日はZendeskで確認します。";
const remark = (id: string, start: number, end: number, original: Original): Remark => ({ id, track: "相手", start, end, text: original.raw });

const setup = Effect.fnUntraced(function* (vocab: ReadonlyArray<VocabLine>) {
  const events: LogEvent[] = [];
  const calls: DiffInput[] = [];
  const readings = fakeReadings({ Zendesk: "zendesuku", Notion: "nōshon", 葛西: "kasai" });
  const layer = Layer.mergeAll(collectLog(events), readings.layer, updaterLayer((input) => Effect.sync(() => {
    calls.push(input);
    return { ops: [{ op: "noop", reason: "テスト" }] };
  })));
  const base = yield* makeSession({ title: "再生" }).pipe(Effect.provide(layer));
  const appendLog = (event: LogEvent) => Effect.sync(() => { events.push(event); });
  const wrap = (log: typeof appendLog) => withReplayCorrection(base, { vocab, commonWords: new Set(), appendLog: log }).pipe(Effect.provide(layer));
  const remarks = () => events.filter((event): event is Extract<LogEvent, { type: "remark" }> => event.type === "remark");
  const vocabWords = () => events.flatMap((event) => event.type === "vocab" ? event.words : []);
  return { base, wrap, appendLog, events, calls, readings, remarks, vocabWords };
});

describe("logReadings", () => {
  it.effect("表記ごとに最初のnullでない読みを返し、読めない語と頼んでいない語はキーに含めない", () => Effect.gen(function* () {
    const read = logReadings([
      { type: "vocab", words: [{ surface: "Zendesk", romaji: null, source: "screen" }, { surface: "Notion", romaji: null, source: "user" }] },
      { type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "user" }, { surface: "葛西", romaji: "kasai", source: "carried" }] },
      { type: "vocab", words: [{ surface: "Zendesk", romaji: "later", source: "screen" }] },
    ]);
    expect(yield* read(["Zendesk", "Notion", "未記録"])).toEqual(new Map([["Zendesk", "zendesuku"]]));
    expect(yield* read(["葛西"])).toEqual(new Map([["葛西", "kasai"]]));
    expect(yield* read([])).toEqual(new Map());
  }));

  it.effect("vocabの行が無ければ読みのキーを返さない", () => Effect.gen(function* () {
    expect(yield* logReadings([])(["Zendesk"])).toEqual(new Map());
  }));
});

describe("replayCorrection", () => {
  it.effect("初期user語彙のログ失敗をdecoratorの初期化へ伝える", () => Effect.gen(function* () {
    const h = yield* setup([{ type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "user" }] }]);
    const defect = new Error("vocab write failed");
    const exit = yield* h.wrap((event) => event.type === "vocab" ? Effect.die(defect) : h.appendLog(event)).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
  }));

  it.effect("screen保存後の語彙ログ失敗をpushScreenへ伝える", () => Effect.gen(function* () {
    const h = yield* setup([{ type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "screen" }] }]);
    const defect = new Error("vocab write failed");
    const replay = yield* h.wrap((event) => event.type === "vocab" ? Effect.die(defect) : h.appendLog(event));
    const exit = yield* replay.pushScreen({ start: 6, image: null }, ["Zendesk 導入"]).pipe(Effect.exit);
    expect(h.events.find((event) => event.type === "screen")).toEqual({ type: "screen", start: 6, image: null, lines: ["Zendesk 導入"] });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
  }));

  it.effect("screen の lines から今の規則で候補を取り直す。screen より前の発言・今の規則で取れない語は直らない", () => Effect.gen(function* () {
    const h = yield* setup([{ type: "vocab", words: [
      { surface: "Zendesk", romaji: "zendesuku", source: "screen" }, { surface: "notion", romaji: "noshon", source: "screen" },
    ] }]);
    const logging = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const returned = yield* Deferred.make<void>();
    const replay = yield* h.wrap((event) => Effect.gen(function* () {
      if (event.type === "vocab") {
        yield* Deferred.succeed(logging, undefined);
        yield* Deferred.await(release);
      }
      yield* h.appendLog(event);
    }));
    yield* replay.push(remark("before", 0, 5, zendesk), zendesk);
    yield* replay.idle;
    const screen = yield* replay.pushScreen({ start: 6, image: null }, ["Zendesk 導入", "notion"]).pipe(
      Effect.andThen(Deferred.succeed(returned, undefined)), Effect.forkChild,
    );
    yield* Deferred.await(logging);
    yield* Effect.gen(function* () {
      expect(h.events.find((event) => event.type === "screen")).toEqual({ type: "screen", start: 6, image: null, lines: ["Zendesk 導入", "notion"] });
      yield* TestClock.adjust(1);
      expect(yield* Deferred.isDone(returned)).toBe(false);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Fiber.join(screen);
    // 再生ではfromを付けない。画面と同時刻に終わる発言も、追加完了後は補正できる。
    yield* replay.push(remark("after", 6, 6, zendesk), zendesk);
    yield* replay.idle;
    yield* replay.push(remark("notion", 10, 12, notion), notion);
    yield* replay.flush;
    expect(h.remarks().map((line) => line.remark.text)).toEqual([zendesk.raw, corrected, notion.raw]);
    expect(h.calls.flatMap((input) => input.fresh).map((r) => r.text)).toEqual([zendesk.raw, corrected, notion.raw]);
    expect(h.vocabWords()).toEqual([{ surface: "Zendesk", romaji: "zendesuku", source: "screen" }]);
    expect(h.readings.calls).toEqual([]);
  }));

  it.effect("読みの無い語（romaji: null）は、画面の候補になっても補正に使われず、元の本文のまま流れ、新しいログには romaji: null で残る。読みのある語は同じ実行で直る", () => Effect.gen(function* () {
    const h = yield* setup([{ type: "vocab", words: [
      { surface: "Notion", romaji: null, source: "screen" }, { surface: "Zendesk", romaji: "zendesuku", source: "screen" },
    ] }]);
    const replay = yield* h.wrap(h.appendLog);
    yield* replay.pushScreen({ start: 6, image: null }, ["Zendesk 導入", "Notion"]);
    yield* replay.push(remark("zendesk", 7, 9, zendesk), zendesk);
    yield* replay.idle;
    yield* replay.push(remark("notion", 10, 12, notion), notion);
    yield* replay.flush;
    expect(h.remarks().map((line) => line.remark.text)).toEqual([corrected, notion.raw]);
    expect(h.vocabWords()).toEqual([
      { surface: "Zendesk", romaji: "zendesuku", source: "screen" }, { surface: "Notion", romaji: null, source: "screen" },
    ]);
    expect(h.readings.calls).toEqual([]);
  }));

  it.effect("元のログの carried の vocab の行の語で直し直し、新しいログにも元の出どころ（carried・user）のまま vocab の行が残る。読みのサブコマンドは呼ばれない", () => Effect.gen(function* () {
    const h = yield* setup([
      { type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "carried" }] },
      { type: "vocab", words: [{ surface: "葛西", romaji: "kasai", source: "user" }] },
    ]);
    const replay = yield* h.wrap(h.appendLog);
    yield* replay.push(remark("r1", 0, 5, zendesk), zendesk);
    yield* replay.flush;
    expect(h.remarks()).toEqual([{ type: "remark", remark: { ...remark("r1", 0, 5, zendesk), text: corrected }, ...zendesk }]);
    expect(h.vocabWords()).toEqual([
      { surface: "Zendesk", romaji: "zendesuku", source: "carried" }, { surface: "葛西", romaji: "kasai", source: "user" },
    ]);
    expect(h.readings.calls).toEqual([]);
  }));

  it.effect("初期user語彙の記録完了を待ち、最初の発言を補正済みtextではなくrawから直してログと差分更新へ渡す", () => Effect.gen(function* () {
    const h = yield* setup([{ type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "user" }] }]);
    const logging = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const returned = yield* Deferred.make<void>();
    const opening = yield* h.wrap((event) => Effect.gen(function* () {
      yield* Deferred.succeed(logging, undefined);
      yield* Deferred.await(release);
      yield* h.appendLog(event);
    })).pipe(Effect.tap(() => Deferred.succeed(returned, undefined)), Effect.forkChild);
    yield* Deferred.await(logging);
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(1);
      expect(yield* Deferred.isDone(returned)).toBe(false);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    const replay = yield* Fiber.join(opening);
    const input = { ...remark("r1", 0, 5, zendesk), text: "以前の補正結果", speaker: "相手 A", duplicate: false };
    yield* replay.push(input, zendesk);
    yield* replay.flush;
    const expected = { ...input, text: corrected };
    expect(h.remarks()).toEqual([{ type: "remark", remark: expected, ...zendesk }]);
    expect(h.calls.flatMap((call) => call.fresh)).toEqual([expected]);
  }));
});
