import { randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import { WebSocket } from "ws";
import { ManagedDeps } from "../src/managedDeps.ts";
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { DiffUpdatePaused, type DiffUpdateFrame, DiffUpdater, type Op } from "../src/core/index.ts";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { HttpClient, type HttpClientRequest } from "effect/http";
import { ConfigProvider, Console, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope, Stream, type Cause } from "effect";
import { TestClock } from "effect/testing";
import { MapCapture } from "../src/capture.ts";
import { AgentSdk, layerClaude } from "../src/claude.ts";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../src/helpers.ts";
import { reportFailure, runCli } from "../src/cli.ts";
import { WS_CLOSE_TIMEOUT_MS } from "../src/http.ts";
import type { ServerLayers } from "../src/server.ts";
import { ReviewBuild } from "../src/review.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { buildPrompt } from "../src/claudePrompt.ts";
import { vocabularyPoolPath } from "../src/vocabularyPool.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { allowedMails } from "./fixtures/allowedMail.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { fakeTunnel, FAKE_TUNNEL_HOST } from "./fixtures/tunnel.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { connect } from "./fixtures/wsClient.ts";

const apps = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];

// 偽の Helpers・SessionSinks の Layer を受け取れる新しい入口（server.ts、CT-ENTRY-LAYERS）を通すテスト用の資源。
// resume が諦める／resume の起動中に stop する、といった起動し直しの失敗経路は、fake-helper.ts から
// attempts・listenDelayMs を削った後（CT-FAKE-TRIM）は実物の子プロセスで再現できないため、ここで偽の
// Helpers を使う（要件92）。Origin の拒否・body.audio の 400 は、実物の子プロセスを起動せずに確認できる
// ため、同じ入口を使う（要件97, 98）。
type AttemptScript = {
  connect?: boolean; // 既定 true。false なら接続失敗（HelperLaunchFailure）
  hold?: boolean; // true なら接続を保留する（stop の印が立つまで接続も失敗もしない。実物の「接続待ち」）
  stderrTail?: string[];
  unexpectedExit?: { afterMs: number; exit: HelperExitInfo }; // 自発的な予期せぬ終了
  exitAfterStop?: HelperExitInfo; // stop が呼ばれたときの終わり方（既定 SIGTERM）
  events?: unknown[]; // 接続した直後にヘルパーが流すイベント（JSON にして events の Stream に載せる）
};

const makeFakeHelpers = (attempts: AttemptScript[], permission: { microphone: "authorized" | "denied" | "notDetermined"; screenCapture: boolean } = { microphone: "authorized", screenCapture: true }) => {
  const calls: string[][] = [];
  const checks: boolean[] = [];
  const sent: boolean[] = []; // server から helper へ送られた休止の指示（paused の値を届いた順に）
  const check = Effect.sync(() => {
    checks.push(true);
    return { ...permission, speechJa: { status: "installed" as const, installedLocales: ["ja-JP"] } };
  });
  const checkNoScreen = Effect.sync(() => {
    checks.push(false);
    return { microphone: permission.microphone, speechJa: { status: "installed" as const, installedLocales: ["ja-JP"] } };
  });
  const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      const index = calls.length;
      calls.push([...args]);
      const script = attempts[Math.min(index, attempts.length - 1)] ?? {};
      if (script.connect === false) return yield* new HelperLaunchFailure({ stderrTail: script.stderrTail ?? [] });
      if (script.hold) {
        yield* Deferred.await(stopRequested); // 止めて、の印で、ヘルパーが止まって接続待ちが失敗する
        return yield* new HelperLaunchFailure({ stderrTail: [], exit: { code: null, signal: "SIGTERM" } });
      }
      const queue = yield* Queue.make<unknown, Cause.Done>();
      for (const event of script.events ?? []) Queue.offerUnsafe(queue, JSON.stringify(event));
      const exitDeferred = yield* Deferred.make<HelperExitInfo>();
      const stoppedRef = yield* Ref.make(false);
      if (script.unexpectedExit) {
        yield* Effect.forkScoped(Effect.gen(function* () {
          yield* Effect.sleep(script.unexpectedExit!.afterMs);
          const already = yield* Ref.getAndSet(stoppedRef, true);
          if (already) return;
          yield* Queue.end(queue);
          yield* Deferred.succeed(exitDeferred, script.unexpectedExit!.exit);
        }));
      }
      const stop = Effect.gen(function* () {
        const already = yield* Ref.getAndSet(stoppedRef, true);
        if (already) return;
        yield* Queue.end(queue);
        yield* Deferred.succeed(exitDeferred, script.exitAfterStop ?? { code: null, signal: "SIGTERM" });
      });
      yield* Effect.addFinalizer(() => Effect.ignore(stop));
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exitDeferred), stderrTail: Effect.succeed(script.stderrTail ?? []), send: (instruction: { type: string; paused: boolean }) => Effect.sync(() => { if (instruction.type === "self-pause") sent.push(instruction.paused); }) };
    });
  const service = { apps: Effect.succeed(apps), check, checkNoScreen, creationDate: () => Effect.succeed(null), launch };
  return { helpers: Helpers.of({ ...service, installSpeechJa: Stream.die("このテストでは日本語モデルを導入しない") }), calls, checks, sent };
};

const resourceWithFakeHelpers = Effect.fnUntraced(function* (attempts: AttemptScript[], options: { managedDeps?: Layer.Layer<ManagedDeps>; updaterLayer?: () => Layer.Layer<DiffUpdater>; permission?: { microphone: "authorized" | "denied" | "notDetermined"; screenCapture: boolean }; viewing?: ServerLayers["viewing"] } & Pick<ExportServicesOptions, "capture"> = {}) {
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-http-fake-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const sessionsDir = join(dir, "sessions");
  const fakeHelpers = makeFakeHelpers(attempts, options.permission);
  const sessionSinksLayer = SessionSinks.layer({
    prepareUpdater: () => Effect.succeed({ layer: options.updaterLayer ? options.updaterLayer() : updaterLayer(() => Effect.succeed({ ops: [] })) }),
  }).pipe(Layer.provide(fakeExportServices({ capture: options.capture })));
  const server = yield* startedServer(
    { port: 0, sessionsDir },
    { helpers: Layer.succeed(Helpers)(fakeHelpers.helpers), sessionSinks: sessionSinksLayer, managedDeps: options.managedDeps ?? readyManagedDeps, ...(options.viewing === undefined ? {} : { viewing: options.viewing }) },
  );
  return {
    server, calls: fakeHelpers.calls, checks: fakeHelpers.checks, sent: fakeHelpers.sent, sessionsDir,
    request: (method: string, path: string, body: string | undefined, origin: string | undefined) => fetch(
      `http://127.0.0.1:${server.port}${path}`,
      { method, headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) }, ...(body === undefined ? {} : { body }) },
    ),
  };
});

// ws は close に自動応答するため、非応答の接続は生 TCP で再現する。
const connectUnresponsive = Effect.fnUntraced(function* (port: number) {
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => netConnect(port, "127.0.0.1")),
    (connection) => Effect.sync(() => connection.destroy()),
  );
  let response = "";
  socket.on("data", (data) => { response += data.toString(); });
  const upgraded = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.once("error", reject);
    socket.on("data", () => { if (response.includes("\r\n\r\n")) resolve(); });
  });
  yield* Effect.tryPromise(() => upgraded).pipe(Effect.timeout("5 seconds"));
  expect(response).toMatch(/^HTTP\/1\.1 101 /);
});

describe("HTTP 本文の検証（要件8・12）", () => {
  const invalid = [
    { name: "app欠落", body: {} },
    { name: "app空文字列", body: { app: "" } },
    { name: "appが数値", body: { app: 1 } },
    { name: "titleが真偽値", body: { app: "us.zoom.xos", title: false, audio: false } },
    // audio が boolean 以外（"no"・0・"false" を含む）のケースは、新しい入口（偽の Helpers）を使う
    // 「新しい入口（...）」describe の方で、より網羅的に確かめる（要件98。重複させない）
    { name: "本文がnull", body: null },
    { name: "本文が配列", body: [] },
  ];
  for (const { name, body } of invalid) {
    it.live(`${name}なら400のerror JSONで拒否し、開始しない。修正した本文なら開始できる`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify(body), undefined));
        expect(response.status).toBe(400);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: expect.any(String) });
        expect(r.calls).toEqual([]);
        expect(yield* Effect.tryPromise(() => readdir(r.sessionsDir).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return [];
          throw e;
        }))).toEqual([]);
        const valid = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify({ app: "us.zoom.xos", title: "週次", audio: false }), undefined));
        expect(valid.status).toBe(200);
        expect(yield* Effect.tryPromise(() => valid.json())).toEqual({ dir: expect.any(String), warnings: [] });
      }));
  }

  it.live("不正なJSONは400のerror JSONで拒否する", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", "{", undefined));
      expect(response.status).toBe(400);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: expect.any(String) });
      expect(r.calls).toEqual([]);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
    }));

});

describe("HTTP の失敗応答（要件8〜11）", () => {
  for (const path of ["/session/stop", "/session/resume"]) {
    it.live(`${path}: セッションなしは409と既存の文面を返す`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        const response = yield* Effect.tryPromise(() => r.request("POST", path, undefined, undefined));
        expect(response.status).toBe(409);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "進行中のセッションがありません" });
      }));
  }
  it.live("進行中のstartと動作中のresumeは409と各条件の文面を返す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const body = '{"app":"us.zoom.xos","audio":false}';
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", body, undefined))).status).toBe(200);
      const busy = yield* Effect.tryPromise(() => r.request("POST", "/session/start", body, undefined));
      expect(busy.status).toBe(409);
      expect(yield* Effect.tryPromise(() => busy.json())).toEqual({ error: "セッションが進行中です（先に stop）" });
      const resume = yield* Effect.tryPromise(() => r.request("POST", "/session/resume", undefined, undefined));
      expect(resume.status).toBe(409);
      expect(yield* Effect.tryPromise(() => resume.json())).toEqual({ error: "取り込みは止まっていません（動いているか、起動し直しの最中です）" });
    }));
  it.live("未知のルートは404と既存の文面を返す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const response = yield* Effect.tryPromise(() => r.request("GET", "/missing", undefined, undefined));
      expect(response.status).toBe(404);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "未対応のリクエスト: GET /missing" });
    }));
  for (const failure of [new Error("updaterの取得失敗"), "タグのない失敗"]) {
    it.live(`予期しない失敗の文面を伏せず500のerror JSONで返す: ${String(failure)}`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}], { updaterLayer: () => Layer.effect(DiffUpdater, Effect.die(failure)) });
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
        expect(response.status).toBe(500);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: failure instanceof Error ? failure.message : failure });
      }));
  }
});


