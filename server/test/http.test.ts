import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Deferred, Effect, Layer, Queue, Ref, Stream, type Cause } from "effect";
import { WebSocket } from "ws";
import { MapCapture } from "../src/capture.ts";
import { AgentSdk, ClaudeDiffUpdater } from "../src/claude.ts";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../src/helpers.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { realLayers, type ServerOptions } from "../src/server.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { DiffUpdater } from "../src/core/index.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { promiseOrDie } from "./fixtures/promiseOrDie.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

const apps = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];
const fakeHelper = join(import.meta.dirname, "fixtures/fake-helper.ts");
const resource = Effect.fnUntraced(function* (options: Partial<Pick<ServerOptions, "updaterLayer">> & Pick<ExportServicesOptions, "capture"> = {}) {
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-http-"))),
    (path) => promiseOrDie(() => rm(path, { recursive: true, force: true })),
  );
  const script = join(dir, "script.json");
  const record = join(dir, "record.jsonl");
  const sessionsDir = join(dir, "sessions");
  yield* Effect.tryPromise(() => writeFile(script, JSON.stringify({ apps, events: [] })));
  yield* Effect.tryPromise(() => writeFile(record, ""));
  const serverOptions: ServerOptions = {
    port: 0, sessionsDir,
    helper: { command: process.execPath, args: [fakeHelper, script, record] },
    updaterLayer: options.updaterLayer ?? updaterLayer(() => Effect.succeed({ ops: [] })),
  };
  const server = yield* startedServer(serverOptions, realLayers(serverOptions, fakeExportServices({ capture: options.capture })));
  return {
    server, sessionsDir,
    records: async () => (await readFile(record, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; argv: string[] }),
    request: (method: string, path: string, body: string | undefined, origin: string | undefined) => fetch(
      `http://127.0.0.1:${server.port}${path}`,
      { method, headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) }, ...(body === undefined ? {} : { body }) },
    ),
  };
});

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

const makeFakeHelpers = (attempts: AttemptScript[]) => {
  const calls: string[][] = [];
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
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exitDeferred), stderrTail: Effect.succeed(script.stderrTail ?? []) };
    });
  return { helpers: Helpers.of({ apps: Effect.succeed(apps), launch }), calls };
};

const resourceWithFakeHelpers = Effect.fnUntraced(function* (attempts: AttemptScript[], options: { updaterLayer?: ServerOptions["updaterLayer"] } = {}) {
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-http-fake-"))),
    (path) => promiseOrDie(() => rm(path, { recursive: true, force: true })),
  );
  const sessionsDir = join(dir, "sessions");
  const fakeHelpers = makeFakeHelpers(attempts);
  const sessionSinksLayer = SessionSinks.layer({
    updaterLayer: options.updaterLayer ?? updaterLayer(() => Effect.succeed({ ops: [] })),
  }).pipe(Layer.provide(fakeExportServices()));
  const server = yield* startedServer(
    { port: 0, sessionsDir },
    { helpers: Layer.succeed(Helpers)(fakeHelpers.helpers), sessionSinks: sessionSinksLayer },
  );
  return {
    server, calls: fakeHelpers.calls, sessionsDir,
    request: (method: string, path: string, body: string | undefined, origin: string | undefined) => fetch(
      `http://127.0.0.1:${server.port}${path}`,
      { method, headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) }, ...(body === undefined ? {} : { body }) },
    ),
  };
});

const connect = Effect.fnUntraced(function* (port: number, path: string, origin: string | undefined) {
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === undefined ? {} : { origin })),
    (s) => Effect.sync(() => s.terminate()),
  );
  const frames: unknown[] = [];
  const closed = new Promise<void>((resolve) => ws.once("close", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  yield* Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  }));
  return { frames, closed };
});

