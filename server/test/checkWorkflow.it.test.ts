import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobLines, root, runScriptOf } from "./fixtures/checkWorkflow.ts";
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
  it("server の Playwright 導入を呼ばず、E2E 自身の入口を実行する", () => {
    const calls = runInlineSteps("e2e");
    expect(calls).toContainEqual(["--filter", "@live-mindmap/e2e", "test:e2e"]);
    expect(calls.filter((args) => args.includes("@live-mindmap/server") && args.includes("playwright") && args.includes("install"))).toEqual([]);
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
    expect(filterOutputs(["helper/package.json"])).toEqual({ ts: "true", swift: "true", external: "false" });
  });

  it("helper/Sources の下だけの変更は ts を飛ばし、swift だけ走らせる", () => {
    expect(filterOutputs(["helper/Sources/Foo.swift"])).toEqual({ ts: "false", swift: "true", external: "false" });
  });

  it("helper/ の package.json 以外のファイルだけの変更は ts を飛ばす", () => {
    expect(filterOutputs(["helper/scripts/checkTestLayers.ts", "helper/Package.swift"])).toEqual({ ts: "false", swift: "true", external: "false" });
  });

  it("入れ子の package.json（helper/Sources/x/package.json）は例外にしない", () => {
    expect(filterOutputs(["helper/Sources/x/package.json"]).ts).toBe("false");
  });

  it("docs だけの変更は ts も swift も飛ばす", () => {
    expect(filterOutputs(["docs/a.md", "README.md", "LICENSE"])).toEqual({ ts: "false", swift: "false", external: "false" });
  });

  it("docs と helper/package.json の変更なら ts が走る", () => {
    expect(filterOutputs(["docs/a.md", "helper/package.json"]).ts).toBe("true");
  });

  it("server の変更は ts を走らせる", () => {
    expect(filterOutputs(["server/src/a.ts"])).toEqual({ ts: "true", swift: "false", external: "false" });
  });

  it("main への push は両方走らせる", () => {
    expect(filterOutputs([], "push")).toEqual({ ts: "true", swift: "true", external: "false" });
  });
});


describe("external の CI 実行", () => {
  it.each([
    "server/managed-deps/claude/README.md",
    "server/managed-deps/chromium/package-lock.json",
    "server/scripts/install-managed-deps.ts",
    "server/src/managedDeps.ts",
  ])("PR で %s を変えたら external を有効にする", (path) => {
    expect(filterOutputs([path]).external).toBe("true");
  });

  it.each([
    "docs/server/managed-deps/claude/README.md",
    "server/managed-deps-other/package.json",
    "server/src/managedDeps.ts.bak",
    "server/scripts/install-managed-deps.ts.bak",
    "server/test/managedDeps.external.test.ts",
  ])("PR で対象外の %s を変えても external を有効にしない", (path) => {
    expect(filterOutputs([path]).external).toBe("false");
  });

  it("他の変更と混在していても対象パスを含む PR は external を有効にする", () => {
    expect(filterOutputs(["docs/a.md", "server/src/managedDeps.ts", "helper/Package.swift"]).external).toBe("true");
  });

  it("対象パスを含む main push でも external を有効にしない", () => {
    expect(filterOutputs(["server/src/managedDeps.ts"], "push")).toEqual({ ts: "true", swift: "true", external: "false" });
  });

  it("管理依存を導入してから専用のテストコマンドを実行する", () => {
    const calls = runInlineSteps("external");
    const chromium = calls.findIndex((args) => args.join(" ") === "--filter @live-mindmap/server deps:install chromium");
    const claude = calls.findIndex((args) => args.join(" ") === "--filter @live-mindmap/server deps:install claude");
    const tests = calls.findIndex((args) => args.includes("test:external"));
    expect(chromium).toBeGreaterThanOrEqual(0);
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(tests).toBeGreaterThan(chromium);
    expect(tests).toBeGreaterThan(claude);
  });

});
