import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobLines, runScriptOf } from "./fixtures/checkWorkflow.ts";

// check.yml の jq が値を決める 2 つの契約の代表。jq は OS のコマンドなので heavy に置く。

// Issue #589: ruleset の必須チェック `check` は、runner を取れずに終わったジョブ（result が failure・cancelled 以外の値で渡る）を見逃して通った。
// 「失敗を探す」から「全部が success か skipped であることを確かめる」に変える。
const needsJson = (results: Record<string, string>): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }])),
  );

const runStep = (json: string) =>
  spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf("check")], {
    env: { ...process.env, NEEDS_JSON: json },
    encoding: "utf8",
  });

const allSuccess = { changes: "success", ts: "success", heavy: "success", e2e: "success", helper: "success" };

describe("check ジョブの判定", () => {
  it("success・skipped だけなら通り、それ以外の値が 1 つでもあれば落ちてジョブ名と結果を出す", () => {
    expect(runStep(needsJson(allSuccess)).status).toBe(0);
    expect(runStep(needsJson({ changes: "success", ts: "skipped", heavy: "skipped", e2e: "skipped", helper: "skipped" })).status).toBe(0);
    const r = runStep(needsJson({ ...allSuccess, helper: "timed_out" }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/helper\W+timed_out/);
  });
});

// Issue #562: each の同じ行を別 runner に分けると、同じテストを重複して実行してしまう。
// heavy ジョブの run を取り出し、`pnpm` を偽物に差し替えて、list の出力に見立てた JSON を渡して割り振りを確かめる
type Listed = { name: string; file: string; location?: { line: number; column: number } };

type RunnerResult = { status: number | null; output: string; runArgs: string[] | undefined };

type HeavyRunner = { package: string; shard: number; shards: number };

const heavyRunners = (): HeavyRunner[] => {
  const lines = jobLines("heavy");
  const start = lines.findIndex((line) => line.trim() === "include:");
  expect(start, "package ごとの runner を matrix.include から読む").toBeGreaterThanOrEqual(0);
  const entries = lines.slice(start + 1).join("\n").matchAll(
    /^\s+- package: (\w+)\n\s+shard: (\d+)\n\s+shards: (\d+)\s*$/gm,
  );
  return [...entries].map((match) => ({
    package: match[1]!, shard: Number(match[2]), shards: Number(match[3]),
  }));
};

const runnerEnv = (runner: HeavyRunner): Record<string, string> => {
  const lines = jobLines("heavy");
  return Object.fromEntries(["SHARD", "SHARDS"].map((name) => {
    const line = lines.find((line) => line.trim().startsWith(`${name}:`));
    const expression = line?.match(/\$\{\{ matrix\.(shard|shards) \}\}/);
    expect(expression, `${name} を matrix から実行環境へ渡す`).toBeDefined();
    return [name, String(runner[expression![1] as "shard" | "shards"])];
  }));
};

const runRunner = (runner: HeavyRunner): RunnerResult => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "heavy-split-")));
  try {
    const bin = join(dir, "bin");
    const work = join(dir, "work");
    for (const d of [bin, work]) spawnSync("mkdir", ["-p", d]);
    const pnpm = join(bin, "pnpm");
    writeFileSync(
      pnpm,
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"vitest list"*) cat "$FAKE_LIST" ;;',
        '  *"vitest run"*) printf \'%s\\n\' "$*" > "$RUN_LOG" ;;',
        '  *) echo "unexpected pnpm call: $*" >&2; exit 99 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(pnpm, 0o755);
    const fakeList = join(dir, "list.json");
    writeFileSync(fakeList, JSON.stringify(mixed(work)));
    const runLog = join(dir, "run.log");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf("heavy")], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...runnerEnv(runner),
        FAKE_LIST: fakeList,
        RUN_LOG: runLog,
      },
      encoding: "utf8",
    });
    const read = (f: string): string[] | undefined => {
      try {
        return readFileSync(f, "utf8").trim().split(/\s+/);
      } catch {
        return undefined;
      }
    };
    return { status: r.status, output: `${r.stdout}${r.stderr}`, runArgs: read(runLog) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const entry = (cwd: string, file: string, line: number, name: string): Listed => ({
  name,
  file: `${cwd}/${file}`,
  location: { line, column: 3 },
});

const targetsOf = (r: RunnerResult): string[] => (r.runArgs ?? []).filter((a) => /\.test\.ts:\d+$/.test(a));

// 同じ行から複数のテストができる（each）ものと、check.yml に名前の無い新しいファイルを含む。順番はばらばら
const mixed = (cwd: string): Listed[] => [
  entry(cwd, "test/b.heavy.test.ts", 30, "b30"),
  entry(cwd, "test/a.heavy.test.ts", 56, "each 1"),
  entry(cwd, "test/a.heavy.test.ts", 56, "each 2"),
  entry(cwd, "test/a.heavy.test.ts", 10, "a10"),
  entry(cwd, "test/a.heavy.test.ts", 56, "each 3"),
  entry(cwd, "test/c.heavy.test.ts", 5, "c5"),
  entry(cwd, "test/b.heavy.test.ts", 20, "b20"),
  entry(cwd, "test/brandNew.heavy.test.ts", 7, "new"),
];
const mixedGroups = [
  "test/a.heavy.test.ts:10",
  "test/a.heavy.test.ts:56",
  "test/b.heavy.test.ts:20",
  "test/b.heavy.test.ts:30",
  "test/brandNew.heavy.test.ts:7",
  "test/c.heavy.test.ts:5",
];

describe("heavy ジョブの割り振り", () => {
  it.each([
    { package: "server", shards: [0] },
    { package: "web", shards: [0, 1] },
  ])("$package の runner の file:line を合わせると入力のまとまりと一致し、重複も漏れも無い", ({ package: pkg, shards }) => {
    const runners = heavyRunners().filter((runner) => runner.package === pkg);
    expect(runners.map((runner) => runner.shard).sort()).toEqual(shards);
    for (const runner of runners) expect(runner.shards).toBe(shards.length);
    const results = runners.map(runRunner);
    for (const r of results) expect(r.status, r.output).toBe(0);
    const all = results.flatMap(targetsOf);
    expect([...all].sort()).toEqual(mixedGroups);
  });
});