// upgrade だけして、以後は何も送らず、サーバーが送る close フレームにも応答しない生の接続（要件7・ISSUE-2）。
// ws クライアントは close フレームに自動応答してしまうので、close ハンドシェイクに応答しないクライアントを
// 再現するには、upgrade の応答だけ読んで止める生の TCP ソケットが必要
const connectUnresponsive = Effect.fnUntraced(function* (port: number) {
  const socket = yield* Effect.acquireRelease(
    Effect.tryPromise(() => new Promise<Socket>((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const s = netConnect(port, "127.0.0.1", () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      s.once("data", () => resolve(s)); // 101 応答。以降は何も送らない（close フレームにも応答しない）
      s.once("error", reject);
    })),
    (s) => Effect.sync(() => s.destroy()),
  );
  return socket;
});

describe("HTTP 本文の検証（要件8・12）", () => {
  const invalid = [
    { name: "app欠落", body: {} },
    { name: "app空文字列", body: { app: "" } },
    { name: "appが数値", body: { app: 1 } },
    { name: "titleが真偽値", body: { app: "us.zoom.xos", title: false } },
    // audio が boolean 以外（"no"・0・"false" を含む）のケースは、新しい入口（偽の Helpers）を使う
    // 「新しい入口（...）」describe の方で、より網羅的に確かめる（要件98。重複させない）
    { name: "本文がnull", body: null },
    { name: "本文が配列", body: [] },
  ];
  for (const { name, body } of invalid) {
    it.live(`${name}なら400のerror JSONで拒否し、開始しない。修正した本文なら開始できる`, () =>
      Effect.gen(function* () {
        const r = yield* resource();
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify(body), undefined));
        expect(response.status).toBe(400);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: expect.any(String) });
        expect(yield* Effect.tryPromise(r.records)).toEqual([]);
        expect(yield* Effect.tryPromise(() => readdir(r.sessionsDir).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return [];
          throw e;
        }))).toEqual([]);
        const valid = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify({ app: "us.zoom.xos", audio: false }), undefined));
        expect(valid.status).toBe(200);
        expect(yield* Effect.tryPromise(() => valid.json())).toEqual({ dir: expect.any(String) });
      }));
  }

  it.live("不正なJSONは400のerror JSONで拒否する", () =>
    Effect.gen(function* () {
      const r = yield* resource();
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", "{", undefined));
      expect(response.status).toBe(400);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: expect.any(String) });
      expect(yield* Effect.tryPromise(r.records)).toEqual([]);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
    }));

  const valid = [
    { name: "省略", body: { app: "us.zoom.xos" }, audio: true, title: undefined },
    { name: "null", body: { app: "us.zoom.xos", title: null, audio: null }, audio: true, title: undefined },
    { name: "指定", body: { app: "us.zoom.xos", title: "週次", audio: true }, audio: true, title: "週次" },
    { name: "空titleと録音なし", body: { app: "us.zoom.xos", title: "", audio: false }, audio: false, title: "" },
    { name: "空白だけのapp", body: { app: " ", audio: false }, audio: false, title: undefined },
  ];
  for (const { name, body, audio, title } of valid) {
    it.live(`${name}を受理し、titleとaudioの値をそのまま開始へ渡す`, () =>
      Effect.gen(function* () {
        const r = yield* resource();
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify(body), undefined));
        expect(response.status).toBe(200);
        const result = yield* Effect.tryPromise(() => response.json() as Promise<{ dir: string }>);
        expect(result).toEqual({ dir: expect.any(String) });
        const runs = (yield* Effect.tryPromise(r.records)).filter((entry) => entry.type === "run");
        expect(runs).toHaveLength(1);
        const argv = runs[0]!.argv;
        expect(argv[argv.indexOf("--app") + 1]).toBe(body.app);
        expect(argv.includes("--audio-dir")).toBe(audio);
        const log = yield* Effect.tryPromise(() => readFile(join(result.dir, "log.jsonl"), "utf8"));
        const start = log.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.type === "start");
        expect(start.title).toBe(title === undefined ? result.dir.split("/").at(-1) : title);
      }));
  }

  // Issue #280: body.screen。省略と null は true（共有画面を使う）。false なら --no-screen を渡し、ログに screen-off（指定）を 1 件残す
  const screenCases = [
    { name: "省略", body: { app: "us.zoom.xos" }, noScreen: false },
    { name: "null", body: { app: "us.zoom.xos", screen: null }, noScreen: false },
    { name: "true", body: { app: "us.zoom.xos", screen: true }, noScreen: false },
    { name: "false", body: { app: "us.zoom.xos", screen: false }, noScreen: true },
    { name: "falseと録音なし", body: { app: "us.zoom.xos", screen: false, audio: false }, noScreen: true },
  ];
  for (const { name, body, noScreen } of screenCases) {
    it.live(`screen が${name}のとき、ヘルパーの --no-screen は${noScreen ? "付き" : "付かず"}、ログの screen-off（指定）は${noScreen ? "1 件" : "残らない"}`, () =>
      Effect.gen(function* () {
        const r = yield* resource();
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", JSON.stringify(body), undefined));
        expect(response.status).toBe(200);
        const result = yield* Effect.tryPromise(() => response.json() as Promise<{ dir: string }>);
        const runs = (yield* Effect.tryPromise(r.records)).filter((entry) => entry.type === "run");
        expect(runs).toHaveLength(1);
        expect(runs[0]!.argv.includes("--no-screen")).toBe(noScreen);
        const log = yield* Effect.tryPromise(() => readFile(join(result.dir, "log.jsonl"), "utf8"));
        const lines = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const offs = lines.filter((entry) => entry.type === "screen-off");
        expect(offs.map(({ type, start, reason }) => ({ type, start, reason }))).toEqual(noScreen ? [{ type: "screen-off", start: 0, reason: "指定" }] : []);
        if (noScreen) expect(lines.findIndex((entry) => entry.type === "start")).toBeLessThan(lines.findIndex((entry) => entry.type === "screen-off")); // start の行の後
      }));
  }
});

