import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const hook = "scripts/hooks/pre-push";

const fakePnpm = `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "$1" "$(pwd -P)" "$(env | cut -d= -f1 | grep '^GIT_' | tr '\\n' ' ')" >> "$PRE_PUSH_TEST_LOG"
case "$PRE_PUSH_TEST_FAIL" in
  all|"$1") exit 1 ;;
esac
`;

type Fixture = {
  work: string;
  git: (cwd: string, fail: string, ...args: string[]) => { status: number | null; output: string };
  calls: () => { script: string; cwd: string; gitEnv: string[] }[];
  remoteSha: (ref: string) => string | undefined;
  localSha: (ref: string) => string;
};

// 実物の mode を index から写す。作業ツリーの mode だと、644 で commit した hook が黙って無視される失敗を見逃す。
function placeHook(work: string) {
  const [mode] = execFileSync("git", ["ls-files", "-s", hook], { cwd: root, encoding: "utf8" }).split(" ");
  if (mode === undefined || mode === "") throw new Error(`${hook} is not tracked`);
  mkdirSync(dirname(join(work, hook)), { recursive: true });
  copyFileSync(join(root, hook), join(work, hook));
  chmodSync(join(work, hook), Number.parseInt(mode.slice(-3), 8));
}

function withFixture(verify: (fixture: Fixture) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pre-push-")));
  try {
    const bin = join(dir, "bin");
    const log = join(dir, "pnpm.log");
    const work = join(dir, "work");
    const remote = join(dir, "remote.git");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), fakePnpm, { mode: 0o755 });
    writeFileSync(log, "");

    const git: Fixture["git"] = (cwd, fail, ...args) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          PRE_PUSH_TEST_LOG: log,
          PRE_PUSH_TEST_FAIL: fail,
        },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    const setup = (cwd: string, ...args: string[]) => {
      const result = git(cwd, "", ...args);
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed\n${result.output}`);
      return result.output.trim();
    };

    setup(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    setup(dir, "clone", "--quiet", remote, work);
    setup(work, "config", "user.name", "Fixture");
    setup(work, "config", "user.email", "fixture@example.invalid");
    setup(work, "config", "core.hooksPath", "scripts/hooks");
    placeHook(work);
    mkdirSync(join(work, "node_modules"));
    setup(work, "add", "scripts");
    setup(work, "commit", "--quiet", "-m", "first");
    setup(work, "branch", "older");
    setup(work, "commit", "--quiet", "--allow-empty", "-m", "second");

    verify({
      work,
      git,
      calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => {
        const [script = "", cwd = "", names = ""] = line.split("\t");
        return { script, cwd, gitEnv: names.split(" ").filter(Boolean) };
      }),
      remoteSha: (ref) => {
        const result = git(remote, "", "rev-parse", "--verify", "--quiet", ref);
        return result.status === 0 ? result.output.trim() : undefined;
      },
      localSha: (ref) => setup(work, "rev-parse", ref),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pre-push hook", () => {
  it("HEAD を branch へ送ると型検査、unit の順に走り、git の環境変数を渡さず push が届く", () => {
    withFixture(({ work, git, calls, remoteSha, localSha }) => {
      const result = git(work, "", "push", "origin", "main");
      expect(result.status, result.output).toBe(0);
      expect(calls().map(({ script }) => script)).toEqual(["typecheck:linux", "test:linux"]);
      for (const { gitEnv } of calls()) {
        expect(gitEnv).not.toContain("GIT_DIR");
        expect(gitEnv).not.toContain("GIT_PREFIX");
      }
      expect(remoteSha("refs/heads/main")).toBe(localSha("HEAD"));
    });
  });

  it("型検査が落ちると push を止め、unit を走らせない", () => {
    withFixture(({ work, git, calls, remoteSha }) => {
      const result = git(work, "typecheck:linux", "push", "origin", "main");
      expect(result.status, result.output).not.toBe(0);
      expect(calls().map(({ script }) => script)).toEqual(["typecheck:linux"]);
      expect(remoteSha("refs/heads/main")).toBeUndefined();
    });
  });

  it.each([
    { name: "HEAD でない branch", before: undefined, push: ["older"], ref: "refs/heads/older", arrives: true },
    { name: "branch の削除", before: ["older"], push: ["--delete", "older"], ref: "refs/heads/older", arrives: false },
    { name: "HEAD の tag", before: undefined, push: ["v1"], ref: "refs/tags/v1", arrives: true },
  ])("$name の push は検査せずに通す", ({ before, push, ref, arrives }) => {
    withFixture(({ work, git, calls, remoteSha }) => {
      expect(git(work, "", "tag", "v1").status).toBe(0);
      if (before) expect(git(work, "", "push", "--no-verify", "origin", ...before).status).toBe(0);
      const result = git(work, "all", "push", "origin", ...push);
      expect(result.status, result.output).toBe(0);
      expect(calls()).toEqual([]);
      expect(remoteSha(ref) !== undefined).toBe(arrives);
    });
  });

  it("node_modules が無い作業ツリーでは検査せずに通し、そのことを知らせる", () => {
    withFixture(({ work, git, calls, remoteSha, localSha }) => {
      rmSync(join(work, "node_modules"), { recursive: true });
      const result = git(work, "all", "push", "origin", "main");
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("pre-push: node_modules か pnpm が無いので検査しない（CI に任せる）");
      expect(calls()).toEqual([]);
      expect(remoteSha("refs/heads/main")).toBe(localSha("HEAD"));
    });
  });

  it("HEAD と別の branch を 1 回で送っても検査は 1 回だけ", () => {
    withFixture(({ work, git, calls }) => {
      const result = git(work, "", "push", "origin", "main", "older");
      expect(result.status, result.output).toBe(0);
      expect(calls().map(({ script }) => script)).toEqual(["typecheck:linux", "test:linux"]);
    });
  });

  it("linked worktree でも相対の core.hooksPath で hook が動き、その作業ツリーで検査して止める", () => {
    withFixture(({ work, git, calls, remoteSha }) => {
      const linked = join(dirname(work), "linked");
      expect(git(work, "", "worktree", "add", "--quiet", "-b", "linked", linked).status).toBe(0);
      expect(existsSync(join(linked, hook))).toBe(true);
      mkdirSync(join(linked, "node_modules"));
      expect(git(linked, "", "commit", "--quiet", "--allow-empty", "-m", "linked").status).toBe(0);
      const result = git(linked, "typecheck:linux", "push", "origin", "linked");
      expect(result.status, result.output).not.toBe(0);
      expect(calls().map(({ script, cwd }) => ({ script, cwd }))).toEqual([{ script: "typecheck:linux", cwd: linked }]);
      expect(remoteSha("refs/heads/linked")).toBeUndefined();
    });
  });
});
