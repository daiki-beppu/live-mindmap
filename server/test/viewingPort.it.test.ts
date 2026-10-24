// 閲覧の口（viewingPort.ts の openViewingPort。Issue #832）の IT。本物のソケットで、127.0.0.1 の別の待受けが
// 静的な画面（ログを埋め込まない single-file ビルド）と /ws の配信だけを、与えたホスト名の Origin にだけ通すことを確かめる。
// 配信は操作の口（serveFeed）と同じ Viewers の実体を使う。本物の tunnel・PIN・iPad は使わない。
// /ws の配信が WebSocket の制御フレーム ping を一定の間隔で送ること（Issue #833。間隔はテストで縮める）も、同じ待受けで確かめる。
import { describe, expect, it, vi } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { WebSocket } from "ws";
import { openListener, serveFeed } from "../src/http.ts";
import { portOf } from "../src/httpServing.ts";
import { openViewingPort } from "../src/viewingPort.ts";
import { ReviewBuild } from "../src/review.ts";
import { Viewers } from "../src/viewers.ts";
import { TEMPLATE } from "./fixtures/review.ts";
import { connect } from "./fixtures/wsClient.ts";

const HOST = "abc-def.trycloudflare.com";
const ALLOWED = `https://${HOST}`;
const fakeBuild = Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(TEMPLATE) }));
const snapshot = { nodes: [], round: 1, changes: [], remarks: [] };
const snapshotFrame = (s: typeof snapshot) => ({ type: "snapshot", snapshot: s });
const intakeFrame = { type: "intake", status: "running" } as const;
const modeFrame = { type: "session-mode", local: false } as const;