describe("HTTP の失敗応答（要件8〜11）", () => {
  for (const path of ["/session/stop", "/session/resume"]) {
    it.live(`${path}: セッションなしは409と既存の文面を返す`, () =>
      Effect.gen(function* () {
        const r = yield* resource();
        const response = yield* Effect.tryPromise(() => r.request("POST", path, undefined, undefined));
        expect(response.status).toBe(409);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "進行中のセッションがありません" });
      }));
  }
  it.live("進行中のstartと動作中のresumeは409と各条件の文面を返す", () =>
    Effect.gen(function* () {
      const r = yield* resource();
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
      const r = yield* resource();
      const response = yield* Effect.tryPromise(() => r.request("GET", "/missing", undefined, undefined));
      expect(response.status).toBe(404);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "未対応のリクエスト: GET /missing" });
    }));
  for (const failure of [new Error("updaterの取得失敗"), "タグのない失敗"]) {
    it.live(`予期しない失敗の文面を伏せず500のerror JSONで返す: ${String(failure)}`, () =>
      Effect.gen(function* () {
        const r = yield* resource({ updaterLayer: Layer.effect(DiffUpdater, Effect.die(failure)) });
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
        expect(response.status).toBe(500);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: failure instanceof Error ? failure.message : failure });
      }));
  }
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
  it.live("非ローカル Origin の start は403で拒否され、ヘルパーを起動しない", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', "https://evil.example"));
      expect(response.status).toBe(403);
      expect(r.calls).toHaveLength(0);
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

  // base の server.test.ts「開始に失敗しても、接続中のクライアントにも新しく接続したクライアントにも、空のマップは届かず…」の移動先。
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

  // base の server.test.ts「cli status が…」の配線部分（cli.ts の status → GET /session/status → formatIntakeStatus → 標準出力）の移動先
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
        const cliLayer = Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: r.sessionsDir, LIVE_MINDMAP_PORT: String(r.server.port) })),
          Layer.succeed(Console.Console, consoleService),
          Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.void })),
          Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("") })),
          fakeAudioMix().layer,
          fakeScreenJpeg().layer,
        );
        return runCli(["status"]).pipe(Effect.provide(cliLayer), Effect.map(() => out.join("")));
      });
      expect(yield* status()).toBe("セッションなし\n");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","title":"週次","audio":false}', undefined))).status).toBe(200);
      const [dir] = yield* Effect.tryPromise(() => readdir(r.sessionsDir));
      const running = yield* status();
      expect(running).toContain("動いている");
      expect(running).toContain(dir!);
      expect(running).toContain("起動し直した回数: 0");
      expect(running).not.toContain("最後の途切れの時刻");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      // 通常の stop の後は none に戻る。「止まった」（諦めた状態）の文面は intake.test.ts、状態の値は sessions.test.ts が観測する
      expect(yield* status()).toBe("セッションなし\n");
    }));

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

