import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { makeSession, type CaptionsFrame, type DiffInput, type LogEvent, type SettledRemark, type SpeakerLogEvent } from "../src/core/index.ts";
import { directFeed, makeRemarkFlow, type Feed, type Inlet } from "../src/remarkFlow.ts";
import { makeSessionVocabulary } from "../src/sessionVocabulary.ts";
import { SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const final = (track: SettledRemark["track"], start: number, end: number, text: string): SettledRemark => ({ track, start, end, text });
const partial = (track: SettledRemark["track"], start: number, end: number, text: string) => ({ track, start, end, text, duplicate: false });
const segment = (slot: number, start: number, end: number, confirmed = true): SpeakerLogEvent => ({ type: "speaker", track: "相手", slot, start, end, final: confirmed });
const settled = (to: number): SpeakerLogEvent => ({ type: "speaker-settled", track: "相手", to });
const speakerOff: SpeakerLogEvent = { type: "speaker-off", start: 0, reason: "モデルなし" };
const utterance = (...tokens: (readonly [string, string])[]) => {
  let location = 0;
  const words = tokens.map(([surface, romaji]) => {
    const word = { surface, romaji, location, length: surface.length };
    location += surface.length;
    return word;
  });
  return { text: tokens.map(([surface]) => surface).join(""), words };
};
const garbled = utterance(["江南", "kounan"], ["店", "ten"], ["に", "ni"], ["行き", "iki"], ["ます", "masu"]);

const bufferedFeed = () => {
  const pending: Effect.Effect<void>[] = [];
  const release = Effect.gen(function* () {
    while (pending.length > 0) yield* pending.shift()!;
  });
  const factory = (inlet: Inlet) => Effect.succeed({
    remark: (c: Parameters<Inlet["remark"]>[0]) => Effect.sync(() => { pending.push(inlet.remark(c)); }),
    screen: (c: Parameters<Inlet["screen"]>[0]) => Effect.sync(() => { pending.push(inlet.screen(c)); }),
    screenOff: (o: Parameters<Inlet["screenOff"]>[0]) => Effect.sync(() => { pending.push(inlet.screenOff(o)); }),
    drain: release,
  } satisfies Feed);
  return { factory, release };
};

const setup = Effect.fn("setup")(function* (options: {
  captions?: "途中結果から" | "入れた発言だけ";
  feed?: (inlet: Inlet) => Effect.Effect<Feed, never, Scope.Scope>;
  speakerOff?: boolean;
  block?: boolean;
} = {}) {
  const events: LogEvent[] = [];
  const calls: DiffInput[] = [];
  const frames: CaptionsFrame[] = [];
  const reply = yield* Deferred.make<void>();
  const layer = Layer.merge(collectLog(events), updaterLayer((input) => Effect.gen(function* () {
    calls.push(input);
    if (options.block) yield* Deferred.await(reply);
    return { ops: [{ op: "add", ref: `topic${calls.length}`, parent: "root", kind: "議題", text: "会議の議題", evidence: input.fresh.map((r) => r.id) }] };
  })));
  const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(layer));
  const vocabulary = yield* makeSessionVocabulary({
    read: (surfaces) => Effect.succeed(new Map(surfaces.map((s) => [s, s === "Zendesk" ? "zendesuku" : "kounanten"]))),
    commonWords: new Set(), carried: [], log: () => Effect.void,
  });
  const flow = yield* makeRemarkFlow({
    session, correct: vocabulary.correct,
    speak: (frame: CaptionsFrame) => Effect.sync(() => { frames.push(frame); }),
    captions: options.captions ?? "途中結果から", feed: options.feed ?? directFeed,
  });
  if (options.speakerOff !== false) yield* flow.speaker(speakerOff);
  const lines = () => events.filter((e): e is Extract<LogEvent, { type: "remark" }> => e.type === "remark");
  const fresh = () => calls.flatMap((c) => c.fresh);
  return { flow, session, vocabulary, frames, events, lines, fresh, calls, reply };
});

const tick = TestClock.adjust(SPEAKING_INTERVAL_MS);
const bubbles = (frames: CaptionsFrame[]) => frames.at(-1)!.bubbles;

