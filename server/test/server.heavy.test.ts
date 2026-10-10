import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it, vi } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import type { DiffInput, Op, Snapshot, SpeakingFrame } from "../src/core/index.ts";
import { HELPER_STOP_TIMEOUT_MS } from "../src/helpers.ts";
import { ReviewBuild } from "../src/review.ts";
import { realLayers } from "../src/server.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { fakeExportServices, FAKE_TEMPLATE } from "./fixtures/exportServices.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

// Issue #240 段 3（ADR 0008）: 本物の子プロセスを使うテストは、Helpers の実物 Layer の契約 6 本だけに絞る
// （order.md:40-46、CT-TEST-SPLIT）。偽の Layer・TestClock で確かめられる振る舞い（起動し直しの回数・
// resume・argv・stop/close の重なり・updater の開閉・speaking・状態のフレーム・cli status 等）は
// server/test/sessions.test.ts・sessionSinks.it.test.ts・http.it.test.ts に移した。このファイルに残るのは、
// 実物の子プロセス・実物の HTTP・実物の WebSocket を通さないと確かめられない契約だけ。

const fakeHelper = join(import.meta.dirname, "fixtures/fake-helper.ts");
const APPS = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];
const remark = (track: "自分" | "相手", start: number, end: number, text: string) => ({ type: "remark", track, start, end, text, duplicate: false });

type Script = {
  apps: unknown;
  events: unknown[];
  failRun?: { stderr: string; code: number };
  ignoreSigterm?: boolean;
  unexpectedExit?: { afterMs: number; code?: number; signal?: NodeJS.Signals };
  stderrLines?: string[];
};
type HelperRecord =
  | { type: "run"; argv: string[]; pid: number; attempt: number }
  | { type: "connection" }
  | { type: "signal"; signal: string }
  | { type: "unexpectedExit"; code?: number; signal?: string };

const setup = (initial: Partial<Script> = {}) =>
  Effect.gen(function* () {
  const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-")));
  const sessionsDir = join(dir, "sessions");
  const scriptPath = join(dir, "script.json");
  const recordPath = join(dir, "record.jsonl");
  const writeScript = (script: Partial<Script> = {}) =>
    writeFileSync(scriptPath, JSON.stringify({ apps: APPS, events: [remark("相手", 1, 5, "採用の面接について")], ...script } satisfies Script));
  writeScript(initial);
  writeFileSync(recordPath, "");
  const records = (): HelperRecord[] =>
    readFileSync(recordPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

  const calls: DiffInput[] = [];
  // 1 回目の呼び出しだけ、受け取った発言を根拠にノードを 1 つ足す（反映がマップへ届くことを観測できるようにする）。
  // 2 回目以降は noop（このファイルの契約は反映の内容そのものではなく、反映が届く・録音が書かれる・
  // ヘルパーの終わり方が読み取れることを確かめるためのもの）
  const updater = (input: DiffInput) =>
    Effect.sync(() => {
      calls.push(input);
      const ops: Op[] = calls.length === 1 ? [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: input.fresh.map((u) => u.id) }] : [];
      return { ops };
    });
  // 通常のテストでは、テストごとに Chromium を起動しないよう、撮影・見返し用の HTML のビルド・mix は偽物の Layer にする
  const options = {
    port: 0,
    depsDir: join(dir, "deps"),
    sessionsDir,
    prepareUpdater: () => Effect.succeed(updaterLayer(updater)),
    helper: { command: process.execPath, args: [fakeHelper, scriptPath, recordPath] },
  };
  // サーバーの標準エラー（Console.error）は、差し替えた Console に集める。ヘルパーを読むループは、start を受ける HTTP の fiber の
  // context を受け継ぐので、サーバーを起こす Effect に渡す
  const stderr: string[] = [];
  const stderrConsole: Console.Console = { ...console, error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); } };
  const server = yield* startedServer(options, realLayers(options, fakeExportServices())).pipe(Effect.provideService(Console.Console, stderrConsole));

  const out: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { out.push(args.map(String).join(" ") + "\n"); },
  };
  // 接続先ポートと保存先は ConfigProvider、標準出力は Console で渡す
  const cliLayer = Layer.mergeAll(
    NodeServices.layer, unusedApple,
    NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: String(server.port) })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({
      capture: (_snapshot: Snapshot, path: string) => Effect.sync(() => writeFileSync(path, "")),
    })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(FAKE_TEMPLATE) })),
    fakeAudioMix().layer,
    fakeScreenJpeg().layer,
  );
  // CLI を実行して、その標準出力を返す。中身の失敗は、入口の表を通す前のタグ付きの失敗のまま失敗にする
  const runOnce = (argv: string[]) =>
    Effect.suspend(() => {
      out.length = 0;
      return runCli(argv).pipe(Effect.provide(cliLayer), Effect.map(() => out.join("")));
    });
  const cli = (...argv: string[]) => runOnce(argv).pipe(Effect.orDie);
  // 失敗するはずのコマンド。成功したらテストが失敗し、失敗したらそのエラーメッセージを返す
  const cliFailure = (...argv: string[]) =>
    runOnce(argv).pipe(
      Effect.flip,
      Effect.map((e) => (e instanceof Error ? e.message : String(e))),
    );
  const sessionDirs = () =>
    Effect.promise(async () => (existsSync(sessionsDir) ? (await readdir(sessionsDir)).sort().map((d) => join(sessionsDir, d)) : []));
  return { server, cli, cliFailure, calls, writeScript, records, sessionDirs, sessionsDir, stderr };
  });

