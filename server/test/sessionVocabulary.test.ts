import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { type DiffUpdater, type LogEvent, type SettledRemark } from "../src/core/index.ts";
import { Readings, ReadingsFailed } from "../src/readings.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";
import { makeSessionVocabulary, modelReadings, RemarkCorrection, type ReadingSource } from "../src/sessionVocabulary.ts";

type VocabLine = Extract<LogEvent, { type: "vocab" }>;
type Options = Parameters<typeof makeSessionVocabulary>[0];

const utterance = (...tokens: ReadonlyArray<readonly [string, string]>) => {
  let location = 0;
  const words = tokens.map(([surface, romaji]) => {
    const word = { surface, romaji, location, length: surface.length };
    location += surface.length;
    return word;
  });
  return { text: tokens.map(([surface]) => surface).join(""), words };
};
const garbled = utterance(["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);
const notion = utterance(["ノーション", "nooshon"], ["を", "wo"], ["開く", "hiraku"]);
const remark = (end: number): SettledRemark => ({ track: "相手", start: end - 1, end, ...garbled });

const recording = () => {
  const lines: VocabLine[] = [];
  return { lines, log: (line: VocabLine) => Effect.sync(() => { lines.push(line); }) };
};
const source = (table: Readonly<Record<string, string>>) => {
  const calls: string[][] = [];
  const read: ReadingSource = (surfaces) => Effect.sync(() => {
    calls.push([...surfaces]);
    return new Map(surfaces.flatMap((surface) => table[surface] === undefined ? [] : [[surface, table[surface]!] as const]));
  });
  return { calls, read };
};
const heldSource = Effect.fnUntraced(function* () {
  const started = yield* Deferred.make<void>();
  const result = yield* Deferred.make<ReadonlyMap<string, string>>();
  const calls: string[][] = [];
  const read: ReadingSource = (surfaces) => Effect.gen(function* () {
    calls.push([...surfaces]);
    yield* Deferred.succeed(started, undefined);
    return yield* Deferred.await(result);
  });
  return { calls, read, started: Deferred.await(started), result };
});
const open = (read: ReadingSource, options: Partial<Omit<Options, "read" | "log">> = {}) => {
  const recorded = recording();
  return Effect.map(makeSessionVocabulary({ read, log: recorded.log, commonWords: new Set(), carried: [], ...options }),
    (vocabulary) => ({ vocabulary, ...recorded }));
};

describe("sessionVocabulary", () => {
  it.effect("足した語を重複なしでまとめて読み、読めない語はnullで記録する", () => Effect.gen(function* () {
    const reading = source({ 港南店: "kounanten", Zendesk: "zendesuku" });
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addUser(["港南店", "Zendesk", "読めない語", "港南店"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["港南店", "Zendesk", "読めない語"]]);
    expect(lines).toEqual([{ type: "vocab", words: [
      { surface: "港南店", romaji: "kounanten", source: "user" },
      { surface: "Zendesk", romaji: "zendesuku", source: "user" },
      { surface: "読めない語", romaji: null, source: "user" },
    ] }]);
  }));

  it.effect("user入力には画面候補の制限をかけず小文字と1文字も記録する", () => Effect.gen(function* () {
    const reading = source({ notion: "nooshon", a: "e" });
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addUser(["notion", "a"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["notion", "a"]]);
    expect(lines.flatMap((l) => l.words)).toEqual([
      { surface: "notion", romaji: "nooshon", source: "user" }, { surface: "a", romaji: "e", source: "user" },
    ]);
  }));

  it.effect("空の追加では読みもvocabの記録も行わず発言を変えない", () => Effect.gen(function* () {
    const reading = source({ 港南店: "kounanten" });
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addUser([]);
    yield* vocabulary.addUser([""]);
    yield* vocabulary.settled;
    expect((yield* vocabulary.correct(remark(3))).rest.text).toBe(garbled.text);
    expect(reading.calls).toEqual([]);
    expect(lines).toEqual([]);
  }));

  it.effect("読みがある語だけで発言を直す", () => Effect.gen(function* () {
    const { vocabulary, lines } = yield* open(source({ Zendesk: "zendesuku" }).read);
    yield* vocabulary.addUser(["港南店", "Zendesk"]);
    yield* vocabulary.settled;
    const zendesk = utterance(["全", "zen"], ["デスク", "desuku"], ["を", "wo"], ["使う", "tsukau"]);
    expect(lines.flatMap((l) => l.words)).toEqual([
      { surface: "港南店", romaji: null, source: "user" }, { surface: "Zendesk", romaji: "zendesuku", source: "user" },
    ]);
    expect((yield* vocabulary.correct(remark(3))).rest.text).toBe(garbled.text);
    expect((yield* vocabulary.correct({ track: "相手", start: 10, end: 12, ...zendesk })).rest.text).toBe("Zendeskを使う");
  }));

  it.effect("渡されたcommonWordsを補正へ渡し通常語を置き換えない", () => Effect.gen(function* () {
    const { vocabulary } = yield* open(source({ 改札: "kaisatsu" }).read, { commonWords: new Set(["開発"]) });
    yield* vocabulary.addUser(["改札"]);
    yield* vocabulary.settled;
    const corrected = yield* vocabulary.correct({ track: "相手", start: 1, end: 2, ...utterance(["開発", "kaihatsu"]) });
    expect(corrected.rest.text).toBe("開発");
  }));

  it.effect("補正のReferenceを読み元の情報とwordTimesと置き換えを保持する", () => {
    const seen: unknown[] = [];
    const replacements = [{ location: 0, length: 3, span: "江南店", surface: "港南店", score: 1 }];
    const correct: typeof RemarkCorrection["Service"] = (vocabulary, text, words, commonWords) => {
      seen.push({ vocabulary, text, words, commonWords: [...commonWords] });
      return { text: "港南店に行きます", replacements };
    };
    return Effect.gen(function* () {
      const { vocabulary } = yield* open(source({ 港南店: "kounanten" }).read, { commonWords: new Set(["開発"]) });
      yield* vocabulary.addUser(["港南店"]);
      yield* vocabulary.settled;
      const wordTimes = [{ location: 0, length: 3, start: 1, end: 2 }];
      const input = { ...remark(3), wordTimes };
      const corrected = yield* vocabulary.correct(input);
      expect(seen).toEqual([{ vocabulary: [{ surface: "港南店", romaji: "kounanten" }], text: garbled.text, words: garbled.words, commonWords: ["開発"] }]);
      expect(corrected).toEqual({ rest: { track: "相手", start: 2, end: 3, text: "港南店に行きます" }, original: { raw: garbled.text, words: garbled.words }, wordTimes, replacements });
      expect(yield* vocabulary.correct({ track: "相手", start: 1, end: 2, text: garbled.text })).toEqual({
        rest: { track: "相手", start: 1, end: 2, text: garbled.text }, original: undefined, wordTimes: undefined, replacements: [],
      });
    }).pipe(Effect.provideService(RemarkCorrection, correct));
  });

  it.effect("vocabのログ完了まで語を使わずsettledも待つ", () => Effect.gen(function* () {
    const logging = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const events: string[] = [];
    const vocabulary = yield* makeSessionVocabulary({ read: source({ 港南店: "kounanten" }).read, commonWords: new Set(), carried: [],
      log: () => Effect.gen(function* () {
        yield* Deferred.succeed(logging, undefined);
        yield* Deferred.await(release);
        events.push("vocab");
      }),
    });
    yield* vocabulary.addUser(["港南店"]);
    yield* Deferred.await(logging);
    yield* Effect.forkChild(Effect.andThen(vocabulary.settled, Deferred.succeed(finished, undefined)));
    yield* Effect.gen(function* () {
      expect((yield* vocabulary.correct(remark(3))).rest.text).toBe(garbled.text);
      yield* TestClock.adjust(1);
      expect(yield* Deferred.isDone(finished)).toBe(false);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Deferred.await(finished);
    events.push((yield* vocabulary.correct(remark(12))).rest.text);
    expect(events).toEqual(["vocab", "港南店に行きます"]);
  }));

  it.effect("同じ実体で画面の読み完了前の発言を保ち完了後の発言だけを直す", () => Effect.gen(function* () {
    const reading = yield* heldSource();
    const { vocabulary, lines } = yield* open(reading.read);
    const outputs: string[] = [];
    const settling = yield* createRemarkSettling({ emit: (r) => Effect.flatMap(vocabulary.correct(r), (c) => Effect.sync(() => { outputs.push(c.rest.text); })) });
    yield* settling.speaker({ type: "speaker-off", start: 0, reason: "モデルなし" });
    yield* vocabulary.addScreen(["港南店"]);
    yield* reading.started;
    yield* settling.final(remark(3));
    expect(outputs).toEqual([garbled.text]);
    expect(lines).toEqual([]);
    yield* Deferred.succeed(reading.result, new Map([["港南店", "kounanten"]]));
    yield* vocabulary.settled;
    yield* settling.final(remark(12));
    yield* settling.drain;
    expect(outputs).toEqual([garbled.text, "港南店に行きます"]);
  }));

  it.effect("fromより前と一致するendは直さず後に終わる発言だけを直す", () => Effect.gen(function* () {
    const { vocabulary } = yield* open(source({ 港南店: "kounanten" }).read);
    yield* vocabulary.addScreen(["港南店"], 6);
    yield* vocabulary.settled;
    const texts = yield* Effect.forEach([2, 6, 12], (end) => Effect.map(vocabulary.correct(remark(end)), (c) => c.rest.text));
    expect(texts).toEqual([garbled.text, garbled.text, "港南店に行きます"]);
  }));

  it.effect("画面候補をまとめて読みscreenとして記録する", () => Effect.gen(function* () {
    const reading = source({ 港南店: "kounanten", Zendesk: "zendesuku" });
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addScreen(["港南店の出店", "Zendesk", "1on1", "ひらがなだけ"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["港南店", "Zendesk"]]);
    expect(lines).toEqual([{ type: "vocab", words: [
      { surface: "港南店", romaji: "kounanten", source: "screen" }, { surface: "Zendesk", romaji: "zendesuku", source: "screen" },
    ] }]);
  }));

  it.effect("短い名前の画面数を引き継ぎ3画面目で一度取得する", () => Effect.gen(function* () {
    const reading = source({ 港南店: "kounanten", Zendesk: "zendesuku", 葛西: "kasai" });
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addScreen(["港南店でZendeskを使う", "葛西", "葛西"]);
    yield* vocabulary.settled;
    yield* vocabulary.addScreen([" 葛西 "]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["港南店", "Zendesk"]]);
    yield* vocabulary.addScreen(["葛西"]);
    yield* vocabulary.settled;
    yield* vocabulary.addScreen(["葛西"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["港南店", "Zendesk"], ["葛西"]]);
    expect(lines.flatMap((l) => l.words).map((w) => [w.surface, w.source])).toEqual([["港南店", "screen"], ["Zendesk", "screen"], ["葛西", "screen"]]);
  }));

  it.effect("短い名前の条件を満たさない行は3画面でも取得しない", () => Effect.gen(function* () {
    const reading = source({});
    const { vocabulary, lines } = yield* open(reading.read);
    for (let i = 0; i < 3; i++) yield* vocabulary.addScreen(["1on1", "さくら", "田中 a", "会・議", "あいうえお会議"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([]);
    expect(lines).toEqual([]);
  }));

  it.effect("小文字だけの語と空とundefinedの画面からは語を要求しない", () => Effect.gen(function* () {
    const reading = source({});
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addScreen(["notion", "a"]);
    yield* vocabulary.addScreen([]);
    yield* vocabulary.addScreen(undefined);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([]);
    expect(lines).toEqual([]);
    expect((yield* vocabulary.correct(remark(3))).rest.text).toBe(garbled.text);
  }));

  it.effect("画面変更後も前の語を保持し再要求しない", () => Effect.gen(function* () {
    const reading = source({ 港南店: "kounanten" });
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addScreen(["港南店"]);
    yield* vocabulary.settled;
    yield* vocabulary.addScreen(["別の内容"]);
    yield* vocabulary.addScreen(undefined);
    yield* vocabulary.addScreen(["港南店"]);
    yield* vocabulary.settled;
    expect((yield* vocabulary.correct(remark(12))).rest.text).toBe("港南店に行きます");
    expect(reading.calls.flat().filter((s) => s === "港南店")).toEqual(["港南店"]);
    expect(lines.flatMap((l) => l.words).filter((w) => w.surface === "港南店")).toHaveLength(1);
  }));

  it.effect("userとscreenは読み待ち中も要求済み集合を共有する", () => Effect.gen(function* () {
    const reading = yield* heldSource();
    const { vocabulary, lines } = yield* open(reading.read);
    yield* vocabulary.addUser(["港南店"]);
    yield* vocabulary.addScreen(["港南店", "Zendesk"]);
    yield* vocabulary.addUser(["港南店", "Zendesk"]);
    yield* vocabulary.addScreen(["Zendesk", "港南店"]);
    yield* Deferred.succeed(reading.result, new Map([["港南店", "kounanten"], ["Zendesk", "zendesuku"]]));
    yield* vocabulary.settled;
    yield* vocabulary.addUser(["港南店", "Zendesk"]);
    yield* vocabulary.addScreen(["港南店", "Zendesk"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["港南店"], ["Zendesk"]]);
    expect(lines.flatMap((l) => l.words).sort((a, b) => a.surface.localeCompare(b.surface))).toEqual([
      { surface: "港南店", romaji: "kounanten", source: "user" }, { surface: "Zendesk", romaji: "zendesuku", source: "screen" },
    ].sort((a, b) => a.surface.localeCompare(b.surface)));
  }));

  it.effect("carriedの読みで補正しuserやscreenからも再取得も再記録もしない", () => Effect.gen(function* () {
    const reading = source({});
    const { vocabulary, lines } = yield* open(reading.read, { carried: [
      { surface: "港南店", romaji: "kounanten" },
      { surface: "読めない語", romaji: null },
    ] });
    expect((yield* vocabulary.correct(remark(3))).rest.text).toBe("港南店に行きます");
    yield* vocabulary.addUser(["港南店", "読めない語"]);
    yield* vocabulary.addScreen(["港南店", "読めない語"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([]);
    expect(lines).toEqual([{ type: "vocab", words: [
      { surface: "港南店", romaji: "kounanten", source: "carried" }, { surface: "読めない語", romaji: null, source: "carried" },
    ] }]);
  }));

  it.effect("読み待ちを中断すると各語をnullで一度記録する", () => Effect.gen(function* () {
    const reading = yield* heldSource();
    const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void));
    const { vocabulary, lines } = yield* Scope.provide(open(reading.read), scope);
    yield* vocabulary.addUser(["港南店", "Zendesk"]);
    yield* reading.started;
    yield* vocabulary.addScreen(["Figma", "港南店"]);
    yield* Scope.close(scope, Exit.void);
    expect(lines.flatMap((l) => l.words).sort((a, b) => a.surface.localeCompare(b.surface))).toEqual([
      { surface: "Figma", romaji: null, source: "screen" }, { surface: "Zendesk", romaji: null, source: "user" }, { surface: "港南店", romaji: null, source: "user" },
    ].sort((a, b) => a.surface.localeCompare(b.surface)));
  }));

  it.effect("読み完了後の中断ではvocabを追記しない", () => Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void));
    const { vocabulary, lines } = yield* Scope.provide(open(source({ 港南店: "kounanten" }).read), scope);
    yield* vocabulary.addUser(["港南店"]);
    yield* vocabulary.settled;
    yield* Scope.close(scope, Exit.void);
    expect(lines).toEqual([{ type: "vocab", words: [{ surface: "港南店", romaji: "kounanten", source: "user" }] }]);
  }));
});

const models = (table: Readonly<Record<string, string>>) => {
  const calls: string[][] = [];
  const katakana: NonNullable<DiffUpdater["Service"]["katakana"]> = (words) => Effect.sync(() => {
    calls.push([...words]);
    return words.flatMap((surface) => table[surface] === undefined ? [] : [{ surface, katakana: table[surface]! }]);
  });
  return { calls, katakana };
};
const reader = (table: Readonly<Record<string, string>>) => {
  const calls: string[][] = [];
  const readings = Readings.of({ readings: (words) => Effect.sync(() => {
    calls.push([...words]);
    return words.flatMap((surface) => table[surface] === undefined ? [] : [{ surface, romaji: table[surface]! }]);
  }) });
  return { calls, readings };
};

describe("modelReadings", () => {
  it.effect("英字だけをモデルにまとめて聞き直接読む語と合わせて一度読む", () => Effect.gen(function* () {
    const model = models({ Notion: "ノーション", Figma: "フィグマ" });
    const reading = reader({ ノーション: "nooshon", フィグマ: "figuma", OJT: "oojiitii", 港南店: "kounanten" });
    const result = yield* modelReadings(model.katakana, reading.readings)(["Notion", "Figma", "OJT", "港南店"]);
    expect(model.calls).toEqual([["Notion", "Figma"]]);
    expect(reading.calls).toEqual([["OJT", "港南店", "ノーション", "フィグマ"]]);
    expect(result).toEqual(new Map([["Notion", "nooshon"], ["Figma", "figuma"], ["OJT", "oojiitii"], ["港南店", "kounanten"]]));
  }));

  it.effect("略語と非英字だけならモデルを呼ばず直接読む", () => Effect.gen(function* () {
    const model = models({});
    const reading = reader({ OJT: "oojiitii", KPI: "keipiai", 港南店: "kounanten" });
    for (const words of [["OJT", "KPI"], ["港南店"]]) {
      const result = yield* modelReadings(model.katakana, reading.readings)(words);
      expect([...result.keys()]).toEqual(words);
    }
    expect(model.calls).toEqual([]);
    expect(reading.calls).toEqual([["OJT", "KPI"], ["港南店"]]);
  }));

  it.effect("同じカタカナを一度読み両方の表記に対応させる", () => Effect.gen(function* () {
    const model = models({ Notion: "ノーション", notion: "ノーション" });
    const reading = reader({ ノーション: "nooshon" });
    const result = yield* modelReadings(model.katakana, reading.readings)(["Notion", "notion"]);
    expect(reading.calls).toEqual([["ノーション"]]);
    expect(result).toEqual(new Map([["Notion", "nooshon"], ["notion", "nooshon"]]));
  }));

  it.effect("モデル待ちでもcorrectは返り過去の結果を変更しない", () => Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const katakana: NonNullable<DiffUpdater["Service"]["katakana"]> = () => Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      return [{ surface: "Notion", katakana: "ノーション" }];
    });
    const { vocabulary, lines } = yield* open(modelReadings(katakana, reader({ ノーション: "nooshon" }).readings));
    yield* vocabulary.addUser(["Notion"]);
    yield* Deferred.await(started);
    const before = yield* vocabulary.correct({ track: "相手", start: 1, end: 3, ...notion });
    expect(before.rest.text).toBe(notion.text);
    expect(lines).toEqual([]);
    yield* Deferred.succeed(release, undefined);
    yield* vocabulary.settled;
    const after = yield* vocabulary.correct({ track: "相手", start: 10, end: 12, ...notion });
    expect([before.rest.text, after.rest.text]).toEqual([notion.text, "Notionを開く"]);
  }));

  it.effect("モデル失敗時は英字だけ読みなしにし直接読む語は使用できる", () => Effect.gen(function* () {
    const katakana: NonNullable<DiffUpdater["Service"]["katakana"]> = () => Effect.fail({ _tag: "FakeKatakanaFailed", message: "モデル失敗" });
    const reading = reader({ Notion: "nooshon", 港南店: "kounanten", OJT: "oojiitii" });
    const { vocabulary, lines } = yield* open(modelReadings(katakana, reading.readings));
    yield* vocabulary.addUser(["Notion", "OJT", "港南店"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([["OJT", "港南店"]]);
    expect(lines.flatMap((l) => l.words)).toEqual([
      { surface: "Notion", romaji: null, source: "user" }, { surface: "OJT", romaji: "oojiitii", source: "user" }, { surface: "港南店", romaji: "kounanten", source: "user" },
    ]);
    expect((yield* vocabulary.correct({ track: "相手", start: 1, end: 3, ...notion })).rest.text).toBe(notion.text);
    expect((yield* vocabulary.correct(remark(12))).rest.text).toBe("港南店に行きます");
  }));

  it.effect("モデル失敗で読む語が残らなければ読み取得を呼ばない", () => Effect.gen(function* () {
    const katakana: NonNullable<DiffUpdater["Service"]["katakana"]> = () => Effect.fail({ _tag: "FakeKatakanaFailed", message: "モデル失敗" });
    const reading = reader({ Notion: "nooshon", Figma: "figuma" });
    const { vocabulary, lines } = yield* open(modelReadings(katakana, reading.readings));
    yield* vocabulary.addUser(["Notion", "Figma"]);
    yield* vocabulary.settled;
    expect(reading.calls).toEqual([]);
    expect(lines).toEqual([{ type: "vocab", words: [
      { surface: "Notion", romaji: null, source: "user" }, { surface: "Figma", romaji: null, source: "user" },
    ] }]);
  }));

  it.effect("読み取得の失敗は全語を読みなしとして扱う", () => Effect.gen(function* () {
    const model = models({ Notion: "ノーション" });
    const readings = Readings.of({ readings: () => Effect.fail(new ReadingsFailed({ message: "読み取得失敗" })) });
    const { vocabulary, lines } = yield* open(modelReadings(model.katakana, readings));
    yield* vocabulary.addUser(["Notion", "港南店"]);
    yield* vocabulary.settled;
    expect(lines).toEqual([{ type: "vocab", words: [
      { surface: "Notion", romaji: null, source: "user" }, { surface: "港南店", romaji: null, source: "user" },
    ] }]);
    expect((yield* vocabulary.correct(remark(3))).rest.text).toBe(garbled.text);
  }));
});
