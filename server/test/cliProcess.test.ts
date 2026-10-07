import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

const cli = join(import.meta.dirname, "../src/cli.ts");

function runProcess(argv: string[], sessionsDir: string) {
  return Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [cli, ...argv], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error.code, stdout, stderr });
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  }));
}

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-cli-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

const emptyExport = { root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] } };

// 期待値は core/evaluate.ts の文面の写しではなく、CLI が出す契約として書く（Schema を使う前の実装と同じ文面）
const KEYWORDS_RULE = "keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）";

describe("CLI のプロセス入口", () => {
  it.live("--help は全サブコマンドとグローバルフラグを表示して成功する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["--help"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of ["play", "apps", "start", "stop", "status", "resume", "export", "restore", "eval"]) {
      expect(result.stdout).toMatch(new RegExp(`\\b${command}\\b`));
    }
    for (const flag of ["help", "version", "wizard", "completions", "log-level"]) {
      expect(result.stdout).toContain(`--${flag}`);
    }
  }).pipe(Effect.scoped));

  it.live.each(["play", "apps", "start", "stop", "status", "resume", "export", "restore", "eval"])(
    "%s --help は処理本体を実行せず成功する",
    (command) => Effect.gen(function* () {
      const sessionsDir = yield* temporaryDirectory;
      const result = yield* runProcess([command, "--help"], sessionsDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/Usage/i);
      expect(result.stdout).toContain(command);
    }).pipe(Effect.scoped),
  );

  it.live("--version は成功して標準出力にバージョンを表示する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["--version"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).not.toBe("");
  }).pipe(Effect.scoped));

  it.live("--completions bash は補完スクリプトを出して成功する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["--completions", "bash"], sessionsDir);

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
    const result = yield* runProcess(["export", "--format", "json", "--log-level", "none"], sessionsDir);

    expect(result).toEqual({ code: 0, stderr: "", stdout: JSON.stringify(emptyExport, null, 2) + "\n" });
  }).pipe(Effect.scoped));

  it.live.each([
    { argv: ["play"] },
    { argv: ["start"] },
    { argv: ["eval"] },
    { argv: ["export", "--format", "xml"] },
    { argv: ["export", "--unknown-flag"] },
  ])("引数の誤り $argv は help と ERROR を一度だけ表示して exit 1", ({ argv }) => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(argv, sessionsDir);

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
    const result = yield* runProcess(["eval", "--truth", truth, dir], dir);

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
    const result = yield* runProcess(["eval", "--truth", truth, dir], dir);

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
    const result = yield* runProcess(["eval", "--truth", truth, run], dir);

    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: "| ラン | 会議 | ノード | 深さ | 議題 | 論点 | 案 | 決定 | 課題 | TODO | 要点 | 決定の再現率 | TODO の再現率 |\n"
        + "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n"
        + "| run | 定例 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 | 0/0 |\n",
    });
  }).pipe(Effect.scoped));

  it.live.each(["export", "restore"])("%s のセッションなしは既存の日本語一行と exit 1", (command) => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess([command], sessionsDir);

    expect(result).toEqual({ code: 1, stdout: "", stderr: `セッションがありません: ${sessionsDir}\n` });
  }).pipe(Effect.scoped));

  it.live("apps の接続失敗は既存の日本語一行と exit 1", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["apps"], sessionsDir);

    expect(result).toEqual({ code: 1, stdout: "", stderr: "サーバーにつながりません（pnpm dev で起動）\n" });
  }).pipe(Effect.scoped));

  it.live("restore の不正 JSON は空行を含む元の行番号と日本語一行を出して exit 1", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const run = join(sessionsDir, "run");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "log.jsonl"), '{"type":"start","title":"定例"}\n\n{ not json\n');
    });
    const result = yield* runProcess(["restore"], sessionsDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^log\.jsonl の 3 行目が JSON として読めません: [^\n]+\n$/);
  }).pipe(Effect.scoped));
});
