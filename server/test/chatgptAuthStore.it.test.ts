import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, type TestContext } from "vitest";
import { chatgptAuthPath, chatgptCredentials } from "./fixtures/chatgpt.ts";

type Result = { code: number | null; signal: string | null; output: string; errors: string };
type Worker = {
  child: ChildProcess;
  output: string;
  errors: string;
  lines: Set<string>;
  result: Result | undefined;
  error: Error | undefined;
};

// このITが所有する資源は、テスト本体と終了フックで同じcleanupを待つ。
class AuthResources {
  readonly changes = new EventEmitter();
  readonly workers: Worker[] = [];
  readonly forms: string[] = [];
  readonly events: string[] = [];
  first: ServerResponse | undefined;
  failure: Error | undefined;
  home!: string;
  path!: string;
  url!: string;
  private cleanupPromise: Promise<void> | undefined;
  readonly ready: Promise<void>;
  readonly signal: AbortSignal;
  readonly server: ReturnType<typeof createServer>;

  constructor(context: TestContext, signal: AbortSignal) {
    this.signal = signal;
    context.onTestFinished(() => this.cleanup(), 10_000);
    this.server = createServer((request, response) => {
      let form = "";
      request.setEncoding("utf8");
      request.on("error", (error) => this.fail(error));
      request.on("data", (chunk: string) => { form += chunk; });
      request.on("end", () => {
        this.forms.push(form);
        this.events.push("request");
        if (this.first) {
          this.fail(new Error("duplicate refresh request"));
          response.destroy();
        } else {
          this.first = response;
          this.changes.emit("change");
        }
      });
    });
    this.server.on("error", (error) => this.fail(error));
    this.ready = this.initialize();
  }

  private async initialize() {
    this.signal.throwIfAborted();
    this.home = await mkdtemp(join(tmpdir(), "live-mindmap-auth-"));
    this.signal.throwIfAborted();
    this.path = chatgptAuthPath(this.home);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(chatgptCredentials(0)), { mode: 0o600 });
    this.signal.throwIfAborted();
    this.server.listen(0, "127.0.0.1", () => this.changes.emit("change"));
    await this.wait("listen", () => this.server.listening ? true : undefined, []);
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    this.url = `http://127.0.0.1:${address.port}/token`;
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.changes.emit("change");
  }

  worker(mode: string, path = this.path, executable = process.execPath): Worker {
    this.signal.throwIfAborted();
    if (this.cleanupPromise) throw new Error("resources are closing");
    if (this.failure) throw this.failure;
    const child = spawn(executable, [join(import.meta.dirname, "fixtures/chatgptWorker.ts"), path, this.url, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const worker: Worker = { child, output: "", errors: "", lines: new Set(), result: undefined, error: undefined };
    this.workers.push(worker);
    child.stdout!.on("data", (data) => { worker.output += String(data); this.changes.emit("change"); });
    child.stderr!.on("data", (data) => { worker.errors += String(data); });
    const lines = createInterface({ input: child.stderr! });
    lines.on("line", (line) => {
      worker.lines.add(line);
      this.events.push(line);
      this.changes.emit("change");
    });
    child.once("error", (error) => { worker.error = error; this.changes.emit("change"); });
    child.once("close", (code, signal) => {
      worker.result = { code, signal, output: worker.output, errors: worker.errors };
      lines.close();
      this.events.push("close");
      this.changes.emit("change");
    });
    return worker;
  }

  wait<T>(label: string, read: () => T | undefined, workers: Worker[], timeout = 5_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (value: T | undefined, error?: Error) => {
        clearTimeout(timer);
        this.changes.off("change", check);
        this.signal.removeEventListener("abort", check);
        if (error) reject(error);
        else resolve(value!);
      };
      const check = () => {
        if (this.signal.aborted) return finish(undefined, new Error(label + ": aborted", { cause: this.signal.reason }));
        if (this.failure) return finish(undefined, this.failure);
        const failed = workers.find((worker) => worker.error);
        if (failed) return finish(undefined, new Error(label + ": spawn error", { cause: failed.error }));
        const value = read();
        if (value !== undefined) return finish(value);
        const closed = workers.find((worker) => worker.result);
        if (closed) return finish(undefined, new Error(label + ": worker exited before " + label + " (" + closed.result!.code + ", " + closed.result!.signal + ")"));
      };
      const timer = setTimeout(() => finish(undefined, new Error(label + ": deadline exceeded")), timeout);
      this.changes.on("change", check);
      this.signal.addEventListener("abort", check, { once: true });
      check();
    });
  }

  requested(worker: Worker, timeout = 5_000) {
    return this.wait("request", () => this.first, [worker], timeout);
  }

  notified(worker: Worker, line: string, timeout = 5_000) {
    return this.wait(line, () => worker.lines.has(line) ? true : undefined, [worker], timeout);
  }

  competing(one: Worker, two: Worker, timeout = 5_000) {
    return this.wait("contended", () => two.lines.has("contended") ? true : undefined, [one, two], timeout);
  }

  ended(worker: Worker, timeout = 5_000) {
    return this.wait("exit", () => worker.result, [worker], timeout);
  }

  release(access = "rotated-access", refresh = "rotated-refresh") {
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (!this.first) throw new Error("no refresh request");
    this.events.push("release");
    this.first.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      access_token: access, refresh_token: refresh, expires_in: 3600,
    }));
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.dispose();
    return this.cleanupPromise;
  }

  private async dispose() {
    // 取得中にtimeoutしても、取得完了後の資源を回収する。取得失敗は本体が報告する。
    await Promise.allSettled([this.ready]);
    const results = await Promise.allSettled([
      ...this.workers.map(async (worker) => {
        if (!worker.result) worker.child.kill("SIGKILL");
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            if (worker.result) { clearTimeout(timer); this.changes.off("change", check); resolve(); }
          };
          const timer = setTimeout(() => {
            this.changes.off("change", check);
            reject(new Error("cleanup: worker exit deadline exceeded"));
          }, 5_000);
          this.changes.on("change", check);
          check();
        });
      }),
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("cleanup: server close deadline exceeded")), 5_000);
        this.server.close((error) => {
          clearTimeout(timer);
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
        this.server.closeAllConnections();
      }),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "auth IT cleanup failed; HOME retained");
    if (this.home) await rm(this.home, { recursive: true, force: true });
  }
}