describe("remarkFlow", () => {
  it.effect("入れた発言だけを字幕に出し、自分と相手のtrackを保つ", () => Effect.gen(function* () {
    const feed = bufferedFeed();
    const h = yield* setup({ captions: "入れた発言だけ", feed: feed.factory, block: true, speakerOff: false });
    yield* h.flow.partial(partial("自分", 100, 101, "先読みの途中結果"));
    yield* h.flow.speaker(segment(0, 1, 2, false));
    yield* h.flow.speaker(settled(2));
    yield* h.flow.final(final("自分", 3, 4, "自分の発言"));
    yield* h.flow.final(final("相手", 5, 6, "相手の発言"));
    yield* h.flow.speaker(speakerOff);
    expect(h.lines()).toEqual([]);
    expect(h.frames.flatMap((f) => f.bubbles)).toEqual([]);
    yield* feed.release;
    expect(bubbles(h.frames).map((b) => [b.track, b.text])).toEqual([["自分", "自分の発言"], ["相手", "相手の発言"]]);
    expect(bubbles(h.frames).every((b) => b.label !== "仮")).toBe(true);
  }));

  it.effect("締めた時点の補正をfeed待ちで変えない", () => Effect.gen(function* () {
    const feed = bufferedFeed();
    const h = yield* setup({ captions: "入れた発言だけ", feed: feed.factory });
    yield* h.flow.final({ track: "相手", start: 1, end: 3, ...garbled });
    expect(h.lines()).toEqual([]);
    yield* h.vocabulary.addUser(["港南店"]);
    yield* h.vocabulary.settled;
    yield* feed.release;
    yield* h.session.idle;
    yield* h.flow.final({ track: "相手", start: 10, end: 12, ...garbled });
    yield* feed.release;
    yield* h.session.idle;
    expect(h.lines().map((l) => [l.remark.text, l.raw, l.words])).toEqual([
      [garbled.text, garbled.text, garbled.words], ["港南店に行きます", garbled.text, garbled.words],
    ]);
    expect(h.fresh().map((r) => r.text)).toEqual([garbled.text, "港南店に行きます"]);
  }));

  it.effect("捨てた確定結果と話者分割をまたいでも発言IDは連続する", () => Effect.gen(function* () {
    const h = yield* setup({ speakerOff: false });
    yield* h.flow.speaker(segment(3, 10, 11));
    yield* h.flow.speaker(segment(1, 11, 14));
    yield* h.flow.speaker(settled(14));
    yield* h.flow.final({ ...final("相手", 10, 14, "はい、ありがとう"), wordTimes: [
      { location: 0, length: 3, start: 10, end: 11 }, { location: 3, length: 5, start: 11, end: 14 },
    ] });
    yield* h.flow.final(final("相手", 10, 14, "遅れた確定結果"));
    yield* h.flow.speaker(segment(1, 20, 22));
    yield* h.flow.speaker(settled(22));
    yield* h.flow.final(final("相手", 20, 22, "つぎ"));
    yield* h.flow.final(final("自分", 23, 24, "自分からも続ける"));
    yield* h.flow.drain;
    yield* h.session.idle;
    expect(h.lines().map((l) => [l.remark.id, l.remark.speaker, l.remark.text])).toEqual([
      ["r1", "相手 A", "はい、"], ["r2", "相手 B", "ありがとう"], ["r3", "相手 B", "つぎ"], ["r4", "自分", "自分からも続ける"],
    ]);
    expect(h.fresh().map((r) => [r.id, r.speaker])).toEqual([["r2", "相手 B"], ["r3", "相手 B"], ["r4", "自分"]]);
  }));

  it.effect("捨てた確定結果は次の発言番号を消費しない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.flow.partial(partial("相手", 10, 12, "あしたの会議"));
    yield* h.flow.partial(partial("自分", 0, 13, "時計を進める"));
    expect(h.lines().map((l) => l.remark.id)).toEqual(["r1"]);
    yield* h.flow.final(final("相手", 10.5, 12.5, "明日の会議。"));
    yield* h.flow.final(final("相手", 20, 22, "つぎの発言"));
    yield* h.session.idle;
    expect(h.lines().map((l) => [l.remark.id, l.remark.text])).toEqual([["r1", "あしたの会議"], ["r2", "つぎの発言"]]);
    expect(h.fresh().map((r) => r.id)).toEqual(["r1", "r2"]);
  }));

  it.effect.each([false, true])("画像IDは連続し、画像なしの変化は番号を消費しない（保留: %s）", (buffered) => Effect.gen(function* () {
    const feed = bufferedFeed();
    const h = yield* setup({ feed: buffered ? feed.factory : directFeed });
    yield* h.flow.screen({ start: 1, image: new Uint8Array([1]), lines: ["画面の文字"] });
    yield* h.flow.screen({ start: 2, image: null });
    yield* h.flow.screen({ start: 12, image: new Uint8Array([2]) });
    yield* h.flow.screenOff({ start: 13, reason: "許可なし" });
    if (buffered) expect(h.events.filter((e) => e.type === "screen" || e.type === "screen-off")).toEqual([]);
    yield* h.flow.final(final("相手", 14, 15, "画面を確認する"));
    yield* h.flow.drain;
    yield* h.session.idle;
    expect(h.calls.flatMap((c) => c.screens ?? []).map((s) => [s.start, s.image?.id ?? null])).toEqual([[1, "s1"], [2, null], [12, "s2"]]);
    expect(h.events.filter((e) => e.type === "screen")[0]).toMatchObject({ start: 1, lines: ["画面の文字"] });
    expect(h.events.filter((e) => e.type === "screen-off")).toEqual([{ type: "screen-off", start: 13, reason: "許可なし" }]);
  }));

  it.effect("途中結果から締めた発言がr1でログと差分更新へ届く", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.flow.partial(partial("相手", 5, 7.5, "あしたの"));
    yield* h.flow.partial(partial("相手", 5, 8, "あしたの会議は"));
    yield* h.flow.partial(partial("自分", 0, 9, "時計を進める"));
    yield* h.session.idle;
    const expected = { id: "r1", track: "相手", start: 5, end: 8, text: "あしたの会議は" };
    expect(h.lines().map((l) => l.remark)).toEqual([expected]);
    expect(h.fresh()).toEqual([expected]);
    yield* h.flow.drain;
    expect(h.lines()).toHaveLength(1);
  }));

  it.effect("drainは残りの発言をfeedへ渡してからfeedをdrainする", () => Effect.gen(function* () {
    const feed = bufferedFeed();
    const h = yield* setup({ feed: feed.factory });
    yield* h.flow.partial(partial("相手", 5, 8, "とちゅうでとめた"));
    expect(h.lines()).toEqual([]);
    yield* h.flow.drain;
    yield* h.session.idle;
    expect(h.fresh().map((r) => [r.id, r.text])).toEqual([["r1", "とちゅうでとめた"]]);
    yield* h.flow.drain;
    expect(h.lines()).toHaveLength(1);
  }));

  it.effect("ライブの字幕はclear後に再開でき、stop後は送らない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.flow.partial(partial("自分", 1, 3, "ひとつめ"));
    expect(bubbles(h.frames).map((b) => b.text)).toEqual(["ひとつめ"]);
    yield* h.flow.clearSpeaking;
    expect(bubbles(h.frames)).toEqual([]);
    yield* h.flow.partial(partial("自分", 4, 5, "ふたつめ"));
    yield* tick;
    expect(bubbles(h.frames).map((b) => [b.track, b.text])).toEqual([["自分", "ふたつめ"]]);
    yield* h.flow.stop;
    expect(bubbles(h.frames)).toEqual([]);
    const sent = h.frames.length;
    yield* h.flow.partial(partial("相手", 9, 10, "終了後の途中結果"));
    yield* h.flow.final(final("自分", 11, 12, "終了後の確定結果"));
    yield* tick;
    expect(h.frames).toHaveLength(sent);
    expect(h.lines()).toEqual([]);
  }));

  it.effect("話者イベントだけで同じ字幕のidと文字を保ってラベルを更新する", () => Effect.gen(function* () {
    const h = yield* setup({ speakerOff: false });
    yield* h.flow.partial(partial("相手", 10, 12, "こんにちは"));
    yield* h.flow.speaker(segment(0, 10, 12, false));
    yield* h.flow.speaker(settled(12));
    yield* tick;
    const first = bubbles(h.frames)[0]!;
    expect(first).toMatchObject({ label: "仮", text: "こんにちは" });
    yield* h.flow.speaker(segment(1, 10, 12, false));
    yield* h.flow.speaker(settled(12));
    yield* tick;
    expect(bubbles(h.frames)).toHaveLength(1);
    expect(bubbles(h.frames)[0]).toMatchObject({ id: first.id, text: first.text, label: "仮" });
    expect(bubbles(h.frames)[0]!.speaker).not.toBe(first.speaker);
  }));

  it.effect("未反映の発言は字幕表の吹き出しを保ち、反映後に消える", () => Effect.gen(function* () {
    const h = yield* setup({ speakerOff: false, block: true });
    const wordTimes = [{ location: 0, length: 6, start: 10, end: 12 }, { location: 6, length: 5, start: 12, end: 14 }];
    yield* h.flow.speaker(segment(0, 10, 12));
    yield* h.flow.speaker(segment(1, 12, 14, false));
    yield* h.flow.speaker(settled(12));
    yield* h.flow.partial({ ...partial("相手", 10, 14, "こんにちは、ありがとう"), wordTimes });
    yield* tick;
    const shown = bubbles(h.frames).map((b) => [b.id, b.text]);
    expect(shown.map(([, text]) => text)).toEqual(["こんにちは、", "ありがとう"]);
    yield* h.flow.final({ ...final("相手", 10, 14, "こんにちは、ありがとう"), wordTimes });
    yield* h.flow.speaker(segment(0, 10, 14));
    yield* h.flow.speaker(settled(14));
    expect(bubbles(h.frames).map((b) => [b.id, b.text])).toEqual(shown);
    yield* h.flow.final(final("自分", 15, 16, "自分の確定した発言"));
    expect(bubbles(h.frames).filter((b) => b.track === "自分").map((b) => b.text)).toEqual(["自分の確定した発言"]);
    yield* Deferred.succeed(h.reply, undefined);
    yield* h.session.idle;
    yield* h.flow.captionsChanged;
    expect(bubbles(h.frames)).toEqual([]);
  }));

  it.effect("rawとwordsはログだけに残り、Remarkと差分入力と書き出しには載らない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.flow.final({ track: "相手", start: 1, end: 3, ...garbled });
    yield* h.session.idle;
    const expected = { id: "r1", track: "相手", start: 1, end: 3, text: garbled.text };
    expect(h.lines()[0]).toMatchObject({ raw: garbled.text, words: garbled.words });
    expect(h.lines()[0]!.remark).toEqual(expected);
    expect(h.fresh()).toEqual([expected]);
    const exported = yield* h.session.exportJson;
    expect(exported.root.children.flatMap((n) => n.evidence)).toEqual([expected]);
  }));

  it.effect("語のメタデータが無い発言のログには対応するキーが無い", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.flow.final(final("相手", 1, 2, "確定した発言"));
    yield* h.flow.partial(partial("相手", 5, 6, "途中の発言"));
    yield* h.flow.drain;
    expect(h.lines()).toHaveLength(2);
    for (const line of h.lines()) {
      expect(line).not.toHaveProperty("raw");
      expect(line).not.toHaveProperty("words");
      expect(line).not.toHaveProperty("wordTimes");
    }
  }));

  it.effect("wordTimesはログだけに残り、Remarkと差分入力と書き出しには載らない", () => Effect.gen(function* () {
    const h = yield* setup();
    const wordTimes = [{ location: 0, length: 5, start: 1, end: 3 }];
    yield* h.flow.final({ ...final("相手", 1, 3, "明日の会議"), wordTimes });
    yield* h.session.idle;
    const expected = { id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" };
    expect(h.lines()[0]!.wordTimes).toEqual(wordTimes);
    expect(h.lines()[0]!.remark).toEqual(expected);
    expect(h.fresh()).toEqual([expected]);
    expect((yield* h.session.exportJson).root.children.flatMap((n) => n.evidence)).toEqual([expected]);
  }));

  it.effect("全ての締め口で補正され、ログと差分更新と字幕へ届く", () => Effect.gen(function* () {
    const h = yield* setup({ block: true, speakerOff: false });
    yield* h.vocabulary.addUser(["港南店"]);
    yield* h.vocabulary.settled;
    yield* h.flow.speaker(segment(0, 1, 3));
    yield* h.flow.speaker(settled(3));
    yield* h.flow.final({ track: "相手", start: 1, end: 3, ...garbled });
    expect(bubbles(h.frames).map((b) => b.text)).toEqual(["港南店に行きます"]);
    yield* h.flow.partial({ ...partial("相手", 5, 6, garbled.text), words: garbled.words });
    yield* h.flow.partial(partial("自分", 0, 7, "時計を進める"));
    yield* h.flow.speaker(speakerOff);
    yield* h.flow.partial({ ...partial("相手", 20, 21, garbled.text), words: garbled.words });
    yield* h.flow.drain;
    expect(h.lines().map((l) => [l.remark.id, l.remark.text, l.raw, l.words])).toEqual([1, 2, 3].map((n) => [`r${n}`, "港南店に行きます", garbled.text, garbled.words]));
    expect(bubbles(h.frames).filter((b) => b.track === "相手").map((b) => b.text)).toEqual(["港南店に行きます", "港南店に行きます", "港南店に行きます"]);
    yield* Deferred.succeed(h.reply, undefined);
    yield* h.session.idle;
    expect(h.fresh().map((r) => r.text)).toEqual(["港南店に行きます", "港南店に行きます", "港南店に行きます"]);
  }));

  it.effect("補正で長さが変わっても後ろの語は同じ吹き出しに残る", () => Effect.gen(function* () {
    const h = yield* setup({ speakerOff: false, block: true });
    yield* h.vocabulary.addUser(["Zendesk"]);
    yield* h.vocabulary.settled;
    const raw = utterance(["はい", "hai"], ["、", ""], ["全", "zen"], ["デスク", "desuku"], ["を", "wo"]);
    const wordTimes = [{ location: 0, length: 3, start: 10, end: 12 }, { location: 3, length: 4, start: 12, end: 14 }, { location: 7, length: 1, start: 14, end: 15 }];
    yield* h.flow.speaker(segment(0, 10, 12));
    yield* h.flow.speaker(segment(1, 12, 14));
    yield* h.flow.speaker(segment(2, 14, 15, false));
    yield* h.flow.speaker(settled(14));
    yield* h.flow.partial({ ...partial("相手", 10, 15, raw.text), wordTimes });
    yield* tick;
    const shown = bubbles(h.frames).map((b) => b.id);
    expect(bubbles(h.frames).map((b) => b.text)).toEqual(["はい、", "全デスク", "を"]);
    yield* h.flow.final({ track: "相手", start: 10, end: 15, ...raw, wordTimes });
    yield* h.flow.speaker(segment(0, 10, 15));
    yield* h.flow.speaker(settled(15));
    expect(bubbles(h.frames).map((b) => [b.id, b.text])).toEqual([[shown[0], "はい、"], [shown[1], "Zendesk"], [shown[2], "を"]]);
  }));

  it.effect("途中結果の字幕は語彙で補正しない", () => Effect.gen(function* () {
    const h = yield* setup();
    yield* h.vocabulary.addUser(["港南店"]);
    yield* h.vocabulary.settled;
    yield* h.flow.partial({ ...partial("相手", 5, 6, garbled.text), words: garbled.words });
    expect(bubbles(h.frames).map((b) => b.text)).toEqual([garbled.text]);
  }));

  it.effect("発言の話者はログと差分入力で一致し、話者なしではキーが無い", () => Effect.gen(function* () {
    const h = yield* setup({ speakerOff: false });
    yield* h.flow.final(final("相手", 10, 12, "来週に開催します"));
    expect(h.lines()).toEqual([]);
    yield* h.flow.speaker(segment(2, 10, 12));
    yield* h.flow.speaker(settled(12));
    yield* h.session.idle;
    const expected = { id: "r1", track: "相手", start: 10, end: 12, text: "来週に開催します", speaker: "相手 A" };
    expect(h.lines().map((l) => l.remark)).toEqual([expected]);
    expect(h.fresh()).toEqual([expected]);
    expect(h.flow.labels()).toEqual(["相手 A"]);
    yield* h.flow.speaker(speakerOff);
    yield* h.flow.final(final("相手", 20, 22, "話者のない発言"));
    yield* h.session.idle;
    expect(h.lines()[1]!.remark).not.toHaveProperty("speaker");
    expect(h.fresh()[1]).not.toHaveProperty("speaker");
  }));

  it.effect("renumberedで保留の発言を話者なしで出し、新世代の区間と混ぜない", () => Effect.gen(function* () {
    const h = yield* setup({ speakerOff: false });
    yield* h.flow.speaker(segment(0, 10, 13));
    yield* h.flow.speaker({ type: "speaker-centroid", track: "相手", slot: 0, centroid: [1, 0, 0] });
    yield* h.flow.speaker(settled(13));
    yield* h.flow.final(final("相手", 10, 13, "ひとつめ"));
    yield* h.flow.final(final("相手", 20, 22, "揃う前に起動し直し"));
    expect(h.lines()).toHaveLength(1);
    yield* h.flow.renumbered;
    expect(h.lines().map((l) => [l.remark.id, l.remark.speaker, l.remark.text])).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", undefined, "揃う前に起動し直し"]]);
    expect(h.lines()[1]!.remark).not.toHaveProperty("speaker");
    yield* h.flow.speaker({ type: "speaker-centroid", track: "相手", slot: 0, centroid: [0.95, Math.sqrt(1 - 0.95 ** 2), 0] });
    yield* h.flow.speaker(segment(0, 30, 33));
    yield* h.flow.speaker(settled(33));
    yield* h.flow.final(final("相手", 30, 33, "新しい世代"));
    yield* h.session.idle;
    expect(h.lines().map((l) => [l.remark.id, l.remark.speaker])).toEqual([["r1", "相手 A"], ["r2", undefined], ["r3", "相手 A"]]);
    expect(h.fresh()).toEqual(h.lines().map((l) => l.remark));
  }));
});
