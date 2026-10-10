import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { ManagedDeps } from "../../src/managedDeps.ts";

export const temporaryDeps = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-managed-deps-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

export const installed = { name: "chromium", need: "optional", state: "ready" } as const;

export const fakeNpm = Effect.fnUntraced(function* (dir: string) {
  const script = join(dir, "npm.cjs");
  yield* Effect.tryPromise(() => writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const control = ${JSON.stringify(dir)};
const record = (kind, args) => fs.appendFileSync(path.join(control, 'calls.jsonl'), JSON.stringify({kind, args, cwd: process.cwd(), browsers: process.env.PLAYWRIGHT_BROWSERS_PATH}) + '\\n');
record('npm', process.argv.slice(2));
fs.writeFileSync(path.join(control, 'npm-pid'), String(process.pid));
const waiting = new Int32Array(new SharedArrayBuffer(4));
while (fs.existsSync(path.join(control, 'hold-npm'))) Atomics.wait(waiting, 0, 0, 10);
if (fs.existsSync(path.join(control, 'fail-npm'))) {
  console.error('npm failure first line');
  console.error('npm failure last line');
  process.exit(17);
}
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies['playwright-core'];
const pkg = path.join(process.cwd(), 'node_modules', 'playwright-core');
fs.mkdirSync(pkg, {recursive: true});
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name: 'playwright-core', version}));
fs.writeFileSync(path.join(pkg, 'browsers.json'), JSON.stringify({browsers: [{name: 'chromium-headless-shell', revision: '999', installByDefault: true, browserVersion: '999.0'}]}));
fs.writeFileSync(path.join(pkg, 'cli.js'), \`
const fs = require('node:fs');
const path = require('node:path');
const control = \${JSON.stringify(control)};
fs.appendFileSync(path.join(control, 'calls.jsonl'), JSON.stringify({kind: 'browser', args: process.argv.slice(2), cwd: process.cwd(), browsers: process.env.PLAYWRIGHT_BROWSERS_PATH}) + '\\\\n');
fs.writeFileSync(path.join(control, 'browser-started'), 'started');
fs.writeFileSync(path.join(control, 'browser-pid'), String(process.pid));
(async () => {
  while (fs.existsSync(path.join(control, 'hold-browser'))) await new Promise(resolve => setTimeout(resolve, 10));
  if (fs.existsSync(path.join(control, 'fail-browser'))) { console.error('browser failed'); process.exit(19); }
  const dir = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium_headless_shell-999');
  const binaries = ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell'];
  for (const binary of binaries) {
    fs.mkdirSync(path.dirname(path.join(dir, binary)), {recursive: true});
    fs.writeFileSync(path.join(dir, binary), 'fake headless shell', {mode: 0o755});
  }
  if (!fs.existsSync(path.join(control, 'omit-marker'))) fs.writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
})();
\`);
`));
  return { command: process.execPath, args: [script] };
});

export const managedLayer = (root: string, npm?: { command: string; args: string[] }) =>
  ManagedDeps.layer({ root, npm }).pipe(Layer.provide(NodeServices.layer));

export const install = Effect.fnUntraced(function* () {
  const deps = yield* ManagedDeps;
  return yield* Stream.runCollect(deps.install(["chromium"]));
});