describe("HTTP と両upgradeの共通Origin制限（要件2・13・24）", () => {
  const allowed = [undefined, "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"];
  for (const origin of allowed) {
    it.live(`Origin ${String(origin)} はHTTP、/、/wsで受理され同じ最新マップが届く`, () =>
      Effect.gen(function* () {
        const r = yield* resource();
        const response = yield* Effect.tryPromise(() => r.request("GET", "/apps", undefined, origin));
        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual(apps);
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","title":"週次","audio":false}', origin))).status).toBe(200);
        const clients = [yield* connect(r.server.port, "/", origin), yield* connect(r.server.port, "/ws", origin)];
        for (const c of clients) {
          yield* Effect.tryPromise(() => vi.waitFor(() => expect(c.frames).toHaveLength(1), { timeout: 10_000 }));
          expect(c.frames[0]).toEqual({ nodes: [{ id: "root", parent: null, kind: "会議", text: "週次", evidence: [] }], round: 0, changes: [], remarks: [] });
        }
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, origin))).status).toBe(200);
        for (const c of clients) yield* Effect.tryPromise(() => vi.waitFor(() => expect(c.frames).toContainEqual({ type: "intake", status: "none" }), { timeout: 10_000 }));
      }));
  }
  for (const origin of ["https://evil.example", "null", "http://localhost.evil.example"]) {
    for (const path of ["/", "/ws"]) {
      it.live(`Origin ${origin} はHTTPと${path}のupgradeで403になり、配信されない`, () =>
        Effect.gen(function* () {
          const r = yield* resource();
          expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
          const withoutOrigin = yield* connect(r.server.port, path, undefined);
          yield* Effect.tryPromise(() => vi.waitFor(() => expect(withoutOrigin.frames).toHaveLength(1), { timeout: 10_000 }));
          const response = yield* Effect.tryPromise(() => r.request("GET", "/apps", undefined, origin));
          expect(response.status).toBe(403);
          expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "許可されていない Origin です" });
          const rejected = yield* Effect.tryPromise(() => new Promise<{ status: number | undefined; frames: unknown[] }>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${r.server.port}${path}`, { origin });
            const frames: unknown[] = [];
            ws.on("message", (data) => frames.push(JSON.parse(String(data))));
            ws.on("error", reject);
            ws.on("open", () => { ws.close(); reject(new Error("許可していないOriginがupgradeされた")); });
            ws.on("unexpected-response", (_req, res) => {
              res.resume();
              ws.terminate();
              resolve({ status: res.statusCode, frames });
            });
          }));
          expect(rejected.status).toBe(403);
          expect(rejected.frames).toEqual([]);
        }));
    }
  }
  it.live("closeで接続中のクライアントが切断され、同じポートは新しい接続を受け付けない（要件7）", () =>
    Effect.gen(function* () {
      const r = yield* resource();
      const c = yield* connect(r.server.port, "/ws", undefined);
      expect((yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined))).status).toBe(200);
      yield* r.server.close;
      yield* Effect.tryPromise(() => c.closed);
      yield* Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${r.server.port}/session/status`)).rejects.toThrow());
      expect(c.frames).toEqual([]);
    }));
  // close フレームに応答しない接続が 1 本残っていても、close() の所要時間はその接続の応答に依存しない有界な
  // 値になる（coding-001）。ws の既定の CLOSE_TIMEOUT（応答を待つ上限）は 30,000ms で、これを無界側の根拠として、
  // 十分小さい上限内に戻ることを確かめる
  it.live("close フレームに応答しない接続があっても、closeは有界時間で解決する（ISSUE-2）", () =>
    Effect.gen(function* () {
      const r = yield* resource();
      yield* connectUnresponsive(r.server.port);
      const startedAt = Date.now();
      yield* r.server.close;
      expect(Date.now() - startedAt).toBeLessThan(10_000);
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
      const r = yield* resource({
        capture: (_snapshot, path) =>
          Effect.promise(async () => {
            notifyReachedCapture!(); // ここに来た時点で state は確実に "stopping"（stop() が同期的に遷移させた後）
            await released; // テストが 409 を確認するまで、stop の応答をここで止めておく
            await writeFile(path, "");
          }),
      });
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined))).status).toBe(200);
      const stopping = r.request("POST", "/session/stop", undefined, undefined); // await しない。処理中に start を送る
      yield* Effect.tryPromise(() => reachedCapture);
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","audio":false}', undefined));
      expect(response.status).toBe(409);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "セッションの開始・終了の処理中です" });
      releaseCapture!();
      expect((yield* Effect.tryPromise(() => stopping)).status).toBe(200);
    }).pipe(Effect.ensuring(Effect.sync(() => releaseCapture!()))); // assert が失敗しても stop を解放する
  });
});

// 共有画面（Issue #278）。偽のヘルパーが流した screen が、ログ・screens/・Claude へのメッセージまで届く。
// 差分更新は本物の ClaudeDiffUpdater を残し、AgentSdk の query だけを偽物にする（server/test/playScreen.test.ts と同じ）
type SentBlock = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type SentMessage = { type: string; message: { role: string; content: string | SentBlock[] } };

describe("ライブのセッションの共有画面（偽のヘルパー + 偽の query）", () => {
  const fakeQuery = (sent: SentMessage[]) =>
    ((params: { prompt: AsyncIterable<SentMessage> }) => {
      const gen = (async function* () {
        for await (const message of params.prompt) {
          sent.push(message);
          yield { type: "assistant" };
          yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "テスト" }] } };
        }
      })();
      return Object.assign(gen, { close: () => {} });
    }) as unknown as AgentSdk["Service"]["query"];

  it.live("ヘルパーが流した screen が log.jsonl と screens/ に残り、Claude へのメッセージに見出しと画像のブロックとして載る", () =>
    Effect.gen(function* () {
      const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
      const sent: SentMessage[] = [];
      const claude = ClaudeDiffUpdater.layer.pipe(Layer.provide(Layer.succeed(AgentSdk, AgentSdk.of({ query: fakeQuery(sent) }))));
      const r = yield* resourceWithFakeHelpers([{
        events: [
          { type: "screen", start: 1, image: Buffer.from(jpeg).toString("base64") },
          { type: "remark", track: "相手", start: 0, end: 5, text: "今日は採用の進め方を決めます" },
          { type: "remark", track: "相手", start: 5, end: 9, text: "面接を何回にするかですね" },
        ],
      }], { updaterLayer: claude });

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
