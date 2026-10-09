import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Deferred, Effect, Layer, Queue, Ref, Stream, type Cause } from "effect";
import { MapCapture } from "../src/capture.ts";
import { AgentSdk, layerClaude } from "../src/claude.ts";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../src/helpers.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { type ServerOptions } from "../src/server.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { startedServer } from "./fixtures/startedServer.ts";
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
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
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

describe("HTTP の失敗応答（要件8〜11）", () => {
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
        const cliLayer = Layer.mergeAll(
          NodeServices.layer,
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
      const claude = layerClaude.pipe(Layer.provide(Layer.succeed(AgentSdk, AgentSdk.of({ query: fakeQuery(sent) }))));
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