const connect = (port: number) =>
  Effect.gen(function* () {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Snapshot[] = [];
  const speaking: SpeakingFrame[] = [];
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data));
    if (frame.type === "speaking") speaking.push(frame);
    else if (!("type" in frame)) received.push(frame);
  });
  yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => ws.close()));
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("接続できない")));
      }),
  );
  return { ws, received, speaking };
  });

const logEvents = (dir: string) =>
  Effect.promise(async () => (await readFile(join(dir, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)));

const waitFor = (fn: () => void, options?: { timeout: number }) => Effect.promise(() => vi.waitFor(fn, options));

describe("Helpers の実物 Layer の契約（本物の子プロセス・HTTP・WebSocket。CT-TEST-SPLIT）", () => {
  it.live("疎通: cli apps → start → 発言 → stop → export（HTTP・/ws・子プロセスを本物で）", () =>
    Effect.gen(function* () {
      const { server, cli, calls, records, sessionDirs } = yield* setup();

      expect(JSON.parse(yield* cli("apps"))).toEqual(APPS);

      const before = yield* connect(server.port);
      yield* cli("start", "--app", "us.zoom.xos", "--title", "週次");
      yield* waitFor(() => expect(records().filter((r) => r.type === "connection")).toHaveLength(1));
      const runs = records().filter((r) => r.type === "run");
      expect(runs).toHaveLength(1);
      expect(runs[0]!.argv.slice(0, 3)).toEqual(["run", "--app", "us.zoom.xos"]);
      yield* waitFor(() => expect(calls.flatMap((c) => c.fresh)).toHaveLength(1));

      const stdout = yield* cli("stop");

      const [dir] = yield* sessionDirs();
      // 偽のヘルパーが stop で録音（相手.m4a・自分.m4a）を書くので、map.html の後に map-audio.html も出る
      const paths = [join(dir!, "map.md"), join(dir!, "map.json"), join(dir!, "map.drawnix"), join(dir!, "map.png"), join(dir!, "map.html"), join(dir!, "map-audio.html")];
      expect(stdout.split("\n").filter((l) => l !== "")).toEqual(paths);
      for (const path of paths) expect(existsSync(path)).toBe(true);
      expect(embeddedAudio(readFileSync(paths[5]!, "utf8"))).toEqual(FAKE_MIX_BYTES);
      expect(embeddedAudio(readFileSync(paths[4]!, "utf8"))).toBeNull();
      yield* waitFor(() => expect(before.received.map((s) => s.nodes.length).at(-1)).toBeGreaterThan(1));
      expect(JSON.parse(yield* cli("export", "--format", "json"))).toEqual(JSON.parse(readFileSync(paths[1]!, "utf8")));
    }));

  // 実時間で HELPER_STOP_TIMEOUT_MS（5 秒）待つ唯一の本物の時間のテスト（order.md:47, 65。forceKillAfter は
  // Node のタイマーで測るので TestClock では進まない）。stop・close の両方の経路を 1 本にまとめる（order.md:42）
  it.live(
    "SIGTERM を無視するヘルパーを、stop でも close でも 5 秒後に SIGKILL で止める",
    () =>
      Effect.gen(function* () {
        const { cli, calls, records, stderr } = yield* setup({ ignoreSigterm: true });
        yield* cli("start", "--app", "us.zoom.xos", "--title", "週次");
        yield* waitFor(() => expect(calls.flatMap((c) => c.fresh)).toHaveLength(1));
        const run = records().find((r) => r.type === "run");
        if (run?.type !== "run") throw new Error("ヘルパーが起動していない");

        const startedAt = Date.now();
        const stdout = yield* cli("stop");
        expect(Date.now() - startedAt).toBeLessThan(HELPER_STOP_TIMEOUT_MS + 3_000);
        expect(stdout.split("\n").filter((l) => l !== "")).toHaveLength(5);
        expect(() => process.kill(run.pid, 0)).toThrow(); // SIGKILL で止まっている
        expect(stderr.some((line) => line.includes("SIGKILL"))).toBe(true);
        // 録音していたので、録音の書き終わりを確認できなかったことも標準エラーに残す
        expect(stderr.some((line) => line.includes("録音の書き終わりを確認できない"))).toBe(true);

        // close の経路も同じ時間内に戻り、子プロセスを残さない
        const { server: server2, cli: cli2, records: records2 } = yield* setup({ ignoreSigterm: true });
        yield* cli2("start", "--app", "us.zoom.xos");
        yield* waitFor(() => expect(records2().filter((r) => r.type === "connection")).toHaveLength(1));
        const run2 = records2().find((r) => r.type === "run");
        if (run2?.type !== "run") throw new Error("ヘルパーが起動していない");
        const closeStartedAt = Date.now();

        yield* server2.close;

        expect(Date.now() - closeStartedAt).toBeLessThan(HELPER_STOP_TIMEOUT_MS + 3_000);
        expect(() => process.kill(run2.pid, 0)).toThrow();
      }),
    2 * HELPER_STOP_TIMEOUT_MS + 10_000,
  );

  it.live("サーバーが終わるとき、起動していたヘルパーの子プロセスを（プロセスグループごと）残さない", () =>
    Effect.gen(function* () {
      const { server, cli, records } = yield* setup();
      yield* cli("start", "--app", "us.zoom.xos");
      const run = records().find((r) => r.type === "run");
      if (run?.type !== "run") throw new Error("ヘルパーが起動していない");
      expect(() => process.kill(run.pid, 0)).not.toThrow(); // 生きている

      yield* server.close;

      yield* waitFor(() => expect(() => process.kill(run.pid, 0)).toThrow());
      // detached: true で起動したヘルパーは自分のプロセスグループの leader（pgid === pid）になる。
      // 負の pid は「そのプロセスグループ全体」を指す（kill(2)）ので、グループごと残っていないことも確かめる
      expect(() => process.kill(-run.pid, 0)).toThrow();
    }));

  it.live("ヘルパーが起動に失敗すると、start はその stderr の末尾を伝えて失敗し、セッションは開始されない", () =>
    Effect.gen(function* () {
      const { cliFailure } = yield* setup({ failRun: { stderr: "マイクが許可されていません", code: 1 } });

      expect(yield* cliFailure("start", "--app", "us.zoom.xos")).toContain("マイクが許可されていません");
      yield* cliFailure("stop"); // 進行中のセッションはない
    }));

  it.live("予期せぬ終了の 2 つの終わり方（code で終わる・signal で落ちる）を、code・signal・stderrTail の値として読み取れる", () =>
    Effect.gen(function* () {
      const codeLines = ["l1", "l2", "l3", "l4", "l5", "l6"]; // STDERR_TAIL_LINES（5）を超える行数で、末尾だけが残ることも確かめる
      const signalLines = ["s1", "s2", "s3"];
      const { cli, sessionDirs } = yield* setup({
        events: [],
        unexpectedExit: { afterMs: 300, code: 1 },
        stderrLines: codeLines,
      });
      yield* cli("start", "--app", "us.zoom.xos", "--title", "週次");
      const [dir] = yield* sessionDirs();
      yield* waitFor(() => expect(readFileSync(join(dir!, "log.jsonl"), "utf8")).toContain("intake-stopped"), { timeout: 10_000 });

      const codeEvents = (yield* logEvents(dir!)).filter((e) => e.type === "intake-stopped");
      expect(codeEvents[0]).toMatchObject({ code: 1, signal: null, stderrTail: codeLines.slice(-5) });

      yield* cli("stop");

      // 同じ 2 つの終わり方を、起動し直し後の signal 側でも確かめる
      const { cli: cli2, sessionDirs: sessionDirs2 } = yield* setup({
        events: [],
        unexpectedExit: { afterMs: 300, signal: "SIGKILL" },
        stderrLines: signalLines,
      });
      yield* cli2("start", "--app", "us.zoom.xos", "--title", "週次");
      const [dir2] = yield* sessionDirs2();
      yield* waitFor(() => expect(JSON.stringify(readFileSync(join(dir2!, "log.jsonl"), "utf8"))).toContain("intake-stopped"), { timeout: 10_000 });
      const signalEvents = (yield* logEvents(dir2!)).filter((e) => e.type === "intake-stopped");
      expect(signalEvents[0]).toMatchObject({ code: null, signal: "SIGKILL", stderrTail: signalLines });
      yield* cli2("stop");
    }));

  it.live("stop が戻った時点で、2 つの録音が最後まで書かれている", () =>
    Effect.gen(function* () {
      const { cli, sessionDirs, stderr } = yield* setup();
      yield* cli("start", "--app", "us.zoom.xos");

      yield* cli("stop");

      // 強制終了していないので、録音の警告は出ない
      expect(stderr.some((line) => line.includes("録音の書き終わり"))).toBe(false);
      const [dir] = yield* sessionDirs();
      for (const name of ["相手.m4a", "自分.m4a"]) {
        expect(readFileSync(join(dir!, name), "utf8")).toBe("complete");
      }
      expect(existsSync(join(dir!, "map.json"))).toBe(true);
    }));
});
