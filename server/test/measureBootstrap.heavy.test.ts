import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const entry = "scripts/measure-bootstrap.sh";

// 実際の clone・checkout と bootstrap を通し、準備コマンドの副作用を fixture で観測する。
const commands = String.raw`
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const [command, ...args] = process.argv.slice(2);
const dir = process.env.MEASURE_TEST_ROOT;
const log = (...fields) => appendFileSync(join(dir, "events"), fields.join("\t") + "\n");
log("pid", process.pid);
if (command !== "git" && args.includes("--version")) { console.log(command + " fixture version"); process.exit(0); }
const unexpected = () => { throw new Error("Unexpected fixture command: " + command + " " + args.join(" ")); };
function run(cmd, argv) {
  const result = spawnSync(cmd, argv, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status === null ? 98 : result.status);
}
function destination(path) {
  if (!path) throw new Error("Missing isolated destination for " + command);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "fixture-write"), command);
  log("destination", command, resolve(path));
}
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
};
async function stage(name, body) {
  log("start", name, Date.now());
  if (process.env.MEASURE_TEST_HOLD === name) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (process.env.MEASURE_TEST_FAILURE === name) {
    console.error("fixture failed: " + name);
    process.exit(37);
  }
  if (process.env.MEASURE_TEST_FAILURE === name + "-signal") {
    console.error("fixture failed: " + name + "-signal");
    process.kill(process.pid, "SIGKILL");
  }
  await body();
  log("end", name, Date.now());
}
if (command === "corepack") {
  if (args.join(" ") !== "enable") unexpected();
} else if (command === "vp") {
  if (args.join(" ") !== "env which pnpm") unexpected();
  console.log(process.env.MEASURE_TEST_NATIVE_PNPM + "\n  Package: pnpm fixture");
} else if (command === "git") {
  // 下位 AEC3 のネットワーク取得は fixture スクリプトに置き換える。
  if (args.includes("clone")) log("clone-start", Date.now());
  run(process.env.MEASURE_TEST_GIT, args);
  if (args.includes("clone")) log("clone", resolve(args.at(-1)));
} else if (command === "pnpm") {
  const scriptShell = args.find((a) => a.startsWith("--config.scriptShell="))?.slice("--config.scriptShell=".length);
  const forwarded = args.filter((a, i) => !["--store-dir", "--state-dir"].includes(a) && !["--store-dir", "--state-dir"].includes(args[i - 1]) && !a.startsWith("--store-dir=") && !a.startsWith("--config.scriptShell="));
  process.env.PATH = process.env.MEASURE_TEST_BIN + ":" + process.env.PATH;
  if (forwarded.join(" ") === "bootstrap") {
    const sha = execFileSync(process.env.MEASURE_TEST_GIT, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    log("checkout", process.cwd(), sha);
    for (const path of ["node_modules", "helper/.build", "helper/.deps"]) {
      if (existsSync(path)) throw new Error("Not a fresh clone: " + path);
    }
    copyFileSync(join(dir, "aec3.sh"), "helper/scripts/build-webrtc-apm.sh");
    run(scriptShell ? scriptShell : "bash", scriptShell ? ["-c", "bash scripts/bootstrap.sh"] : ["scripts/bootstrap.sh"]);
  } else if (forwarded.join(" ") === "install --frozen-lockfile") {
    await stage("install", async () => { destination(option("--store-dir")); await delay(800); });
  } else if (forwarded.join(" ") === "dev") {
    const child = spawn(scriptShell ? scriptShell : "swift", scriptShell ? ["-c", "swift build -c release --package-path helper"] : ["build", "-c", "release", "--package-path", "helper"], { stdio: "inherit" });
    const code = await new Promise((done) => child.once("exit", done));
    if (code !== 0) process.exit(code === null ? 143 : code);
    if (process.env.MEASURE_TEST_FAILURE === "server") { console.error("fixture failed: server"); process.exit(39); }
    // pnpm の workspace script は別の process group を作る。親子関係だけを保持する。
    const server = spawn(process.execPath, [join(dir, "commands.mjs"), "server"], { detached: true, stdio: "inherit" });
    const serverCode = await new Promise((done) => server.once("exit", done));
    process.exitCode = serverCode === null ? 143 : serverCode;
  } else if (forwarded[0] === "cli") {
    const port = Number(process.env.LIVE_MINDMAP_PORT);
    const identity = await (await fetch("http://127.0.0.1:" + port + "/server")).json();
    if (identity.pid !== Number(readFileSync(join(dir, "server-pid"), "utf8"))) throw new Error("Wrong server");
    if (forwarded.slice(1).join(" ") === "server stop") {
      log("stop", port);
      process.kill(identity.pid, "SIGTERM");
    } else if (forwarded[1] === "install" && ["chromium", "claude"].includes(forwarded[2])) {
      await stage(forwarded[2], async () => { destination(process.env.LIVE_MINDMAP_DEPS); });
    } else unexpected();
  } else unexpected();
} else if (command === "server") {
    destination(process.env.LIVE_MINDMAP_SESSIONS);
    destination(process.env.LIVE_MINDMAP_DEPS);
    destination(process.env.npm_config_cache);
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/server" ? { pid: process.pid } : { status: "none" }));
    });
    server.listen(Number(process.env.LIVE_MINDMAP_PORT), "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server port");
      log("server", process.pid, address.port);
      writeFileSync(join(dir, "server-pid"), String(process.pid));
      console.error("live-mindmap サーバーを起動しました: http://127.0.0.1:" + address.port);
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (command === "swift") {
  for (const name of ["--cache-path", "--config-path", "--security-path"]) destination(option(name));
  if (args.includes("resolve")) {
    await stage("resolve", () => delay(800));
  } else if (args.includes("build") && args.includes("release")) {
    await stage("release", async () => {
      await delay(300);
      const output = join(resolve(option("--package-path")), ".build/release");
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "live-mindmap-helper"), '#!/bin/bash\nexec "$MEASURE_TEST_NODE" "$MEASURE_TEST_ROOT/commands.mjs" models "$@"\n', { mode: 0o755 });
    });
  } else unexpected();
} else if (command === "uvx") {
  destination(process.env.UV_CACHE_DIR);
  const name = args.includes("compile") ? "compile" : "setup";
  await stage(name, () => delay(name === "setup" ? 900 : 150));
} else if (command === "models") {
  if (args.join(" ") !== "install-speaker-models") unexpected();
  await stage("models", async () => { destination(process.env.LIVE_MINDMAP_HELPER_SPEAKER_MODEL_DIR); });
} else if (command === "ps") {
  if (args.includes("comm=")) {
    if (process.env.MEASURE_TEST_CONDITION === "swift") console.log("swift-build");
  } else run("/bin/ps", args);
} else if (command === "uv") console.log("uv 0.9.0");
else unexpected();
`;

