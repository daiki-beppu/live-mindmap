// CLI の入口が利用者に見せるもの（help・version・補完・失敗の 1 行・終了コード）を、runCli と入口の reportFailure・teardown で確かめる。
// プロセスでしか見えないもの（実際の終了コード・stdout と stderr の実バイト）は cliProcess.heavy.test.ts の代表 4 件が持つ。
// 入口の出力は Console を差し替えて集める（Console.log / Console.error の 1 回が、本物の 1 行と同じ末尾の改行つきの 1 件になる）。
// 終了コードは入口と同じく teardown に任せ、process.exitCode に置かれた値を読む。
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCliEntry } from "./fixtures/cliEntry.ts";
import { ReviewBuild } from "../src/review.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

const external = vi.hoisted(() => ({ openClaudeUpdater: vi.fn() }));
// play の準備（モデルの updater）だけを偽物にする。待受け（http.ts）は本物のまま（ポート使用中を実際の待受けで起こすため）
vi.mock("../src/claude.ts", async () => (await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater()));

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openClaudeUpdater.mockReturnValue({ update: () => Effect.succeed({ ops: [] }), close: () => {} });
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-cli-entry-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

const runEntry = Effect.fnUntraced(function* (argv: string[], sessionsDir: string, env: Record<string, string> = {}) {
  const layer = Layer.mergeAll(
    NodeServices.layer, unusedApple, readyManagedDeps, NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({
      HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_MODEL: "",
      LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0", ...env,
    })),
    Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.void })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
    fakeAudioMix().layer,
    fakeScreenJpeg().layer,
  );
  return yield* runCliEntry(argv, layer);
});

// 127.0.0.1 で待ち受けて塞いだポートを返す（play も 127.0.0.1 で待ち受けるので、同じアドレスでないと衝突しない）
const occupiedPort = Effect.acquireRelease(
  Effect.tryPromise(() => new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ポートを取得できない"));
        return;
      }
      resolve({ port: address.port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  })),
  (held) => Effect.promise(() => held.close()),
);

const emptyExport = { root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] } };

// 期待値は core/evaluate.ts の文面の写しではなく、CLI が出す契約として書く（Schema を使う前の実装と同じ文面）
const KEYWORDS_RULE = "keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）";

