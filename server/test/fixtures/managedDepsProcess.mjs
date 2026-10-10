import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";

const [control, id, point] = process.argv.slice(2);
const lock = join(control, "deps/chromium/install.lock");
const guard = `${lock}.guard`;
const original = {
  readFileSync: fs.readFileSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
};
let paused = false;
const pause = (operation, path) => {
  if (paused || point !== operation) return;
  paused = true;
  fs.writeFileSync(join(control, `${id}.reached`), String(path));
  const signal = new Int32Array(new SharedArrayBuffer(4));
  // FS 操作の結果を変えずに、親が指定した交差位置で停止する。
  while (!fs.existsSync(join(control, `${id}.resume`))) Atomics.wait(signal, 0, 0, 10);
};
fs.readFileSync = function (path, ...args) {
  const result = original.readFileSync.call(this, path, ...args);
  if (String(path) === lock) pause("pid-read", path);
  if (String(path).startsWith(`${guard}/`)) pause("guard-read", path);
  return result;
};
fs.renameSync = function (from, to) {
  const result = original.renameSync.call(this, from, to);
  if (String(to) === guard) pause("guard-published", to);
  return result;
};
fs.unlinkSync = function (path) {
  const result = original.unlinkSync.call(this, path);
  if (String(path).startsWith(`${guard}/`) && !String(path).includes("/execution-")) pause("owner-released", path);
  return result;
};
syncBuiltinESMExports();
if (point.startsWith("execution-")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${join(import.meta.dirname, "managedDepsRunnerHooks.mjs")}`;
  process.env.MANAGED_TEST_CONTROL = control;
  process.env.MANAGED_TEST_ID = id;
  process.env.MANAGED_TEST_POINT = point;
}
const { ManagedDeps } = await import("../../src/managedDeps.ts");
const program = Effect.gen(function* () {
  const deps = yield* ManagedDeps;
  return yield* Stream.runCollect(deps.install(["chromium"]));
}).pipe(Effect.provide(ManagedDeps.layer({
  root: join(control, "deps"), npm: { command: process.execPath, args: [join(control, "npm.cjs")] },
}).pipe(Layer.provide(NodeServices.layer))));
const result = await Effect.runPromise(Effect.result(program));
fs.writeFileSync(join(control, `${id}.result`), JSON.stringify(result));
process.exitCode = result._tag === "Success" ? 0 : 1;