// 操作の口（serveFeed）と閲覧の口を、同じ Viewers で立てる。閲覧の口だけを閉じられる Scope を別に持つ
// pingIntervalMs を渡すと、両方の口の ping の間隔をその値にする。渡さなければ本番の既定値
// openViewingPort は待受けのポートと allow（許す Origin のホスト名を後から 1 つ決める）を返す。
// allowHost を false にすると、ホスト名を決めないまま返す（tunnel のホスト名が出る前の状態）
const ports = Effect.fnUntraced(function* (pingIntervalMs?: number, allowHost = true) {
  const ctx = yield* openListener(0, pingIntervalMs);
  const viewers = Context.get(ctx, Viewers);
  const operationPort = yield* portOf(Context.get(ctx, HttpServer.HttpServer).address);
  yield* Effect.provide(serveFeed, ctx);
  const viewingScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
  const opened = yield* openViewingPort(pingIntervalMs).pipe(
    Effect.provide(Layer.merge(Layer.succeed(Viewers, viewers), fakeBuild)),
    Scope.provide(viewingScope),
  );
  if (allowHost) yield* opened.allow(HOST);
  return { viewers, operationPort, viewingPort: opened.port, allow: opened.allow, viewingScope };
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
      ["POST", "/session/self-pause"], ["GET", "/session/self-pause"],
      ["POST", "/session/speaker-name"], ["GET", "/session/speaker-name"],
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

  it.live("ホスト名が決まる前は、Origin 付きの GET / も /ws の upgrade もすべて 403。決まった後は同じ待受けでそのホスト名だけが通る", () => Effect.gen(function* () {
    const p = yield* ports(undefined, false);
    // 決まる前: 守っている状態に到達していることを、Origin の無い GET / が通ることで先に示す
    expect((yield* Effect.tryPromise(() => get(p.viewingPort, "/", undefined))).status).toBe(200);
    for (const origin of [ALLOWED, "https://evil.example"]) {
      expect([origin, (yield* Effect.tryPromise(() => get(p.viewingPort, "/", origin))).status]).toEqual([origin, 403]);
      expect([origin, yield* upgradeStatus(p.viewingPort, "/ws", origin)]).toEqual([origin, 403]);
    }
    expect(yield* upgradeStatus(p.viewingPort, "/ws", undefined)).toBe(403);
    // 決まった後
    yield* p.allow(HOST);
    expect(yield* upgradeStatus(p.viewingPort, "/ws", ALLOWED)).toBe(101);
    expect((yield* Effect.tryPromise(() => get(p.viewingPort, "/", ALLOWED))).status).toBe(200);
    expect(yield* upgradeStatus(p.viewingPort, "/ws", "https://evil.example")).toBe(403);
  }));

  it.live("つないだら保持している値が先に届き、その後の publish は操作の口と閲覧の口の両方へ届く（同じ Viewers）", () => Effect.gen(function* () {
    const p = yield* ports();
    yield* p.viewers.publish(snapshot);
    yield* p.viewers.intake(intakeFrame);
    yield* p.viewers.sessionMode(modeFrame);
    const viewing = yield* connect(p.viewingPort, "/ws", ALLOWED);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames).toHaveLength(3)));
    expect(viewing.frames).toEqual([snapshotFrame(snapshot), intakeFrame, modeFrame]);
    const operation = yield* connect(p.operationPort, "/ws", undefined);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.frames).toHaveLength(3)));
    const next = { ...snapshot, round: 2 };
    yield* p.viewers.publish(next);
    yield* Effect.tryPromise(() => vi.waitFor(() => {
      expect(viewing.frames.at(-1)).toEqual(snapshotFrame(next));
      expect(operation.frames.at(-1)).toEqual(snapshotFrame(next));
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
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames.at(-1)).toEqual(snapshotFrame(next))));
    // 送ったものは何も返ってこず、閉じられない
    expect(viewing.frames).toEqual([snapshotFrame(snapshot), snapshotFrame(next)]);
    expect(viewing.isOpen()).toBe(true);
    // 新しく繋いだクライアントには、送ったメッセージの影響のない保持値が届く
    const later = yield* connect(p.viewingPort, "/ws", ALLOWED);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(later.frames).toEqual([snapshotFrame(next)])));
  }));

  it.live("Scope を閉じると閲覧の口は閉じ、操作の口は動き続ける", () => Effect.gen(function* () {
    const p = yield* ports();
    expect((yield* Effect.tryPromise(() => get(p.viewingPort, "/", undefined))).status).toBe(200);
    yield* Scope.close(p.viewingScope, Exit.void);
    yield* Effect.tryPromise(() => expect(get(p.viewingPort, "/", undefined)).rejects.toThrow());
    // 操作の口の保持値は閲覧の口を閉じても消えない
    yield* p.viewers.publish(snapshot);
    const operation = yield* connect(p.operationPort, "/ws", undefined);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.frames).toEqual([snapshotFrame(snapshot)])));
  }));

  describe("ping（Issue #833）", () => {
    const SHORT_MS = 30;

    it.live("閲覧の口の /ws へ、server から制御フレームの ping が繰り返し届く。アプリのフレームは増えない", () => Effect.gen(function* () {
      const p = yield* ports(SHORT_MS);
      const viewing = yield* connect(p.viewingPort, "/ws", ALLOWED);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.pings()).toBeGreaterThanOrEqual(2)));
      expect(viewing.frames).toEqual([]);
      expect(viewing.isOpen()).toBe(true);
    }));

    it.live("操作の口の /ws にも ping が繰り返し届く。アプリのフレームは増えない", () => Effect.gen(function* () {
      const p = yield* ports(SHORT_MS);
      const operation = yield* connect(p.operationPort, "/ws", undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.pings()).toBeGreaterThanOrEqual(2)));
      expect(operation.frames).toEqual([]);
      expect(operation.isOpen()).toBe(true);
    }));

    it.live("ping が流れても保持値と publish は今のまま届く", () => Effect.gen(function* () {
      const p = yield* ports(SHORT_MS);
      yield* p.viewers.publish(snapshot);
      const viewing = yield* connect(p.viewingPort, "/ws", ALLOWED);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.pings()).toBeGreaterThanOrEqual(1)));
      const next = { ...snapshot, round: 2 };
      yield* p.viewers.publish(next);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames).toEqual([snapshotFrame(snapshot), snapshotFrame(next)])));
    }));

    it.live("クライアントが切れた後も、別の接続には ping が届き続ける", () => Effect.gen(function* () {
      const p = yield* ports(SHORT_MS);
      const first = yield* connect(p.viewingPort, "/ws", ALLOWED);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(first.pings()).toBeGreaterThanOrEqual(1)));
      yield* Effect.sync(() => first.close());
      yield* Effect.tryPromise(() => first.closed);
      const second = yield* connect(p.viewingPort, "/ws", ALLOWED);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(second.pings()).toBeGreaterThanOrEqual(2)));
    }));

    it.live("クライアントが切れると、その接続の ping の周期タイマーが解除される（接続中は解除されない）", () => Effect.gen(function* () {
      const spyOn = <K extends "setInterval" | "clearInterval">(name: K) =>
        Effect.acquireRelease(Effect.sync(() => vi.spyOn(globalThis, name)), (spy) => Effect.sync(() => spy.mockRestore()));
      const setSpy = yield* spyOn("setInterval");
      const clearSpy = yield* spyOn("clearInterval");
      const p = yield* ports(SHORT_MS);
      const client = yield* connect(p.viewingPort, "/ws", ALLOWED);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(client.pings()).toBeGreaterThanOrEqual(1)));
      // 間隔が SHORT_MS の周期タイマーは、この接続のものだけ
      const pingTimers = setSpy.mock.calls.flatMap((call, i) => call[1] === SHORT_MS ? [setSpy.mock.results[i]?.value] : []);
      expect(pingTimers).toHaveLength(1);
      const timer = pingTimers[0];
      // 接続中は解除されていない
      expect(clearSpy.mock.calls.filter(([t]) => t === timer)).toHaveLength(0);
      yield* Effect.sync(() => client.close());
      yield* Effect.tryPromise(() => client.closed);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(clearSpy.mock.calls.filter(([t]) => t === timer)).toHaveLength(1)));
    }));

    it.live("間隔を渡さない既定では、短い間に ping は来ない（既定は 30 秒）", () => Effect.gen(function* () {
      const p = yield* ports();
      const viewing = yield* connect(p.viewingPort, "/ws", ALLOWED);
      const operation = yield* connect(p.operationPort, "/ws", undefined);
      yield* Effect.sleep("300 millis");
      expect([viewing.pings(), operation.pings()]).toEqual([0, 0]);
    }));
  });
});
