import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { WebSocket } from "ws";
import { realLayers, type ServerOptions } from "../src/server.ts";
import { DiffUpdater } from "../src/core/index.ts";
import { fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { connect } from "./fixtures/wsClient.ts";

const apps = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];
const fakeHelper = join(import.meta.dirname, "fixtures/fake-helper.ts");
const resource = Effect.fnUntraced(function* (options: { updaterLayer?: (model: import("../src/modelSelection.ts").ExecutableModel) => Layer.Layer<DiffUpdater> } & Pick<ExportServicesOptions, "capture"> = {}) {
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-http-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const script = join(dir, "script.json");
  const record = join(dir, "record.jsonl");
  const sessionsDir = join(dir, "sessions");
  yield* Effect.tryPromise(() => writeFile(script, JSON.stringify({ apps, events: [] })));
  yield* Effect.tryPromise(() => writeFile(record, ""));
  const serverOptions: ServerOptions = {
    port: 0, sessionsDir, depsDir: join(dir, "deps"),
    helper: { command: process.execPath, args: [fakeHelper, script, record] },
    prepareUpdater: (model) => Effect.succeed(options.updaterLayer ? options.updaterLayer(model) : updaterLayer(() => Effect.succeed({ ops: [] }))),
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
        const r = yield* resource({ updaterLayer: () => Layer.effect(DiffUpdater, Effect.die(failure)) });
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
