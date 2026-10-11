import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import type { DiffUpdateFrame, SpeakingFrame } from "../src/core/index.ts";
import { appleLiveServer } from "./fixtures/appleLiveServer.ts";
import { connect } from "./fixtures/wsClient.ts";

const states = (all: unknown[]) => all.filter((frame): frame is DiffUpdateFrame =>
  typeof frame === "object" && frame !== null && "type" in frame && frame.type === "diff-update");
const waitState = (all: unknown[], state: DiffUpdateFrame["state"]) =>
  Effect.tryPromise(() => vi.waitFor(() => expect(states(all).at(-1)?.state).toEqual(state)));

describe("Apple の状態配信", () => {
  it.live("発言のない会議で再起動と停止を通知し、再接続で現在状態を送り、停止後も字幕を届ける", () => Effect.gen(function* () {
    const server = yield* appleLiveServer();
    const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const first = yield* connect(server.port, "/ws", undefined).pipe(Scope.provide(firstScope));
    expect((yield* server.start).status).toBe(200);
    yield* waitState(first.frames, { status: "running" });
    yield* server.fake.crash(0);
    yield* waitState(first.frames, { status: "restarting" });
    expect(server.fake.requests).toHaveLength(1);
    yield* Scope.close(firstScope, Exit.void);
    const second = yield* connect(server.port, "/ws", undefined);
    yield* waitState(second.frames, { status: "restarting" });
    yield* server.fake.releaseReady(1);
    yield* waitState(second.frames, { status: "running" });
    for (let i = 1; i < 3; i++) {
      const before = states(second.frames).length;
      yield* server.fake.crash(i);
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        expect(server.fake.processes).toHaveLength(i + 2);
        expect(states(second.frames).length).toBeGreaterThan(before);
        expect(states(second.frames).at(-1)?.state).toEqual({ status: "running" });
      }));
    }
    yield* server.fake.crash(3);
    yield* waitState(second.frames, { status: "stopped" });
    const stopped = yield* connect(server.port, "/ws", undefined);
    yield* waitState(stopped.frames, { status: "stopped" });
    const requests = server.fake.requests.length;
    yield* server.emit({ type: "partial", track: "自分", start: 0, end: 1, text: "停止後も続く字幕です。" });
    yield* server.emit({ type: "remark", track: "相手", start: 1, end: 2, text: "停止後も記録する発言です。" });
    const speaking = (all: unknown[]) => all.filter((frame): frame is SpeakingFrame =>
      typeof frame === "object" && frame !== null && "type" in frame && frame.type === "speaking");
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(speaking(second.frames).some((frame) => frame.text === "停止後も続く字幕です。")).toBe(true)));
    expect((yield* server.stop).status).toBe(200);
    yield* waitState(second.frames, null);
    yield* waitState(stopped.frames, null);
    expect(server.fake.requests).toHaveLength(requests);
    const after = yield* connect(server.port, "/ws", undefined);
    yield* waitState(after.frames, null);
  }));
});
