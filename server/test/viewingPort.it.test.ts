// 閲覧の口（http.ts の openViewingPort。Issue #832）の IT。本物のソケットで、127.0.0.1 の別の待受けが
// 静的な画面（ログを埋め込まない single-file ビルド）と /ws の配信だけを、与えたホスト名の Origin にだけ通すことを確かめる。
// 配信は操作の口（serveFeed）と同じ Viewers の実体を使う。本物の tunnel・PIN・iPad は使わない。
import { describe, expect, it, vi } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { WebSocket } from "ws";
import { openListener, openViewingPort, portOf, serveFeed } from "../src/http.ts";
import { ReviewBuild } from "../src/review.ts";
import { Viewers } from "../src/viewers.ts";
import { TEMPLATE } from "./fixtures/review.ts";
import { connect } from "./fixtures/wsClient.ts";

const HOST = "abc-def.trycloudflare.com";
const ALLOWED = `https://${HOST}`;
const fakeBuild = Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(TEMPLATE) }));
const snapshot = { nodes: [], round: 1, changes: [], remarks: [] };
const intakeFrame = { type: "intake", status: "running" } as const;
const modeFrame = { type: "session-mode", local: false } as const;

// 操作の口（serveFeed）と閲覧の口を、同じ Viewers で立てる。閲覧の口だけを閉じられる Scope を別に持つ
const ports = Effect.fnUntraced(function* () {
  const ctx = yield* openListener(0);
  const viewers = Context.get(ctx, Viewers);
  const operationPort = yield* portOf(Context.get(ctx, HttpServer.HttpServer).address);
  yield* Effect.provide(serveFeed, ctx);
  const viewingScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
  const viewingPort = yield* openViewingPort(HOST).pipe(
    Effect.provide(Layer.merge(Layer.succeed(Viewers, viewers), fakeBuild)),
    Scope.provide(viewingScope),
  );
  return { viewers, operationPort, viewingPort, viewingScope };
});

const get = (port: number, path: string, origin?: string, method = "GET") =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: origin === undefined ? {} : { origin } });

// upgrade が断られたときの HTTP ステータス。upgrade できてしまったら 101 を返す
const upgradeStatus = (port: number, path: string, origin: string | undefined) =>
  Effect.tryPromise(() => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === undefined ? {} : { origin });
    ws.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
    ws.once("open", () => { ws.terminate(); resolve(101); });
    ws.once("error", reject);
  }));

