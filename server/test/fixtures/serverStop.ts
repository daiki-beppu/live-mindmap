import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Cause, ConfigProvider, Console, Effect, Exit, Layer } from "effect";
import { runCli } from "../../src/cli.ts";
import { serverPidPath } from "../../src/serverProcess.ts";
import { unusedApple } from "./appleIntelligence.ts";
import { fakeExportServices } from "./exportServices.ts";
import { forbiddenManagedDeps } from "./forbiddenManagedDeps.ts";
import { fakeScreenJpeg } from "./screenJpeg.ts";

export const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-server-stop-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

export const serverStop = (sessionsDir: string, port: number) => Effect.gen(function* () {
  const out: string[] = [];
  const err: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { out.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { err.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
    Layer.succeed(Console.Console, consoleService),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_SESSIONS: sessionsDir })));
  const exit = yield* Effect.exit(runCli(["server", "stop"]).pipe(Effect.provide(layer)));
  const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  return { out: out.join(""), failed: Exit.isFailure(exit), message: failure instanceof Error ? failure.message : String(failure) };
});

export const unusedPort = Effect.tryPromise(() => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("TCP の待受けがありません")));
  });
}));

export const writePid = (sessionsDir: string, port: number, pid: number) => Effect.promise(async () => {
  const path = serverPidPath(sessionsDir, port);
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`);
  return path;
});
