import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { ManagedDeps } from "../../src/managedDeps.ts";
import { fakeNpm } from "./managedDeps.ts";

export const ready = { name: "claude", state: "ready" } as const;
export const fakeInstaller = Effect.fnUntraced(function* (root: string) {
  const chromium = yield* fakeNpm(root);
  const script = join(root, "sdk-npm.cjs");
  yield* Effect.tryPromise(() => writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const control = ${JSON.stringify(root)};
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = '@anthropic-ai/claude-agent-sdk';
if (!manifest.dependencies[name]) { require(${JSON.stringify(chromium.args[0])}); }
else {
  fs.appendFileSync(path.join(control, 'sdk-calls'), JSON.stringify(process.argv.slice(2)) + '\\n');
  fs.writeFileSync(path.join(control, 'sdk-started'), String(process.pid));
  const waiting = new Int32Array(new SharedArrayBuffer(4));
  while (fs.existsSync(path.join(control, 'hold-sdk'))) Atomics.wait(waiting, 0, 0, 10);
  if (fs.existsSync(path.join(control, 'fail-sdk'))) { console.error('synthetic npm failure'); process.exit(17); }
  const pkg = path.join('node_modules', name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: manifest.dependencies[name], type: 'module', exports: { '.': './sdk.mjs' } }));
  fs.writeFileSync(path.join(pkg, 'sdk.mjs'), "export const query = () => { throw new Error('query must not run'); };\\n");
  const binaryPkg = name + '-' + process.platform + '-' + process.arch;
  const binaryDir = path.join('node_modules', binaryPkg);
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, 'package.json'), JSON.stringify({ name: binaryPkg, version: manifest.dependencies[name] }));
  fs.writeFileSync(path.join(binaryDir, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'synthetic CLI binary', { mode: 0o755 });
}
`));
  return { command: process.execPath, args: [script] };
});
export const install = Effect.fnUntraced(function* (names: string[]) {
  return yield* Stream.runCollect((yield* ManagedDeps).install(names));
});
export const oldCurrent = async (root: string) => {
  const old = join(root, "claude/old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, ".ready.json"), JSON.stringify({ version: "0.0.0", installedAt: "2000-01-01T00:00:00Z", hashes: {} }));
  await symlink("old", join(root, "claude/current"));
};
export const leftovers = async (root: string) => (await readdir(join(root, "claude"))).filter((name) => name.startsWith(".work-") || name.startsWith("install.lock"));