describe("HTTP と両upgradeの共通Origin制限（要件2・13・24）", () => {
  const allowed = [undefined, "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"];
  for (const origin of allowed) {
    it.live(`Origin ${String(origin)} はHTTP、/、/wsで受理され同じ最新マップが届く`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        const response = yield* Effect.tryPromise(() => r.request("GET", "/apps", undefined, origin));
        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual(apps);
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","title":"週次","audio":false}', origin))).status).toBe(200);
        const clients = [yield* connect(r.server.port, "/", origin), yield* connect(r.server.port, "/ws", origin)];
        // マップのほかに、差分更新の状態（type: "diff-update"）も接続時に届く。ここで確かめるのはマップだけ
        const map = { nodes: [{ id: "root", parent: null, kind: "会議", text: "週次", evidence: [] }], round: 0, changes: [], remarks: [] };
        for (const c of clients) {
          yield* Effect.tryPromise(() => vi.waitFor(() => expect(c.frames).toContainEqual(map), { timeout: 10_000 }));
          expect(c.frames.filter((frame) => !(typeof frame === "object" && frame !== null && "type" in frame))).toEqual([map]);
        }
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, origin))).status).toBe(200);
        for (const c of clients) yield* Effect.tryPromise(() => vi.waitFor(() => expect(c.frames).toContainEqual({ type: "intake", status: "none" }), { timeout: 10_000 }));
      }));
  }
  for (const origin of ["https://evil.example", "null", "http://localhost.evil.example"]) {
    it.live(`Origin ${origin} はHTTPと両upgradeで403になり、配信されない`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        const body = '{"app":"us.zoom.xos","audio":false}';
        const deniedStart = yield* Effect.tryPromise(() => r.request("POST", "/session/start", body, origin));
        expect(deniedStart.status).toBe(403);
        expect(yield* Effect.tryPromise(() => deniedStart.json())).toEqual({ error: "許可されていない Origin です" });
        expect(r.calls).toEqual([]);
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", body, undefined))).status).toBe(200);
        for (const path of ["/", "/ws"]) {
          const allowed = yield* connect(r.server.port, path, undefined);
          yield* Effect.tryPromise(() => vi.waitFor(() => expect(allowed.frames).toContainEqual(expect.objectContaining({ round: 0 }))));
          const ws = yield* Effect.acquireRelease(
            Effect.sync(() => new WebSocket(`ws://127.0.0.1:${r.server.port}${path}`, { origin })),
            (socket) => Effect.sync(() => socket.terminate()),
          );
          const frames: unknown[] = [];
          ws.on("message", (data) => frames.push(JSON.parse(String(data))));
          const status = yield* Effect.tryPromise(() => new Promise<number | undefined>((resolve, reject) => {
            ws.on("error", reject);
            ws.on("open", () => reject(new Error("許可していないOriginがupgradeされた")));
            ws.on("unexpected-response", (_req, response) => {
              response.resume();
              ws.terminate();
              resolve(response.statusCode);
            });
          }));
          expect(status).toBe(403);
          expect(frames).toEqual([]);
        }
      }));
  }
  it.live("closeで接続中のクライアントが切断され、同じポートは新しい接続を受け付けない（要件7）", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const c = yield* connect(r.server.port, "/ws", undefined);
      expect((yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined))).status).toBe(200);
      yield* r.server.close;
      yield* Effect.tryPromise(() => c.closed);
      yield* Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${r.server.port}/session/status`)).rejects.toThrow());
      expect(c.frames).toEqual([]);
    }));
  // close フレームに応答しない接続が 1 本残っていても、close() の所要時間はその接続の応答に依存しない有界な
  // 値になる（coding-001）。上限（WS_CLOSE_TIMEOUT_MS。既定 3 秒）はテストだけ短い値を与え、経過時間を
  // 「上限以上」（応答を待たずに切る誤りを落とす）と「上限 + 2 秒未満」（与えた上限が効かず既定の 3 秒や
  // ws の既定 30 秒まで待つ誤りを落とす）で挟む
  const WS_CLOSE_LIMIT_MS = 500;
  it.live("close フレームに応答しない接続があっても、closeは与えた上限で解決する（ISSUE-2）", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]).pipe(Effect.provideService(WS_CLOSE_TIMEOUT_MS, WS_CLOSE_LIMIT_MS));
      yield* connectUnresponsive(r.server.port);
      const startedAt = Date.now();
      yield* r.server.close;
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(WS_CLOSE_LIMIT_MS);
      expect(elapsed).toBeLessThan(WS_CLOSE_LIMIT_MS + 2_000);
    }), 15_000);
});

describe("セッションの開始・終了の処理中の保護（要件8・testing-001）", () => {
  // 開始・終了の処理中（starting/stopping）に別の操作が来ると、SessionTransition として 409 になる
  // （http.ts の STATUS・sessionFailure.ts の文面）。この経路は、stop の処理中に capture（MapCapture の Service。
  // 終了時の書き出しが文脈から受け取る）へ到達するまで待ち、確実に stopping のままの状態で start を送ることで再現する。
  // SessionBusy（live 中の start、既存テストで検証済み）と同じ 409 でも文面が異なるため、文面まで確認する
  it.live("stopの処理中にstartすると409と専用の文面を返す（SessionTransition）", () => {
    let releaseCapture: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let notifyReachedCapture: (() => void) | undefined;
    const reachedCapture = new Promise<void>((resolve) => {
      notifyReachedCapture = resolve;
    });
    return Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}], {
        capture: (_snapshot, path) =>
          Effect.promise(async () => {
            notifyReachedCapture!(); // ここに来た時点で state は確実に "stopping"（stop() が同期的に遷移させた後）
            await released; // テストが 409 を確認するまで、stop の応答をここで止めておく
            await writeFile(path, "");
          }),
      });
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
      const stopping = r.request("POST", "/session/stop", undefined, undefined); // await しない。処理中に start を送る
      yield* Effect.tryPromise(() => reachedCapture).pipe(Effect.timeout("5 seconds"));
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
      expect(response.status).toBe(409);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "セッションの開始・終了の処理中です" });
      releaseCapture!();
      expect((yield* Effect.tryPromise(() => stopping)).status).toBe(200);
    }).pipe(Effect.ensuring(Effect.sync(() => releaseCapture!()))); // assert が失敗しても stop を解放する
  });
});

describe("HTTP の失敗応答（要件8〜11）", () => {
  it.effect("同じライブセッションの一時停止・再開・終了が接続中と再接続の画面へ届く", () => Effect.gen(function* () {
    let calls = 0;
    const r = yield* resourceWithFakeHelpers([{ events: [
      { type: "speaker-off", start: 0, reason: "モデルなし" }, // 相手の発言は話者の確定を待つので、話者分離を使えない helper にして待たせない（Issue #1021）
      { type: "remark", track: "相手", start: 0, end: 1, text: "最初の発言" },
      { type: "remark", track: "相手", start: 1, end: 2, text: "次の発言" },
    ] }], { updaterLayer: () => updaterLayer(() => Effect.suspend(() => {
      calls++;
      return calls === 1 ? Effect.fail(new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "合成の利用上限" })) : Effect.succeed({ ops: [] });
    })) });
    const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const first = yield* connect(r.server.port, "/ws", undefined).pipe(Scope.provide(firstScope));
    const frames = (all: unknown[]) => all.filter((f): f is DiffUpdateFrame => typeof f === "object" && f !== null && "type" in f && f.type === "diff-update");
    const wait = (all: unknown[], state: DiffUpdateFrame["state"]) => Effect.tryPromise(() => vi.waitFor(() => expect(frames(all).at(-1)?.state).toEqual(state)));
    expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
    const paused = { status: "paused", reason: "ChatGPT の利用上限" } as const;
    yield* wait(first.frames, paused);
    expect(frames(first.frames).map((f) => f.state)).toEqual([{ status: "running" }, paused]);
    yield* Scope.close(firstScope, Exit.void);
    const reconnected = yield* connect(r.server.port, "/ws", undefined);
    yield* wait(reconnected.frames, paused);
    yield* TestClock.adjust(300_000);
    yield* wait(reconnected.frames, { status: "running" });
    expect(calls).toBe(2);
    expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
    yield* wait(reconnected.frames, null);
    const after = yield* connect(r.server.port, "/ws", undefined);
    yield* wait(after.frames, null);
    expect(frames(after.frames)).toEqual([{ type: "diff-update", state: null }]);
  }));
  // 偽の Helpers の Layer（新しい入口、CT-ENTRY-LAYERS）を使う。fake-helper.ts から attempts・listenDelayMs を
  // 削った後（CT-FAKE-TRIM）は、この 2 本を実物の子プロセスで再現できない（要件92）。期待値は変えない。
  // 1 回目（start の初回起動）は接続してから予期せず終わる（続けて失敗した回に数える）。2・3 回目の失敗で諦める
  const firstAttemptExits: AttemptScript = { unexpectedExit: { afterMs: 50, exit: { code: 1, signal: null } } };
  const giveUpAttempts: AttemptScript[] = [
    { connect: false, stderrTail: ["初回の再起動失敗"] },
    { connect: false, stderrTail: ["初回の再起動失敗"] },
  ];
  it.live("resumeが再起動を諦めると503で最後のstderrを返す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([
        firstAttemptExits,
        ...giveUpAttempts, // 2・3 回目の失敗で諦める
        { connect: false, stderrTail: ["途中の失敗"] },
        { connect: false, stderrTail: ["途中の失敗"] },
        { connect: false, stderrTail: ["最後の失敗"] },
      ]);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(async () => {
        const response = await r.request("GET", "/session/status", undefined, undefined);
        expect(await response.json()).toMatchObject({ status: "stopped" });
      }, { timeout: 10_000 }));
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/resume", undefined, undefined));
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "起動し直しに失敗しました: 最後の失敗" });
    }));
  it.live("resumeの起動中にstopすると503で中断を返す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([firstAttemptExits, ...giveUpAttempts, { hold: true }]); // resume の起動し直しは接続待ちのまま止める
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(async () => {
        const response = await r.request("GET", "/session/status", undefined, undefined);
        expect(await response.json()).toMatchObject({ status: "stopped" });
      }, { timeout: 10_000 }));
      const resuming = r.request("POST", "/session/resume", undefined, undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(r.calls).toHaveLength(4), { timeout: 10_000 }));
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      const response = yield* Effect.tryPromise(() => resuming);
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "中断されました" });
    }));
});

describe("新しい入口（偽の Helpers・SessionSinks を受け取れるサーバー。CT-ENTRY-LAYERS）", () => {
  it.live("711-2: HTTP start は版違いの必須 SDK を警告して開始する", () => Effect.gen(function* () {
    const service = {
      executable: () => Effect.die("実行ファイル取得は対象外"),
      check: () => Effect.succeed([{ name: "claude" as const, need: "optional" as const, state: "outdated" as const, version: "0.0.0" }]),
      load: () => Effect.die("偽 updater は SDK を読まない"),
      install: () => Stream.die("開始は導入しない"), update: () => Stream.die("開始は更新しない"),
    };
    const r = yield* resourceWithFakeHelpers([{}], { managedDeps: Layer.succeed(ManagedDeps, ManagedDeps.of(service)) });
    const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
    expect(response.status).toBe(200);
    const body = yield* Effect.tryPromise(() => response.json());
    expect(body.warnings).toEqual([`警告: claude（Claude Agent SDK、約 224MB） が版違いです（入っている版 0.0.0、固定版 ${claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"]}）。そろえるには: pnpm cli update claude`]);
    expect(r.calls).toHaveLength(1);
    const status = yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined));
    expect(yield* Effect.tryPromise(() => status.json())).toMatchObject({ status: "running", dir: body.dir });
  }));

  it.live.each([
    { microphone: "authorized", screenCapture: true, warnings: [] },
    { microphone: "denied", screenCapture: false, warnings: ["マイクの許可がありません。自分の声が入りません", "画面収録の許可がありません。共有画面は読まず、音声だけで始めます"] },
    { microphone: "notDetermined", screenCapture: true, warnings: ["マイクの許可が未決定です。開始時に許可のダイアログが出ます"] },
  ] as const)("C2: $microphone / screen=$screenCapture でも警告して開始する", ({ microphone, screenCapture, warnings }) => Effect.gen(function* () {
    const r = yield* resourceWithFakeHelpers([{}], { permission: { microphone, screenCapture } });
    const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
    expect(response.status).toBe(200);
    const body = yield* Effect.tryPromise(() => response.json());
    expect(body.warnings ?? []).toEqual(warnings);
    expect(r.checks).toEqual([true]);
    expect(r.calls).toHaveLength(1);
    const status = yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined));
    expect(yield* Effect.tryPromise(() => status.json())).toMatchObject({ status: "running", dir: body.dir });
  }));

  it.live("C4: screen=false は画面の確認と警告を省き、マイクの警告だけで開始する", () => Effect.gen(function* () {
    const r = yield* resourceWithFakeHelpers([{}], { permission: { microphone: "denied", screenCapture: false } });
    const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false,"screen":false}', undefined));
    expect(response.status).toBe(200);
    expect((yield* Effect.tryPromise(() => response.json())).warnings).toEqual(["マイクの許可がありません。自分の声が入りません"]);
    expect(r.checks).toEqual([false]);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("--no-screen");
  }));

  it.live.each([false, true])("C2・C4: resume と check resume は保存済み screen=%s で許可を確認する", (screen) => Effect.gen(function* () {
    const permission = { microphone: "authorized" as "authorized" | "denied", screenCapture: false };
    const r = yield* resourceWithFakeHelpers([
      { unexpectedExit: { afterMs: 50, exit: { code: 1, signal: null } } },
      { connect: false }, { connect: false }, {},
    ], { permission });
    const start = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify({ app: "us.zoom.xos", audio: false, screen }), undefined));
    expect(start.status).toBe(200);
    const { dir } = yield* Effect.tryPromise(() => start.json());
    yield* Effect.tryPromise(() => vi.waitFor(async () => {
      expect(await (await r.request("GET", "/session/status", undefined, undefined)).json()).toMatchObject({ status: "stopped" });
    }, { timeout: 10_000 }));
    permission.microphone = "denied";
    const checked = yield* Effect.tryPromise(() => r.request("GET", "/check?for=resume", undefined, undefined));
    expect(checked.status).toBe(200);
    const report = yield* Effect.tryPromise(() => checked.json());
    expect(report.ready).toBe(true);
    expect(report.items.filter((item: { name: string }) => ["microphone", "screen-capture"].includes(item.name))).toEqual([
      { name: "microphone", need: "optional", state: "absent" },
      ...(screen ? [{ name: "screen-capture", need: "optional", state: "absent" }] : []),
    ]);
    const resumed = yield* Effect.tryPromise(() => r.request("POST", "/session/resume", undefined, undefined));
    expect(resumed.status).toBe(200);
    expect((yield* Effect.tryPromise(() => resumed.json())).warnings).toEqual([
      "マイクの許可がありません。自分の声が入りません",
      ...(screen ? ["画面収録の許可がありません。共有画面は読まず、音声だけで始めます"] : []),
    ]);
    expect(r.checks).toEqual([screen, screen, screen]);
    const status = yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined));
    expect(yield* Effect.tryPromise(() => status.json())).toMatchObject({ status: "running", dir, restarts: 1 });
  }));

  // Issue #645: 語彙の溜まりは、始めたセッションの数を持つ。数えるのは開始（start）で、resume は同じセッションを続けるので増やさない
  it.live("resume で続けたセッションは 1 セッションと数え、溜まりの始めたセッションの数が増えない。新しく start すると増える", () => Effect.gen(function* () {
    const r = yield* resourceWithFakeHelpers([
      { unexpectedExit: { afterMs: 50, exit: { code: 1, signal: null } } },
      { connect: false }, { connect: false }, {}, // start の初回起動が落ち、2・3 回目の失敗で諦めて止まる。resume の起動し直しは成功する
      {}, // 新しい start
    ]);
    const poolSessions = () => Effect.tryPromise(async () => JSON.parse(await readFile(vocabularyPoolPath(r.sessionsDir), "utf8")).sessions as number);
    const post = (path: string, body?: string) => Effect.tryPromise(() => r.request("POST", path, body, undefined));
    const statusIs = (status: string) => Effect.tryPromise(() => vi.waitFor(async () => {
      expect(await (await r.request("GET", "/session/status", undefined, undefined)).json()).toMatchObject({ status });
    }, { timeout: 10_000 }));

    expect((yield* post("/session/start", '{"app":"us.zoom.xos","audio":false}')).status).toBe(200);
    expect(yield* poolSessions()).toBe(1);
    yield* statusIs("stopped");
    expect(yield* poolSessions()).toBe(1); // resume の前に、すでに 1（このテストが数えた後の状態に届いている）

    expect((yield* post("/session/resume")).status).toBe(200);
    yield* statusIs("running");
    expect(yield* poolSessions()).toBe(1);
    expect((yield* post("/session/stop")).status).toBe(200);
    expect(yield* poolSessions()).toBe(1);

    expect((yield* post("/session/start", '{"app":"us.zoom.xos","audio":false}')).status).toBe(200);
    expect(yield* poolSessions()).toBe(2);
    expect((yield* post("/session/stop")).status).toBe(200);
  }));

  it.live("ヘルパーが接続する前に終わると start は500で、終わった理由の文面を返し、セッションは開始されない（HelperExited）", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{ connect: false, stderrTail: ["マイクが許可されていません"] }]);
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
      expect(response.status).toBe(500);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "ヘルパーが終了しました（null）: マイクが許可されていません" });
      const status = yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined));
      expect(yield* Effect.tryPromise(() => status.json())).toMatchObject({ status: "none" });
    }));

  // base の server.heavy.test.ts「開始に失敗しても、接続中のクライアントにも新しく接続したクライアントにも、空のマップは届かず…」の移動先。
  // 実物の SessionSinks・Viewers・/ws を通す。sessions.ts が sinks.open を helpers.launch より前に動かす、
  // または失敗時に viewers.publish を呼ぶと、before/after が「失敗」のマップを受け取りこのテストは落ちる。
  // base の値（4 ノード・子の文面）は実物 fake-helper の台本と updater から決まっていた。偽 Helpers はイベントを
  // 送らず updater は ops: [] なので root だけになる（[[1,"前"],[1,"次"]]）。守る不変条件（失敗の前後で
  // スナップショットが増えない・新しいクライアントには前のセッションの最後のマップが届く）は同じ
  it.live("開始に失敗しても、接続中のクライアントにも新しく接続したクライアントにも、空のマップは届かず、前のセッションの最後のマップが残る", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}, { connect: false, stderrTail: ["マイクが許可されていません"] }, {}]);
      const post = (path: string, body?: string) => Effect.tryPromise(() => r.request("POST", path, body, undefined));
      type Snap = { nodes: { text: string }[] };
      const snapshots = (frames: unknown[]) => frames.filter((f) => !(typeof f === "object" && f !== null && "type" in f)) as Snap[];
      const waitCount = (frames: unknown[], n: number) => Effect.tryPromise(() => vi.waitFor(() => expect(snapshots(frames)).toHaveLength(n)));

      expect((yield* post("/session/start", '{"app":"us.zoom.xos","title":"前","audio":false}')).status).toBe(200);
      expect((yield* post("/session/stop")).status).toBe(200);
      const before = yield* connect(r.server.port, "/ws", undefined);
      yield* waitCount(before.frames, 1);

      const failed = yield* post("/session/start", '{"app":"us.zoom.xos","title":"失敗","audio":false}');
      expect(failed.status).toBe(500);
      expect(yield* Effect.tryPromise(() => failed.json())).toEqual({ error: "ヘルパーが終了しました（null）: マイクが許可されていません" });

      const after = yield* connect(r.server.port, "/ws", undefined);
      yield* waitCount(after.frames, 1);
      expect(snapshots(after.frames)[0]!.nodes.map((n) => n.text)).toEqual(["前"]);

      expect((yield* post("/session/start", '{"app":"us.zoom.xos","title":"次","audio":false}')).status).toBe(200);
      expect((yield* post("/session/stop")).status).toBe(200);
      yield* waitCount(before.frames, 2);
      expect(snapshots(before.frames).map((s) => [s.nodes.length, s.nodes[0]!.text])).toEqual([[1, "前"], [1, "次"]]);
      expect(snapshots(after.frames).map((s) => s.nodes[0]!.text)).toEqual(["前", "次"]);
    }));

  // base の server.heavy.test.ts「cli status が…」の配線部分（cli.ts の status → GET /session/status → formatIntakeStatus → 標準出力）の移動先
  it.live("cli status が、セッションなし・動いている・stop 後の状態を、サーバーの応答から標準出力へ値として出す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      // 接続先ポートと保存先は ConfigProvider、標準出力は Console で渡す（cli.ts の入口と同じ Service）
      const status = () => Effect.suspend(() => {
        const out: string[] = [];
        const consoleService: Console.Console = {
          ...console,
          log: (...args: unknown[]) => { out.push(args.map(String).join(" ") + "\n"); },
        };
        const cliLayer = Layer.mergeAll(forbiddenManagedDeps,
          NodeServices.layer, unusedApple,
          NodeHttpClient.layerUndici,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: r.sessionsDir, LIVE_MINDMAP_PORT: String(r.server.port) })),
          Layer.succeed(Console.Console, consoleService),
          Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.void })),
          Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("") })),
          fakeAudioMix().layer,
          fakeScreenJpeg().layer,
        );
        return runCli(["status"]).pipe(Effect.provide(cliLayer), Effect.map(() => out.join("")));
      });
      expect(yield* status()).toBe("セッションなし\n閲覧の共有: 無し\n");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","title":"週次","audio":false}', undefined))).status).toBe(200);
      const [dir] = (yield* Effect.tryPromise(() => readdir(r.sessionsDir, { withFileTypes: true }))).filter((entry) => entry.isDirectory()).map((entry) => entry.name); // 語彙の溜まりのファイルは除く
      const running = yield* status();
      expect(running).toContain("動いている");
      expect(running).toContain(dir!);
      expect(running).toContain("起動し直した回数: 0");
      expect(running).not.toContain("最後の途切れの時刻");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      // 通常の stop の後は none に戻る。「止まった」（諦めた状態）の文面は intake.test.ts、状態の値は sessions.test.ts が観測する
      expect(yield* status()).toBe("セッションなし\n閲覧の共有: 無し\n");
    }));

  describe("自分の休止（POST /session/self-pause）", () => {
    const selfPause = (r: { request: (m: string, p: string, b: string | undefined, o: string | undefined) => Promise<Response> }, body: string | undefined) =>
      Effect.tryPromise(() => r.request("POST", "/session/self-pause", body, undefined));

    it.live("セッション中に {paused:true} を送ると 204 になり、helper へ休止の指示が届く。{paused:false} で再開の指示が届く", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);

        expect((yield* selfPause(r, '{"paused":true}')).status).toBe(204);
        expect(r.sent).toEqual([true]);
        expect((yield* selfPause(r, '{"paused":false}')).status).toBe(204);
        expect(r.sent).toEqual([true, false]);
      }));

    for (const body of ['{}', '{"paused":"true"}', '{"paused":1}', '{"paused":true,"extra":1}', "not json", undefined]) {
      it.live(`本文が ${String(body)} なら 400 で拒否し、helper へ何も送らない`, () =>
        Effect.gen(function* () {
          const r = yield* resourceWithFakeHelpers([{}]);
          yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));

          expect((yield* selfPause(r, body)).status).toBe(400);
          expect(r.sent).toEqual([]);
        }));
    }

    it.live("セッションが無いときは 409 で、helper へ何も送らない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        expect((yield* selfPause(r, '{"paused":true}')).status).toBe(409);
        expect(r.sent).toEqual([]);
      }));

    it.live("非ローカル Origin からは 403 で拒否し、helper へ何も送らない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/self-pause", '{"paused":true}', "https://evil.example"));
        expect(response.status).toBe(403);
        expect(r.sent).toEqual([]);
      }));
  });

  // Issue #1026: 話者の名前（POST /session/speaker-name）。ラベルは、ヘルパーの speaker と発言で振られたものだけ
  describe("話者の名前（POST /session/speaker-name）", () => {
    type Requester = { request: (m: string, p: string, b: string | undefined, o: string | undefined) => Promise<Response> };
    const START = '{"app":"us.zoom.xos","audio":false}';
    const speakerName = (r: Requester, body: string | undefined, origin?: string) => Effect.tryPromise(() => r.request("POST", "/session/speaker-name", body, origin));
    const nameBody = (label: string, name: string) => JSON.stringify({ label, name });
    // 相手の 2 人が 1 発言ずつ話す台本（相手 A・相手 B が振られる）。start で一度に流れる
    const twoSpeakers = (start: number): unknown[] => [0, 1].flatMap((slot) => [
      { type: "speaker", track: "相手", start: start + slot * 2, end: start + slot * 2 + 2, slot, final: true },
      { type: "speaker-settled", track: "相手", to: start + slot * 2 + 2 },
      { type: "remark", track: "相手", start: start + slot * 2, end: start + slot * 2 + 2, text: `発言${slot + 1}です` },
    ]);
    // 振られるまで待って名前を付ける（振る前は 4xx で断られるので、204 になるまで繰り返す）
    const nameWhenLabeled = (r: Requester, label: string, name: string) => Effect.tryPromise(() => vi.waitFor(async () => {
      expect((await r.request("POST", "/session/speaker-name", nameBody(label, name), undefined)).status).toBe(204);
    }, { timeout: 10_000 }));
    const names = (frames: unknown[]) => frames
      .filter((f): f is { type: "speaker-names"; names: Array<{ label: string; name: string }> } => typeof f === "object" && f !== null && "type" in f && f.type === "speaker-names")
      .map((f) => f.names);
    const logLines = (dir: string) => Effect.tryPromise(async () => (await readFile(join(dir, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type: string; label?: string; name?: string; source?: string; at?: string }));

    it.live("振られたラベルに {label,name} を送ると 204 になり、log.jsonl に手入力の名前が残り、つないでいる画面へ名前のフレームが届く", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        const viewer = yield* connect(r.server.port, "/ws", undefined);

        yield* nameWhenLabeled(r, "相手 B", "田中");

        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(viewer.frames).at(-1)).toEqual([{ label: "相手 B", name: "田中" }])));
        const lines = (yield* logLines(dir)).filter((l) => l.type === "speaker-name");
        expect(lines.map(({ at, ...rest }) => ({ hasAt: typeof at === "string", rest }))).toEqual([{ hasAt: true, rest: { type: "speaker-name", label: "相手 B", name: "田中", source: "手入力" } }]);
      }));

    it.live("後からつないだ画面にも、いまの名前が（最初のフレームとして）届く", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        yield* nameWhenLabeled(r, "相手 A", "鈴木");

        const late = yield* connect(r.server.port, "/ws", undefined);

        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(late.frames)).toEqual([[{ label: "相手 A", name: "鈴木" }]])));
      }));

    it.live("自分・まだ振られていないラベル・ラベルの無い「相手」・空の名前は 4xx で断り、log.jsonl にも画面のフレームにも何も出ない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        const viewer = yield* connect(r.server.port, "/ws", undefined);
        yield* nameWhenLabeled(r, "相手 A", "鈴木"); // 振られた後の状態で、断られることを示す
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(viewer.frames).at(-1)).toEqual([{ label: "相手 A", name: "鈴木" }])));
        const before = names(viewer.frames).length;

        for (const [label, name] of [["自分", "田中"], ["相手 C", "田中"], ["相手", "田中"], ["相手 A", ""], ["相手 A", "   "]] as const) {
          const response = yield* speakerName(r, nameBody(label, name));
          expect([label, name, response.status >= 400 && response.status < 500]).toEqual([label, name, true]);
        }

        expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name").map((l) => [l.label, l.name])).toEqual([["相手 A", "鈴木"]]); // 最初に付けた 1 件だけ
        yield* Effect.tryPromise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
        expect(names(viewer.frames)).toHaveLength(before);
        expect(names(viewer.frames).at(-1)).toEqual([{ label: "相手 A", name: "鈴木" }]); // 空の名前で外れていない
      }));

    for (const body of ['{}', '{"label":"相手 A"}', '{"name":"田中"}', '{"label":1,"name":"田中"}', '{"label":"相手 A","name":2}', '{"label":"相手 A","name":"田中","extra":1}', "not json", undefined]) {
      it.live(`本文が ${String(body)} なら 400 で拒否し、名前を付けない`, () =>
        Effect.gen(function* () {
          const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
          const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
          const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
          yield* nameWhenLabeled(r, "相手 B", "先に付けた名前"); // 振られた後でも、本文が違えば 400（振られていないことによる 4xx と区別する）

          expect((yield* speakerName(r, body)).status).toBe(400);

          expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name")).toHaveLength(1);
        }));
    }

    it.live("セッションが無いときは 409", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        expect((yield* speakerName(r, nameBody("相手 A", "田中"))).status).toBe(409);
      }));

    it.live("非ローカル Origin からは 403 で拒否し、名前を付けない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        yield* nameWhenLabeled(r, "相手 A", "先に付けた名前");

        expect((yield* speakerName(r, nameBody("相手 B", "田中"), "https://evil.example")).status).toBe(403);

        expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name").map((l) => l.label)).toEqual(["相手 A"]);
      }));

    // cli resume は同じセッションのヘルパーを起動し直すだけ。名前はサーバーのメモリに残り、起動し直した後の差分更新にも使われる
    it.live("取り込みが止まって resume しても名前が残る。resume の後の差分更新の直前の発言の行は 相手 B（田中）、新しくつないだ画面にも名前が届く", () =>
      Effect.gen(function* () {
        const prompts: string[][] = [];
        const r = yield* resourceWithFakeHelpers([
          { events: twoSpeakers(0), unexpectedExit: { afterMs: 1500, exit: { code: 1, signal: null } } },
          { connect: false }, { connect: false }, // 2・3 回目の失敗で諦めて止まる
          { events: [{ type: "speaker-off", start: 0, reason: "モデルなし" }, { type: "remark", track: "相手", start: 10, end: 12, text: "再開後の発言です" }] },
        ], { updaterLayer: () => updaterLayer((input) => Effect.sync(() => {
          prompts.push(buildPrompt(input).split("\n").filter((line) => /^r\d+ /.test(line)));
          return { ops: [] };
        })) });
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined))).status).toBe(200);
        yield* nameWhenLabeled(r, "相手 B", "田中");
        yield* Effect.tryPromise(() => vi.waitFor(async () => {
          expect(await (await r.request("GET", "/session/status", undefined, undefined)).json()).toMatchObject({ status: "stopped" });
        }, { timeout: 10_000 }));

        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/resume", undefined, undefined))).status).toBe(200);

        yield* Effect.tryPromise(() => vi.waitFor(() => {
          expect(prompts.flat().some((line) => line.includes("再開後の発言です"))).toBe(true);
        }, { timeout: 10_000 }));
        const afterResume = prompts.find((lines) => lines.some((line) => line.includes("再開後の発言です")))!;
        expect(afterResume.filter((line) => line.includes("発言2です"))).toEqual(["r2 [00:02] 相手 B（田中）: 発言2です"]);
        const reconnected = yield* connect(r.server.port, "/ws", undefined);
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(reconnected.frames).at(-1)).toEqual([{ label: "相手 B", name: "田中" }])));
        // resume の後も、振ったラベルには名前を付けられる（ラベルの状態も残っている）
        expect((yield* speakerName(r, nameBody("相手 A", "鈴木"))).status).toBe(204);
      }));

    // Issue #1028 AC4: 偽のヘルパー＋偽の AI で、HTTP の start → 名前付け → stop を通し、書き出した map.md / map.json に人と名前が載る
    it.live("start → 名前付け → stop の後、map.md は名前を付けたラベルを名前で・付けないラベルをラベルのまま出し、map.json のノードはラベルのまま、ルートに対応表が載る", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }], { updaterLayer: () => updaterLayer((input) => Effect.sync(() => ({
          ops: input.fresh.flatMap((remark): Op[] => {
            if (remark.text.includes("発言1です")) return [{ op: "add", ref: "p1", parent: "root", kind: "案", text: "週 1", evidence: [remark.id] }];
            if (remark.text.includes("発言2です")) return [
              { op: "add", ref: "p2", parent: "root", kind: "案", text: "隔週", evidence: [remark.id] },
              { op: "add", ref: "p3", parent: "root", kind: "TODO", text: "資料を送る", evidence: [remark.id], assigneeSpeaker: "相手 B" },
            ];
            return [];
          }),
        }))) });
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        expect(started.status).toBe(200);
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        yield* nameWhenLabeled(r, "相手 B", "田中"); // 相手 A には名前を付けない

        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);

        const md = yield* Effect.tryPromise(() => readFile(join(dir, "map.md"), "utf8"));
        const lines = md.split("\n");
        expect(lines).toContain("- 週 1 — 相手 A（00:00）");
        expect(lines).toContain("- 隔週 — 田中（00:02）");
        expect(lines.filter((l) => l === "- 資料を送る（担当：田中）（00:02）")).toHaveLength(2); // 冒頭の TODO 一覧とアウトライン
        expect(md).not.toContain("相手 B");
        const out = JSON.parse(yield* Effect.tryPromise(() => readFile(join(dir, "map.json"), "utf8"))) as { speakerNames?: unknown; root: { children: Array<{ text: string }> } };
        expect(out.speakerNames).toEqual({ "相手 B": "田中" });
        const byText = (text: string) => out.root.children.find((c) => c.text === text);
        expect(byText("週 1")).toMatchObject({ proposer: "相手 A" });
        expect(byText("隔週")).toMatchObject({ proposer: "相手 B" });
        expect(byText("資料を送る")).toMatchObject({ assigneeSpeaker: "相手 B" });
      }));

    it.live("セッションを終えて新しく start すると、名前は持ち越されない（画面へ届く表は空）", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }, { events: twoSpeakers(0) }]);
        yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        yield* nameWhenLabeled(r, "相手 A", "田中");
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);

        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        expect(started.status).toBe(200);
        const viewer = yield* connect(r.server.port, "/ws", undefined);

        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(viewer.frames).at(-1)).toEqual([])));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name")).toEqual([]);
      }));
  });

  for (const screen of ["no", 0, "false"]) {
    it.live(`body.screen が ${JSON.stringify(screen)}（boolean でも null でもない）なら400で拒否し、ヘルパーを起動しない`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify({ app: "us.zoom.xos", screen }), undefined));
        expect(response.status).toBe(400);
        expect(r.calls).toHaveLength(0);
      }));
  }

  for (const audio of ["no", 0, "false"]) {
    it.live(`body.audio が ${JSON.stringify(audio)}（boolean 以外）なら400で拒否し、ヘルパーを起動せず、セッションのフォルダも作らない`, () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify({ app: "us.zoom.xos", audio }), undefined));
        expect(response.status).toBe(400);
        expect(r.calls).toHaveLength(0);
        const dirs = yield* Effect.tryPromise(() => readdir(r.sessionsDir).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return [];
          throw e;
        }));
        expect(dirs).toEqual([]);
      }));
  }
});

