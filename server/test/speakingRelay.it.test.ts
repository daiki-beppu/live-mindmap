import { defaultClaude } from "../src/modelSelection.ts";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { type DiffInput, type DiffResult, type Op, type Remark, type Session, type CaptionsFrame, type Track } from "../src/core/index.ts";
import { createSessionDir, openLoggedSession } from "../src/sessionFiles.ts";
import { createSpeakingRelay, SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";
import { partialOf, remark } from "./fixtures/speakingRelay.ts";

const textsOf = (frames: readonly CaptionsFrame[], track: Track): string[][] => frames.map((f) => f.bubbles.filter((b) => b.track === track).map((b) => b.text));

const settleUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) yield* Effect.yieldNow;
  });

describe("仮の文字（未反映の発言 + 途中結果）が、反映で消える範囲", () => {
  type Call = { input: DiffInput; resolve: (ops: Op[]) => void; reject: (e: Error) => void };

  const setup = Effect.fn("setup")(function* () {
    const calls: Call[] = [];
    const update = (input: DiffInput): Effect.Effect<DiffResult, UpdateFailure> =>
      Effect.callback<DiffResult, UpdateFailure>((resume) => {
        calls.push({
          input,
          resolve: (ops) => resume(Effect.succeed({ ops })),
          reject: (e) => resume(Effect.fail({ _tag: "UpdateFailed", message: e.message })),
        });
      });
    const frames: CaptionsFrame[] = [];
    const unreflectedAtPublish: string[][] = [];
    let session: Session | undefined;
    let relay: Effect.Success<ReturnType<typeof createSpeakingRelay>> | undefined;
    const sessionsDir = yield* Effect.promise(() => mktempSessionsDir());
    const dir = yield* createSessionDir(sessionsDir).pipe(Effect.provide(NodeFileSystem.layer));
    const started = yield* openLoggedSession({ model: defaultClaude,
      dir,
      title: "定例",
      send: (frame) =>
        Effect.gen(function* () {
          if (frame.type === "snapshot" && session) unreflectedAtPublish.push((yield* session.unreflectedRemarks).map((r) => r.id));
        }),
      onDiff: Effect.suspend(() => relay!.flushAll),
    }).pipe(Effect.provide(Layer.mergeAll(updaterLayer(update), NodeFileSystem.layer)));
    session = started.session;
    relay = yield* createSpeakingRelay({
      context: Effect.map(session.unreflectedRemarks, (remarks) => ({ unreflected: remarks.map(({ id, ...r }) => ({ id, remark: r })), held: [], intervals: [], previewLabel: () => "相手 A" })),
      send: (f) => Effect.sync(() => frames.push(f)),
    });
    const say = (r: Remark) =>
      Effect.gen(function* () {
        yield* session!.push(r);
        yield* relay!.remark(r.track);
      });
    const partial = (track: Track, text: string, duplicate = false) =>
      Effect.gen(function* () {
        yield* relay!.partial(partialOf(track, text, 100, { duplicate }));
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
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input.fresh.map((r) => r.id)).toEqual(["r1"]);
      yield* say(remark(2, "相手", "青"));
      yield* say(remark(3, "相手", "緑"));
      yield* partial("相手", "…");
      expect(calls).toHaveLength(1);
      expect(textsOf(frames, "相手").at(-1)).toEqual(["赤", "青", "緑", "…"]);

      calls[0]!.resolve(add(["r1"]));
      yield* settleUntil(() => calls.length === 2);
      expect(calls[1]!.input.fresh.map((r) => r.id)).toEqual(["r2", "r3"]);
      expect(textsOf(frames, "相手").at(-1)).toEqual(["青", "緑", "…"]);
      expect(unreflectedAtPublish.at(-1)).toEqual(["r2", "r3"]);

      yield* say(remark(4, "相手", "黄"));
      expect(textsOf(frames, "相手").at(-1)).toEqual(["青", "緑", "黄"]);
      calls[1]!.resolve([{ op: "noop", reason: "なし" }]);
      yield* settleUntil(() => calls.length === 3);
      expect(calls[2]!.input.fresh.map((r) => r.id)).toEqual(["r4"]);
      expect(textsOf(frames, "相手").at(-1)).toEqual(["黄"]);

      calls[2]!.resolve([{ op: "noop", reason: "なし" }]);
      yield* idle();

      expect(textsOf(frames, "相手").at(-1)).toEqual([]);
      expect(session).toBeDefined();
    }));

  it.effect("反映が失敗しても、その回に渡した発言は仮の文字から消える。マップは送られない", () =>
    Effect.gen(function* () {
      const { say, partial, calls, frames, unreflectedAtPublish, idle } = yield* setup();
      yield* say(remark(1, "相手", "赤"));
      yield* partial("相手", "…");
      expect(textsOf(frames, "相手").at(-1)).toEqual(["赤", "…"]);
      const publishedBefore = unreflectedAtPublish.length;

      calls[0]!.reject(new Error("差分更新の失敗"));
      yield* idle();

      expect(textsOf(frames, "相手").at(-1)).toEqual(["…"]);
      expect(unreflectedAtPublish).toHaveLength(publishedBefore);
    }));

  it.effect("トラックごとに別の仮の文字になる。相手の反映待ちの発言は、自分の仮の文字に出ない", () =>
    Effect.gen(function* () {
      const { say, partial, calls, frames, add, idle } = yield* setup();
      yield* say(remark(1, "相手", "赤"));
      yield* say(remark(2, "自分", "青"));
      yield* partial("相手", "…");

      expect(textsOf(frames, "相手").at(-1)).toEqual(["赤", "…"]);
      expect(textsOf(frames, "自分").at(-1)).toEqual(["青"]);

      calls[0]!.resolve(add(["r1"]));
      yield* settleUntil(() => calls.length === 2);
      expect(textsOf(frames, "相手").at(-1)).toEqual(["…"]);
      expect(textsOf(frames, "自分").at(-1)).toEqual(["青"]);

      calls[1]!.resolve([{ op: "noop", reason: "なし" }]);
      yield* idle();
      expect(textsOf(frames, "自分").at(-1)).toEqual([]);
    }));

  it.effect("重複の印が付いた発言と途中結果は、仮の文字に出ない。項目がない（印なし）途中結果は出る", () =>
    Effect.gen(function* () {
      const { say, partial, frames } = yield* setup();

      yield* say(remark(1, "自分", "相手の声の拾い直し", { duplicate: true }));
      yield* partial("自分", "拾い直しの途中結果", true);
      expect(textsOf(frames, "自分").flat().every((t) => !t.includes("拾い直し"))).toBe(true);
      expect(textsOf(frames, "自分").at(-1)).toEqual([]);

      yield* partial("自分", "自分の声", false);
      expect(textsOf(frames, "自分").at(-1)).toEqual(["自分の声"]);
    }));

  it.effect("途中結果と未反映の発言は、スナップショットのノード・エクスポート・ログに入らない", () =>
    Effect.gen(function* () {
      const { session, say, partial, calls, dir, add } = yield* setup();
      yield* say(remark(1, "相手", "確定した発言ア"));
      yield* say(remark(2, "相手", "確定した発言イ"));
      yield* partial("相手", "ZZ-途中結果");
      calls[0]!.resolve(add(["r1"], "採用"));
      yield* settleUntil(() => calls.length === 2);
      yield* say(remark(3, "相手", "未反映の発言ウ"));
      calls[1]!.resolve(add(["r2"], "採用イ"));
      yield* settleUntil(() => calls.length === 3);
      expect(calls[2]!.input.fresh.map((r) => r.id)).toEqual(["r3"]);

      const partialText = "ZZ-途中結果";
      const snapshot = yield* session!.snapshot;
      expect(snapshot.nodes.map((n) => n.text)).toEqual(["定例", "採用", "採用イ"]);
      expect(snapshot.remarks.map((r) => r.id)).toEqual(["r1", "r2"]);
      for (const text of [...snapshot.nodes.map((n) => n.text), ...snapshot.remarks.map((r) => r.text), ...snapshot.changes.map((c) => JSON.stringify(c))]) {
        expect(text).not.toContain(partialText);
      }
      expect(JSON.stringify(yield* session!.exportJson)).not.toContain(partialText);
      expect(JSON.parse(readFileSync(join(dir, "export.json"), "utf8"))).toEqual(yield* session!.exportJson);

      const events = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
      expect(events.map((e) => e.type).every((t) => t === "start" || t === "remark" || t === "diff")).toBe(true);
      for (const e of events) expect(JSON.stringify(e)).not.toContain(partialText);
      expect(events.filter((e) => e.type === "remark").map((e) => e.remark.id)).toEqual(["r1", "r2", "r3"]);
    }));
});
