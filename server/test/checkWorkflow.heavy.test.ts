import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobLines, root, runScriptOf } from "./fixtures/checkWorkflow.ts";

// check.yml の jq が値を決める 2 つの契約の代表。jq は OS のコマンドなので heavy に置く。

// Issue #589: ruleset の必須チェック `check` は、runner を取れずに終わったジョブ（result が failure・cancelled 以外の値で渡る）を見逃して通った。
// 「失敗を探す」から「全部が success か skipped であることを確かめる」に変える。
const needsJson = (results: Record<string, string>): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }])),
  );

const runStep = (json: string, parents: Record<string, string>) =>
  spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf("check")], {
    env: { ...process.env, NEEDS_JSON: needsJson(parents), TEST_RESULTS_JSON: json },
    encoding: "utf8",
  });

const workflow = readFileSync(join(root, ".github/workflows/tests.yml"), "utf8");
const jobNames = [...workflow.slice(workflow.indexOf("\njobs:\n"))
  .matchAll(/^  ([\w-]+):$/gm)].map((match) => match[1]!).filter((job) => job !== "results");
const allSuccess = Object.fromEntries(jobNames.map((job) => [job, "success"]));
const parentsSuccess = { changes: "success", tests: "success" };

describe("check ジョブの判定", () => {
  it("success・skipped だけなら通り、それ以外の値が 1 つでもあれば落ちてジョブ名と結果を出す", () => {
    expect(runStep(needsJson(allSuccess), parentsSuccess).status).toBe(0);
    expect(runStep(needsJson(Object.fromEntries(jobNames.map((job) => [job, "skipped"]))), parentsSuccess).status).toBe(0);
    expect(runStep(needsJson({ ...allSuccess, helper: "skipped" }), parentsSuccess).status).toBe(0);
    const r = runStep(needsJson({ ...allSuccess, helper: "timed_out" }), parentsSuccess);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/helper\W+timed_out/);
  });

  it.each(Object.keys(allSuccess))("%s の不許可の結果なら必須 check を失敗にする", (job) => {
    for (const result of ["failure", "cancelled", "timed_out", ""]) {
      const r = runStep(needsJson({ ...allSuccess, [job]: result }), parentsSuccess);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain(`${job}: ${result}`);
    }
  });

  it.each(jobNames)("%s の結果だけ欠けても必須 check を失敗にする", (job) => {
    const remaining = Object.fromEntries(Object.entries(allSuccess).filter(([name]) => name !== job));
    expect(runStep(needsJson(remaining), parentsSuccess).status).not.toBe(0);
  });

  it.each(["changes", "tests"])("%s 自体が成功しなければ子結果に依存せず失敗する", (job) => {
    for (const result of ["failure", "cancelled", "timed_out", ""]) {
      const parents = { ...parentsSuccess, [job]: result };
      expect(runStep(needsJson(allSuccess), parents).status).not.toBe(0);
      expect(runStep("", parents).status).not.toBe(0);
    }
  });

  it("changes 失敗で呼び出しが skipped になっても失敗する", () => {
    expect(runStep("", { changes: "failure", tests: "skipped" }).status).not.toBe(0);
  });

  it.each([
    "", "{", "{}", "null", "[]", "true",
    needsJson({ ...allSuccess, unexpected: "success" }),
    JSON.stringify({ ...JSON.parse(needsJson(allSuccess)), helper: {} }),
    JSON.stringify({ ...JSON.parse(needsJson(allSuccess)), helper: "success" }),
    `${needsJson(allSuccess)}\n${needsJson(allSuccess)}`,
  ])("呼び出し成功でも子結果が欠落・不正なら失敗する (%j)", (json) => {
    expect(runStep(json, parentsSuccess).status).not.toBe(0);
  });

  it.each(jobNames)("結果出力ステップを通った %s の結果から最上位 check が判定する", (job) => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-results-"));
    try {
      const output = join(dir, "output");
      for (const result of ["success", "skipped", "failure", "cancelled"]) {
        writeFileSync(output, "");
        const expected = { ...allSuccess, [job]: result };
        const dependencyLine = jobLines("results").find((line) => line.trimStart().startsWith("needs:"));
        expect(dependencyLine, "collector が結果を受け取る依存ジョブ").toBeDefined();
        const dependencies = dependencyLine!.slice(dependencyLine!.indexOf("[") + 1, dependencyLine!.indexOf("]"))
          .split(",").map((name) => name.trim());
        const json = needsJson(Object.fromEntries(dependencies.map((name) => [name, expected[name]!])));
        const collected = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf("results")], {
          env: { ...process.env, NEEDS_JSON: json, GITHUB_OUTPUT: output }, encoding: "utf8",
        });
        expect(collected.status, collected.stderr).toBe(0);
        const line = readFileSync(output, "utf8").trim();
        expect(line.startsWith("results=")).toBe(true);
        const transferred = line.slice("results=".length);
        expect(JSON.parse(transferred)).toEqual(JSON.parse(needsJson(expected)));
        expect(runStep(transferred, parentsSuccess).status === 0).toBe(result === "success" || result === "skipped");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Issue #562: each の同じ行を別 runner に分けると、同じテストを重複して実行してしまう。
// heavy ジョブの run を取り出し、`pnpm` を偽物に差し替えて、list の出力に見立てた JSON を渡して割り振りを確かめる
type Listed = { name: string; file: string; location?: { line: number; column: number } };

type RunnerResult = { status: number | null; output: string; runArgs: string[] | undefined };

type WorkflowRunner = { job: "heavy" | "light"; package: string; shard: number; shards: number };

const heavyRunners = (): WorkflowRunner[] => {
  const lines = jobLines("heavy");
  const start = lines.findIndex((line) => line.trim() === "include:");
  expect(start, "package ごとの runner を matrix.include から読む").toBeGreaterThanOrEqual(0);
  const entries = lines.slice(start + 1).join("\n").matchAll(
    /^\s+- package: (\w+)\n\s+shard: (\d+)\n\s+shards: (\d+)\s*$/gm,
  );
  return [...entries].map((match) => ({
    job: "heavy", package: match[1]!, shard: Number(match[2]), shards: Number(match[3]),
  }));
};

const runnerEnv = (runner: WorkflowRunner): Record<string, string> => {
  const lines = jobLines(runner.job);
  const names = runner.job === "light" ? ["SHARD"] : ["SHARD", "SHARDS"];
  return Object.fromEntries(names.map((name) => {
    const line = lines.find((line) => line.trim().startsWith(`${name}:`));
    const expression = line?.match(/\$\{\{ matrix\.(shard|shards) \}\}/);
    expect(expression, `${name} を matrix から実行環境へ渡す`).toBeDefined();
    return [name, String(runner[expression![1] as "shard" | "shards"])];
  }));
};

const runRunner = (runner: WorkflowRunner, options: {
  listing: (cwd: string) => Listed[];
  listStatus: number;
  runStatus: number;
}): RunnerResult => {
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
        '  *"--dir web exec vitest list"*) cat "$FAKE_WEB_LIST"; exit "$LIST_STATUS" ;;',
        '  *"vitest list"*) cat "$FAKE_LIST"; exit "$LIST_STATUS" ;;',
        '  *"vitest run"*) printf \'%s\\n\' "$*" >> "$RUN_LOG"; exit "$RUN_STATUS" ;;',
        '  *) echo "unexpected pnpm call: $*" >&2; exit 99 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(pnpm, 0o755);
    mkdirSync(join(work, "scripts"));
    copyFileSync(join(root, "scripts/run-ci-tests.sh"), join(work, "scripts/run-ci-tests.sh"));
    const fakeList = join(dir, "list.json");
    writeFileSync(fakeList, JSON.stringify(options.listing(join(work, runner.package))));
    const webList = join(dir, "web-list.json");
    writeFileSync(webList, JSON.stringify(runner.job === "light"
      ? [entry(join(work, "web"), "test/web.it.test.ts", 1, "web light")]
      : options.listing(join(work, "web"))));
    const runLog = join(dir, "run.log");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf(runner.job)], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...runnerEnv(runner),
        PACKAGE: runner.package,
        FAKE_LIST: fakeList,
        FAKE_WEB_LIST: webList,
        RUN_LOG: runLog,
        LIST_STATUS: String(options.listStatus),
        RUN_STATUS: String(options.runStatus),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.error).toBeUndefined();
    return {
      status: r.status, output: `${r.stdout}${r.stderr}`,
      runArgs: existsSync(runLog) ? readFileSync(runLog, "utf8").trim().split(/\s+/) : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const entry = (cwd: string, file: string, line: number, name: string): Listed => ({
  name,
  file: `${cwd}/${file}`,
  location: { line, column: 3 },
});

const targetsOf = (r: RunnerResult, groups: string[]): string[] => (r.runArgs ?? [])
  .filter((arg) => /\.test\.ts(?::\d+)?$/.test(arg))
  .flatMap((arg) => groups.filter((group) => group === arg || group.startsWith(`${arg}:`)));

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
  it.each(["server", "web"])("%s の runner の file:line を合わせると入力のまとまりと一致し、重複も漏れも無い", (pkg) => {
    const runners = heavyRunners().filter((runner) => runner.package === pkg);
    expect(runners.length).toBeGreaterThan(0);
    const results = runners.map((runner) => runRunner(runner, { listing: mixed, listStatus: 0, runStatus: 0 }));
    for (const r of results) expect(r.status, r.output).toBe(0);
    const all = results.flatMap((r) => targetsOf(r, mixedGroups));
    expect([...all].sort()).toEqual(mixedGroups);
  });

  it("measureBootstrap の担当 runner は他の heavy を実行しない", () => {
    const bootstrapGroups = [
      "test/measureBootstrap.heavy.test.ts:10",
      "test/measureBootstrap.heavy.test.ts:20",
    ];
    const groups = [...mixedGroups, ...bootstrapGroups].sort();
    const listing = (cwd: string): Listed[] => [
      ...mixed(cwd),
      entry(cwd, "test/measureBootstrap.heavy.test.ts", 10, "bootstrap"),
      entry(cwd, "test/measureBootstrap.heavy.test.ts", 20, "bootstrap again"),
    ];
    const results = heavyRunners().filter((runner) => runner.package === "server")
      .map((runner) => runRunner(runner, { listing, listStatus: 0, runStatus: 0 }));
    for (const r of results) expect(r.status, r.output).toBe(0);
    const bootstrap = results.filter((r) => targetsOf(r, groups).some((target) => target.includes("/measureBootstrap.heavy.test.ts:")));
    expect(bootstrap).toHaveLength(1);
    expect(targetsOf(bootstrap[0]!, groups)).toEqual(bootstrapGroups);
    expect(results.flatMap((r) => targetsOf(r, groups)).sort()).toEqual(groups);
  });

  it("空の担当では vitest run を呼ばずに成功する", () => {
    for (const runner of heavyRunners()) {
      const r = runRunner(runner, { listing: () => [], listStatus: 0, runStatus: 0 });
      expect(r.status, r.output).toBe(0);
      expect(r.runArgs).toBeUndefined();
    }
  });

  it("一覧取得が失敗したら空の担当として成功させない", () => {
    for (const runner of heavyRunners()) {
      const r = runRunner(runner, { listing: () => [], listStatus: 42, runStatus: 0 });
      expect(r.status, r.output).not.toBe(0);
      expect(r.runArgs).toBeUndefined();
    }
  });

  it("担当テストの失敗を runner の失敗として返す", () => {
    const results = heavyRunners().map((runner) => runRunner(runner, { listing: mixed, listStatus: 0, runStatus: 43 }));
    const executed = results.filter((r) => r.runArgs !== undefined);
    expect(executed.length).toBeGreaterThan(0);
    for (const r of executed) expect(r.status, r.output).not.toBe(0);
  });
});


