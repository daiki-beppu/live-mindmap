import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect";
import { buildPrompt } from "../src/claudePrompt.ts";
import { DiffUpdater, restoreState, type DiffInput, type InferredSpeakerName, type SpeakerNamesFrame } from "../src/core/index.ts";
import { localUpdaterLayer, type LocalModel } from "../src/localDiffUpdater.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #1026: 話者の名前（GLOSSARY「話者の名前」）。実物の SessionSinks（話者のラベルを振る本物の仕組み・名前の表・log.jsonl）に、
// ヘルパーの speaker と発言を流し、偽の AI が受け取る入力を、本物の buildPrompt に通して「AI に渡る行」を見る。
// 想定する契約:
// - sink.nameSpeaker({ label, name }) は手入力の名前を付ける。ラベルは発言に振ったもの（自分・まだ振っていないラベル・「相手」は型付きの失敗）。名前が空でも失敗
// - 付いた名前は speakerNames のフレーム { type: "speaker-names", names: [{ label, name }] } で（全体を）送る。開いた直後に空の表を 1 回送る
// - log.jsonl に { at, type: "speaker-name", label, name, source: "手入力" } が 1 行増える。表が変わらないときは行もフレームも増えない
// - 差分更新の入力 DiffInput.speakerNames（ラベル → 名前）は呼ぶたびにそのときの表になる

const fileIo = trackedFileSystem();
const { settle, settleUntil } = fileIo;
const sinksLayer = (updaterLayer: Layer.Layer<DiffUpdater>) =>
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer }) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer })));

const segment = (slot: number, start: number, end: number) => ({ type: "speaker", track: "相手", start, end, slot, final: true }) as const;
const settledAt = (to: number) => ({ type: "speaker-settled", track: "相手", to }) as const;
const mixed = (slot: number, start: number) => ({ type: "speaker-mixed", track: "相手", slot, start }) as const;
const SPEAKER_OFF = { type: "speaker-off", start: 0, reason: "モデルなし" } as const;
const logEvents = (dir: string) => readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const nameLines = (dir: string) => logEvents(dir).filter((e) => e.type === "speaker-name");

// 呼ばれた時点の入力から作ったプロンプトの「発言の行」（r1 [00:10] …）を記録する偽の AI。後から入力が書き換わっても記録は変わらない
const recordingAi = () => {
  const prompts: string[][] = [];
  const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({ update: (input: DiffInput) => Effect.sync(() => {
    prompts.push(buildPrompt(input).split("\n").filter((line) => /^r\d+ /.test(line)));
    return { ops: [] };
  }) }));
  return { prompts, updaterLayer };
};

// Issue #1027: n 回目の呼び出しに、台本の n 番目の names を返す偽の AI。呼ばれた入力の speakerNames（ラベル → 名前）も、呼ばれた時点のコピーで記録する
const namingAi = (...script: (InferredSpeakerName[] | undefined)[]) => {
  const prompts: string[][] = [];
  const tables: Array<Record<string, string> | undefined> = [];
  const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({ update: (input: DiffInput) => Effect.sync(() => {
    const n = prompts.length;
    prompts.push(buildPrompt(input).split("\n").filter((line) => /^r\d+ /.test(line)));
    tables.push(input.speakerNames === undefined ? undefined : Object.fromEntries(input.speakerNames));
    const names = script[n];
    return names ? { ops: [], names } : { ops: [] };
  }) }));
  return { prompts, tables, updaterLayer };
};
const claim = (label: string, name: string, evidence: string, basis: InferredSpeakerName["basis"] = "名乗り"): InferredSpeakerName => ({ label, name, evidence, basis });

// 名前を付けられなかった（型付きの失敗。defect や中断ではない）
const rejected = <A, E>(effect: Effect.Effect<A, E>) => Effect.exit(effect).pipe(Effect.map((exit) => Exit.isFailure(exit) && Cause.hasFails(exit.cause) && !Cause.hasDies(exit.cause)));

