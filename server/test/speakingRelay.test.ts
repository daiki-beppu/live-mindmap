import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { type DiffInput, type DiffOutput, type Op, type Remark, type Session, type SpeakingFrame, type Track } from "../src/core/index.ts";
import { createSessionDir, openRecordedSession } from "../src/sessionFiles.ts";
import { createSpeakingRelay, SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { promiseOrDie } from "./fixtures/promiseOrDie.ts";
import { updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

// いま話している文字（SpeakingFrame）をブラウザへ送る層。段 3（Issue #240）で、setTimeout/clearTimeout・
// Date.now() 直読みを Effect の Clock と Effect.sleep のファイバーに置き換える（order.md:62）。
// 期待値は書き換え前のこのファイルと同じにする（order.md:49「期待値は変えない」）。

const remark = (n: number, track: Track, text: string, extra: Partial<Remark> = {}): Remark => ({ id: `r${n}`, track, start: n * 10, end: n * 10 + 9, text, ...extra });

const textsOf = (frames: SpeakingFrame[], track: Track) => frames.filter((f) => f.track === track).map((f) => f.text);

describe("途中結果の間引き（トラックごとに SPEAKING_INTERVAL_MS に 1 回まで）", () => {
  const setup = Effect.fn("setup")(function* (initial: Remark[] = []) {
    const frames: SpeakingFrame[] = [];
    let unreflected = initial;
    const relay = yield* createSpeakingRelay({ unreflected: Effect.sync(() => unreflected), send: (f) => Effect.sync(() => frames.push(f)) });
    return { relay, frames, setUnreflected: (r: Remark[]) => (unreflected = r) };
  });

  it.effect("間隔内に続けて届いた途中結果は、先頭の 1 件をすぐ送り、残りは間隔が過ぎたときに最後の値を 1 件だけ送る", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      expect(textsOf(frames, "相手")).toEqual(["あ"]); // 先頭はすぐ
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あい", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あいう", false);
      expect(textsOf(frames, "相手")).toEqual(["あ"]); // 間隔内なので増えない

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS - 200 - 1);
      expect(textsOf(frames, "相手")).toEqual(["あ"]); // 間隔の直前まではまだ送らない
      yield* TestClock.adjust(1);
      expect(textsOf(frames, "相手")).toEqual(["あ", "あいう"]); // 途中の「あい」は送らず、最後の値だけ

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 3);
      expect(textsOf(frames, "相手")).toEqual(["あ", "あいう"]); // 予約は 1 回だけ
    }));

  it.effect("間隔が過ぎてから届いた途中結果は、待たずにすぐ送る", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* relay.partial("相手", "あい", false);

      expect(textsOf(frames, "相手")).toEqual(["あ", "あい"]);
    }));

  it.effect("トラックごとに独立して間引く（片方の送信が、もう片方を待たせない）", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("自分", "い", false);

      expect(textsOf(frames, "自分")).toEqual(["い"]);
      expect(textsOf(frames, "相手")).toEqual(["あ"]);
    }));

  it.effect("予約した送信は、予約した時点ではなく送る時点の最新の未反映の発言と途中結果を合成する", () =>
    Effect.gen(function* () {
      const { relay, frames, setUnreflected } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あい", false);
      setUnreflected([remark(1, "相手", "確定した発言")]); // 予約してから送るまでの間に、発言が増えた
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);

      expect(textsOf(frames, "相手").at(-1)).toBe("確定した発言 あい");
    }));

  it.effect("stop で予約を取り消し、両トラックの空の frame を送る。stop の後は、予約も途中結果も送らない", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();
      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あい", false); // 予約中
      frames.length = 0;

      yield* relay.stop();

      expect(textsOf(frames, "相手")).toEqual([""]);
      expect(textsOf(frames, "自分")).toEqual([""]);
      frames.length = 0;
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 5);
      yield* relay.partial("相手", "う", false);
      yield* relay.remark("相手");
      yield* relay.flushAll();
      expect(frames).toEqual([]);
    }));
});

