import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const script = join(root, "scripts/report-scheduled-failure.sh");
const repo = "example/scheduled-ci-test";
const nightly = "Nightly の CI が落ちている";
const weekly = "Weekly の CI が落ちている";
const runUrl = `https://github.com/${repo}/actions/runs/123`;
const sha = "1234567890abcdef1234567890abcdef12345678";

type Issue = { number: number; title: string; state: string; labels: { name: string }[]; body: string; comments: string[] };
const issue = (number: number, title: string, state: string, labels: string[]): Issue => ({
  number, title, state, labels: labels.map((name) => ({ name })), body: "previous run", comments: [],
});

// Only GitHub is replaced: Bash, jq, the notification script and workflow run steps execute for real.
const fakeGh = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR;
const stateFile = dir + "/issues.json";
const issues = JSON.parse(readFileSync(stateFile, "utf8"));
appendFileSync(dir + "/calls", JSON.stringify(args) + "\n");
const flag = (...names) => {
  const at = args.findIndex((arg) => names.includes(arg));
  return at < 0 ? undefined : args[at + 1];
};
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1); };
const operation = args[0] === "api" ? "list" : args[1];
if (process.env.FAKE_GH_FAIL === operation) fail("GitHub unavailable: " + operation);
const emit = (value) => {
  const json = JSON.stringify(value);
  const query = flag("--jq", "-q");
  if (!query) { process.stdout.write(json + "\n"); return; }
  const result = spawnSync("jq", ["-r", query], { input: json, encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr);
  process.stdout.write(result.stdout);
};
const body = () => {
  const file = flag("--body-file", "-F");
  if (file) return readFileSync(file === "-" ? 0 : file, "utf8");
  const value = flag("--body", "-b");
  if (value === undefined) fail("missing body");
  return value;
};
const save = () => writeFileSync(stateFile, JSON.stringify(issues));
if (args[0] === "run" && args[1] === "view") {
  if (!args.includes("123") || flag("--attempt") !== "2") fail("wrong run or attempt");
  emit({ jobs: JSON.parse(readFileSync(dir + "/jobs.json", "utf8")) });
} else if (args[0] === "api") {
  const [owner, name] = process.env.GITHUB_REPOSITORY.split("/");
  if (!args.includes("graphql") || !args.includes("owner=" + owner) || !args.includes("name=" + name)) fail("unexpected repository");
  const query = args.find((arg) => arg.startsWith("query="));
  if (!query) fail("missing GraphQL query");
  const openOnly = /states:\s*\[OPEN\]/.test(query);
  const bugOnly = /labels:\s*\["bug"\]/.test(query);
  const selected = issues.filter((i) => (!openOnly || i.state === "open") && (!bugOnly || i.labels.some((l) => l.name === "bug")));
  const size = 100;
  const pages = [];
  do { pages.push(selected.slice(pages.length * size, (pages.length + 1) * size)); }
  while (args.includes("--paginate") && pages.length * size < selected.length);
  for (const [index, nodes] of pages.entries()) emit({ data: { repository: { issues: {
    nodes, pageInfo: { hasNextPage: (index + 1) * size < selected.length, endCursor: nodes.length ? String(index + 1) : null },
  } } } });
} else if (args[0] === "issue" && args[1] === "create") {
  const labels = args.flatMap((arg, index) => ["--label", "-l"].includes(arg) ? args[index + 1].split(",") : []).sort();
  const created = { number: 1000, title: flag("--title", "-t"), state: "open", labels: labels.map((name) => ({ name })), body: body(), comments: [] };
  issues.push(created); save();
  writeFileSync(dir + "/created-body", created.body);
  process.stdout.write("https://github.com/" + process.env.GITHUB_REPOSITORY + "/issues/1000\n");
} else if (args[0] === "issue" && args[1] === "comment") {
  const number = Number(args[2].split("/").pop());
  const target = issues.find((i) => i.number === number);
  if (!target) fail("unknown issue");
  target.comments.push(body()); save();
  writeFileSync(dir + "/comment-body", target.comments.at(-1));
  process.stdout.write("https://github.com/" + process.env.GITHUB_REPOSITORY + "/issues/" + number + "#issuecomment-1\n");
} else fail("unexpected gh call: " + JSON.stringify(args));
`;

const withGitHub = <T>(issues: Issue[], test: (fixture: ReturnType<typeof githubFixture>) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "scheduled-failure-"));
  try { return test(githubFixture(dir, issues)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

const githubFixture = (dir: string, issues: Issue[]) => {
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!${process.execPath}\n${fakeGh}`);
  chmodSync(gh, 0o755);
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
  writeFileSync(join(dir, "calls"), "");
  const env = {
    PATH: `${dir}:${process.env.PATH}`, HOME: dir, GH_CONFIG_DIR: dir, GH_TOKEN: "fake-token",
    FAKE_GH_DIR: dir, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: sha, GITHUB_SERVER_URL: "https://github.com", GITHUB_EVENT_NAME: "schedule",
  };
  const run = (command: string[], extra: Record<string, string>) => spawnSync("/bin/bash", command, {
    cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
  });
  return {
    dir, run,
    report: (title: string, url: string, commit: string, jobs: string, extra: Record<string, string>) =>
      run([script, repo, title, url, commit, jobs], extra),
    read: (name: string): string => readFileSync(join(dir, name), "utf8"),
    state: (): unknown => JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")),
  };
};

