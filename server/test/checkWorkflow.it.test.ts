import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #589: ruleset の必須チェック `check` は、runner を取れずに終わったジョブ（result が failure・cancelled 以外の値で渡る）を見逃して通った。
// 「失敗を探す」から「全部が success か skipped であることを確かめる」に変える。
const root = join(import.meta.dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");

const indentOf = (line: string): number => line.length - line.trimStart().length;

const jobLines = (job: string): string[] => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() !== "" && indentOf(l) <= 2);
  return end === -1 ? rest : rest.slice(0, end);
};

const checkJobLines = (): string[] => jobLines("check");

const runScriptOf = (job: string): string => {
  const lines = jobLines(job);
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  expect(at).toBeGreaterThanOrEqual(0);
  const base = indentOf(lines[at]!);
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && indentOf(l) <= base) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  return body.map((l) => l.slice(strip)).join("\n");
};

const runScript = (): string => runScriptOf("check");

const needsJson = (results: Record<string, string>): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }])),
  );

const runStep = (json: string) =>
  spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScript()], {
    env: { ...process.env, NEEDS_JSON: json },
    encoding: "utf8",
  });

const allJobs = (): string[] => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  expect(start).toBeGreaterThanOrEqual(0);
  return lines
    .slice(start + 1)
    .map((l) => /^ {2}([\w-]+):\s*$/.exec(l)?.[1])
    .filter((j): j is string => j !== undefined);
};

const otherJobs = (): string[] => allJobs().filter((j) => j !== "check");

const allSuccess = { changes: "success", ts: "success", heavy: "success", helper: "success" };

describe("check ジョブの構造", () => {
  it("判定のステップは条件なしで毎回走る（スキップされたステップは成功扱いになる）", () => {
    const stepLines = checkJobLines().filter((l) => /^\s+- /.test(l) || /^\s+if:/.test(l));
    const jobIf = checkJobLines().filter((l) => indentOf(l) === 4 && l.trim().startsWith("if:"));
    expect(jobIf.map((l) => l.trim())).toEqual(["if: always()"]);
    const stepIfs = stepLines.filter((l) => indentOf(l) > 4 && /if:/.test(l));
    expect(stepIfs).toEqual([]);
  });

  it("結果は toJSON(needs) から読む", () => {
    expect(checkJobLines().join("\n")).toContain("NEEDS_JSON: ${{ toJSON(needs) }}");
  });

  it("needs は check 以外の全ジョブを含む", () => {
    const needsLine = checkJobLines().find((l) => /^\s+needs:/.test(l));
    expect(needsLine).toBeDefined();
    const needs = needsLine!
      .replace(/^\s+needs:\s*/, "")
      .replace(/[[\]]/g, "")
      .split(",")
      .map((j) => j.trim())
      .filter((j) => j !== "");
    expect([...needs].sort()).toEqual(otherJobs().sort());
  });

  it("Chromium を入れるのは heavy ジョブだけ", () => {
    for (const job of allJobs()) {
      const installs = jobLines(job).some((l) => l.includes("playwright install"));
      expect(installs, job).toBe(job === "heavy");
    }
  });
});

