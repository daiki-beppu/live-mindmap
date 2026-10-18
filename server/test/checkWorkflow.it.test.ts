import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indentOf, jobLines, root, runScriptOf, workflow } from "./fixtures/checkWorkflow.ts";
import { selectionOf, testIds } from "./swiftTestSelection.ts";

const runInlineSteps = (job: string): string[][] => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-managed-deps-"));
  try {
    const log = join(dir, "calls");
    const pnpm = join(dir, "pnpm");
    writeFileSync(pnpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n');
    chmodSync(pnpm, 0o755);
    const commands = jobLines(job).flatMap((line) => {
      const match = /^\s+(?:- )?run:\s*(pnpm .*)$/.exec(line);
      return match ? [match[1]!] : [];
    });
    const result = spawnSync("bash", ["-e", "-c", commands.join("\n")], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log },
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(/\s+/));
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const checkJobLines = (): string[] => jobLines("check");

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

});

describe("heavy の管理依存導入", () => {
  it("開発用の直接導入スクリプトを chromium と claude 指定で呼ぶ", () => {
    const scripts = (JSON.parse(readFileSync(join(root, "server/package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    const installer = Object.keys(scripts).find((name) => scripts[name]!.includes("scripts/install-managed-deps.ts"));
    expect(installer, "直接導入スクリプトの package script").toBeDefined();
    const calls = runInlineSteps("heavy");
    expect(calls).toContainEqual(["--filter", "@live-mindmap/server", installer, "chromium"]);
    expect(calls.some((args) => args[0] === "--filter" && args[1] === "@live-mindmap/server" && args[2] === installer && args.includes("claude"))).toBe(true);
    expect(calls.filter((args) => args.includes("playwright") && args.includes("install"))).toEqual([]);
  });
});

// Issue #568: ts の変更がある PR で test:e2e の全件を 1 ジョブで回す。replay cache は --strict-cache で再生だけ、リトライ 0、資格情報なし
describe("e2e ジョブ", () => {
  const e2eRunLines = (): string[] =>
    jobLines("e2e")
      .map((l) => l.trim())
      .filter((l) => /^(- )?run:/.test(l))
      .map((l) => l.replace(/^(- )?run:\s*/, ""))
      .filter((l) => l.includes("e2e"));

  it("check の needs に入っている", () => {
    const needsLine = checkJobLines().find((l) => /^\s+needs:/.test(l));
    const needs = needsLine!
      .replace(/^\s+needs:\s*/, "")
      .replace(/[[\]]/g, "")
      .split(",")
      .map((j) => j.trim());
    expect(needs).toContain("e2e");
  });

  it("changes の ts 出力で振り分けられる", () => {
    const lines = jobLines("e2e").filter((l) => indentOf(l) === 4);
    expect(lines.map((l) => l.trim())).toContain("needs: changes");
    expect(lines.map((l) => l.trim())).toContain("if: needs.changes.outputs.ts == 'true'");
  });

  it("swift の出力では振り分けない（helper だけの変更では回さない）", () => {
    expect(jobLines("e2e").join("\n")).not.toContain("outputs.swift");
  });

  it("ジョブに E2E_TELEMETRY_DISABLED=1 を設定する", () => {
    expect(jobLines("e2e").map((l) => l.trim())).toContain('E2E_TELEMETRY_DISABLED: "1"');
  });

  it("test:e2e を全件で回す（パス・target を絞らず、引数で上書きもしない）", () => {
    expect(e2eRunLines()).toContain("pnpm --filter @live-mindmap/e2e test:e2e");
    const script = (JSON.parse(readFileSync(join(root, "e2e/package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts["test:e2e"]!;
    expect(script).toMatch(/^e2e run( --[\w-]+( \d+)?)*$/);
    expect(script).not.toMatch(/--target/);
  });

  it("--strict-cache かつリトライ 0 で回る", () => {
    const script = (JSON.parse(readFileSync(join(root, "e2e/package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts["test:e2e"]!;
    expect(script).toContain("--strict-cache");
    expect(script).toMatch(/--retries 0(\s|$)/);
    const text = jobLines("e2e").join("\n");
    expect(text).not.toMatch(/--retries\s+[1-9]/);
    expect(text).not.toContain("--no-strict-cache");
  });

  it("server の Playwright 導入を呼ばず、E2E 自身の入口を実行する", () => {
    const calls = runInlineSteps("e2e");
    expect(calls).toContainEqual(["--filter", "@live-mindmap/e2e", "test:e2e"]);
    expect(calls.filter((args) => args.includes("@live-mindmap/server") && args.includes("playwright") && args.includes("install"))).toEqual([]);
  });

  it("資格情報（E2E_OAUTH_CREDENTIALS・*_API_KEY・secrets.）を渡さない", () => {
    const text = jobLines("e2e").join("\n");
    expect(text).not.toContain("E2E_OAUTH_CREDENTIALS");
    expect(text).not.toMatch(/_API_KEY/);
    expect(text).not.toContain("secrets.");
  });
});

// Issue #563: helper ジョブは 1 回の `swift build --build-tests` の後、`swift test --skip-build` を unit・軽い IT・重い IT の 3 ステップで回す。
// 層の選び方は helper/package.json の test・test:it・test:it:heavy と同じテストを選ぶこと（代表的なテスト ID で確かめる）
describe("helper ジョブ", () => {
  const helperRuns = (): string[] =>
    jobLines("helper")
      .map((l) => l.trim())
      .filter((l) => /^(- )?run:/.test(l))
      .map((l) => l.replace(/^(- )?run:\s*/, ""));

  const swiftTestRuns = (): string[] => helperRuns().filter((c) => c.startsWith("swift test"));

  const packageScripts = (JSON.parse(readFileSync(join(root, "helper/package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts;
  const packageSwiftTest = (name: string): string => {
    const command = (packageScripts[name] ?? "").split("&&").map((c) => c.trim()).find((c) => c.startsWith("swift test"));
    expect(command, name).toBeDefined();
    return command!;
  };

  const ciScripts = ["test", "test:it", "test:it:heavy"];
  const ciLayers = ["unit", "it", "heavy"] as const;

  it("swift build --build-tests は 1 回だけ", () => {
    const builds = helperRuns().filter((c) => c.startsWith("swift build"));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain("--build-tests");
  });

  it("swift test は 3 ステップで、どれも --skip-build 付き", () => {
    const tests = swiftTestRuns();
    expect(tests).toHaveLength(3);
    for (const command of tests) expect(command).toMatch(/^swift test\b.*--skip-build/);
  });

  it("3 つの swift test は、ビルドより後・キャッシュの保存より前に並ぶ", () => {
    const lines = jobLines("helper");
    const build = lines.findIndex((l) => /run:\s*swift build/.test(l));
    const tests = lines.flatMap((l, i) => (/run:\s*swift test/.test(l) ? [i] : []));
    const save = lines.findIndex((l) => l.includes("actions/cache/save"));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThanOrEqual(0);
    expect(tests).toHaveLength(3);
    for (const at of tests) {
      expect(at).toBeGreaterThan(build);
      expect(at).toBeLessThan(save);
    }
  });

  it("3 ステップは unit・軽い IT・重い IT の順に、定義どおりの層だけを選ぶ", () => {
    const tests = swiftTestRuns();
    expect(tests).toHaveLength(3);
    ciLayers.forEach((layer, i) => {
      const selects = selectionOf(tests[i]!);
      for (const [l, ids] of Object.entries(testIds)) {
        for (const id of ids) expect(selects(id), `${layer} ステップ: ${id} (${l})`).toBe(l === layer);
      }
    });
  });

  it("3 ステップの層の選び方は package.json の test・test:it・test:it:heavy と同じテストを選ぶ", () => {
    const tests = swiftTestRuns();
    expect(tests).toHaveLength(3);
    ciScripts.forEach((name, i) => {
      const ci = selectionOf(tests[i]!);
      const pkg = selectionOf(packageSwiftTest(name));
      for (const id of Object.values(testIds).flat()) expect(ci(id), `${name}: ${id}`).toBe(pkg(id));
    });
  });

  it("pnpm を呼ばず swift test を直接呼ぶ（ランナーには Xcode がある）", () => {
    expect(helperRuns().some((c) => c.includes("pnpm"))).toBe(false);
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
