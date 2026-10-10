import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { emptyMap, LogEvent, restoreState, type Snapshot } from "../src/core/index.ts";
import { prepareChatgpt } from "../src/chatgptResponses.ts";
import { classificationRequest } from "../src/localPrompt.ts";
import { LOG_FILE, openRecordedSession } from "../src/sessionFiles.ts";
import { CHATGPT_HOME, CHATGPT_MODEL, chatgptCredentials, classification, completedSse, fakeChatgptFiles, fakeChatgptHttp } from "./fixtures/chatgpt.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

describe("一時停止の保存ログ", () => {
  it.effect("実際のJSONLに停止・試行・再開が保存され、停止直後と再開後を読み直せる", () => Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-pause-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((_request, call) => call === 1
      ? new Response(completedSse(classification([{ 種類: "なし" }])))
      : new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }), { status: 429 }));
    const classify = yield* prepareChatgpt(CHATGPT_MODEL).pipe(
      Effect.provideService(FileSystem.FileSystem, files.fs), Effect.provideService(HttpClient.HttpClient, http.client),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: CHATGPT_HOME }))), Effect.orDie,
    );
    const failed = yield* Effect.result(classify(classificationRequest(emptyMap("定例"), [], [{ remark: "probe", text: "確認。" }])));
    if (Result.isSuccess(failed)) return yield* Effect.die("429が成功として返りました");
    let calls = 0;
    const published: Snapshot[] = [];
    const { session } = yield* openRecordedSession({ model: CHATGPT_MODEL, dir, title: "定例", publish: (snapshot) => Effect.sync(() => void published.push(snapshot)) }).pipe(
      Effect.provide(Layer.merge(NodeFileSystem.layer, updaterLayer((input) => Effect.suspend(() => {
        calls++;
        return calls === 1 ? Effect.fail(failed.failure) : Effect.succeed({ ops: input.fresh.map((r) => ({ op: "add" as const, ref: r.id, parent: "root", kind: "議題" as const, text: r.text, evidence: [r.id] })) });
      })))),
    );
    const readLines = Effect.promise(() => readFile(join(dir, LOG_FILE), "utf8")).pipe(
      Effect.map((text) => text.trim().split("\n").map((line): unknown => JSON.parse(line))),
    );
    for (const n of [1, 2]) yield* session.push({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}` });
    yield* session.idle;
    const pausedLines = yield* readLines;
    const paused = yield* restoreState(pausedLines);
    expect(paused.pending.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(paused.round).toBe(0);
    expect(published.map((s) => s.round)).toEqual([0]);
    yield* TestClock.adjust(300_000);
    yield* session.idle;
    const resumedLines = yield* readLines;
    const decoded = yield* Effect.forEach(resumedLines, (line) => Schema.decodeUnknownEffect(LogEvent)(line));
    const transitions = decoded.filter((e) => !["start", "remark", "diff", "screen-input-skipped"].includes(e.type));
    expect(transitions.map((e) => e.type)).toEqual(["diff-update-paused", "diff-update-retry", "diff-update-resumed"]);
    const resumed = yield* restoreState(resumedLines);
    expect(resumed.pending).toEqual([]);
    expect(resumed.round).toBe(1);
    expect(resumed.map.order.map((id) => resumed.map.nodes[id]!.text)).toEqual((yield* session.snapshot).nodes.map((n) => n.text));
    expect(published.map((s) => s.round)).toEqual([0, 1]);
  }));
});
