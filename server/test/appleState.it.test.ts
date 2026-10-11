import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { LogEvent, restoreState, type DiffUpdateFrame } from "../src/core/index.ts";
import { EXPORT_FILE, LOG_FILE, openRecordedSession } from "../src/sessionFiles.ts";
import { appleModel, fakeAppleLifecycle, waitForDiffState, waitUntil } from "./fixtures/appleLifecycle.ts";

describe("Apple の状態遷移と保存ログ", () => {
  it.effect("同じ録音セッションの再起動・復帰・停止をJSONLと配信へ流し、読み直して処理済みと未反映を区別する", () => Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-apple-state-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })));
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }]);
    const layer = yield* fake.prepare.pipe(Scope.provide(scope));
    const frames: DiffUpdateFrame[] = [];
    const { session } = yield* openRecordedSession({ dir, model: appleModel, title: "定例", publish: () => Effect.void,
      diffUpdate: (frame) => Effect.sync(() => { frames.push(frame); }),
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, layer)), Scope.provide(scope));
    const readLines = Effect.promise(() => readFile(join(dir, LOG_FILE), "utf8")).pipe(
      Effect.map((text) => text.trim().split("\n").map((line): unknown => JSON.parse(line))),
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => Schema.decodeUnknownEffect(LogEvent)(line))),
    );
    const push = (n: number) => session.push({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
    yield* push(1);
    yield* push(2);
    yield* session.idle;
    const before = yield* session.snapshot;
    expect(before.nodes.some((n) => n.text === "面接官は3人")).toBe(true);
    const baseline = (yield* readLines).length;
    yield* fake.crash(0);
    yield* waitForDiffState(session, "restarting");
    expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
    yield* waitUntil(() => frames.at(-1)?.state?.status === "restarting", "restarting の配信");
    expect(frames.at(-1)?.state).toEqual({ status: "restarting" });
    const restartingLines = (yield* readLines).slice(baseline);
    expect(restartingLines.some((line) => JSON.stringify(line).includes("restarting"))).toBe(true);
    expect(restartingLines.filter((line) => line.type === "remark")).toEqual([]);
    yield* push(3);
    yield* push(4);
    yield* session.idle;
    const restarting = yield* restoreState(yield* readLines);
    expect(restarting.processed.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(restarting.pending).toEqual([]);
    yield* fake.releaseReady(1);
    yield* waitForDiffState(session, "running");
    expect(yield* session.diffUpdate).toEqual({ status: "running" });
    for (let i = 1; i < 3; i++) {
      yield* fake.crash(i);
      yield* waitUntil(() => fake.processes.length === i + 2 && fake.requests.some((r) => r.url === `${fake.processes[i + 1]!.url}/chat/completions`), `立ち上げ直し ${i} 回目の呼び出し`);
      expect(fake.processes).toHaveLength(i + 2);
      yield* waitForDiffState(session, "running");
    }
    yield* fake.crash(3);
    yield* waitForDiffState(session, "stopped");
    expect(yield* session.diffUpdate).toEqual({ status: "stopped" });
    yield* waitUntil(() => frames.at(-1)?.state?.status === "stopped", "stopped の配信");
    expect(frames.at(-1)?.state).toEqual({ status: "stopped" });
    yield* push(5);
    yield* session.flush;
    const lines = yield* readLines;
    const serialized = lines.slice(baseline).map((line) => JSON.stringify(line));
    const restart = serialized.findIndex((line) => line.includes("restarting"));
    const running = serialized.findIndex((line, index) => index > restart && line.includes("running"));
    const stopped = serialized.findIndex((line, index) => index > running && line.includes("stopped"));
    expect(restart).toBeGreaterThanOrEqual(0);
    expect(running).toBeGreaterThan(restart);
    expect(stopped).toBeGreaterThan(running);
    const restored = yield* restoreState(lines);
    expect(restored.remarks.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(restored.processed.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(restored.pending.map((r) => r.id)).toEqual(["r5"]);
    expect(restored.map.order.map((id) => restored.map.nodes[id]!.text)).toEqual(before.nodes.map((n) => n.text));
    expect(JSON.parse(yield* Effect.promise(() => readFile(join(dir, EXPORT_FILE), "utf8")))).toEqual(yield* session.exportJson);
    yield* Scope.close(scope, Exit.void);
    expect(frames.at(-1)).toEqual({ type: "diff-update", state: null });
  }));
});
