import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const allSuccess = { changes: "success", typecheck: "success", "server-split": "success", server: "success", helper: "success" };

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
});

describe("check ジョブの判定", () => {
  it("全部 success なら通る", () => {
    const r = runStep(needsJson(allSuccess));
    expect(r.status).toBe(0);
  });

  it("docs だけの PR（テストのジョブが skipped）なら通る", () => {
    const r = runStep(
      needsJson({ changes: "success", typecheck: "skipped", "server-split": "skipped", server: "skipped", helper: "skipped" }),
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
    const r = runStep(needsJson({ ...allSuccess, server: "" }));
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("server");
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