// 負荷と空き容量は Node API の置換で固定する。
const host = String.raw`
const os = require("node:os");
const fs = require("node:fs");
os.loadavg = () => [process.env.MEASURE_TEST_CONDITION === "load" ? 4 : 0.1, 0.1, 0.1];
const statfs = (path, options) => {
  const n = options?.bigint ? BigInt : Number;
  const blocks = process.env.MEASURE_TEST_CONDITION === "disk" ? 9 * 1024 * 1024 : 20 * 1024 * 1024;
  return { bsize: n(1024), bavail: n(blocks), bfree: n(blocks), blocks: n(40 * 1024 * 1024) };
};
fs.statfsSync = statfs;
fs.promises.statfs = async (...args) => statfs(...args);
require("node:module").syncBuiltinESMExports();
if (process.env.MEASURE_TEST_CLOCK_SCALE) {
  const clock = process.hrtime.bigint.bind(process.hrtime);
  process.hrtime.bigint = () => clock() * BigInt(process.env.MEASURE_TEST_CLOCK_SCALE);
}
`;

type RunOptions = { commit?: string; failure?: string; hold?: string; signal?: NodeJS.Signals; clockScale?: string; condition?: "disk" | "load" | "swift" };

function createSourceRepository(repo: string) {
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  const files = [entry, "scripts/bootstrap.sh", "scripts/setup-deps.sh", ".nvmrc", "package.json", "pnpm-lock.yaml", "helper/scripts/fetch-speaker-models.sh"];
  let history = "commit refs/heads/main\nmark :1\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 5\nfirst\n";
  for (const file of files) {
    const content = readFileSync(join(root, file));
    history += `M 100755 inline ${file}\ndata ${content.byteLength}\n${content.toString()}\n`;
  }
  history += "\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000001 +0000\ndata 6\nsecond\nfrom :1\n\ndone\n";
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: history });
  execFileSync("git", ["reset", "--hard", "--quiet", "HEAD"], { cwd: repo });
}