const expectSuccess = (result: ReturnType<typeof spawnSync>) => {
  expect(result.error, "子プロセスが起動・終了できる").toBeUndefined();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
};

describe("定期段の失敗通知スクリプト", () => {
  it("初回の通知を作り、次の異なる失敗は本文を残して同じ open issue にコメントする", () => {
    withGitHub([], (f) => {
      expectSuccess(f.report(nightly, runUrl, sha, "tests / ts", {}));
      const originalBody = f.read("created-body");
      for (const value of [runUrl, sha, "tests / ts"]) expect(originalBody).toContain(value);
      expectSuccess(f.report(nightly, `${runUrl}4`, "next-sha", "tests / helper", {}));
      const comment = f.read("comment-body");
      for (const value of [`${runUrl}4`, "next-sha", "tests / helper"]) expect(comment).toContain(value);
      expect(f.state()).toEqual([{
        number: 1000, title: nightly, state: "open", labels: [{ name: "bug" }, { name: "needs-triage" }],
        body: originalBody, comments: [comment],
      }]);
    });
  });

  it("部分一致・他段・closed・bug なしの issue を流用しない", () => {
    const existing = [
      issue(1, `${nightly}・調査用`, "open", ["bug"]), issue(2, weekly, "open", ["bug"]),
      issue(3, nightly, "closed", ["bug"]), issue(4, nightly, "open", ["needs-triage"]),
    ];
    withGitHub(existing, (f) => {
      expectSuccess(f.report(nightly, runUrl, sha, "tests / ts", {}));
      expect(f.state()).toEqual([...existing, {
        number: 1000, title: nightly, state: "open", labels: [{ name: "bug" }, { name: "needs-triage" }],
        body: f.read("created-body"), comments: [],
      }]);
    });
  });

  it("最初のページより後にある完全一致の open bug issue にコメントする", () => {
    const existing = [
      ...Array.from({ length: 100 }, (_, i) => issue(i + 1, `別の障害 ${i}`, "open", ["bug"])),
      issue(101, weekly, "open", ["bug"]),
    ];
    withGitHub(existing, (f) => {
      expectSuccess(f.report(weekly, runUrl, sha, "tests / external", {}));
      expect(f.state()).toEqual(existing.map((value) => value.number === 101 ? { ...value, comments: [f.read("comment-body")] } : value));
    });
  });

  it.each(["list", "create", "comment"])("GitHub の %s が失敗したら非ゼロで終わり、issue を増やさず再実行できる", (operation) => {
    withGitHub(operation === "comment" ? [issue(100, nightly, "open", ["bug"])] : [], (f) => {
      const before = f.state();
      const result = f.report(nightly, runUrl, sha, "tests / ts", { FAKE_GH_FAIL: operation });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(f.read("calls").trim(), "失敗は GitHub 操作の境界で発生する").not.toBe("");
      expect(f.state()).toEqual(before);
      expectSuccess(f.report(nightly, runUrl, sha, "tests / ts", {}));
      expect(existsSync(join(f.dir, operation === "comment" ? "comment-body" : "created-body"))).toBe(true);
      expect(f.state()).toEqual([{
        number: operation === "comment" ? 100 : 1000, title: nightly, state: "open",
        labels: operation === "comment" ? [{ name: "bug" }] : [{ name: "bug" }, { name: "needs-triage" }],
        body: operation === "comment" ? "previous run" : f.read("created-body"),
        comments: operation === "comment" ? [f.read("comment-body")] : [],
      }]);
    });
  });
});

