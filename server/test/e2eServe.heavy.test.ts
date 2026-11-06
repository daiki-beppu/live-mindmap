import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { SnapshotFrame, type Snapshot } from "../src/core/snapshot.ts";

const e2eDir = join(import.meta.dirname, "../../e2e");
const TIMEOUT = 60_000;
const RunInfo = Schema.Struct({ port: Schema.Number, sessionsDir: Schema.String, filesPort: Schema.Number, events: Schema.Number });

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (address === null || typeof address === "string") return reject(new Error("TCP port was not assigned"));
        resolve(address.port);
      });
    });
  });
}

async function launch(args: string[], webPort: number, options: { discussion?: string } = { discussion: "0" }) {
  const home = await mkdtemp(join(tmpdir(), "e2e-serve-test-"));
  const runInfoPath = join(e2eDir, ".run", `${webPort}.json`);
  if (existsSync(runInfoPath)) {
    await rm(home, { recursive: true, force: true });
    throw new Error(`run-info already exists: ${runInfoPath}`);
  }
  let root: string | undefined;
  let output = "";
  let spawnError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const child = spawn(process.execPath, ["scripts/serve.ts", ...args], {
    cwd: e2eDir,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: join(home, "config"),
      LIVE_MINDMAP_CONFIG: join(home, "absent.config.json"),
      LIVE_MINDMAP_MODEL: "",
      LIVE_MINDMAP_PORT: "0",
      LIVE_MINDMAP_VERIFY_REAL_HELPER: "0",
      LIVE_MINDMAP_VERIFY_DISCUSSION: options.discussion,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT,
    killSignal: "SIGKILL",
  });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.on("error", (error) => { spawnError = error; });
  child.on("close", (code, signal) => { exit = { code, signal }; });
  const exited = () => vi.waitFor(() => {
    if (spawnError) throw spawnError;
    if (!exit) throw new Error(`serve.ts has not exited\n${output}`);
    return exit;
  }, { timeout: 10_000, interval: 50 });

  onTestFinished(async () => {
    try {
      if (!exit) {
        child.kill("SIGTERM");
        try {
          await exited();
        } finally {
          if (!exit) {
            child.kill("SIGKILL");
            await exited();
          }
        }
      }
    } finally {
      await rm(runInfoPath, { force: true });
      if (root) await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  const ready = () => vi.waitFor(async () => {
    if (spawnError) throw spawnError;
    if (exit) throw new Error(`serve.ts exited before readiness: ${JSON.stringify(exit)}\n${output}`);
    const info = Schema.decodeUnknownSync(Schema.fromJsonString(RunInfo))(await readFile(runInfoPath, "utf8"));
    root = dirname(info.sessionsDir);
    const response = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(2_000) });
    expect(response.status).toBe(200);
    await response.text();
    return info;
  }, { timeout: 30_000, interval: 100 });

  return { child, ready, exited, runInfoPath, home };
}

describe("e2e serve CLI", () => {
  it.each([
    { name: "web-port missing", web: undefined, events: "2" },
    { name: "events missing", web: "valid", events: undefined },
    { name: "zero web-port", web: "0", events: "2" },
    { name: "fractional web-port", web: "1.5", events: "2" },
    { name: "zero events", web: "valid", events: "0" },
    { name: "fractional events", web: "valid", events: "1.5" },
    { name: "non-numeric events", web: "valid", events: "invalid" },
  ])("rejects $name before publishing run-info", async (input) => {
    const webPort = await unusedPort();
    const web = input.web === "valid" ? String(webPort) : input.web;
    const args = [...(web === undefined ? [] : ["--web-port", web]), ...(input.events === undefined ? [] : ["--events", input.events])];
    const app = await launch(args, webPort);
    const exit = await app.exited();
    expect(exit.signal).toBeNull();
    expect(exit.code).not.toBe(0);
    expect(existsSync(app.runInfoPath)).toBe(false);
  }, TIMEOUT);

  it.each([undefined, "0", "true", "1"])("uses the discussion fixture and updater only for setting %s equal to 1", async (discussion) => {
    const webPort = await unusedPort();
    const app = await launch(["--web-port", String(webPort), "--events", "1"], webPort, { discussion });
    const info = await app.ready();
    const snapshots: Snapshot[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
    onTestFinished(() => ws.close());
    ws.addEventListener("message", (event) => {
      const frame: unknown = JSON.parse(String(event.data));
      if (Schema.is(SnapshotFrame)(frame)) snapshots.push(frame.snapshot);
    });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.OPEN));
    const started = await fetch(`http://127.0.0.1:${info.port}/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "us.zoom.xos", audio: false, screen: false }),
    });
    expect(started.status).toBe(200);
    await started.text();
    await vi.waitFor(() => {
      const snapshot = snapshots.at(-1);
      expect(snapshot?.remarks.map((remark) => remark.text)).toEqual([
        discussion === "1" ? "導入の進め方を相談します" : "来月の新機能の進め方を相談したいです",
      ]);
      expect(snapshot?.nodes.filter((node) => node.kind === "案").map((node) => node.text)).toEqual(
        discussion === "1" ? ["段階導入", "一括導入", "試験導入"] : [],
      );
      expect(snapshot?.nodes.filter((node) => node.kind === "要点").map((node) => node.text)).toEqual(
        discussion === "1" ? [] : ["来月の新機能の進め方を相談したいです"],
      );
    }, { timeout: 10_000 });
  }, TIMEOUT);

  it("publishes usable run-info and releases listeners and temporary files on SIGTERM", async () => {
    const webPort = await unusedPort();
    const app = await launch(["--web-port", String(webPort), "--events", "2"], webPort);
    const info = await app.ready();
    expect(Object.keys(JSON.parse(await readFile(app.runInfoPath, "utf8"))).sort()).toEqual(["events", "filesPort", "port", "sessionsDir"]);
    expect(info.events).toBe(2);
    const status = await fetch(`http://127.0.0.1:${info.port}/session/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "none" });
    const files = await fetch(`http://127.0.0.1:${info.filesPort}/missing`);
    expect(files.status).toBe(404);
    await files.text();
    expect(existsSync(info.sessionsDir)).toBe(true);

    app.child.kill("SIGTERM");
    await app.exited();
    expect(existsSync(app.runInfoPath)).toBe(false);
    expect(existsSync(dirname(info.sessionsDir))).toBe(false);
    for (const port of [webPort, info.port, info.filesPort]) {
      await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
    }
  }, TIMEOUT);

  it("removes acquired temporary files and run-info when the web port is already occupied", async () => {
    const blocker = createServer();
    onTestFinished(() => new Promise<void>((resolve) => { blocker.close(() => resolve()); }));
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("blocker has no TCP address");
    const webPort = address.port;
    await mkdir(join(e2eDir, ".run"), { recursive: true });
    const app = await launch(["--web-port", String(webPort), "--events", "2"], webPort);
    const roots = new Set<string>();
    let published = false;
    // Observe creation events even if startup fails and removes the files before the next poll.
    const temporaryFiles = watch(app.home, (_event, name) => {
      if (name?.startsWith("live-mindmap-e2e-")) roots.add(join(app.home, name));
    });
    const runInfo = watch(dirname(app.runInfoPath), (_event, name) => {
      if (name === `${webPort}.json`) published = true;
    });
    onTestFinished(() => { temporaryFiles.close(); runInfo.close(); });

    const exit = await app.exited();
    expect(exit.signal).toBeNull();
    expect(exit.code).not.toBe(0);
    await vi.waitFor(() => {
      expect(published).toBe(true);
      expect(roots.size).toBeGreaterThan(0);
    });
    expect(existsSync(app.runInfoPath)).toBe(false);
    for (const root of roots) expect(existsSync(root)).toBe(false);
    expect(blocker.listening).toBe(true);
  }, TIMEOUT);

  it("serves HTML and plain text and returns 404 for missing and outside files through both HTTP entrances", async () => {
    const webPort = await unusedPort();
    const app = await launch(["--web-port", String(webPort), "--events", "2"], webPort);
    const info = await app.ready();
    const dir = join(info.sessionsDir, "review");
    await mkdir(dir);
    const html = "<!doctype html><title>review</title><p>見返し</p>";
    const plain = '{"text":"発言"}\n';
    await writeFile(join(dir, "map.html"), html);
    await writeFile(join(dir, "log.jsonl"), plain);
    await writeFile(join(dirname(info.sessionsDir), "outside.txt"), "outside");

    for (const base of [`http://127.0.0.1:${info.filesPort}`, `http://127.0.0.1:${webPort}/session-files`]) {
      for (const [name, type, body] of [["map.html", "text/html", html], ["log.jsonl", "text/plain", plain]]) {
        const response = await fetch(`${base}/review/${name}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(`${type}; charset=utf-8`);
        expect(await response.text()).toBe(body);
      }
      // Encode the slash too: URL normalization must not remove the traversal before the server sees it.
      for (const path of ["/review/missing.html", "/%2e%2e%2foutside.txt"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
      }
    }
  }, TIMEOUT);
});