// 共有画面（Issue #278）。偽のヘルパーが流した screen が、ログ・screens/・Claude へのメッセージまで届く。
// 差分更新は本物の layerClaude を残し、AgentSdk の query だけを偽物にする（server/test/playScreen.it.test.ts と同じ）
type SentBlock = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type SentMessage = { type: string; message: { role: string; content: string | SentBlock[] } };

describe("ライブのセッションの共有画面（偽のヘルパー + 偽の query）", () => {
  const fakeQuery = (sent: SentMessage[]) =>
    ((params: { prompt: AsyncIterable<SentMessage> }) => {
      const gen = (async function* () {
        for await (const message of params.prompt) {
          sent.push(message);
          yield { type: "assistant", message: { model: "fake-model", usage: { input_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 0 } } };
          yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "テスト" }] } };
        }
      })();
      return Object.assign(gen, { close: () => {} });
    }) as unknown as AgentSdk["Service"]["query"];

  it.live("ヘルパーが流した screen が log.jsonl と screens/ に残り、Claude へのメッセージに見出しと画像のブロックとして載る", () =>
    Effect.gen(function* () {
      const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
      const sent: SentMessage[] = [];
      const claude = layerClaude(defaultClaude.model).pipe(Layer.provide(Layer.succeed(AgentSdk, AgentSdk.of({ query: fakeQuery(sent) }))));
      const r = yield* resourceWithFakeHelpers([{
        events: [
          { type: "screen", start: 1, image: Buffer.from(jpeg).toString("base64") },
          { type: "speaker-off", start: 0, reason: "モデルなし" },
          { type: "remark", track: "相手", start: 0, end: 5, text: "今日は採用の進め方を決めます" },
          { type: "remark", track: "相手", start: 5, end: 9, text: "面接を何回にするかですね" },
        ],
      }], { updaterLayer: () => claude });

      const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
      expect(started.status).toBe(200);
      const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);

      // ログ: screen の行（画像は screens/ のファイル名）
      const lines = (yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8")))
        .trim().split("\n").map((line) => JSON.parse(line) as { type: string; start?: number; image?: string | null });
      expect(lines.filter((l) => l.type === "screen").map(({ type, start, image }) => ({ type, start, image }))).toEqual([
        { type: "screen", start: 1, image: "0001.0.jpg" },
      ]);

      // screens/: ヘルパーが流したバイト列のまま
      expect(yield* Effect.tryPromise(() => readdir(join(dir, "screens")))).toEqual(["0001.0.jpg"]);
      const saved = yield* Effect.tryPromise(() => readFile(join(dir, "screens", "0001.0.jpg")));
      expect([...saved]).toEqual([...jpeg]);

      // Claude へのメッセージ: 見出し（text）と画像（base64 を戻すと同じバイト列）が、マップと発言の本文より前に載る
      const withScreen = sent.map((m) => m.message.content).filter((c): c is SentBlock[] => Array.isArray(c));
      expect(withScreen).toHaveLength(1);
      const blocks = withScreen[0]!;
      expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text"]);
      expect(blocks[0]!.text?.trim()).toBe("## 共有画面 [00:01] から");
      expect(blocks[1]!.source).toMatchObject({ type: "base64", media_type: "image/jpeg" });
      expect([...Buffer.from(blocks[1]!.source!.data, "base64")]).toEqual([...jpeg]);
      expect(blocks[2]!.text).toContain("今日は採用の進め方を決めます");
    }));
});


