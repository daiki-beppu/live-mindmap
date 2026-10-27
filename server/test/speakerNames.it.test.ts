import { TestUpdaterLayer } from "./fixtures/sessionLayers.ts";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { DiffUpdater, type InferredSpeakerName, type SpeakerNamesFrame } from "../src/core/index.ts";
import { localUpdaterLayer, type LocalModel } from "../src/localDiffUpdater.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// SessionSinks の受付、名前ログの保存、frame と書き出しへの接続を確かめる。

const fileIo = trackedFileSystem();
const { settle, settleUntil } = fileIo;
const sinksLayer = (updaterLayer: Layer.Layer<DiffUpdater>) =>
  Layer.merge(SessionSinks.layer, Layer.succeed(TestUpdaterLayer, updaterLayer)).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer })));

const segment = (slot: number, start: number, end: number) => ({ type: "speaker", track: "相手", start, end, slot, final: true }) as const;
const settledAt = (to: number) => ({ type: "speaker-settled", track: "相手", to }) as const;
const mixed = (slot: number, start: number) => ({ type: "speaker-mixed", track: "相手", slot, start }) as const;
const SPEAKER_OFF = { type: "speaker-off", start: 0, reason: "モデルなし" } as const;
const logEvents = (dir: string) => readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const nameLines = (dir: string) => logEvents(dir).filter((e) => e.type === "speaker-name");

const recordingAi = () => ({
  updaterLayer: Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) })),
});

const namingAi = (...script: (InferredSpeakerName[] | undefined)[]) => {
  let n = 0;
  const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.sync(() => {
    const names = script[n++];
    return names ? { ops: [], names } : { ops: [] };
  }) }));
  return { updaterLayer };
};
const claim = (label: string, name: string, evidence: string, basis: InferredSpeakerName["basis"] = "名乗り"): InferredSpeakerName => ({ label, name, evidence, basis });

// 名前を付けられなかった（型付きの失敗。defect や中断ではない）
const rejected = <A, E>(effect: Effect.Effect<A, E>) => Effect.exit(effect).pipe(Effect.map((exit) => Exit.isFailure(exit) && Cause.hasFails(exit.cause) && !Cause.hasDies(exit.cause)));

const openSession = Effect.fnUntraced(function* (updaterLayer: Layer.Layer<DiffUpdater>, options: { speakerOff?: boolean } = {}) {
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "speaker-names-it-"))), (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))));
  const frames: SpeakerNamesFrame[] = [];
  const sink = yield* sinks.open({ updaterLayer: (yield* TestUpdaterLayer), model: defaultClaude, dir, title: "週次",
    send: (frame) => Effect.sync(() => { if ("type" in frame && frame.type === "speaker-names") frames.push(frame); }) });
  if (options.speakerOff) yield* sink.speaker(SPEAKER_OFF);
  const diffs = () => logEvents(dir).filter((e) => e.type === "diff").length;
  // slot の相手が start から 2 秒話し、n 番目の発言（発言 n です）になる。差分更新が n 回目まで済むのを待つ
  const say = (n: number, slot: number, start: number) => Effect.gen(function* () {
    yield* sink.speaker(segment(slot, start, start + 2));
    yield* sink.speaker(settledAt(start + 2));
    yield* sink.final({ track: "相手", start, end: start + 2, text: `発言${n}です` });
    yield* settleUntil(() => diffs() === n);
  });
  // 話者の判定を終えた（speaker-off）後の、話者なしの発言
  const sayUnlabeled = (n: number, start: number) => Effect.gen(function* () {
    yield* sink.final({ track: "相手", start, end: start + 2, text: `発言${n}です` });
    yield* settleUntil(() => diffs() === n);
  });
  return { sink, dir, frames, say, sayUnlabeled };
});

