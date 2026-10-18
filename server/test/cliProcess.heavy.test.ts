// CLI をプロセスとして起動して、プロセスでしか見えないもの（終了コード・stdout と stderr の実バイト・1 行にまとまること）だけを確かめる。
// help の文面・失敗の文面の中身・優先順は cliEntry.it.test.ts（runCli の軽い IT）が持つ。ここに残すのは代表 4 件
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

const cli = join(import.meta.dirname, "../src/cli.ts");
const repositoryRoot = join(import.meta.dirname, "../..");

type Result = { code: number; stdout: string; stderr: string };

function execute(command: string, args: string[], cwd: string | undefined, sessionsDir: string) {
  return Effect.tryPromise(() => new Promise<Result>((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      timeout: 20_000,
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_MODEL: "", LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0", NO_COLOR: "1" },
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

const runProcess = (argv: string[], sessionsDir: string) => execute(process.execPath, [cli, ...argv], undefined, sessionsDir);
// リポジトリのルートの package.json の cli スクリプト（pnpm cli）を通して起動する
const runPnpmCli = (argv: string[], sessionsDir: string) => execute("pnpm", ["cli", ...argv], repositoryRoot, sessionsDir);

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-cli-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

const emptyExport = { root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] } };

describe("CLI のプロセス入口", () => {
  it.live("--help は全サブコマンド・グローバルフラグと exit code 3 の意味を表示して成功する", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["--help"], sessionsDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of ["play", "apps", "start", "stop", "status", "resume", "export", "restore", "review", "eval"]) {
      expect(result.stdout).toMatch(new RegExp(`\\b${command}\\b`));
    }
    for (const flag of ["help", "version", "wizard", "completions", "log-level"]) {
      expect(result.stdout).toContain(`--${flag}`);
    }
    expect(result.stdout).toContain("exit code 3 = 開始に要るものが未導入");
  }).pipe(Effect.scoped));

  it.live("引数の誤りは help と ERROR を一度だけ表示して exit 1", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["export", "--format", "xml"], sessionsDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Usage/i);
    const errors = result.stderr.split("\n").filter((line) => line.trim() !== "");
    expect(errors.filter((line) => /^ERROR\b/.test(line))).toHaveLength(1);
    expect(errors[0]).toBe("ERROR");
    expect(errors.length).toBeGreaterThan(1);
    for (const detail of errors.slice(1)) expect(detail).toMatch(/^\s+\S/);
  }).pipe(Effect.scoped));

  it.live("export のセッションなしは既存の日本語一行と exit 1", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const result = yield* runProcess(["export"], sessionsDir);

    expect(result).toEqual({ code: 1, stdout: "", stderr: `セッションがありません: ${sessionsDir}\n` });
  }).pipe(Effect.scoped));

  it.live("pnpm cli 経由でも export の JSON を stdout に出して exit 0", () => Effect.gen(function* () {
    const sessionsDir = yield* temporaryDirectory;
    const run = join(sessionsDir, "run");
    yield* Effect.tryPromise(async () => {
      await mkdir(run);
      await writeFile(join(run, "export.json"), JSON.stringify(emptyExport));
    });
    const result = yield* runPnpmCli(["export", "--format", "json"], sessionsDir);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(emptyExport);
  }).pipe(Effect.scoped));
});
