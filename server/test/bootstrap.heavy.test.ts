import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const stages = ["install", "aec3", "resolve"] as const;
type Stage = (typeof stages)[number];

// 子プロセス境界で、開始の合流と失敗後の終了待ちを観測する。実際の依存取得は行わない。
const fakeCommand = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const [command, ...args] = process.argv.slice(2);
const stage = command === "pnpm" && args.join(" ") === "install" ? "install"
  : command === "swift" && args.join(" ") === "package resolve --package-path helper" ? "resolve"
  : command === "aec3" && args.length === 0 ? "aec3" : undefined;
if (!stage) {
  console.error("fixture:unexpected " + command + " " + args.join(" "));
  process.exit(99);
}
const dir = process.env.BOOTSTRAP_TEST_ROOT;
if (stage === "install" && existsSync(join(dir, "node_modules"))) {
  console.error("fixture:unexpected install before bootstrap");
  process.exit(98);
}
const failures = process.env.BOOTSTRAP_TEST_FAILURES.split(",").filter(Boolean);
const stages = ["install", "aec3", "resolve"];
const deadline = Date.now() + 8_000;
async function until(condition, description) {
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("fixture:timeout waiting for " + description);
    await setTimeout(10);
  }
}
console.log("fixture:" + stage + ":stdout-1");
console.log("fixture:" + stage + ":stdout-2");
console.error("fixture:" + stage + ":stderr-1");
console.error("fixture:" + stage + ":stderr-2");
writeFileSync(join(dir, stage + ".started"), String(process.pid));
await until(() => stages.every((name) => existsSync(join(dir, name + ".started"))), "all three stages to start");
if (failures.includes(stage)) {
  console.error("fixture:" + stage + ":failed");
  process.exit(37);
}
// 成功する段は、失敗する段のプロセスが実際に終わった後まで残す。
await until(() => failures.every((name) => {
  const pid = Number(readFileSync(join(dir, name + ".started"), "utf8"));
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}), "failing stages to exit");
console.log("fixture:" + stage + ":done");
`;

async function runBootstrap(failures: readonly Stage[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bootstrap-")));
  try {
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    for (const path of [bin, home, join(dir, "scripts"), join(dir, "helper/scripts")]) {
      mkdirSync(path, { recursive: true });
    }
    for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
      copyFileSync(join(root, file), join(dir, file));
    }
    // 未実装時も fixture の copy エラーにせず、公開コマンドの失敗を観測する。
    if (existsSync(join(root, "scripts/bootstrap.sh"))) {
      copyFileSync(join(root, "scripts/bootstrap.sh"), join(dir, "scripts/bootstrap.sh"));
    }
    writeFileSync(join(dir, "stage.mjs"), fakeCommand);
    for (const [path, command] of [
      [join(bin, "pnpm"), "pnpm"],
      [join(bin, "swift"), "swift"],
      [join(dir, "helper/scripts/build-webrtc-apm.sh"), "aec3"],
    ] satisfies [string, string][]) {
      writeFileSync(path, `#!/bin/bash\nexec "$BOOTSTRAP_TEST_NODE" "$BOOTSTRAP_TEST_ROOT/stage.mjs" ${command} "$@"\n`, { mode: 0o755 });
    }
    const config = join(home, "empty.npmrc");
    writeFileSync(config, "");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    const pnpm = process.env.npm_execpath;
    if (!pnpm) throw new Error("Run this test through the project's pnpm test script");
    const command = /\.[cm]?js$/.test(pnpm) ? [process.execPath, pnpm] : [pnpm];
    const child = spawn("bash", ["-c", 'exec "$@" 2>&1', "bootstrap-test", ...command, "bootstrap"], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        XDG_CONFIG_HOME: home,
        npm_config_userconfig: config,
        npm_config_globalconfig: config,
        PNPM_CONFIG_OFFLINE: "true",
        BOOTSTRAP_TEST_NODE: process.execPath,
        BOOTSTRAP_TEST_ROOT: dir,
        BOOTSTRAP_TEST_FAILURES: failures.join(","),
      },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { output += String(data); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for pnpm bootstrap to finish\n${output}`)), 12_000);
        }),
      ]);
      return { code, output, lines: output.split(/\r?\n/).filter(Boolean) };
    } finally {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
      await closed;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pnpm bootstrap", () => {
  it("node_modules がなくても3段を並行実行し、各出力を識別して dev を案内する", async () => {
    const result = await runBootstrap([]);
    expect(result.code, result.output).toBe(0);
    const stageOutput = result.lines.filter((line) => !line.startsWith("$ ") && !/\bpnpm dev\b/.test(line));
    expect(stageOutput.every((line) => /^\[(install|aec3|resolve)\] /.test(line)), result.output).toBe(true);
    for (const stage of stages) {
      for (const message of ["stdout-1", "stdout-2", "stderr-1", "stderr-2", "done"]) {
        const payload = `fixture:${stage}:${message}`;
        const lines = result.lines.filter((line) => line.includes(payload));
        expect(lines, result.output).toHaveLength(1);
        expect(lines[0], result.output).toMatch(new RegExp(`^\\[${stage}\\][ \\t]*${payload}$`));
      }
    }
    const nextStep = result.lines.findLastIndex((line) => /\bpnpm dev\b/.test(line));
    const lastCompletion = result.lines.findLastIndex((line) => line.includes(":done"));
    expect(nextStep, result.output).toBeGreaterThan(lastCompletion);
    expect(result.lines.filter((line) => line.includes("fixture:unexpected")), result.output).toEqual([]);
  });

  it.each<{ failures: Stage[] }>([
    { failures: ["install"] },
    { failures: ["aec3"] },
    { failures: ["resolve"] },
    { failures: ["install", "resolve"] },
  ])("$failures が失敗しても残りを待ち、失敗した全段を報告して非0で終える", async ({ failures }) => {
    const result = await runBootstrap(failures);
    expect(result.code, result.output).not.toBeNull();
    expect(result.code, result.output).not.toBe(0);
    for (const stage of stages) {
      const terminal = failures.includes(stage) ? "failed" : "done";
      expect(result.output).toContain(`fixture:${stage}:${terminal}`);
    }
    const lastCompletion = result.lines.findLastIndex((line) => line.includes(":done"));
    for (const stage of failures) {
      const summary = result.lines.findLastIndex((line) => !line.includes("fixture:") && new RegExp(`\\b${stage}\\b`).test(line));
      expect(summary, result.output).toBeGreaterThan(lastCompletion);
    }
  });
});