const notificationStep = (workflow: string) => {
  const text = readFileSync(join(root, `.github/workflows/${workflow}.yml`), "utf8");
  const lines = text.split("\n");
  const runs = lines.flatMap((line, index) => {
    const match = /^\s+(?:- )?run: (.+)$/.exec(line);
    if (!match) return [];
    if (match[1]!.trim() !== "|") return [match[1]!.replace(/^(['"])(.*)\1$/, "$2")];
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((next) => next.trim() !== "" && next.length - next.trimStart().length <= line.indexOf("run:"));
    const block = end < 0 ? rest : rest.slice(0, end);
    const indent = Math.min(...block.filter((next) => next.trim() !== "").map((next) => next.length - next.trimStart().length));
    return [block.map((next) => next.slice(indent)).join("\n")];
  });
  const run = runs.find((command) => command.includes("report-scheduled-failure.sh"));
  expect(run, `${workflow} の実行ステップから共通通知スクリプトを呼ぶ`).toBeDefined();
  const context: Record<string, string> = {
    repository: repo, run_id: "123", run_attempt: "2", sha, server_url: "https://github.com", token: "fake-token",
  };
  const env = Object.fromEntries([...text.matchAll(/^\s+([A-Z_][A-Z_0-9]*):\s*(.+)$/gm)].map((match) => {
    const value = match[2]!.replace(/\$\{\{\s*github\.(\w+)\s*\}\}/g, (_, key: string) => {
      if (!(key in context)) throw new Error(`未対応の Actions context: ${key}`);
      return context[key]!;
    }).replace(/^(['"])(.*)\1$/, "$2");
    return [match[1]!, value];
  }));
  return { command: run!, env };
};

describe.each([{ workflow: "nightly", title: nightly }, { workflow: "weekly", title: weekly }])("$workflow の失敗ジョブ通知", ({ workflow, title }) => {
  it.each(["success", "timed_out"])("通常失敗とタイムアウトを作成本文・追加コメントへ通知し、成功を除外する（helper: %s）", (helperConclusion) => {
    withGitHub([], (f) => {
      writeFileSync(join(f.dir, "jobs.json"), JSON.stringify([
        { name: "tests / ts", conclusion: "failure" },
        { name: "tests / helper", conclusion: helperConclusion },
        { name: "tests / external", conclusion: "success" },
      ]));
      const step = notificationStep(workflow);
      expectSuccess(f.run(["-e", "-o", "pipefail", "-c", step.command], step.env));
      const originalBody = f.read("created-body");
      expectSuccess(f.run(["-e", "-o", "pipefail", "-c", step.command], step.env));
      const comment = f.read("comment-body");
      const expectedJobs = helperConclusion === "timed_out" ? ["- tests / ts", "- tests / helper"] : ["- tests / ts"];
      for (const [output, body] of [["作成本文", originalBody], ["追加コメント", comment]] as const) {
        for (const value of [runUrl, sha]) expect(body).toContain(value);
        expect.soft(body.split("\n").filter((line) => line.startsWith("- ")), output).toEqual(expectedJobs);
      }
      expect(f.state()).toEqual([{
        number: 1000, title, state: "open", labels: [{ name: "bug" }, { name: "needs-triage" }],
        body: originalBody, comments: [comment],
      }]);
    });
  });

  it.each([
    { failed: "tests / heavy IT (web 1/2)", passed: "tests / helper", additionalFailures: ["tests / external"] },
    { failed: "tests / ts", passed: "failure", additionalFailures: [] },
  ])("conclusion が failure のジョブだけを当該 run の URL・SHA と通知する（$failed）", ({ failed, passed, additionalFailures }) => {
    const notify = (successfulJob: string): string => withGitHub([], (f) => {
      writeFileSync(join(f.dir, "jobs.json"), JSON.stringify([
        { name: failed, conclusion: "failure" },
        ...additionalFailures.map((name) => ({ name, conclusion: "failure" })),
        { name: successfulJob, conclusion: "success" },
      ]));
      const step = notificationStep(workflow);
      expectSuccess(f.run(["-e", "-o", "pipefail", "-c", step.command], step.env));
      const body = f.read("created-body");
      for (const value of [runUrl, sha, failed, ...additionalFailures]) expect(body).toContain(value);
      expect(f.state()).toMatchObject([{ title }]);
      return body;
    });
    const body = notify(passed);
    if (passed === "failure") {
      // A prose heading may legitimately say "failure"; changing only a successful job name must not change the notification.
      expect(body).toBe(notify("successful helper"));
    } else {
      expect(body.split("\n").filter((line) => line.includes(passed))).toEqual([]);
    }
  });
});