// 同じ Session・同じ relay・同じ記録つきセッションの配線（openRecordedSession の onDiff）の上で、変化の前後を続けて観測する
describe("仮の文字（未反映の発言 + 途中結果）が、反映で消える範囲", () => {
  type Call = { input: DiffInput; resolve: (ops: Op[]) => void; reject: (e: Error) => void };

  const setup = Effect.fn("setup")(function* () {
    const calls: Call[] = [];
    // 差分更新の応答をテストの側から返せる偽物。reject は DiffUpdater の失敗（タグ付き）になる
    const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
      Effect.callback<DiffOutput, UpdateFailure>((resume) => {
        calls.push({
          input,
          resolve: (ops) => resume(Effect.succeed({ ops })),
          reject: (e) => resume(Effect.fail({ _tag: "UpdateFailed", message: e.message })),
        });
      });
    const frames: SpeakingFrame[] = [];
    const unreflectedAtPublish: string[][] = []; // publish が呼ばれた時点で、Session が未反映とみなしていた発言の ID
    let session: Session | undefined;
    let relay: Effect.Success<ReturnType<typeof createSpeakingRelay>> | undefined;
    const sessionsDir = yield* promiseOrDie(() => mktempSessionsDir());
    const dir = createSessionDir(sessionsDir);
    const started = yield* openRecordedSession({
      dir,
      title: "定例",
      publish: () =>
        Effect.gen(function* () {
          if (session) unreflectedAtPublish.push((yield* session.unreflectedRemarks).map((r) => r.id));
        }),
      onDiff: Effect.suspend(() => relay!.flushAll()),
    }).pipe(Effect.provide(updaterLayer(update)));
    session = started.session;
    relay = yield* createSpeakingRelay({ unreflected: session.unreflectedRemarks, send: (f) => Effect.sync(() => frames.push(f)) });
    // server/src/sessions.ts の読み取りループと同じ順: 発言は push してから relay に知らせる
    const say = (r: Remark) =>
      Effect.gen(function* () {
        yield* session!.push(r);
        yield* relay!.remark(r.track);
      });
    const partial = (track: Track, text: string, duplicate = false) =>
      Effect.gen(function* () {
        yield* relay!.partial(track, text, duplicate);
        yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      });
    const add = (evidence: string[], text = "採用"): Op[] => [{ op: "add", ref: "t1", parent: "root", kind: "議題", text, evidence }];
    const idle = () => session!.idle;
    return { session, relay, say, partial, calls, frames, unreflectedAtPublish, dir, add, idle };
  });

  function mktempSessionsDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "live-mindmap-speaking-"));
  }

  it.effect("反映に渡した発言の分だけが消え、反映に渡していない発言と途中結果は残る。続く反映で、残りも消える", () =>
    Effect.gen(function* () {
      const { session, say, partial, calls, frames, unreflectedAtPublish, add, idle } = yield* setup();

      yield* say(remark(1, "相手", "赤"));
      yield* say(remark(2, "相手", "青")); // r1・r2 が差分更新に渡る（結果待ち）
      expect(calls).toHaveLength(1);
      yield* say(remark(3, "相手", "緑")); // 反映に渡していない
      yield* partial("相手", "…");
      expect(textsOf(frames, "相手").at(-1)).toBe("赤 青 緑 …"); // 反映前: 結果待ちの発言も未反映の発言も、途中結果も

      calls[0]!.resolve(add(["r1", "r2"]));
      yield* idle();

      expect(textsOf(frames, "相手").at(-1)).toBe("緑 …"); // r1・r2 だけが消える
      expect(unreflectedAtPublish.at(-1)).toEqual(["r3"]); // 反映したマップの送信の時点で、すでに反映済みの発言は未反映から外れている

      yield* say(remark(4, "相手", "黄")); // 話し終えた（途中結果は空になる）。r3・r4 が差分更新に渡る
      expect(textsOf(frames, "相手").at(-1)).toBe("緑 黄");
      calls[1]!.resolve([{ op: "noop", reason: "なし" }]);
      yield* idle();

      expect(textsOf(frames, "相手").at(-1)).toBe(""); // 何も残らない
      expect(session).toBeDefined();
    }));

  it.effect("反映が失敗しても、その回に渡した発言は仮の文字から消える。マップは送られない", () =>
    Effect.gen(function* () {
      const { say, partial, calls, frames, unreflectedAtPublish, idle } = yield* setup();
      yield* say(remark(1, "相手", "赤"));
      yield* say(remark(2, "相手", "青"));
      yield* partial("相手", "…");
      expect(textsOf(frames, "相手").at(-1)).toBe("赤 青 …");
      const publishedBefore = unreflectedAtPublish.length;

      calls[0]!.reject(new Error("差分更新の失敗"));
      yield* idle();

      expect(textsOf(frames, "相手").at(-1)).toBe("…");
      expect(unreflectedAtPublish).toHaveLength(publishedBefore); // 失敗した反映ではマップを送らない（既存の動作）
    }));

  it.effect("トラックごとに別の仮の文字になる。相手の反映待ちの発言は、自分の仮の文字に出ない", () =>
    Effect.gen(function* () {
      const { say, partial, calls, frames, add, idle } = yield* setup();
      yield* say(remark(1, "相手", "赤"));
      yield* say(remark(2, "自分", "青"));
      yield* partial("相手", "…");

      expect(textsOf(frames, "相手").at(-1)).toBe("赤 …");
      expect(textsOf(frames, "自分").at(-1)).toBe("青");

      calls[0]!.resolve(add(["r1", "r2"]));
      yield* idle();

      expect(textsOf(frames, "相手").at(-1)).toBe("…");
      expect(textsOf(frames, "自分").at(-1)).toBe("");
    }));

  it.effect("重複の印が付いた発言と途中結果は、仮の文字に出ない。項目がない（印なし）途中結果は出る", () =>
    Effect.gen(function* () {
      const { say, partial, frames } = yield* setup();

      yield* say(remark(1, "自分", "相手の声の拾い直し", { duplicate: true }));
      yield* partial("自分", "拾い直しの途中結果", true);
      expect(textsOf(frames, "自分").every((t) => !t.includes("拾い直し"))).toBe(true);
      expect(textsOf(frames, "自分").at(-1)).toBe("");

      yield* partial("自分", "自分の声", false);
      expect(textsOf(frames, "自分").at(-1)).toBe("自分の声");
    }));

  it.effect("途中結果と未反映の発言は、スナップショットのノード・エクスポート・ログに入らない", () =>
    Effect.gen(function* () {
      const { session, say, partial, calls, dir, add, idle } = yield* setup();
      yield* say(remark(1, "相手", "確定した発言ア"));
      yield* say(remark(2, "相手", "確定した発言イ"));
      yield* say(remark(3, "相手", "未反映の発言ウ"));
      yield* partial("相手", "ZZ-途中結果");
      calls[0]!.resolve(add(["r1", "r2"], "採用"));
      yield* idle();

      // 観測単位（ノード・根拠の発言・変わったこと・ログのイベント）ごとに、途中結果が入っていないことを検査する
      const partialText = "ZZ-途中結果";
      const snapshot = yield* session!.snapshot;
      expect(snapshot.nodes.map((n) => n.text)).toEqual(["定例", "採用"]); // 未反映の発言ウもノードにならない
      expect(snapshot.remarks.map((r) => r.id)).toEqual(["r1", "r2"]); // 根拠に挙がった発言だけ
      for (const text of [...snapshot.nodes.map((n) => n.text), ...snapshot.remarks.map((r) => r.text), ...snapshot.changes.map((c) => JSON.stringify(c))]) {
        expect(text).not.toContain(partialText);
      }
      expect(JSON.stringify(yield* session!.exportJson)).not.toContain(partialText);
      expect(JSON.parse(readFileSync(join(dir, "export.json"), "utf8"))).toEqual(yield* session!.exportJson);

      const events = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
      expect(events.map((e) => e.type).every((t) => t === "start" || t === "remark" || t === "diff")).toBe(true); // partial・speaking のイベントはない
      for (const e of events) expect(JSON.stringify(e)).not.toContain(partialText);
      expect(events.filter((e) => e.type === "remark").map((e) => e.remark.id)).toEqual(["r1", "r2", "r3"]); // 発言は今までどおり
    }));
});