const openSession = Effect.fnUntraced(function* (updaterLayer: Layer.Layer<DiffUpdater>, options: { speakerOff?: boolean } = {}) {
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "speaker-names-it-"))), (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))));
  const frames: SpeakerNamesFrame[] = [];
  const sink = yield* sinks.open({ updaterLayer: (yield* sinks.prepare({ kind: "single", model: defaultClaude })).layer, model: defaultClaude, dir, title: "週次",
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
  it.effect("名前を手で付けると、log.jsonl に名前・時刻・出どころ（手入力）が残り、以後の差分更新に 相手 B（田中）: 本文 が渡る。それまでの発言（直前の発言）の行も名前になる", () => {
    const { prompts, updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A
      yield* say(2, 6, 20); // 相手 B

      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });
      yield* say(3, 6, 30); // 名前を付けた後の、相手 B の発言
      yield* settle;

      // 名前を付ける前の呼び出しには、名前が混ざらない
      expect(prompts[0]).toEqual(["r1 [00:10] 相手 A: 発言1です"]);
      expect(prompts[1]).toEqual(["r1 [00:10] 相手 A: 発言1です", "r2 [00:20] 相手 B: 発言2です"]);
      // 付けた後の呼び出し: 新しい発言も、直前の発言（r2）も名前つき。名前の無い 相手 A はそのまま
      expect(prompts[2]).toEqual([
        "r1 [00:10] 相手 A: 発言1です",
        "r2 [00:20] 相手 B（田中）: 発言2です",
        "r3 [00:30] 相手 B（田中）: 発言3です",
      ]);

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
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("同じ名前を 2 つのラベルに付けても、ラベルは別のまま（表は 2 件、ログは 2 行、プロンプトは 相手 A（田中） と 相手 B（田中））", () => {
    const { prompts, updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);

      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });
      yield* say(3, 5, 30);
      yield* settle;

      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 A", name: "田中" }, { label: "相手 B", name: "田中" }] });
      expect(nameLines(dir).map((e) => [e.label, e.name])).toEqual([["相手 A", "田中"], ["相手 B", "田中"]]);
      expect(prompts[2]).toEqual([
        "r1 [00:10] 相手 A（田中）: 発言1です",
        "r2 [00:20] 相手 B（田中）: 発言2です",
        "r3 [00:30] 相手 A（田中）: 発言3です",
      ]);
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark.speaker)).toEqual(["相手 A", "相手 B", "相手 A"]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("手入力の名前は手入力で替わる。替えた後の呼び出しは新しい名前になり、ログとフレームも増える。同じ名前の入れ直しはログもフレームも重ねない", () => {
    const { prompts, updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 6, 10); // 相手 A
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      expect(nameLines(dir)).toHaveLength(1);
      expect(frames).toHaveLength(2);

      yield* sink.nameSpeaker({ label: "相手 A", name: "鈴木" });
      yield* say(2, 6, 20);
      yield* settle;

      expect(nameLines(dir).map((e) => e.name)).toEqual(["田中", "鈴木"]);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 A", name: "鈴木" }] });
      expect(prompts[1]).toEqual(["r1 [00:10] 相手 A（鈴木）: 発言1です", "r2 [00:20] 相手 A（鈴木）: 発言2です"]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("同時に別のラベルへ名前を付けても、どちらも失われない（表・ログ・最後のフレームに両方ある）", () => {
    const { updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);

      yield* Effect.all([sink.nameSpeaker({ label: "相手 A", name: "田中" }), sink.nameSpeaker({ label: "相手 B", name: "鈴木" })], { concurrency: "unbounded" });
      yield* settle;

      expect(nameLines(dir).map((e) => [e.label, e.name]).sort()).toEqual([["相手 A", "田中"], ["相手 B", "鈴木"]]);
      const last = frames.at(-1)!;
      expect([...last.names].sort((a, b) => a.label.localeCompare(b.label))).toEqual([{ label: "相手 A", name: "田中" }, { label: "相手 B", name: "鈴木" }]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("名前を付けられないもの（自分・まだ振っていないラベル・ラベルの無い「相手」・空の名前）は失敗し、表・ログ・フレームに何も出ない。その後も付けられる", () => {
    const { prompts, updaterLayer } = recordingAi();
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

      // 失敗の後も壊れていない: 振ったラベルには付けられ、まだ振っていなかったラベルは振られた後なら付けられる
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      yield* say(2, 6, 20); // 相手 B が振られる
      yield* sink.nameSpeaker({ label: "相手 B", name: "鈴木" });
      yield* say(3, 6, 30);
      yield* settle;
      expect(prompts[2]).toEqual([
        "r1 [00:10] 相手 A（田中）: 発言1です",
        "r2 [00:20] 相手 B（鈴木）: 発言2です",
        "r3 [00:30] 相手 B（鈴木）: 発言3です",
      ]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("自分の発言の行・話者なしの相手の行には名前が付かない（名前が付くのは、ラベルのある相手の発言だけ）", () => {
    const { prompts, updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, say, sayUnlabeled } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sayUnlabeled(2, 20); // 話者なし
      yield* sink.final({ track: "自分", start: 30, end: 32, text: "発言3です" });
      yield* settleUntil(() => prompts.length === 3);
      yield* settle;

      expect(prompts[2]).toEqual([
        "r1 [00:10] 相手 A（田中）: 発言1です",
        "r2 [00:20] 相手: 発言2です",
        "r3 [00:30] 自分: 発言3です",
      ]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("namesNeverRemoved: 混入でラベルを戻しても、起動し直しても、付いた名前は外れない（以後の呼び出しの直前の発言の行も名前つき）", () => {
    const { prompts, updaterLayer } = recordingAi();
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

      expect(prompts[2]).toEqual([
        "r1 [00:10] 相手 A: 発言1です",
        "r2 [00:20] 相手 B（田中）: 発言2です",
        "r3 [00:30] 相手: 発言3です",
      ]);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("名前はセッションの中だけ。新しく開いたセッションは空の表で始まり、前のセッションの名前を持ち越さない", () => {
    const { prompts, updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const first = yield* openSession(updaterLayer);
      yield* first.say(1, 5, 10);
      yield* first.sink.nameSpeaker({ label: "相手 A", name: "田中" });
      expect(first.frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] });

      const second = yield* openSession(updaterLayer);
      expect(second.frames).toEqual([{ type: "speaker-names", names: [] }]);
      yield* second.say(1, 5, 10);
      yield* settle;

      expect(prompts.at(-1)).toEqual(["r1 [00:10] 相手 A: 発言1です"]);
      expect(nameLines(second.dir)).toEqual([]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("speaker-name の行を含む log.jsonl は、restoreState がこれまでどおり読める（行が無いときと同じマップ・発言になる）", () => {
    const { updaterLayer } = recordingAi();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      yield* sink.flush;
      yield* settle;

      const events = logEvents(dir);
      expect(events.some((e) => e.type === "speaker-name")).toBe(true);
      const withName = yield* restoreState(events);
      const withoutName = yield* restoreState(events.filter((e) => e.type !== "speaker-name"));
      expect(withName).toEqual(withoutName);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });
});

// ログの書き込みを、合図を出している間だけ最初の 1 回止める FileSystem。止まった時点で entered を完了させ、release が完了するまで元の処理に渡さない
// （元の処理より前で待つので、trackedFileSystem の inFlight は増えず、settle は止まらない）
const gatedFileSystem = (gate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void>; armed: boolean }) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new Proxy(fs, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "writeFileString" || typeof value !== "function") return value;
          return (path: string, ...rest: unknown[]) => {
            const write = value.apply(target, [path, ...rest]) as Effect.Effect<void, unknown>;
            if (!gate.armed || !path.endsWith("log.jsonl")) return write;
            gate.armed = false;
            return Effect.andThen(Effect.andThen(Deferred.succeed(gate.entered, undefined), Deferred.await(gate.release)), write);
          };
        },
      });
    }),
  ).pipe(Layer.provide(fileIo.layer));

describe("名前の更新は、要求の中断から保護される", () => {
  it.effect("別のログ書き込みがログのロックを持つ間に要求が中断されても、表・ログ・フレームはすべて更新される。同じ名前の再送は 3 つが一致したまま成功する", () => {
    const { prompts, updaterLayer } = recordingAi();
    const gate = { entered: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>(), armed: false };
    const layer = SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer }) }).pipe(Layer.provide(fakeExportServices({ fileSystem: gatedFileSystem(gate) })));
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A

      // 別の書き込み（済んだ時刻の speaker-settled）がログのロックを持ったまま止まる
      gate.armed = true;
      const holder = yield* Effect.forkChild(sink.speaker(settledAt(12)));
      yield* Deferred.await(gate.entered);

      const request = yield* Effect.forkChild(sink.nameSpeaker({ label: "相手 A", name: "田中" }), { startImmediately: true });
      expect(request.pollUnsafe()).toBeUndefined();
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(request));
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(interrupting);
      yield* settle;

      yield* say(2, 5, 20);
      yield* settle;
      const named = [{ label: "相手 A", name: "田中" }];
      expect(nameLines(dir).map((e) => [e.label, e.name])).toEqual([["相手 A", "田中"]]);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: named });
      expect(prompts.at(-1)).toEqual(["r1 [00:10] 相手 A（田中）: 発言1です", "r2 [00:20] 相手 A（田中）: 発言2です"]);

      // 中断の後の再送は成功し、3 つは一致したまま増えない
      const framesBefore = frames.length;
      yield* sink.nameSpeaker({ label: "相手 A", name: "田中" });
      expect(nameLines(dir)).toHaveLength(1);
      expect(frames).toHaveLength(framesBefore);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: named });
    })).pipe(Effect.provide(layer));
  });
});

