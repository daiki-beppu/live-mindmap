import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function readSessionStartHook() {
  const settings: unknown = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert(settings !== null && typeof settings === "object" && "hooks" in settings);
  const hooks = settings.hooks;
  assert(hooks !== null && typeof hooks === "object" && "SessionStart" in hooks);
  assert(Array.isArray(hooks.SessionStart));
  const groups: unknown[] = hooks.SessionStart;
  const group = groups[0];
  assert(group !== null && typeof group === "object" && "matcher" in group && "hooks" in group);
  assert(Array.isArray(group.hooks));
  const commands: unknown[] = group.hooks;
  const hook = commands[0];
  assert(hook !== null && typeof hook === "object" && "type" in hook && "command" in hook);
  assert(typeof hook.command === "string");
  return { group, hook, command: hook.command };
}

function runHook(remote: string | undefined) {
  const { command } = readSessionStartHook();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-start-")));
  try {
    const project = join(dir, "project with spaces");
    const home = join(dir, "home");
    const calls = join(dir, "calls");
    mkdirSync(join(project, "scripts"), { recursive: true });
    mkdirSync(home);
    writeFileSync(calls, "");
    // 実行権限に依存せず、指定プロジェクトのスクリプトを Bash で呼べることを観測する。
    writeFileSync(join(project, "scripts/setup-deps.sh"), 'printf "%s\\n" "$0" >> "$HOOK_TEST_CALLS"\n', { mode: 0o644 });
    const result = spawnSync("/bin/bash", ["-c", command], {
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: home,
        CLAUDE_PROJECT_DIR: project,
        ...(remote === undefined ? {} : { CLAUDE_CODE_REMOTE: remote }),
        HOOK_TEST_CALLS: calls,
      },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
      script: join(project, "scripts/setup-deps.sh"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Claude SessionStart hook", () => {
  it("startup と resume の command hook に既定の時間制限を使う", () => {
    const { group, hook } = readSessionStartHook();
    expect(group.matcher).toBe("startup|resume");
    expect(hook.type).toBe("command");
    expect(hook).not.toHaveProperty("timeout");
  });

  it("remote が true なら空白を含む指定プロジェクトの setup を一度呼ぶ", () => {
    const result = runHook("true");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([result.script]);
  });

  it.each([undefined, "", "false", "TRUE"])("remote が %s なら setup を呼ばず正常終了する", (remote) => {
    const result = runHook(remote);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