// 閲覧の共有（Issue #834）。Tunnel は偽の Layer（cloudflared を起動しない。公開の tunnel は開かない）。
// 常駐サーバーと同じセッションの上で 開く → 状態 → 閉じる → 開き直す を続けて観測する。
describe("閲覧の共有（Issue #834）", () => {
  const ORIGIN = `https://${FAKE_TUNNEL_HOST}`;
  const START = '{"app":"us.zoom.xos","title":"週次","audio":false}';

  // env は cli の環境変数（既定の許可 LIVE_MINDMAP_SHARE_ALLOW など）
  const shareResource = Effect.fnUntraced(function* (tunnelOptions?: { readonly holdFirstOpen?: boolean; readonly holdFirstCleanup?: boolean; readonly missing?: boolean; readonly distinctHosts?: boolean }, env: Readonly<Record<string, string>> = {}) {
    const tunnel = fakeTunnel(tunnelOptions);
    const r = yield* resourceWithFakeHelpers([{}], { viewing: tunnel.viewing });
    const call = (method: string, path: string, body?: string, origin?: string) =>
      Effect.tryPromise(() => r.request(method, path, body, origin));
    const json = (response: Response) => Effect.tryPromise(() => response.json());
    const open = () => call("POST", "/share/open", '{"anyone":true}');
    const startSession = call("POST", "/session/start", START).pipe(Effect.tap((res) => Effect.sync(() => expect(res.status).toBe(200))));
    // ローカルモード（Apple Intelligence）のセッションを開始する
    const startLocalSession = call("POST", "/session/start", '{"app":"us.zoom.xos","title":"週次","audio":false,"model":{"name":"apple","route":"apple","local":true}}').pipe(Effect.tap((res) => Effect.sync(() => expect(res.status).toBe(200))));
    // cli を、このサーバーに向けて実行する。標準出力・標準エラーの行と、終了が失敗かを返す
    // onRequest は、cli が送る HTTP 要求を送る直前に観測する（決まった順序の再現に使う）
    const cli = (args: ReadonlyArray<string>, onRequest?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>) => Effect.suspend(() => {
      const out: string[] = [];
      const err: string[] = [];
      const consoleService: Console.Console = {
        ...console,
        log: (...a: unknown[]) => { out.push(a.map(String).join(" ") + "\n"); },
        error: (...a: unknown[]) => { err.push(a.map(String).join(" ") + "\n"); },
      };
      const observedClient = onRequest === undefined
        ? NodeHttpClient.layerUndici
        : Layer.effect(HttpClient.HttpClient)(Effect.map(HttpClient.HttpClient, (client) => HttpClient.tapRequest(client, onRequest))).pipe(Layer.provide(NodeHttpClient.layerUndici));
      const cliLayer = Layer.mergeAll(forbiddenManagedDeps,
        NodeServices.layer, unusedApple,
        observedClient,
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: r.sessionsDir, LIVE_MINDMAP_PORT: String(r.server.port), ...env })),
        Layer.succeed(Console.Console, consoleService),
        Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.void })),
        Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("") })),
        fakeAudioMix().layer,
        fakeScreenJpeg().layer,
      );
      // 失敗の表示は入口の reportFailure が持つので、実際の入口と同じく失敗の原因をそこへ渡す
      return runCli([...args]).pipe(Effect.tapCause(reportFailure), Effect.provide(cliLayer), Effect.exit, Effect.map((exit) => ({ out: out.join(""), err: err.join(""), failed: Exit.isFailure(exit) })));
    });
    return { r, tunnel, call, json, open, startSession, startLocalSession, cli };
  });

  const refused = (port: number) => Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow());
  const viewingPortOf = (tunnel: { opened: number[] }) => tunnel.opened.at(-1)!;

  it.live("開くと、閲覧の口が待ち受けて Tunnel に そのポートが渡り、url と許可の範囲が返る。状態も同じ値になる", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    expect(s.tunnel.opened).toEqual([]);
    const opened = yield* s.open();
    expect(opened.status).toBe(200);
    expect(yield* s.json(opened)).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    expect(s.tunnel.opened).toHaveLength(1);
    const port = viewingPortOf(s.tunnel);
    expect(port).not.toBe(s.r.server.port);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    // 閲覧の口は、与えられたホスト名の Origin の /ws だけを通し、操作の口のルートは断る
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
    expect((yield* connect(port, "/ws", ORIGIN)).isOpen()).toBe(true);
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/session/status`))).status).toBe(404);
    expect(s.tunnel.closed()).toBe(0);
  }));

  it.live("閉じると、Tunnel の後始末が 1 回走り、閲覧の口は待受けをやめ、状態は off になる。同じサーバー・セッションで開き直せる", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    yield* s.open();
    const firstPort = viewingPortOf(s.tunnel);
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${firstPort}/`))).status).toBe(200);
    const closed = yield* s.call("POST", "/share/close");
    expect(closed.status).toBe(200);
    expect(s.tunnel.closed()).toBe(1);
    yield* refused(firstPort);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    // セッションは続いている
    expect((yield* s.json(yield* s.call("GET", "/session/status")))).toMatchObject({ status: "running" });
    // 開き直す
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(2);
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${viewingPortOf(s.tunnel)}/`))).status).toBe(200);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
  }));

  it.live("共有していないときの close は何も壊さず成功し、Tunnel の後始末も走らない", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    expect((yield* s.call("POST", "/share/close")).status).toBe(200);
    expect(s.tunnel.closed()).toBe(0);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
  }));

  it.live("すでに開いているときの open は、新しい Tunnel も待受けも作らず、今の状態を返す", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    const first = yield* s.json(yield* s.open());
    const second = yield* s.open();
    expect(second.status).toBe(200);
    expect(yield* s.json(second)).toEqual(first);
    expect(s.tunnel.opened).toHaveLength(1);
    expect(s.tunnel.closed()).toBe(0);
  }));

  it.live("セッションの終了（/session/stop）で閉じる: Tunnel の後始末が 1 回、閲覧の口は待受けをやめ、状態は off", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    yield* s.open();
    const port = viewingPortOf(s.tunnel);
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
    expect((yield* s.call("POST", "/session/stop")).status).toBe(200);
    expect(s.tunnel.closed()).toBe(1);
    yield* refused(port);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    // 次のセッションは、閲覧の共有を引き継がず、改めて開ける
    yield* s.startSession;
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(2);
  }));

  it.live("server の終了で閉じる: Tunnel の後始末が 1 回走り、閲覧の口は待受けをやめる", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    yield* s.open();
    const port = viewingPortOf(s.tunnel);
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
    yield* s.r.server.close;
    expect(s.tunnel.closed()).toBe(1);
    yield* refused(port);
  }));

  it.live("open の本文は {anyone:true}・{mails:[1 件以上のメール]}・{} だけを受ける。それ以外は 400 で、Tunnel を開かない", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    const bad = ['{"anyone":false}', '{"anyone":"yes"}', '{"mails":[]}', '{"mails":[""]}', '{"mails":["no-at"]}', '{"mails":["a b@x.com"]}', '{"mails":"a@example.com"}',
      '{"anyone":true,"mails":["a@example.com"]}', "{not json", undefined];
    for (const body of bad) {
      const response = yield* s.call("POST", "/share/open", body);
      expect([body, response.status]).toEqual([body, 400]);
    }
    expect(s.tunnel.opened).toEqual([]);
    // 守っている状態に到達していることを、正しい本文なら開くことで示す
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(1);
  }));

  it.live("open の本文 {mails:[...]} は 200 で開き、Tunnel に --allowed-mail が渡り、状態の許可の範囲はメール・ドメインの一覧になる。--anyone では --allowed-mail を渡さない", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    const response = yield* s.call("POST", "/share/open", '{"mails":["a@example.com","*@example.co.jp"]}');
    expect(response.status).toBe(200);
    expect(yield* s.json(response)).toEqual({ status: "open", url: ORIGIN, allow: { mails: ["a@example.com", "*@example.co.jp"] } });
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: { mails: ["a@example.com", "*@example.co.jp"] } });
    expect(allowedMails(s.tunnel.args.at(-1)!)).toEqual(["*@example.co.jp", "a@example.com"]);
    // --anyone で開き直すと、--allowed-mail は付かない
    yield* s.call("POST", "/share/close");
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.args.at(-1)).not.toContain("--allowed-mail");
  }));

  it.live("共有のルートにも操作の口の Origin の制限が掛かる（ローカル以外の Origin は 403 で、開きも閉じもしない）", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    const foreign = "https://evil.example";
    expect((yield* s.call("POST", "/share/open", '{"anyone":true}', foreign)).status).toBe(403);
    expect(s.tunnel.opened).toEqual([]);
    yield* s.open();
    expect((yield* s.call("POST", "/share/close", undefined, foreign)).status).toBe(403);
    expect((yield* s.call("GET", "/share/status", undefined, foreign)).status).toBe(403);
    expect(s.tunnel.closed()).toBe(0);
    expect(yield* s.json(yield* s.call("GET", "/share/status", undefined, "http://localhost:5173"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
  }));

  it.live("ホスト名を待つ間にセッションが終わると、開始要求は 500 で終わり、閲覧の口は待受けをやめ、状態は off。ロックは解放され、次のセッションで開ける", () => Effect.gen(function* () {
    const s = yield* shareResource({ holdFirstOpen: true });
    yield* s.startSession;
    const pending = yield* Effect.forkChild(s.open());
    const port = yield* s.tunnel.reached;
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
    expect((yield* s.call("POST", "/session/stop")).status).toBe(200);
    const response = yield* Fiber.join(pending);
    expect(response.status).toBe(500);
    yield* refused(port);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    expect(s.tunnel.closed()).toBe(1);
    expect((yield* s.call("POST", "/share/close")).status).toBe(200);
    yield* s.startSession;
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(2);
  }));

  it.live("閲覧の口を開いた後に Tunnel の起動が失敗すると、開始要求は 500 で終わり、閲覧の口は待受けをやめ、状態は off で、Tunnel の後始末が走る", () => Effect.gen(function* () {
    const s = yield* shareResource({ holdFirstOpen: true });
    yield* s.startSession;
    const pending = yield* Effect.forkChild(s.open());
    const port = yield* s.tunnel.reached;
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
    yield* s.tunnel.failHeld;
    const response = yield* Fiber.join(pending);
    expect(response.status).toBe(500);
    yield* refused(port);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    expect(s.tunnel.closed()).toBe(1);
  }));

  it.live("後始末の途中（共有の Scope が Closed で状態の消去は未実行）にホスト名が届いても、open を公開せず 500 で終わり、状態は off。後始末の完了後に閲覧の口は待受けをやめ、次のセッションで開ける", () => Effect.gen(function* () {
    const s = yield* shareResource({ holdFirstOpen: true, holdFirstCleanup: true });
    yield* s.startSession;
    const pending = yield* Effect.forkChild(s.open());
    const port = yield* s.tunnel.reached;
    const stopping = yield* Effect.forkChild(s.call("POST", "/session/stop"));
    yield* s.tunnel.cleanupReached;
    expect(s.tunnel.closed()).toBe(0);
    yield* s.tunnel.succeedHeld;
    const response = yield* Fiber.join(pending);
    expect(response.status).toBe(500);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    yield* s.tunnel.releaseCleanup;
    expect((yield* Fiber.join(stopping)).status).toBe(200);
    yield* refused(port);
    expect(s.tunnel.closed()).toBe(1);
    expect((yield* s.call("POST", "/share/close")).status).toBe(200);
    yield* s.startSession;
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(2);
  }));

  // 開けないときに理由を示して止まる 4 つの場合（Issue #835）。拒む判定は、閲覧の口・画面のビルド・Tunnel の起動より前に走る
  const NO_SESSION = "進行中のセッションがありません";
  const LOCAL_REASON = "ローカルモード";
  const INSTALL_HOW = "pnpm cli install cloudflared";

  it.live("セッションが無いときの open は 409 で理由を返し、Tunnel を開かず、状態は off のまま。セッションを始めれば開ける", () => Effect.gen(function* () {
    const s = yield* shareResource();
    const response = yield* s.open();
    expect(response.status).toBe(409);
    expect(((yield* s.json(response)) as { error: string }).error).toContain(NO_SESSION);
    expect(s.tunnel.opened).toEqual([]);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    yield* s.startSession;
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(1);
  }));

  it.live("ローカルモードのセッションでの open は 409 で理由を返し、閲覧の口も Tunnel も開かず、状態は off のまま", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startLocalSession;
    const response = yield* s.open();
    expect(response.status).toBe(409);
    expect(((yield* s.json(response)) as { error: string }).error).toContain(LOCAL_REASON);
    expect(s.tunnel.opened).toEqual([]);
    expect(s.tunnel.closed()).toBe(0);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
    // 何度打っても開かない
    expect((yield* s.open()).status).toBe(409);
    expect(s.tunnel.opened).toEqual([]);
  }));

  it.live("ローカルモードを終えた次の通常のセッションでは、同じサーバーで開ける（拒みはセッションの種類に結ぶ）", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startLocalSession;
    expect((yield* s.open()).status).toBe(409);
    expect((yield* s.call("POST", "/session/stop")).status).toBe(200);
    yield* s.startSession;
    expect((yield* s.open()).status).toBe(200);
    expect(s.tunnel.opened).toHaveLength(1);
  }));

  it.live("cloudflared が無いときの open は 503 で入れ方を返し、Tunnel を開かず、状態は off のまま", () => Effect.gen(function* () {
    const s = yield* shareResource({ missing: true });
    yield* s.startSession;
    const response = yield* s.open();
    expect(response.status).toBe(503);
    expect(((yield* s.json(response)) as { error: string }).error).toContain(INSTALL_HOW);
    expect(s.tunnel.checked()).toBeGreaterThan(0);
    expect(s.tunnel.opened).toEqual([]);
    expect(s.tunnel.closed()).toBe(0);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
  }));

  it.live("すでに開いているときの open は、URL も許可の範囲も変えず、状態の URL も同じまま", () => Effect.gen(function* () {
    const s = yield* shareResource();
    yield* s.startSession;
    yield* s.open();
    const before = yield* s.json(yield* s.call("GET", "/share/status"));
    expect((yield* s.open()).status).toBe(200);
    expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual(before);
    expect(before).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    expect(s.tunnel.opened).toHaveLength(1);
  }));

  describe("cli", () => {
    it.live("share --anyone は URL・許可の範囲・稼働の保証が無い旨を標準出力に出し、閲覧の口を開く", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      const { out, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(false);
      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain(ORIGIN);
      expect(lines[1]).toContain("誰でも");
      expect(lines[2]).toContain("保証");
      expect(s.tunnel.opened).toHaveLength(1);
      expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${viewingPortOf(s.tunnel)}/`))).status).toBe(200);
    }));

    it.live("範囲が空の share（--anyone が無い）は失敗し、URL を出さない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      const { out, err, failed } = yield* s.cli(["share"]);
      expect(failed).toBe(true);
      expect(err).toContain("許可の範囲を指定");
      expect(err).not.toContain(NO_SESSION);
      expect(err).not.toContain(LOCAL_REASON);
      expect(err).not.toContain(INSTALL_HOW);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
      // 守っている状態に到達していることを、--anyone を付ければ開くことで示す
      expect((yield* s.cli(["share", "--anyone"])).failed).toBe(false);
      expect(s.tunnel.opened).toHaveLength(1);
    }));

    it.live("セッションが無いときの引数なしの share は、セッションが無い理由で失敗し、Tunnel を開かない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      const { out, err, failed } = yield* s.cli(["share"]);
      expect(failed).toBe(true);
      expect(err).toContain(NO_SESSION);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
    }));

    it.live("ローカルモードのセッションでの引数なしの share は、ローカルモードの理由で失敗し、Tunnel を開かない。status は 無し のまま", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startLocalSession;
      const { out, err, failed } = yield* s.cli(["share"]);
      expect(failed).toBe(true);
      expect(err).toContain(LOCAL_REASON);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
      expect((yield* s.cli(["status"])).out.trimEnd().split("\n").at(-1)).toBe("閲覧の共有: 無し");
    }));

    it.live("cloudflared が無いときの引数なしの share は、入れ方を出して失敗し、Tunnel を開かない", () => Effect.gen(function* () {
      const s = yield* shareResource({ missing: true });
      yield* s.startSession;
      const { out, err, failed } = yield* s.cli(["share"]);
      expect(failed).toBe(true);
      expect(err).toContain(INSTALL_HOW);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
      expect((yield* s.cli(["status"])).out.trimEnd().split("\n").at(-1)).toBe("閲覧の共有: 無し");
    }));

    it.live("--stop と --anyone を一緒に渡したら失敗し、開きも閉じもしない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      expect((yield* s.cli(["share", "--stop", "--anyone"])).failed).toBe(true);
      expect(s.tunnel.opened).toEqual([]);
      yield* s.open();
      expect((yield* s.cli(["share", "--stop", "--anyone"])).failed).toBe(true);
      expect(s.tunnel.closed()).toBe(0);
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toMatchObject({ status: "open" });
    }));

    it.live("share --stop で閉じ、status の閲覧の共有が 共有中 から 無し に変わる。status の URL・許可の範囲は取り込みの行の後ろに出る", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.cli(["share", "--anyone"]);
      const sharing = (yield* s.cli(["status"])).out;
      expect(sharing).toContain("動いている");
      expect(sharing.trimEnd().split("\n").slice(-3)).toEqual(["閲覧の共有: 共有中", `URL: ${ORIGIN}`, "許可の範囲: 誰でも"]);
      expect(sharing.indexOf("動いている")).toBeLessThan(sharing.indexOf("閲覧の共有"));
      const stopped = yield* s.cli(["share", "--stop"]);
      expect(stopped.failed).toBe(false);
      expect(s.tunnel.closed()).toBe(1);
      const after = (yield* s.cli(["status"])).out;
      expect(after.trimEnd().split("\n").at(-1)).toBe("閲覧の共有: 無し");
      expect(after).not.toContain(ORIGIN);
      yield* refused(viewingPortOf(s.tunnel));
    }));

    it.live("セッションが無いときの share --anyone は失敗し、標準エラーに理由が出て、URL は出さず、Tunnel を開かない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      const { out, err, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(true);
      expect(err).toContain(NO_SESSION);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
    }));

    it.live("ローカルモードのセッションでの share --anyone は失敗し、標準エラーに理由が出て、URL は出さず、閲覧の口も Tunnel も開かない。status は 無し のまま", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startLocalSession;
      const { out, err, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(true);
      expect(err).toContain(LOCAL_REASON);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
      expect((yield* s.cli(["status"])).out.trimEnd().split("\n").at(-1)).toBe("閲覧の共有: 無し");
    }));

    it.live("cloudflared が無いときの share --anyone は失敗し、標準エラーに入れ方が出て、URL は出さず、Tunnel を開かない", () => Effect.gen(function* () {
      const s = yield* shareResource({ missing: true });
      yield* s.startSession;
      const { out, err, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(true);
      expect(err).toContain(INSTALL_HOW);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
      expect((yield* s.cli(["status"])).out.trimEnd().split("\n").at(-1)).toBe("閲覧の共有: 無し");
    }));

    it.live("すでに共有中の share --anyone は失敗し、標準エラーに「すでに」と今の URL と許可の範囲が出る。標準出力に「開きました」は出ず、新しくは開かない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      expect((yield* s.cli(["share", "--anyone"])).failed).toBe(false);
      const { out, err, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(true);
      expect(err).toContain("すでに");
      expect(err).toContain(ORIGIN);
      expect(err).toContain("誰でも");
      expect(out).not.toContain("開きました");
      expect(s.tunnel.opened).toHaveLength(1);
      expect(s.tunnel.closed()).toBe(0);
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    }));

    it.live("開始の途中の共有と交差した share --anyone は、すでに共有中として失敗し、新しくは開かず、「開きました」を出さない", () => Effect.gen(function* () {
      const s = yield* shareResource({ holdFirstOpen: true });
      yield* s.startSession;
      const first = yield* Effect.forkChild(s.open());
      yield* s.tunnel.reached;
      // 事前の確認が済んだ後（POST を送る直前）まで、開始の途中を止めておく
      const posting = yield* Deferred.make<void>();
      const second = yield* Effect.forkChild(s.cli(["share", "--anyone"], (request) =>
        request.method === "POST" && request.url.endsWith("/share/open") ? Deferred.succeed(posting, undefined).pipe(Effect.asVoid) : Effect.void));
      yield* Deferred.await(posting);
      yield* s.tunnel.succeedHeld;
      expect((yield* Fiber.join(first)).status).toBe(200);
      const { out, err, failed } = yield* Fiber.join(second);
      expect(failed).toBe(true);
      expect(err).toContain("すでに");
      expect(err).toContain(ORIGIN);
      expect(err).toContain("誰でも");
      expect(out).not.toContain("開きました");
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toHaveLength(1);
      expect(s.tunnel.closed()).toBe(0);
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    }));

    it.live("共有中の範囲が空の share は、すでに共有中として失敗し、新しくは開かず、URL と「開きました」を標準出力に出さない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      expect((yield* s.cli(["share", "--anyone"])).failed).toBe(false);
      const { out, err, failed } = yield* s.cli(["share"]);
      expect(failed).toBe(true);
      expect(err).toContain("すでに");
      expect(err).toContain(ORIGIN);
      expect(err).toContain("誰でも");
      expect(out).not.toContain("https://");
      expect(out).not.toContain("開きました");
      expect(s.tunnel.opened).toHaveLength(1);
      expect(s.tunnel.closed()).toBe(0);
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    }));

    it.live("share <メール・ドメイン...> は --allowed-mail で渡して開き、出力・status に許可の範囲が出る。--anyone ではない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      const { out, failed } = yield* s.cli(["share", "a@x.com", "*@example.co.jp"]);
      expect(failed).toBe(false);
      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain(ORIGIN);
      expect(lines[1]).toContain("a@x.com");
      expect(lines[1]).toContain("*@example.co.jp");
      expect(lines[1]).not.toContain("誰でも");
      expect(lines[2]).toContain("保証");
      expect(allowedMails(s.tunnel.args.at(-1)!)).toEqual(["*@example.co.jp", "a@x.com"]);
      const status = (yield* s.cli(["status"])).out.trimEnd().split("\n");
      expect(status.slice(-3)).toEqual(["閲覧の共有: 共有中", `URL: ${ORIGIN}`, "許可の範囲: a@x.com, *@example.co.jp"]);
    }));

    it.live("既定の許可（LIVE_MINDMAP_SHARE_ALLOW）に引数を足した範囲で開く。出力・status・--allowed-mail に両方が出る", () => Effect.gen(function* () {
      const s = yield* shareResource(undefined, { LIVE_MINDMAP_SHARE_ALLOW: "d@x.com, *@corp.example" });
      yield* s.startSession;
      const { out, failed } = yield* s.cli(["share", "a@x.com"]);
      expect(failed).toBe(false);
      for (const value of ["d@x.com", "*@corp.example", "a@x.com"]) {
        expect(out).toContain(value);
      }
      expect(allowedMails(s.tunnel.args.at(-1)!)).toEqual(["*@corp.example", "a@x.com", "d@x.com"]);
      const status = (yield* s.cli(["status"])).out;
      for (const value of ["d@x.com", "*@corp.example", "a@x.com"]) expect(status).toContain(value);
      expect(status).not.toContain("誰でも");
    }));

    it.live("既定の許可だけでも、引数なしの share は開く。範囲は既定の許可で、「誰でも」にはならない", () => Effect.gen(function* () {
      const s = yield* shareResource(undefined, { LIVE_MINDMAP_SHARE_ALLOW: "d1@x.com,d2@x.com" });
      yield* s.startSession;
      const { out, err, failed } = yield* s.cli(["share"]);
      expect(failed).toBe(false);
      expect(err).toBe("");
      expect(out).toContain("d1@x.com");
      expect(out).toContain("d2@x.com");
      expect(out).not.toContain("誰でも");
      expect(allowedMails(s.tunnel.args.at(-1)!)).toEqual(["d1@x.com", "d2@x.com"]);
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: { mails: ["d1@x.com", "d2@x.com"] } });
    }));

    it.live("既定の許可があっても --anyone なら「誰でも」で開き、--allowed-mail は付かない", () => Effect.gen(function* () {
      const s = yield* shareResource(undefined, { LIVE_MINDMAP_SHARE_ALLOW: "d@x.com" });
      yield* s.startSession;
      const { out, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(false);
      expect(out).toContain("誰でも");
      expect(s.tunnel.args.at(-1)).not.toContain("--allowed-mail");
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "open", url: ORIGIN, allow: "anyone" });
    }));

    it.live("範囲が空（環境変数が空・空要素だけ）で --anyone も無い share は、許可の範囲を指定するよう案内して止まり、Tunnel を開かない", () => Effect.gen(function* () {
      for (const env of [{ LIVE_MINDMAP_SHARE_ALLOW: "" }, { LIVE_MINDMAP_SHARE_ALLOW: " , " }]) {
        const s = yield* shareResource(undefined, env);
        yield* s.startSession;
        const { out, err, failed } = yield* s.cli(["share"]);
        expect([env, failed]).toEqual([env, true]);
        expect(err).toContain("許可の範囲を指定");
        expect(out).not.toContain("https://");
        expect(s.tunnel.opened).toEqual([]);
        expect((yield* s.cli(["status"])).out.trimEnd().split("\n").at(-1)).toBe("閲覧の共有: 無し");
      }
    }));

    it.live("--anyone とメール・ドメインは同時に渡せない。既定の許可があっても失敗し、開かない", () => Effect.gen(function* () {
      const s = yield* shareResource(undefined, { LIVE_MINDMAP_SHARE_ALLOW: "d@x.com" });
      yield* s.startSession;
      const { out, failed } = yield* s.cli(["share", "--anyone", "a@x.com"]);
      expect(failed).toBe(true);
      expect(out).not.toContain("https://");
      expect(s.tunnel.opened).toEqual([]);
      expect(yield* s.json(yield* s.call("GET", "/share/status"))).toEqual({ status: "off" });
      // 守っている状態に到達していることを、片方だけなら開くことで示す
      expect((yield* s.cli(["share", "a@x.com"])).failed).toBe(false);
      expect(s.tunnel.opened).toHaveLength(1);
    }));

    it.live("すでに共有中の share <メール> は失敗し、標準エラーに今の URL と今の許可の範囲（メール・ドメイン）が出る。新しくは開かない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      expect((yield* s.cli(["share", "a@x.com"])).failed).toBe(false);
      const { err, failed } = yield* s.cli(["share", "b@x.com"]);
      expect(failed).toBe(true);
      expect(err).toContain("すでに");
      expect(err).toContain(ORIGIN);
      expect(err).toContain("a@x.com");
      expect(err).not.toContain("b@x.com");
      expect(s.tunnel.opened).toHaveLength(1);
    }));

    it.live("閉じた後の share --anyone は、拒まれずに開き直せる", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.cli(["share", "--anyone"]);
      expect((yield* s.cli(["share", "--stop"])).failed).toBe(false);
      const again = yield* s.cli(["share", "--anyone"]);
      expect(again.failed).toBe(false);
      expect(again.err).toBe("");
      expect(s.tunnel.opened).toHaveLength(2);
    }));
  });

  // 閲覧の共有が切れた（Issue #837）。偽の Tunnel の drop() で cloudflared が切れたことを再現する。
  // 切れたことを反映するのは別の Fiber なので、状態が変わるまで回数の上限つきで取り直す（固定時間の sleep では待たない）
  describe("切れたとき（Issue #837）", () => {
    const BROKEN_ANYONE = { status: "broken", allow: "anyone" };
    const awaitStatus = (s: { call: (method: string, path: string) => Effect.Effect<Response, unknown>; json: (response: Response) => Effect.Effect<unknown, unknown> }, expected: string) =>
      Effect.gen(function* () {
        let last: unknown;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          last = yield* s.json(yield* s.call("GET", "/share/status"));
          if ((last as { status: string }).status === expected) return last;
          yield* Effect.sleep("10 millis");
        }
        return last;
      });
    const shareStatus = (s: { call: (method: string, path: string) => Effect.Effect<Response, unknown>; json: (response: Response) => Effect.Effect<unknown, unknown> }) =>
      Effect.flatMap(s.call("GET", "/share/status"), s.json);

    it.live("切れると状態は broken（許可の範囲つき）になり、閲覧の口は待受けをやめ、Tunnel の後始末が 1 回走る。自動では開き直さず、セッションは続く", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.open();
      const port = viewingPortOf(s.tunnel);
      expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
      yield* s.tunnel.drop;
      expect(yield* awaitStatus(s, "broken")).toEqual(BROKEN_ANYONE);
      yield* refused(port);
      expect(s.tunnel.closed()).toBe(1);
      // 立て直さない: 新しい Tunnel は開かれず、状態に URL は出ない
      expect(s.tunnel.opened).toHaveLength(1);
      expect(yield* shareStatus(s)).toEqual(BROKEN_ANYONE);
      expect((yield* s.json(yield* s.call("GET", "/session/status")))).toMatchObject({ status: "running" });
    }));

    it.live("メールで開いた共有が切れると、broken の許可の範囲はそのメール・ドメインの一覧のまま", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.call("POST", "/share/open", '{"mails":["a@example.com","*@example.co.jp"]}');
      yield* s.tunnel.drop;
      expect(yield* awaitStatus(s, "broken")).toEqual({ status: "broken", allow: { mails: ["a@example.com", "*@example.co.jp"] } });
    }));

    it.live("broken のとき cli status は「切れた」と許可の範囲を出し、URL は出さない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.cli(["share", "--anyone"]);
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      const out = (yield* s.cli(["status"])).out;
      expect(out.trimEnd().split("\n").slice(-2)).toEqual(["閲覧の共有: 切れた", "許可の範囲: 誰でも"]);
      expect(out).not.toContain(ORIGIN);
    }));

    it.live("broken から share を打ち直すと、新しい Tunnel・新しい閲覧の口・新しい URL で開く。前の URL は使わない", () => Effect.gen(function* () {
      const s = yield* shareResource({ distinctHosts: true });
      yield* s.startSession;
      const first = yield* s.json(yield* s.open());
      const firstPort = viewingPortOf(s.tunnel);
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      // 切れたら閲覧の口は待受けをやめる。新しい待受けができる前に確かめる
      yield* refused(firstPort);
      const again = yield* s.open();
      expect(again.status).toBe(200);
      expect(again.headers.get("x-share-open-outcome")).toBe("opened");
      const second = (yield* s.json(again)) as { status: string; url: string; allow: unknown };
      expect(second).toEqual({ status: "open", url: "https://fake-tunnel-2.trycloudflare.com", allow: "anyone" });
      expect(second.url).not.toBe((first as { url: string }).url);
      expect(s.tunnel.opened).toHaveLength(2);
      expect(s.tunnel.hosts).toEqual(["fake-tunnel-1.trycloudflare.com", "fake-tunnel-2.trycloudflare.com"]);
      const port = viewingPortOf(s.tunnel);
      expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(200);
      expect((yield* connect(port, "/ws", second.url)).isOpen()).toBe(true);
      expect(yield* shareStatus(s)).toEqual(second);
      // 前の共有の後始末は、切れたときの 1 回だけ。打ち直しで二重に走らない
      expect(s.tunnel.closed()).toBe(1);
    }));

    it.live("打ち直した共有がまた切れても broken になり、もう一度打ち直せる", () => Effect.gen(function* () {
      const s = yield* shareResource({ distinctHosts: true });
      yield* s.startSession;
      yield* s.open();
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      expect((yield* s.open()).status).toBe(200);
      yield* s.tunnel.drop;
      expect(yield* awaitStatus(s, "broken")).toEqual(BROKEN_ANYONE);
      expect(s.tunnel.closed()).toBe(2);
      const third = yield* s.open();
      expect(third.headers.get("x-share-open-outcome")).toBe("opened");
      expect(yield* s.json(third)).toMatchObject({ status: "open", url: "https://fake-tunnel-3.trycloudflare.com" });
    }));

    it.live("cli share --anyone は broken から成功し、標準エラーは空で、新しい URL を出す", () => Effect.gen(function* () {
      const s = yield* shareResource({ distinctHosts: true });
      yield* s.startSession;
      yield* s.cli(["share", "--anyone"]);
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      const { out, err, failed } = yield* s.cli(["share", "--anyone"]);
      expect(failed).toBe(false);
      expect(err).toBe("");
      expect(out).toContain("https://fake-tunnel-2.trycloudflare.com");
      expect(out).not.toContain("https://fake-tunnel-1.trycloudflare.com");
      expect(s.tunnel.opened).toHaveLength(2);
      expect((yield* s.cli(["status"])).out.trimEnd().split("\n").slice(-3)).toEqual(["閲覧の共有: 共有中", "URL: https://fake-tunnel-2.trycloudflare.com", "許可の範囲: 誰でも"]);
    }));

    it.live("broken からの share が拒まれた（範囲が空）ときは broken のまま変わらず、Tunnel は開かない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.open();
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      const rejected = yield* s.call("POST", "/share/open", "{}");
      expect(rejected.status).toBe(400);
      expect(yield* shareStatus(s)).toEqual(BROKEN_ANYONE);
      expect(s.tunnel.opened).toHaveLength(1);
      expect(s.tunnel.closed()).toBe(1);
      const viaCli = yield* s.cli(["share"]);
      expect(viaCli.failed).toBe(true);
      expect(yield* shareStatus(s)).toEqual(BROKEN_ANYONE);
    }));

    it.live("broken から share --stop（/share/close）で off に戻り、後始末は二重に走らない。そのあと開き直せる", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.open();
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      const closed = yield* s.call("POST", "/share/close");
      expect(closed.status).toBe(200);
      expect(yield* s.json(closed)).toEqual({ status: "off" });
      expect(yield* shareStatus(s)).toEqual({ status: "off" });
      expect(s.tunnel.closed()).toBe(1);
      const reopened = yield* s.open();
      expect(reopened.headers.get("x-share-open-outcome")).toBe("opened");
      expect(s.tunnel.opened).toHaveLength(2);
    }));

    it.live("broken のままセッションが終わる（/session/stop）と off に戻り、次のセッションで開ける", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.open();
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      expect((yield* s.call("POST", "/session/stop")).status).toBe(200);
      expect(yield* shareStatus(s)).toEqual({ status: "off" });
      expect(s.tunnel.closed()).toBe(1);
      yield* s.startSession;
      expect(yield* shareStatus(s)).toEqual({ status: "off" });
      expect((yield* s.open()).headers.get("x-share-open-outcome")).toBe("opened");
      expect(s.tunnel.opened).toHaveLength(2);
    }));

    it.live("broken のまま server が終わっても失敗せず閉じ、Tunnel の後始末は二重に走らない", () => Effect.gen(function* () {
      const s = yield* shareResource();
      yield* s.startSession;
      yield* s.open();
      const port = viewingPortOf(s.tunnel);
      yield* s.tunnel.drop;
      yield* awaitStatus(s, "broken");
      yield* s.r.server.close;
      expect(s.tunnel.closed()).toBe(1);
      yield* refused(port);
    }));

    it.live("共有中（切れていない）の open は、drop が無い限り今までどおり already-open で新しくは開かない", () => Effect.gen(function* () {
      const s = yield* shareResource({ distinctHosts: true });
      yield* s.startSession;
      const first = yield* s.json(yield* s.open());
      const second = yield* s.open();
      expect(second.headers.get("x-share-open-outcome")).toBe("already-open");
      expect(yield* s.json(second)).toEqual(first);
      expect(s.tunnel.opened).toHaveLength(1);
    }));
  });
});

describe("WS の close の上限（WS_CLOSE_TIMEOUT_MS）", () => {
  it.effect("上書きしない製品の構築では、既定の 3_000ms", () =>
    Effect.gen(function* () {
      expect(yield* WS_CLOSE_TIMEOUT_MS).toBe(3_000);
    }));
});