describe("CLI の入口の出力", () => {
  it.live.each(["play", "apps", "start", "stop", "status", "resume", "export", "restore", "review", "eval", "install", "check"])(
    "%s --help は処理本体を実行せず成功する",
    (command) => Effect.gen(function* () {
      const sessionsDir = yield* temporaryDirectory;
      const result = yield* runEntry([command, "--help"], sessionsDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/Usage/i);
      expect(result.stdout).toContain(command);
      if (["start", "resume", "play", "install", "check"].includes(command)) {
        expect(result.stdout).toContain("入れる前に利用者に確認する");
      }
    }).pipe(Effect.scoped),
  );

  it.live("start --help は --no-screen とその説明（共有画面を AI に渡さない（取り込まない））を表示する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runEntry(["start", "--help"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--no-screen");
    expect(result.stdout).toContain("共有画面を AI に渡さない（取り込まない）");
  }).pipe(Effect.scoped));

  it.live("--version は成功して標準出力にバージョンを表示する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runEntry(["--version"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).not.toBe("");
  }).pipe(Effect.scoped));

  it.live("--completions bash は補完スクリプトを出して成功する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runEntry(["--completions", "bash"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout).toContain("play");
    expect(result.stdout).toContain("export");
  }).pipe(Effect.scoped));

  it.live("--log-level none を付けても正常な export の stdout は変わらない", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const run = join(sessionsDir, "run");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "export.json"), JSON.stringify(emptyExport));
    });
    const result = yield* runEntry(["export", "--format", "json", "--log-level", "none"], sessionsDir);

    expect(result).toEqual({ code: 0, stderr: "", stdout: JSON.stringify(emptyExport, null, 2) + "\n" });
  }).pipe(Effect.scoped));

  it.live.each([
    { argv: ["play"] },
    { argv: ["start"] },
    { argv: ["eval"] },
    { argv: ["export", "--unknown-flag"] },
  ])("引数の誤り $argv は help と ERROR を一度だけ表示して exit 1", ({ argv }) => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runEntry(argv, sessionsDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Usage/i);
    const errors = result.stderr.split("\n").filter((line) => line.trim() !== "");
    expect(errors.filter((line) => /^ERROR\b/.test(line))).toHaveLength(1);
    expect(errors[0]).toBe("ERROR");
    expect(errors.length).toBeGreaterThan(1);
    for (const detail of errors.slice(1)) expect(detail).toMatch(/^\s+\S/);
  }).pipe(Effect.scoped));

  // JSON の構文エラーだけは理由が effect の文面になる（正解の形まで進めない）。枠・1 行・exit 1 を固定する
  it.live.each([
    { name: "JSON 構文不正", content: "{ not json" },
  ])("不正な正解ファイル（$name）は日本語の一行だけを stderr に出して exit 1", ({ content }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const truth = join(dir, "invalid.truth.json");
    yield* Effect.tryPromise(() => writeFile(truth, content));
    const result = yield* runEntry(["eval", "--truth", truth, dir], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const errors = result.stderr.trimEnd().split("\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^正解ファイルが不正です: /);
    expect(errors[0]).toContain(`${truth}（`);
    expect(errors[0]).toMatch(/）$/);
    expect(result.stderr).toBe(`${errors[0]}\n`);
  }).pipe(Effect.scoped));

  // 理由の文面は、人が正解ファイルを直せる日本語（CLI の出力契約）。期待値は Truth の Schema を使う前の実装と同じ
  it.live.each([
    { name: "入れ物が配列", content: JSON.stringify([]), reason: "正解はオブジェクトで書く" },
    { name: "種別のキーが無い", content: JSON.stringify({ TODO: [] }), reason: "「決定」は配列で書く" },
    { name: "種別が配列でない", content: JSON.stringify({ 決定: {}, TODO: [] }), reason: "「決定」は配列で書く" },
    {
      name: "from が数でない",
      content: JSON.stringify({ 決定: [{ text: "x", from: "1", to: 2, keywords: ["x"] }], TODO: [] }),
      reason: "「決定」の 1 件目: from / to は秒の数値で書く",
    },
    {
      name: "to が無い",
      content: JSON.stringify({ 決定: [], TODO: [{ text: "x", from: 1, keywords: ["x"] }] }),
      reason: "「TODO」の 1 件目: from / to は秒の数値で書く",
    },
    {
      name: "from が to より大きい",
      content: JSON.stringify({ 決定: [{ text: "x", from: 5, to: 2, keywords: ["x"] }], TODO: [] }),
      reason: "「決定」の 1 件目: from が to より大きい",
    },
    {
      name: "keywords が無い",
      content: JSON.stringify({ 決定: [{ text: "x", from: 1, to: 2 }], TODO: [] }),
      reason: `「決定」の 1 件目: ${KEYWORDS_RULE}`,
    },
    {
      name: "keywords が空",
      content: JSON.stringify({ 決定: [{ text: "x", from: 1, to: 2, keywords: [] }], TODO: [] }),
      reason: `「決定」の 1 件目: ${KEYWORDS_RULE}`,
    },
    {
      name: "keywords の要素が数",
      content: JSON.stringify({ 決定: [{ text: "x", from: 1, to: 2, keywords: [1] }], TODO: [] }),
      reason: `「決定」の 1 件目: ${KEYWORDS_RULE}`,
    },
    {
      name: "2 件目の keywords が無い",
      content: JSON.stringify({ 決定: [], TODO: [{ text: "x", from: 1, to: 2, keywords: ["x"] }, { text: "y", from: 1, to: 2 }] }),
      reason: `「TODO」の 2 件目: ${KEYWORDS_RULE}`,
    },
    // 1 つの項目に複数の誤りがあるときに選ぶ理由。Schema を使う前の実装は from / to の型 → from が to より大きい →
    // keywords の順に止めたので、その順を保つ（keywords の誤りが時刻の誤りを隠さない）
    {
      name: "from が to より大きく keywords も無い",
      content: JSON.stringify({ 決定: [{ text: "x", from: 5, to: 2 }], TODO: [] }),
      reason: "「決定」の 1 件目: from が to より大きい",
    },
    {
      name: "from が to より大きく keywords が空",
      content: JSON.stringify({ 決定: [{ text: "x", from: 5, to: 2, keywords: [] }], TODO: [] }),
      reason: "「決定」の 1 件目: from が to より大きい",
    },
    {
      name: "from が数でなく keywords も無い",
      content: JSON.stringify({ 決定: [{ text: "x", from: "5", to: 2 }], TODO: [] }),
      reason: "「決定」の 1 件目: from / to は秒の数値で書く",
    },
  ])("不正な正解ファイル（$name）は $reason を stderr の一行に出して exit 1", ({ content, reason }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const truth = join(dir, "invalid.truth.json");
    yield* Effect.tryPromise(() => writeFile(truth, content));
    const result = yield* runEntry(["eval", "--truth", truth, dir], dir);

    expect(result).toEqual({ code: 1, stdout: "", stderr: `正解ファイルが不正です: ${truth}（${reason}）\n` });
  }).pipe(Effect.scoped));

  it.live("正常な正解ファイルは eval の表へ届き、出力の書式と改行を保持する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const run = join(dir, "run");
    const truth = join(dir, "valid.truth.json");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "export.json"), JSON.stringify(emptyExport));
      await writeFile(truth, JSON.stringify({ 決定: [], TODO: [] }));
    });
    const result = yield* runEntry(["eval", "--truth", truth, run], dir);

    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: "| ラン | 会議 | ノード | 深さ | 議題 | 論点 | 案 | 決定 | 課題 | TODO | 要点 | 書き換え/発言 | 1 ノードの書き換えの最多 | 話し中の兄弟の最多 | 入力トークン | キャッシュ書き込みトークン | キャッシュ読み出しトークン | 出力トークン | 決定の再現率 | TODO の再現率 | 決定の種別違い | TODO の種別違い |\n"
        + "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n"
        + "| run | 定例 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | - | - | - | - | - | - | 0/0 | 0/0 | 0 | 0 |\n",
    });
  }).pipe(Effect.scoped));

  it.live.each(["restore", "publish"])("%s のセッションなしは既存の日本語一行と exit 1", (command) => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runEntry([command], sessionsDir);

    expect(result).toEqual({ code: 1, stdout: "", stderr: `セッションがありません: ${sessionsDir}\n` });
  }).pipe(Effect.scoped));

  it.live("restore の不正 JSON は空行を含む元の行番号と日本語一行を出して exit 1", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const run = join(sessionsDir, "run");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "log.jsonl"), '{"type":"start","title":"定例"}\n\n{ not json\n');
    });
    const result = yield* runEntry(["restore"], sessionsDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const reason = result.stderr.match(/: ([^\n]+)\n$/)?.[1];
    expect(reason).toBeTruthy();
    expect(result.stderr).toBe(`${join(run, "log.jsonl")} の 3 行目が JSON として読めません: ${reason}\n`);
  }).pipe(Effect.scoped));

  it.live("eval の不正イベントは、パスと空行を含む元の行番号の日本語一行を出して exit 1", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const run = join(sessionsDir, "run");
    const logPath = join(run, "log.jsonl");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "export.json"), JSON.stringify(emptyExport));
      await writeFile(logPath, '{"type":"start","title":"定例"}\n\n{"type":"remark"}\n');
    });
    const result = yield* runEntry(["eval", run], sessionsDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const detail = result.stderr.match(/: ([^\n]+)\n$/)?.[1];
    expect(detail).toBeTruthy();
    expect(result.stderr).toBe(`${logPath} の 3 行目が読めません: ${detail}\n`);
  }).pipe(Effect.scoped));

  it.live.each([
    { command: "review --self-only", argv: ["review", "--self-only"] },
    { command: "publish", argv: ["publish"] },
  ])("$command の不正 JSON は書き出し失敗に言い換えず、ログのパスを含む stderr 1 行と exit 1", ({ argv }) => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const run = join(sessionsDir, "run");
    const logPath = join(run, "log.jsonl");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(logPath, '{"type":"start","title":"定例"}\n\n{ not json\n');
      await writeFile(join(run, "自分.m4a"), "録音");
    });

    const result = yield* runEntry(argv, sessionsDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(logPath);
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toContain("を書き出せませんでした");
    expect(existsSync(join(run, "map-audio-自分.html"))).toBe(false);
  }).pipe(Effect.scoped));

  it.live("review の log.jsonl なしは、パスに改行があっても標準エラー 1 行と exit 1", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const missing = join(dir, "review\nmissing");
    const result = yield* runEntry(["review", missing], dir);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `log.jsonl がありません: ${join(missing, "log.jsonl").replaceAll("\n", " ")}\n`,
    });
    expect(existsSync(missing)).toBe(false);
  }).pipe(Effect.scoped));

  it.live("play の start なしは既存の日本語一行と exit 1", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const run = join(dir, "run");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "log.jsonl"), '{"type":"diff","input":5}\n');
    });

    const result = yield* runEntry(["play", run], dir);

    expect(result).toEqual({ code: 1, stdout: "", stderr: `log.jsonl に start の行がありません: ${join(run, "log.jsonl")}\n` });
  }).pipe(Effect.scoped));

  it.live("review のセッションなしは、保存先に改行があっても標準エラー 1 行と exit 1", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const sessionsDir = join(dir, "sessions\nroot");
    const result = yield* runEntry(["review"], sessionsDir);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `セッションがありません: ${sessionsDir.replaceAll("\n", " ")}\n`,
    });
    expect(existsSync(sessionsDir)).toBe(false);
  }).pipe(Effect.scoped));

  it.live("play --help は、文字起こしのほかにセッションのフォルダ（log.jsonl を持つフォルダ）も受けられることと、--screen と一緒に使えないことを説明する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runEntry(["play", "--help"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("セッションのフォルダ");
    expect(result.stdout).toContain("log.jsonl");
    expect(result.stdout).toContain("一緒に使えない");
  }).pipe(Effect.scoped));

  it.live("play にセッションのフォルダと --screen を一緒に渡すと、理由の標準エラー 1 行と 0 以外の終了で、セッションのフォルダを作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const folder = join(dir, "original");
    const tsv = join(dir, "slides.tsv");
    const sessionsDir = join(dir, "sessions");
    yield* Effect.tryPromise(async () => {
      await mkdir(folder);
      await writeFile(join(folder, "log.jsonl"), '{"type":"start","title":"定例"}\n');
      await writeFile(tsv, "start\tend\tslide\timage\n");
    });
    const result = yield* runEntry(["play", folder, "--screen", tsv], sessionsDir);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("--screen");
    expect(existsSync(sessionsDir)).toBe(false);
  }).pipe(Effect.scoped));

  it.live("play は待ち受けるポートが使用中なら、ポート番号と LIVE_MINDMAP_PORT を含む標準エラー 1 行と 0 以外の終了で、セッションのフォルダを作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const held = yield* occupiedPort;
    const transcript = join(dir, "small.transcript.json");
    const sessionsDir = join(dir, "sessions");
    yield* Effect.tryPromise(() => writeFile(transcript, JSON.stringify({
      schema_version: 1,
      duration: 10,
      source_path: "small.m4a",
      transcript: {
        tracks: ["speaker"],
        diagnostics: {},
        segments: [{ track: "speaker", start_seconds: 0.5, end_seconds: 9.5, text: "ポートが使用中の確認です", confidence: 0.9 }],
      },
    })));
    const result = yield* runEntry(["play", transcript], sessionsDir, { LIVE_MINDMAP_PORT: String(held.port) });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(String(held.port));
    expect(result.stderr).toContain("別のプロセス");
    expect(result.stderr).toContain("LIVE_MINDMAP_PORT");
    expect(existsSync(sessionsDir)).toBe(false);
  }).pipe(Effect.scoped));
});