describe("閲覧の口（Issue #832）", () => {
  it.live("GET / は、ログを埋め込まない画面を text/html で返す。Origin が無くても、与えたホスト名の Origin でも通る", () => Effect.gen(function* () {
    const p = yield* ports();
    for (const origin of [undefined, ALLOWED]) {
      const response = yield* Effect.tryPromise(() => get(p.viewingPort, "/", origin));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      expect(yield* Effect.tryPromise(() => response.text())).toBe(TEMPLATE);
    }
  }));

  it.live("/ws 以外のパス・メソッドは断る（/session/*・/apps・/check・/deps/*・/update・POST /・/index.html）。/ws の upgrade は通る", () => Effect.gen(function* () {
    const p = yield* ports();
    // 負例の前に、同じ待受けで通る経路が通ることを示す
    expect((yield* Effect.tryPromise(() => get(p.viewingPort, "/", undefined))).status).toBe(200);
    expect((yield* connect(p.viewingPort, "/ws", ALLOWED)).isOpen()).toBe(true);
    const refused = [
      ...["start", "stop", "status", "resume"].flatMap((name) => ["GET", "POST"].map((m) => [m, `/session/${name}`] as const)),
      ["GET", "/apps"], ["GET", "/check"], ["GET", "/deps/check"], ["POST", "/deps/install"], ["POST", "/update"],
      ["POST", "/"], ["GET", "/index.html"], ["POST", "/ws"],
    ] as const;
    for (const [method, path] of refused) {
      for (const origin of [undefined, ALLOWED]) {
        const response = yield* Effect.tryPromise(() => get(p.viewingPort, path, origin, method));
        expect([method, path, response.status]).toEqual([method, path, 404]);
      }
    }
    // / への upgrade は配信にならない（101 にならず、通常の GET として画面を返す）
    expect(yield* upgradeStatus(p.viewingPort, "/", ALLOWED)).toBe(200);
  }));

  const wrongOrigins = [
    "https://evil.example", "null", `http://${HOST}`, `https://${HOST}.evil.example`, `https://evil.example.${HOST}`,
    `https://${HOST}:8443`, `https://x${HOST}`, `${ALLOWED}/`, ALLOWED.toUpperCase(),
  ];
  it.live("与えたホスト名の Origin だけが通り、ほかの Origin は GET / も /ws の upgrade も 403。/ws は Origin が無くても 403", () => Effect.gen(function* () {
    const p = yield* ports();
    expect(yield* upgradeStatus(p.viewingPort, "/ws", ALLOWED)).toBe(101);
    for (const origin of wrongOrigins) {
      expect([origin, (yield* Effect.tryPromise(() => get(p.viewingPort, "/", origin))).status]).toEqual([origin, 403]);
      expect([origin, yield* upgradeStatus(p.viewingPort, "/ws", origin)]).toEqual([origin, 403]);
    }
    expect(yield* upgradeStatus(p.viewingPort, "/ws", undefined)).toBe(403);
  }));

  it.live("つないだら保持している値が先に届き、その後の publish は操作の口と閲覧の口の両方へ届く（同じ Viewers）", () => Effect.gen(function* () {
    const p = yield* ports();
    yield* p.viewers.publish(snapshot);
    yield* p.viewers.intake(intakeFrame);
    yield* p.viewers.sessionMode(modeFrame);
    const viewing = yield* connect(p.viewingPort, "/ws", ALLOWED);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames).toHaveLength(3)));
    expect(viewing.frames).toEqual([snapshot, intakeFrame, modeFrame]);
    const operation = yield* connect(p.operationPort, "/ws", undefined);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.frames).toHaveLength(3)));
    const next = { ...snapshot, round: 2 };
    yield* p.viewers.publish(next);
    yield* Effect.tryPromise(() => vi.waitFor(() => {
      expect(viewing.frames.at(-1)).toEqual(next);
      expect(operation.frames.at(-1)).toEqual(next);
    }));
  }));

  it.live("ブラウザから届くメッセージは解釈しない（コマンドに見える JSON・不正な文字列・バイナリを送っても、接続も保持値も変わらない）", () => Effect.gen(function* () {
    const p = yield* ports();
    yield* p.viewers.publish(snapshot);
    const viewing = yield* connect(p.viewingPort, "/ws", ALLOWED);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames).toHaveLength(1)));
    viewing.send(JSON.stringify({ type: "session-mode", local: true }));
    viewing.send(JSON.stringify({ command: "stop" }));
    viewing.send("{not json");
    viewing.send(new Uint8Array([0, 255, 1]));
    const next = { ...snapshot, round: 2 };
    yield* p.viewers.publish(next);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames.at(-1)).toEqual(next)));
    // 送ったものは何も返ってこず、閉じられない
    expect(viewing.frames).toEqual([snapshot, next]);
    expect(viewing.isOpen()).toBe(true);
    // 新しく繋いだクライアントには、送ったメッセージの影響のない保持値が届く
    const later = yield* connect(p.viewingPort, "/ws", ALLOWED);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(later.frames).toEqual([next])));
  }));

  it.live("Scope を閉じると閲覧の口は閉じ、操作の口は動き続ける", () => Effect.gen(function* () {
    const p = yield* ports();
    expect((yield* Effect.tryPromise(() => get(p.viewingPort, "/", undefined))).status).toBe(200);
    yield* Scope.close(p.viewingScope, Exit.void);
    yield* Effect.tryPromise(() => expect(get(p.viewingPort, "/", undefined)).rejects.toThrow());
    // 操作の口の保持値は閲覧の口を閉じても消えない
    yield* p.viewers.publish(snapshot);
    const operation = yield* connect(p.operationPort, "/ws", undefined);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.frames).toEqual([snapshot])));
  }));
});
