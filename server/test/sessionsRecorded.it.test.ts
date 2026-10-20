import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Result, Stream } from "effect";
import { vi } from "vitest";
import { SessionSinks } from "../src/sessionSinks.ts";
import { Sessions, SessionsDir, type RecordedStart } from "../src/sessions.ts";
import { Viewers } from "../src/viewers.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeHelpers, HELPER_AUDIO, HELPER_SELF_AUDIO, type Script } from "./fixtures/recordedHelper.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

const resource = Effect.fnUntraced(function* (script: Script, options: { attempts?: readonly Script[] } = {}) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-recorded-sessions-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const sessionsDir = join(root, "sessions");
  const file = join(root, "meeting.m4a");
  const selfFile = join(root, "me.m4a");
  const helpers = fakeHelpers(script, options.attempts);
  const updater = updaterLayer(() => Effect.succeed({ ops: [] }));
  const layer = Sessions.layer.pipe(Layer.provide(Layer.mergeAll(
    readyManagedDeps, helpers.layer, Viewers.layer, Layer.succeed(SessionsDir, sessionsDir),
    SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updater }) }).pipe(Layer.provide(fakeExportServices())),
  )));
  const context = yield* Layer.build(layer);
  const sessions = Context.get(context, Sessions);
  const run = Effect.fnUntraced(function* (input: Partial<RecordedStart> = {}) {
    const started = yield* sessions.startRecorded({ file, title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude }, ...input });
    const events = yield* Stream.runCollect(started.events);
    expect(events.at(-1)?.type).toBe("finished");
    return { dir: started.dir, events };
  });
  return { sessionsDir, file, selfFile, helpers, sessions, run };
});

type Line = Record<string, unknown> & { type: string };
const logLines = (dir: string): Line[] => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
const onlySession = (sessionsDir: string) => {
  const names = readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, "log.jsonl")));
  expect(names).toHaveLength(1);
  return join(sessionsDir, names[0]!);
};
const remarksOf = (lines: Line[]) => lines.filter((line) => line.type === "remark").map((line) => line.remark as { id: string; track: string; start: number; end: number; text: string });
const THREE: Script = { duration: 3484, remarks: [
  { start: 590, end: 600, text: "最初の発言です" },
  { start: 600, end: 660, text: "次の発言です" },
  { start: 700, end: 750, text: "三つ目の発言です" },
] };
describe("Sessions と録画 sink の保存・再起動", () => {
  it.live.each([false, true])("録画の音声ファイルを書き、自分用の録音は指定時だけ保存する（selfTrack=%s）", (selfTrack) => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const { dir } = yield* r.run(selfTrack ? { selfFile: r.selfFile } : {});
    expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    expect(existsSync(join(dir, "自分.m4a"))).toBe(selfTrack);
    if (selfTrack) expect(readFileSync(join(dir, "自分.m4a"), "utf8")).toBe(HELPER_SELF_AUDIO);
    expect(readdirSync(dir)).not.toContain("meeting.m4a");
  }).pipe(Effect.scoped));

  it.live("指定した題名とユーザー語彙を録画 sink のログへ渡す", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const { dir } = yield* r.run({ title: "週次会議", vocab: ["ヤマダ商事", "アルファ"] });
    const lines = logLines(dir);
    expect(lines.find((line) => line.type === "start")).toMatchObject({ title: "週次会議" });
    expect(lines.filter((line) => line.type === "vocab").flatMap((line) => line.words as { surface: string; source: string }[]).filter((word) => word.source === "user").map((word) => word.surface)).toEqual(["ヤマダ商事", "アルファ"]);
  }).pipe(Effect.scoped));
  it.live.each([false, true])("諦めてもログと書き出しを残す（接続失敗=%s）", (failLaunch) => Effect.gen(function* () {
    const first: Script = { ...THREE, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } };
    const r = yield* resource(first, failLaunch ? { attempts: [first, { remarks: [], failLaunch: true }, { remarks: [], failLaunch: true }] } : {});
    const { dir } = yield* r.run();
    const lines = logLines(dir);
    const ids = remarksOf(lines).map((remark) => remark.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toEqual(["r1", "r2"].slice(0, ids.length));
    expect(lines.filter((line) => line.type === "intake-gave-up")).toEqual([expect.objectContaining({ reason: "failures" })]);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
  }).pipe(Effect.scoped));

  it.live("接続待ちでstopしても、入れた発言でmap.*を書き出す", () => Effect.gen(function* () {
    const r = yield* resource(THREE, {
      attempts: [{ duration: 3484, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } }, { remarks: [], blockLaunch: true }],
    });
    const running = yield* Effect.forkChild(r.run());
    yield* Effect.promise(() => vi.waitFor(() => expect(r.helpers.calls).toHaveLength(2)));
    yield* r.sessions.stop;
    const result = yield* Effect.result(Fiber.join(running));

    expect(Result.isSuccess(result)).toBe(true);
    const dir = onlySession(r.sessionsDir);
    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(existsSync(join(dir, "map.md"))).toBe(true);
  }).pipe(Effect.scoped));

});