async function expectReleased(resources: AuthResources) {
  expect(resources.workers.length).toBeGreaterThan(0);
  for (const worker of resources.workers) expect(worker.result).toBeDefined();
  expect(resources.server.listening).toBe(false);
  expect(resources.server.address()).toBeNull();
  await expect(readFile(resources.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(resources.home)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("認証ストアのプロセス間排他（C02）", () => {
  it("別プロセスの更新を直列化し、強制終了後の lock を勝手に奪わない", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const one = resources.worker("refresh");
      const first = await resources.requested(one);
      const two = resources.worker("refresh");
      await resources.competing(one, two);
      expect(first.writableEnded).toBe(false);
      expect(resources.forms).toHaveLength(1);
      resources.release();
      for (const result of await Promise.all([resources.ended(one), resources.ended(two)])) {
        expect(result.code, result.errors).toBe(0);
        expect(result.output.trim()).toBe("rotated-access");
      }
      expect(resources.events).toEqual(["request", "contended", "release", "close", "close"]);
      expect(resources.forms).toHaveLength(1);
      expect(new URLSearchParams(resources.forms[0]).get("refresh_token")).toBe("synthetic-refresh");
      expect(JSON.parse(await readFile(resources.path, "utf8"))).toMatchObject({ refresh_token: "rotated-refresh" });
      const holder = resources.worker("hold");
      await resources.wait("locked", () => holder.output.includes("locked\n") ? true : undefined, [holder]);
      holder.child.kill("SIGKILL");
      expect((await resources.ended(holder)).signal).toBe("SIGKILL");
      const leftover = await readFile(resources.path, "utf8");
      // 残存lockは、全workerの終了確認後にだけ手動回収する。
      await rm(resources.path + ".lock", { recursive: true });
      expect((await resources.ended(resources.worker("refresh"))).code).toBe(0);
      expect(await readFile(resources.path, "utf8")).toBe(leftover);
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  }, 20_000);

  it.for(["request", "contended"])("%s前の終了コード0も早期終了として失敗し、資源を解放する", async (label, context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const worker = resources.worker("exit");
      const waiting = label === "request" ? resources.requested(worker) : resources.notified(worker, label);
      await expect(waiting).rejects.toThrow("worker exited before " + label + " (0, null)");
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it("spawnエラーで要求待ちを失敗させ、資源を解放する", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const worker = resources.worker("refresh", resources.path, join(resources.home, "missing-executable"));
      await expect(resources.requested(worker)).rejects.toThrow("request: spawn error");
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it.for(["request", "contended", "exit"])("%sの期限超過を区別し、生存中workerを回収する", async (label, context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const worker = resources.worker("idle");
      await resources.notified(worker, "ready");
      const waiting = label === "request" ? resources.requested(worker, 25)
        : label === "exit" ? resources.ended(worker, 25) : resources.notified(worker, label, 25);
      await expect(waiting).rejects.toThrow(label + ": deadline exceeded");
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it.for(["request", "contended", "exit"])("%s待機中の中断で追加生成を止め、資源を解放する", async (label, context) => {
    const controller = new AbortController();
    const resources = new AuthResources(context, AbortSignal.any([context.signal, controller.signal]));
    try {
      await resources.ready;
      const worker = resources.worker("idle");
      await resources.notified(worker, "ready");
      const waiting = label === "request" ? resources.requested(worker)
        : label === "exit" ? resources.ended(worker) : resources.notified(worker, label);
      const rejected = expect(waiting).rejects.toThrow(label + ": aborted");
      controller.abort(new Error("test interruption"));
      await rejected;
      expect(() => resources.worker("refresh")).toThrow("test interruption");
      expect(resources.workers).toHaveLength(1);
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it("後発の認証開始が保留なら応答を解放せず、通知期限で失敗する", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const one = resources.worker("refresh");
      const first = await resources.requested(one);
      const two = resources.worker("idle");
      await resources.notified(two, "ready");
      await expect(resources.competing(one, two, 25)).rejects.toThrow("contended: deadline exceeded");
      expect(first.writableEnded).toBe(false);
      expect(resources.forms).toHaveLength(1);
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it("別pathの旧資格情報では重複要求を検出し、最初の応答を保持する", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const one = resources.worker("refresh");
      const first = await resources.requested(one);
      const separate = join(dirname(resources.path), "separate.json");
      await writeFile(separate, JSON.stringify(chatgptCredentials(0)), { mode: 0o600 });
      const two = resources.worker("refresh", separate);
      await expect(resources.competing(one, two)).rejects.toThrow("duplicate refresh request");
      expect(resources.forms).toHaveLength(2);
      expect(resources.first).toBe(first);
      expect(first.writableEnded).toBe(false);
      expect(() => resources.release()).toThrow("duplicate refresh request");
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it.for(["access", "refresh"])("%sの更新値のassertion失敗後も全workerとサーバーを回収する", async (field, context) => {
    const resources = new AuthResources(context, context.signal);
    const scenario = async () => {
      try {
        await resources.ready;
        const one = resources.worker("refresh");
        await resources.requested(one);
        const two = resources.worker("refresh");
        await resources.competing(one, two);
        resources.release(field === "access" ? "different-access" : "rotated-access",
          field === "refresh" ? "different-refresh" : "rotated-refresh");
        const results = await Promise.all([resources.ended(one), resources.ended(two)]);
        expect(results.map((result) => result.output.trim())).toEqual(["rotated-access", "rotated-access"]);
        expect(JSON.parse(await readFile(resources.path, "utf8"))).toMatchObject({ refresh_token: "rotated-refresh" });
      } finally {
        await resources.cleanup();
      }
    };
    await expect(scenario()).rejects.toThrow("rotated-" + field);
    await expectReleased(resources);
  });

  it("更新完了後もworkerが終了しなければ終了期限で失敗する", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const worker = resources.worker("refresh-stay");
      await resources.requested(worker);
      resources.release();
      await resources.wait("access", () => worker.output.includes("rotated-access\n") ? true : undefined, [worker]);
      await expect(resources.ended(worker, 25)).rejects.toThrow("exit: deadline exceeded");
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it("holdの終了未確認では手動回収へ進まず、cleanupで終了を確認する", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const holder = resources.worker("hold");
      await resources.wait("locked", () => holder.output.includes("locked\n") ? true : undefined, [holder]);
      await expect(resources.ended(holder, 25)).rejects.toThrow("exit: deadline exceeded");
      expect(holder.result).toBeUndefined();
      await expect(mkdir(resources.path + ".lock")).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });

  it("手動回収後のworkerも終了未確認ならファイル一致だけで成功にしない", async (context) => {
    const resources = new AuthResources(context, context.signal);
    try {
      await resources.ready;
      const one = resources.worker("refresh");
      await resources.requested(one);
      resources.release();
      expect((await resources.ended(one)).code).toBe(0);
      const holder = resources.worker("hold");
      await resources.wait("locked", () => holder.output.includes("locked\n") ? true : undefined, [holder]);
      holder.child.kill("SIGKILL");
      expect((await resources.ended(holder)).signal).toBe("SIGKILL");
      const leftover = await readFile(resources.path, "utf8");
      await rm(resources.path + ".lock", { recursive: true });
      const recovered = resources.worker("refresh-stay");
      await resources.wait("access", () => recovered.output.includes("rotated-access\n") ? true : undefined, [recovered]);
      expect(await readFile(resources.path, "utf8")).toBe(leftover);
      await expect(resources.ended(recovered, 25)).rejects.toThrow("exit: deadline exceeded");
    } finally {
      await resources.cleanup();
    }
    await expectReleased(resources);
  });
});