describe("light ジョブの割り振り", () => {
  it("server を2 runner に重複・漏れなく配り、web は片方だけが全件実行する", () => {
    const matrix = jobLines("light").find((line) => line.trim().startsWith("shard:"));
    const shards = matrix!.slice(matrix!.indexOf("[") + 1, matrix!.indexOf("]")).split(",").map(Number);
    const listing = (cwd: string) => mixed(cwd).map((listed) => ({ ...listed, file: listed.file.replace(".heavy.", ".it.") }));
    const groups = [...mixedGroups.map((group) => group.replace(".heavy.", ".it.")), "test/web.it.test.ts:1"].sort();
    const results = shards.map((shard) => runRunner({ job: "light", package: "server", shard, shards: 2 }, { listing, listStatus: 0, runStatus: 0 }));
    for (const r of results) expect(r.status, r.output).toBe(0);
    expect(results.flatMap((r) => targetsOf(r, groups)).sort()).toEqual(groups);
  });
});

it("一覧には実際に登録されたテストを含め、テストに似た変数の呼び出しを含めない", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workflow-collection-")));
  try {
    const pkg = join(dir, "server");
    mkdirSync(pkg);
    symlinkSync(join(root, "server/node_modules"), join(pkg, "node_modules"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(pkg, "vitest.config.ts"), `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { projects: [{ test: { name: "heavy", include: ["*.heavy.test.js"] } }] } });
`);
    writeFileSync(join(pkg, "generated.heavy.test.js"), `import { it } from "vitest";
const testData = [1];
testData.map((value) => value + 1);
const register = it;
register("registered", () => {});
`);
    const result = spawnSync("bash", [join(root, "scripts/run-ci-tests.sh"), "server", "heavy", "1", "2", "tests", "list"], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const rows: Listed[] = JSON.parse(result.stdout);
    expect(rows.map((row) => row.name)).toEqual(["registered"]);
    expect(rows[0]?.file).toBe("generated.heavy.test.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