describe("check ジョブの判定", () => {
  it("全部 success なら通る", () => {
    const r = runStep(needsJson(allSuccess));
    expect(r.status).toBe(0);
  });

  it("docs だけの PR（テストのジョブが skipped）なら通る", () => {
    const r = runStep(
      needsJson({ changes: "success", ts: "skipped", heavy: "skipped", helper: "skipped" }),
    );
    expect(r.status).toBe(0);
  });

  it("failure が 1 つでもあれば落ち、ジョブ名と結果を出す", () => {
    const r = runStep(needsJson({ ...allSuccess, helper: "failure" }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/helper\W+failure/);
  });

  it("cancelled が 1 つでもあれば落ち、ジョブ名と結果を出す", () => {
    const r = runStep(needsJson({ ...allSuccess, helper: "cancelled" }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/helper\W+cancelled/);
  });

  it("結果が空文字なら落ち、ジョブ名を出す", () => {
    const r = runStep(needsJson({ ...allSuccess, heavy: "" }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("heavy");
  });

  it("success・skipped・failure・cancelled 以外の未知の値でも落ちる", () => {
    const r = runStep(needsJson({ ...allSuccess, helper: "timed_out" }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/helper\W+timed_out/);
  });

  it("result が無いジョブがあっても落ちる", () => {
    const r = runStep(JSON.stringify({ ...JSON.parse(needsJson(allSuccess)), helper: { outputs: {} } }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("helper");
  });

  it("JSON が読めないときも落ちる", () => {
    const r = runStep("not json");
    expect(r.status).not.toBe(0);
  });

  it("check 以外のどのジョブが failure でも落ち、そのジョブ名を出す", () => {
    expect(otherJobs().length).toBeGreaterThan(0);
    for (const job of otherJobs()) {
      const results = Object.fromEntries(otherJobs().map((j) => [j, j === job ? "failure" : "success"]));
      const r = runStep(needsJson(results));
      expect(r.status, job).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`, job).toMatch(new RegExp(`${job}\\W+failure`));
    }
  });
});

// Issue #599: server のテスト（helperScripts.it.test.ts）は helper/package.json を読む。
// helper/ の下だけの変更で ts のジョブを飛ばす振り分けでは、その変更でテストが落ちても CI が気付かない。
// changes ジョブの run を取り出し、`gh api` を変更ファイルの一覧を返す偽物に差し替えて、ts と swift の出力を確かめる
const filterOutputs = (files: string[], event = "pull_request"): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), "changes-filter-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_FILES"\n');
    chmodSync(gh, 0o755);
    const outputFile = join(dir, "output");
    writeFileSync(outputFile, "");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf("changes")], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_FILES: files.join("\n"),
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPOSITORY: "o/r",
        GH_TOKEN: "x",
        PR: "1",
      },
      encoding: "utf8",
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    return Object.fromEntries(
      readFileSync(outputFile, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("changes ジョブの振り分け", () => {
  it("helper/package.json だけの変更は ts のジョブを走らせる（swift も走る）", () => {
    expect(filterOutputs(["helper/package.json"])).toEqual({ ts: "true", swift: "true" });
  });

  it("helper/Sources の下だけの変更は ts を飛ばし、swift だけ走らせる", () => {
    expect(filterOutputs(["helper/Sources/Foo.swift"])).toEqual({ ts: "false", swift: "true" });
  });

  it("helper/ の package.json 以外のファイルだけの変更は ts を飛ばす", () => {
    expect(filterOutputs(["helper/scripts/checkTestLayers.ts", "helper/Package.swift"])).toEqual({ ts: "false", swift: "true" });
  });

  it("入れ子の package.json（helper/Sources/x/package.json）は例外にしない", () => {
    expect(filterOutputs(["helper/Sources/x/package.json"]).ts).toBe("false");
  });

  it("docs だけの変更は ts も swift も飛ばす", () => {
    expect(filterOutputs(["docs/a.md", "README.md", "LICENSE"])).toEqual({ ts: "false", swift: "false" });
  });

  it("docs と helper/package.json の変更なら ts が走る", () => {
    expect(filterOutputs(["docs/a.md", "helper/package.json"]).ts).toBe("true");
  });

  it("server の変更は ts を走らせる", () => {
    expect(filterOutputs(["server/src/a.ts"])).toEqual({ ts: "true", swift: "false" });
  });

  it("main への push は両方走らせる", () => {
    expect(filterOutputs([], "push")).toEqual({ ts: "true", swift: "true" });
  });
});

// Issue #562: 重い IT は `vitest list --project heavy --json` から file:line のまとまりごとに 4 つの runner へ割る。
// heavy ジョブの run を取り出し、`pnpm` を偽物に差し替えて、list の出力に見立てた JSON を渡して割り振りを確かめる
type Listed = { name: string; file: string; location?: { line: number; column: number } };

type RunnerResult = { status: number | null; output: string; listArgs: string[]; runArgs: string[] | undefined };

const runRunner = (shard: number, build: (cwd: string) => Listed[]): RunnerResult => {
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
        '  *"vitest list"*) printf \'%s\\n\' "$*" > "$LIST_LOG"; cat "$FAKE_LIST" ;;',
        '  *"vitest run"*) printf \'%s\\n\' "$*" > "$RUN_LOG" ;;',
        '  *) echo "unexpected pnpm call: $*" >&2; exit 99 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(pnpm, 0o755);
    const fakeList = join(dir, "list.json");
    writeFileSync(fakeList, JSON.stringify(build(work)));
    const listLog = join(dir, "list.log");
    const runLog = join(dir, "run.log");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScriptOf("heavy")], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SHARD: String(shard),
        FAKE_LIST: fakeList,
        LIST_LOG: listLog,
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
    return { status: r.status, output: `${r.stdout}${r.stderr}`, listArgs: read(listLog) ?? [], runArgs: read(runLog) };
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

const SHARDS = [0, 1, 2, 3];

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
  it("4 つの runner の file:line を合わせると入力のまとまりと一致し、重複も漏れも無い", () => {
    const results = SHARDS.map((s) => runRunner(s, mixed));
    for (const r of results) expect(r.status, r.output).toBe(0);
    const all = results.flatMap(targetsOf);
    expect([...all].sort()).toEqual(mixedGroups);
  });

  it("同じ行の複数テスト（each）は 1 つの runner にだけ入る", () => {
    const results = SHARDS.map((s) => runRunner(s, mixed));
    const holders = results.filter((r) => targetsOf(r).includes("test/a.heavy.test.ts:56"));
    expect(holders).toHaveLength(1);
  });

  it("各 runner が出す件数の合計が入力のテスト件数と一致する", () => {
    const results = SHARDS.map((s) => runRunner(s, mixed));
    const counts = results.map((r, s) => {
      const m = new RegExp(`runner ${s}: (\\d+) of (\\d+) tests`).exec(r.output);
      expect(m, r.output).not.toBeNull();
      expect(Number(m![2])).toBe(8);
      return Number(m![1]);
    });
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("check.yml に名前の無い新しい重い IT のファイルもどれかの runner に入る", () => {
    expect(workflow).not.toContain("brandNew");
    const results = SHARDS.map((s) => runRunner(s, mixed));
    expect(results.flatMap(targetsOf)).toContain("test/brandNew.heavy.test.ts:7");
  });

  it("list は --project heavy で取り、ファイルは指定しない。run も --project heavy に絞る", () => {
    const r = runRunner(0, mixed);
    const list = r.listArgs.join(" ");
    expect(list).toContain("--project heavy");
    expect(list).toContain("--json");
    expect(r.listArgs.some((a) => a.endsWith(".ts"))).toBe(false);
    expect(r.runArgs?.join(" ")).toContain("--project heavy");
  });

  it("まとまりが runner より少なくても、合計は一致する。空の runner は vitest run を呼ばずに 0 で終わる", () => {
    const two = (cwd: string): Listed[] => [entry(cwd, "test/a.heavy.test.ts", 1, "a"), entry(cwd, "test/b.heavy.test.ts", 2, "b")];
    const results = SHARDS.map((s) => runRunner(s, two));
    for (const r of results) expect(r.status, r.output).toBe(0);
    expect(results.flatMap(targetsOf).sort()).toEqual(["test/a.heavy.test.ts:1", "test/b.heavy.test.ts:2"]);
    const empty = results.filter((r) => r.runArgs === undefined);
    expect(empty).toHaveLength(2);
  });

  it("location が無いテストが 1 件でもあれば、どの runner も 0 以外で終わり、vitest run を呼ばない", () => {
    const broken = (cwd: string): Listed[] => [
      entry(cwd, "test/a.heavy.test.ts", 1, "a"),
      { name: "no location", file: `${cwd}/test/b.heavy.test.ts` },
    ];
    for (const s of SHARDS) {
      const r = runRunner(s, broken);
      expect(r.status, `shard ${s}`).not.toBe(0);
      expect(r.runArgs, `shard ${s}`).toBeUndefined();
    }
  });
});