describe("話者の名前（実物の SessionSinks + 偽の AI）", () => {
  it.effect("地図なしの録画セッションも、発言のラベルへの手入力をログとframeへ繋ぐ", () => {
    const { updaterLayer } = recordingAi();
    return Effect.gen(function* () {
      const sinks = yield* SessionSinks;
      const root = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "speaker-names-no-map-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })));
      const dir = yield* sinks.createDir(root);
      const frames: SpeakerNamesFrame[] = [];
      const sink = yield* sinks.openRecorded({ noMap: true, dir, title: "地図なし",
        send: (frame) => Effect.sync(() => { if (frame.type === "speaker-names") frames.push(frame); }),
        recorded: { realtime: false, progress: () => Effect.void, paused: () => Effect.void },
      });
      yield* sink.speaker(segment(5, 0, 2));
      yield* sink.speaker(settledAt(2));
      yield* sink.final({ track: "相手", start: 0, end: 2, text: "発言です" });
      yield* sink.drain;
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      expect(nameLines(dir).map(({ label, name, source }) => ({ label, name, source }))).toEqual([
        { label: "相手 A", name: "田中", source: "手入力" },
      ]);
      expect(frames).toEqual([{ type: "speaker-names", names: [] }, { type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] }]);
    }).pipe(Effect.scoped, Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("手入力を名前ログ・frame・ライブの書き出しへ渡す", () => {
    const { updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A
      yield* say(2, 6, 20); // 相手 B

      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });
      yield* say(3, 6, 30); // 名前を付けた後の、相手 B の発言
      yield* settle;

      // log.jsonl: 名前・付いた時刻（at）・出どころ。ラベルを残したまま 1 行だけ
      const lines = nameLines(dir);
      expect(lines).toHaveLength(1);
      const { at, ...rest } = lines[0];
      expect(Number.isNaN(Date.parse(at))).toBe(false);
      expect(rest).toEqual({ type: "speaker-name", label: "相手 B", name: "田中", source: "手入力" });
      // 発言は変わらない: ログの発言の話者はラベルのまま
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark.speaker)).toEqual(["相手 A", "相手 B", "相手 B"]);

      // 画面へ: 開いた直後の空の表と、付いた後の表
      expect(frames).toEqual([
        { type: "speaker-names", names: [] },
        { type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] },
      ]);
      yield* sink.exports;
      expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).speakerNames).toEqual({ "相手 B": "田中" });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("名前を付けられないもの（自分・まだ振っていないラベル・ラベルの無い「相手」・空の名前）は失敗し、表・ログ・フレームに何も出ない。その後も付けられる", () => {
    const { updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A だけを振った

      for (const label of ["自分", "相手 B", "相手", "仮", ""]) {
        expect([label, yield* rejected(sink.nameSpeaker({ label, name: "田中" }))]).toEqual([label, true]);
      }
      for (const name of ["", "  ", "　"]) {
        expect([name, yield* rejected(sink.nameSpeaker({ label: "相手 A", name }))]).toEqual([name, true]);
      }
      expect(nameLines(dir)).toEqual([]);
      expect(frames).toEqual([{ type: "speaker-names", names: [] }]);

      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      yield* say(2, 6, 20); // 相手 B が振られる
      yield* sink.nameSpeaker({ label: "相手 B", name: "鈴木" });
      yield* say(3, 6, 30);
      yield* settle;
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 A", name: "田中" }, { label: "相手 B", name: "鈴木" }] });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("namesNeverRemoved: 混入でラベルを戻しても、起動し直しても、付いた名前は外れない", () => {
    const { updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, frames, say, sayUnlabeled } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A
      yield* say(2, 6, 20); // 相手 B
      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });

      yield* sink.speaker(mixed(6, 25)); // 相手 B の枠に別の人が混ざった。ラベルを戻す
      yield* sink.speakersRenumbered; // ヘルパーを起動し直した
      yield* sink.speaker(SPEAKER_OFF);
      yield* sayUnlabeled(3, 30);
      yield* settle;

      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("名前はセッションの中だけ。新しく開いたセッションは空の表で始まり、前のセッションの名前を持ち越さない", () => {
    const { updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const first = yield* openSession(updaterLayer);
      yield* first.say(1, 5, 10);
      yield* first.sink.nameSpeaker({ label: "相手 A", name: "田中" });
      expect(first.frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] });

      const second = yield* openSession(updaterLayer);
      expect(second.frames).toEqual([{ type: "speaker-names", names: [] }]);
      yield* second.say(1, 5, 10);
      yield* settle;

      expect(nameLines(second.dir)).toEqual([]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });
});

describe("話者の名前の推定（実物の SessionSinks + 偽の AI が names を返す）", () => {
  it.effect("推定名が変わると現在の表を送り、同じ名前では frame を重ねない", () => {
    const { updaterLayer } = namingAi([claim("相手 A", "田中", "r1")], [claim("相手 A", "田中", "r1")]);
    return Effect.scoped(Effect.gen(function* () {
      const { frames, say } = yield* openSession(updaterLayer);
      expect(frames).toEqual([{ type: "speaker-names", names: [] }]);
      yield* say(1, 5, 10);
      yield* say(2, 5, 20);
      yield* settle;
      expect(frames).toEqual([
        { type: "speaker-names", names: [] },
        { type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] },
      ]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });
});

// Issue #1027: 分類経路（ChatGPT・OpenAI互換・Apple が通る localUpdaterLayer）も、分類結果の名前を DiffOutput.names として core へ渡す
describe("話者の名前の推定（実物の SessionSinks + localUpdaterLayer + 偽の classify）", () => {
  // n 回目の分類に、台本の n 番目の名前を返す偽の classify
  const classifyingAi = (...script: InferredSpeakerName[][]) => {
    let n = 0;
    const classify: LocalModel["classify"] = () => Effect.sync(() => ({ 議題: { id: "新しい議題", 題: "" }, 文: [{ 種類: "なし" as const }], 済み: "なし", 名前: script[n++] ?? [] }));
    return localUpdaterLayer({ classify, katakana: () => Effect.succeed([]) });
  };

  it.effect("分類結果の名前が core の確認を通れば、出どころ（推定）で log.jsonl に残り、名前のフレームが出る", () => {
    const updaterLayer = classifyingAi([], [claim("相手 B", "田中", "r2")]);
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A
      yield* say(2, 6, 20); // 相手 B の名乗り
      yield* settleUntil(() => frames.length === 2);

      expect(nameLines(dir).map(({ at: _at, ...rest }) => rest)).toEqual([{ type: "speaker-name", label: "相手 B", name: "田中", source: "推定" }]);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("根拠の発言が無い名前・話者がラベルと合わない名前は捨てられる（行もフレームも増えない）", () => {
    const updaterLayer = classifyingAi([], [claim("相手 B", "田中", "r99"), claim("相手 B", "鈴木", "r1")]);
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);
      yield* settle;

      expect(nameLines(dir)).toEqual([]);
      expect(frames).toEqual([{ type: "speaker-names", names: [] }]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });
});
