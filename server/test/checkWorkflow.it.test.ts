import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #589: ruleset の必須チェック `check` は、runner を取れずに終わったジョブ（result が failure・cancelled 以外の値で渡る）を見逃して通った。
// 「失敗を探す」から「全部が success か skipped であることを確かめる」に変える。
const root = join(import.meta.dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");

const indentOf = (line: string): number => line.length - line.trimStart().length;

const checkJobLines = (): string[] => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === "  check:");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() !== "" && indentOf(l) <= 2);
  return end === -1 ? rest : rest.slice(0, end);
};

const runScript = (): string => {
  const lines = checkJobLines();
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