async function interruptMeasurement({ child, stage, signal, events, output }: {
  child: ReturnType<typeof spawn>; stage: string; signal: NodeJS.Signals; events: () => string[][]; output: () => string;
}) {
  const deadline = Date.now() + 10_000;
  while (!events().some(([event, name]) => event === "start" && name === stage)) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Measurement exited before ${stage}\n${output()}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${stage}\n${output()}`);
    await delay(20);
  }
  child.kill(signal);
}

async function withMeasurement(options: RunOptions, verify: (result: {
  code: number | null; output: string; events: string[][]; temp: string; home: string; elapsedSeconds: number; expectedCommit: string;
}) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "measure-bootstrap-test-")));
  const temp = join(dir, "tmp");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  try {
    const native = join(dir, "native");
    for (const path of [temp, home, bin, native]) mkdirSync(path);
    writeFileSync(join(dir, "events"), "");
    writeFileSync(join(dir, "commands.mjs"), commands);
    writeFileSync(join(dir, "host.cjs"), host);
    writeFileSync(join(dir, "aec3.sh"), "#!/bin/bash\nset -euo pipefail\nuvx --from meson --with ninja meson setup build src\nuvx --from meson --with ninja meson compile -C build\n");
    for (const command of ["git", "vp", "corepack", "swift", "uvx", "uv", "ps"]) {
      writeFileSync(join(bin, command), `#!/bin/bash\nexec "$MEASURE_TEST_NODE" "$MEASURE_TEST_ROOT/commands.mjs" ${command} "$@"\n`, { mode: 0o755 });
    }
    writeFileSync(join(native, "pnpm"), '#!/bin/bash\nexec "$MEASURE_TEST_NODE" "$MEASURE_TEST_ROOT/commands.mjs" pnpm "$@"\n', { mode: 0o755 });
    symlinkSync(join(bin, "vp"), join(bin, "pnpm"));
    const git = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const repo = join(dir, "source");
    createSourceRepository(repo);
    const expectedCommit = execFileSync(git, ["rev-parse", options.commit ?? "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const startedAt = performance.now();
    const child = spawn("bash", [entry, ...(options.commit === undefined ? [] : [options.commit])], {
      cwd: repo, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: temp,
        XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        NODE_OPTIONS: `--require=${join(dir, "host.cjs")}`,
        MEASURE_TEST_ROOT: dir, MEASURE_TEST_NODE: process.execPath, MEASURE_TEST_GIT: git,
        MEASURE_TEST_BIN: bin,
        MEASURE_TEST_NATIVE_PNPM: join(native, "pnpm"),
        MEASURE_TEST_FAILURE: options.failure, MEASURE_TEST_HOLD: options.hold,
        MEASURE_TEST_CONDITION: options.condition,
        MEASURE_TEST_CLOCK_SCALE: options.clockScale,
        LIVE_MINDMAP_PORT: "0",
      },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { output += String(data); });
    const closed = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    const events = () => readFileSync(join(dir, "events"), "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.hold) {
        await interruptMeasurement({ child, stage: options.hold, signal: options.signal ?? "SIGTERM", events, output: () => output });
      }
      const code = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for measurement\n${output}`)), 15_000);
        }),
      ]);
      verify({ code, output, events: events(), temp, home, elapsedSeconds: (performance.now() - startedAt) / 1000, expectedCommit });
    } finally {
      clearTimeout(timer);
      // production cleanup を観測した後でだけ、失敗したテストが残した子を回収する。
      for (const pid of [...events().filter(([kind]) => kind === "pid").map(([, pid]) => Number(pid)), ...(child.pid === undefined ? [] : [-child.pid])]) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
      await closed;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectClean(result: { events: string[][]; temp: string; output: string }) {
  expect(readdirSync(result.temp), result.output).toEqual([]);
  for (const [, pid] of result.events.filter(([kind]) => kind === "pid")) {
    expect(() => process.kill(Number(pid), 0), `process ${pid} remains alive`).toThrow();
  }
}

describe("bootstrap measurement", () => {
  it.each([undefined, "HEAD~1"])("%s の新規 clone で準備の全段を順に実行する", async (commit) => {
    const original = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    await withMeasurement({ commit }, (result) => {
      expect(result.code, result.output).toBe(0);
      const checkout = result.events.find(([event]) => event === "checkout");
      expect(checkout?.[2]).toBe(result.expectedCommit);
      expect(checkout?.[1]).not.toBe(root);
      expect(result.events.some(([event, path]) => event === "clone" && path === checkout?.[1])).toBe(true);
      const starts = result.events.filter(([event]) => event === "start").map(([, name]) => name);
      expect(starts.slice(-4)).toEqual(["release", "models", "chromium", "claude"]);
      for (const name of ["install", "resolve", "setup", "compile"]) expect(starts).toContain(name);
      const release = result.events.findIndex(([event, name]) => event === "start" && name === "release");
      for (const name of ["install", "resolve", "compile"]) {
        const end = result.events.findIndex(([event, stage]) => event === "end" && stage === name);
        expect(end).toBeGreaterThan(-1);
        expect(end).toBeLessThan(release);
      }
      expectClean(result);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).toBe(original);
    });
  });

  it("目標を超えた時間も合否を付けずに表示して正常終了する", async () => {
    await withMeasurement({ clockScale: "1000" }, (result) => {
      expect(result.code, result.output).toBe(0);
      const rows = result.output.split("\n").filter((line) => /ビルド.*計|初回.*計/.test(line));
      expect(rows).toHaveLength(2);
      for (const line of rows) {
        const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
        expect(Number(cells[1])).toBeGreaterThan(Number(cells[2]));
        expect(line).not.toMatch(/\b(PASS|FAIL)\b|合格|不合格/i);
      }
      expectClean(result);
    });
  });

  it("入れ子のツールとモデル取得へ一時保存先を渡し、利用者の HOME を汚さない", async () => {
    await withMeasurement({}, (result) => {
      expect(result.code, result.output).toBe(0);
      const destinations = result.events.filter(([kind]) => kind === "destination");
      for (const tool of ["pnpm", "swift", "uvx", "models"]) expect(destinations.some(([, command]) => command === tool)).toBe(true);
      expect(destinations.filter(([, command]) => command === "swift")).toHaveLength(6);
      for (const [, , path] of destinations) {
        expect(path).toBeDefined();
        if (path === undefined) throw new Error("Missing destination");
        expect(relative(result.temp, path)).not.toMatch(/^\.\./);
        expect(path.startsWith(result.home)).toBe(false);
      }
      expect(readdirSync(result.home)).toEqual([]);
    });
  });

  it("段別・compile と Swift のビルド計・初回の実時間を目標と併記する", async () => {
    await withMeasurement({}, (result) => {
      expect(result.code, result.output).toBe(0);
      const rows = result.output.split("\n").filter((line) => line.includes("|"));
      const row = (label: RegExp) => {
        const found = rows.find((line) => label.test(line));
        expect(found, result.output).toBeDefined();
        if (found === undefined) throw new Error("Missing timing row " + label);
        const cells = found.split("|").map((cell) => cell.trim()).filter(Boolean);
        const value = cells[1]?.replace(/\s*(s|秒)$/, "");
        const seconds = Number(value);
        expect(Number.isFinite(seconds), found).toBe(true);
        expect(seconds).toBeGreaterThanOrEqual(0);
        const precision = value?.split(".")[1]?.length ?? 0;
        return { seconds, rounding: 0.5 * 10 ** -precision, text: found };
      };
      for (const label of [/clone/i, /install|インストール/, /resolve|依存.*解決/, /bootstrap.*(total|全体|計)/i, /サーバー|server/i, /モデル|models/i, /chromium/i, /claude/i]) row(label);
      const compile = row(/AEC3.*compile/i);
      const aec3 = row(/AEC3(?!.*compile)/i);
      const swift = row(/helper.*(release|Swift)|Swift.*build/i);
      const build = row(/ビルド.*計|build.*total/i);
      const total = row(/初回.*計|overall|first.*total/i);
      expect(aec3.seconds).toBeGreaterThan(compile.seconds);
      expect(Math.abs(build.seconds - compile.seconds - swift.seconds)).toBeLessThanOrEqual(build.rounding + compile.rounding + swift.rounding + 0.01);
      expect(total.seconds).toBeGreaterThanOrEqual(build.seconds - total.rounding - build.rounding);
      const cloneStarted = result.events.find(([event]) => event === "clone-start");
      const claudeFinished = result.events.find(([event, name]) => event === "end" && name === "claude");
      const elapsed = (Number(claudeFinished?.[2]) - Number(cloneStarted?.[1])) / 1000;
      expect(total.seconds + total.rounding).toBeGreaterThanOrEqual(elapsed);
      expect(total.seconds - total.rounding).toBeLessThanOrEqual(result.elapsedSeconds);
      expect(build.text).toMatch(/140/);
      expect(total.text).toMatch(/240/);
      for (const line of rows) expect(line).not.toMatch(/\b(PASS|FAIL)\b|合格|不合格/i);
    });
  });

  it.each([
    { condition: "disk", value: /9(?:\.\d+)?\s*(?:Gi?B|GB)|9437184|9663676416/i },
    { condition: "load", value: /4(?:\.0+)?/ },
    { condition: "swift", value: /1|999999/ },
  ] satisfies { condition: "disk" | "load" | "swift"; value: RegExp }[])("$condition の条件不成立を値付きで通知して計測を開始しない", async ({ condition, value }) => {
    await withMeasurement({ condition }, (result) => {
      expect(result.output).toMatch(value);
      expect(result.output).toMatch(/空き|disk|load|負荷|swift-build/i);
      expect(result.events.filter(([kind]) => ["clone", "start"].includes(kind ?? ""))).toEqual([]);
      expectClean(result);
    });
  });

  it.each(["install", "server", "claude", "release-signal"])("%s の失敗を報告し、子プロセスと一時領域を残さない", async (failure) => {
    await withMeasurement({ failure }, (result) => {
      expect(result.output).toContain(`fixture failed: ${failure}`);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      if (failure === "release-signal") expect(result.output).toContain("exited 137");
      expect(result.events.some(([event]) => event === "clone")).toBe(true);
      expectClean(result);
    });
  });

  it.each([
    { hold: "release", signal: "SIGTERM" },
    { hold: "claude", signal: "SIGTERM" },
    { hold: "release", signal: "SIGINT" },
    { hold: "claude", signal: "SIGINT" },
  ] satisfies { hold: string; signal: NodeJS.Signals }[])("$hold 実行中の $signal で所有する子と一時領域を片付ける", async ({ hold, signal }) => {
    await withMeasurement({ hold, signal }, (result) => {
      expect(result.code).not.toBe(0);
      expect(result.events.some(([event, name]) => event === "start" && name === hold)).toBe(true);
      expectClean(result);
    });
  });
});