// Issue #1027: 名乗り・呼びかけへの応答から AI が推定した名前（出どころ「推定」）。偽の AI が names を返し、サーバーが根拠の発言を確かめる。
// 発言 n は r{n}。say(n, slot, start) は slot の相手の n 番目の発言（相手 A = slot 5、相手 B = slot 6）
describe("話者の名前の推定（実物の SessionSinks + 偽の AI が names を返す）", () => {
  it.effect("名乗りの発言を根拠にした名前が付き、log.jsonl に at・出どころ（推定）で残る。同じ sink の上で、付く前の入力は名前なし、付いた後のフレーム・入力・直前の発言の行が名前になる", () => {
    const { prompts, tables, updaterLayer } = namingAi(undefined, [claim("相手 B", "田中", "r2")]);
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A
      expect(frames).toEqual([{ type: "speaker-names", names: [] }]);

      yield* say(2, 6, 20); // 相手 B の名乗り。この回の応答が名前を返す
      yield* settleUntil(() => frames.length === 2);
      yield* say(3, 6, 30);
      yield* settle;

      // 付く前の 2 回には名前が混ざらない。付いた後（3 回目）は、直前の発言の行（r2）も名前つき
      expect(tables.slice(0, 2)).toEqual([undefined, undefined]);
      expect(prompts[2]).toEqual([
        "r1 [00:10] 相手 A: 発言1です",
        "r2 [00:20] 相手 B（田中）: 発言2です",
        "r3 [00:30] 相手 B（田中）: 発言3です",
      ]);
      expect(tables[2]).toEqual({ "相手 B": "田中" });
      expect(frames).toEqual([
        { type: "speaker-names", names: [] },
        { type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] },
      ]);
      const lines = nameLines(dir);
      expect(lines).toHaveLength(1);
      const { at, ...rest } = lines[0];
      expect(Number.isNaN(Date.parse(at))).toBe(false);
      expect(rest).toEqual({ type: "speaker-name", label: "相手 B", name: "田中", source: "推定" });
      // 名前を付けても発言の話者はラベルのまま。名前の行は、根拠を消費した diff の行の後ろにある
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark.speaker)).toEqual(["相手 A", "相手 B", "相手 B"]);
      const types = logEvents(dir).map((e) => e.type);
      expect(types.indexOf("speaker-name")).toBeGreaterThan(types.indexOf("diff", types.indexOf("diff") + 1));
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("推定の名前を含む log.jsonl は、restoreState がこれまでどおり読める（行が無いときと同じマップ・発言になる）", () => {
    const { updaterLayer } = namingAi([claim("相手 A", "田中", "r1")]);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* sink.flush;
      yield* settle;

      const events = logEvents(dir);
      expect(events.some((e) => e.type === "speaker-name")).toBe(true);
      expect(yield* restoreState(events)).toEqual(yield* restoreState(events.filter((e) => e.type !== "speaker-name")));
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("根拠の発言が無い名前・根拠の発言の話者がラベルと合わない名前は捨てられる（行もフレームも増えず、入力にも名前が載らない）", () => {
    const { prompts, tables, updaterLayer } = namingAi(undefined, [claim("相手 B", "田中", "r99"), claim("相手 B", "鈴木", "r1")]);
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10); // 相手 A（r1）
      yield* say(2, 6, 20); // 相手 B。応答は、存在しない根拠の名前と、相手 A の発言を根拠にした「相手 B」の名前
      yield* say(3, 6, 30);
      yield* settle;

      expect(nameLines(dir)).toEqual([]);
      expect(frames).toEqual([{ type: "speaker-names", names: [] }]);
      expect(tables).toEqual([undefined, undefined, undefined]);
      expect(prompts[2]).toEqual(["r1 [00:10] 相手 A: 発言1です", "r2 [00:20] 相手 B: 発言2です", "r3 [00:30] 相手 B: 発言3です"]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("自分には名前を付けない。自分の発言を根拠にした名前も、ラベル「自分」の名前も捨てられる", () => {
    const { tables, updaterLayer } = namingAi(undefined, undefined, [claim("自分", "田中", "r2"), claim("相手 A", "田中", "r2")]);
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say, sink } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* sink.final({ track: "自分", start: 20, end: 22, text: "発言2です" });
      yield* settleUntil(() => tables.length === 2);
      yield* sink.final({ track: "自分", start: 30, end: 32, text: "発言3です" });
      yield* settleUntil(() => tables.length === 3);
      yield* settle;

      expect(nameLines(dir)).toEqual([]);
      expect(frames).toEqual([{ type: "speaker-names", names: [] }]);
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("手入力の名前は、AI が名乗りを根拠に別の名前を出しても変わらない（表・ログ・フレーム・次の入力）", () => {
    const { prompts, tables, updaterLayer } = namingAi(undefined, undefined, [claim("相手 B", "鈴木", "r2")]);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);
      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });
      const framesBefore = frames.length;

      yield* say(3, 6, 30); // この回の応答が、相手 B=鈴木 を返す
      yield* say(4, 6, 40);
      yield* settle;

      expect(nameLines(dir).map((e) => [e.label, e.name, e.source])).toEqual([["相手 B", "田中", "手入力"]]);
      expect(frames).toHaveLength(framesBefore);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] });
      expect(tables[3]).toEqual({ "相手 B": "田中" });
      expect(prompts[3]!.at(-1)).toBe("r4 [00:40] 相手 B（田中）: 発言4です");
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("AI の名前は、呼びかけへの応答を根拠にした別の名前では付け替わらず、名乗りを根拠にした別の名前では付け替わる（出どころは推定のまま、行とフレームが増える）", () => {
    const { prompts, tables, updaterLayer } = namingAi(
      undefined,
      [claim("相手 B", "田中", "r2", "呼びかけへの応答")], // 呼びかけへの応答で最初の名前が付く
      [claim("相手 B", "鈴木", "r3", "呼びかけへの応答")], // 付け替えない
      [claim("相手 B", "佐藤", "r4", "名乗り")], // 名乗りなので付け替える
    );
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);
      yield* say(3, 6, 30);
      yield* settle;
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 B", name: "田中" }] }); // r3 の応答（鈴木）は付け替えなかった
      expect(nameLines(dir)).toHaveLength(1);
      yield* say(4, 6, 40);
      yield* say(5, 6, 50);
      yield* settle;

      expect(nameLines(dir).map((e) => [e.label, e.name, e.source])).toEqual([["相手 B", "田中", "推定"], ["相手 B", "佐藤", "推定"]]);
      expect(frames.at(-1)).toEqual({ type: "speaker-names", names: [{ label: "相手 B", name: "佐藤" }] });
      expect(tables.slice(2)).toEqual([{ "相手 B": "田中" }, { "相手 B": "田中" }, { "相手 B": "佐藤" }]);
      expect(prompts[4]!.at(-1)).toBe("r5 [00:50] 相手 B（佐藤）: 発言5です");
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("手入力は、AI が付けた名前を替える。その後は AI の名乗りでも戻らない", () => {
    const { tables, updaterLayer } = namingAi(undefined, [claim("相手 B", "たなか", "r2")], undefined, [claim("相手 B", "佐藤", "r4")]);
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);
      yield* settle;
      expect(nameLines(dir).map((e) => [e.name, e.source])).toEqual([["たなか", "推定"]]);

      yield* sink.nameSpeaker({ label: "相手 B", name: "田中" });
      yield* say(3, 6, 30);
      yield* say(4, 6, 40);
      yield* say(5, 6, 50);
      yield* settle;

      expect(nameLines(dir).map((e) => [e.name, e.source])).toEqual([["たなか", "推定"], ["田中", "手入力"]]);
      expect(tables.at(-1)).toEqual({ "相手 B": "田中" });
    })).pipe(Effect.provide(sinksLayer(updaterLayer)));
  });

  it.effect("1 回の応答の複数の名前は、別のラベルならすべて付く", () => {
    const { updaterLayer } = namingAi(undefined, [claim("相手 A", "山田", "r1"), claim("相手 B", "田中", "r2")]);
    return Effect.scoped(Effect.gen(function* () {
      const { dir, frames, say } = yield* openSession(updaterLayer);
      yield* say(1, 5, 10);
      yield* say(2, 6, 20);
      yield* settle;

      expect(nameLines(dir).map((e) => [e.label, e.name, e.source])).toEqual([["相手 A", "山田", "推定"], ["相手 B", "田中", "推定"]]);
      expect([...frames.at(-1)!.names].sort((a, b) => a.label.localeCompare(b.label))).toEqual([{ label: "相手 A", name: "山田" }, { label: "相手 B", name: "田中" }]);
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
