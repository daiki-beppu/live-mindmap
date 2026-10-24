#!/usr/bin/env bash
# 初回準備に効く依存・ビルド・取得処理や README の準備手順を変えたときに実行する。
# 使用法: bash scripts/measure-bootstrap.sh [commit]（既定 HEAD）。未コミットの変更は clone に含まれない。
# main とブランチを同じ時間帯に続けて測り、PR に before/after を記録する。
# 空き 10 GB 以上、1 分 load average 4 未満、他の swift-build 0 本でのみ開始する。
# clone と SwiftPM の cache/config/security、pnpm store、uv、管理依存、話者モデルを一時領域へ置く。
# pnpm bootstrap → pnpm dev → 話者モデル取得 → cli install chromium → cli install claude の順で測る。
# pnpm bootstrap の並列性を保ち、AEC3 compile と helper release の合計をビルド計として表示する。
# 初回計は clone 開始から最後の導入完了までの実時間（事前確認と cleanup を除く）。
# 目標はビルド 140 秒・初回 240 秒。揺れは ±10〜20%、混雑時は 2〜5 倍なので合否は出さない。
# 目標を ±20% より大きく超えたら、その PR で直すか issue を立てる。CI の性能 check にはしない。
# 約 5 GB 使用する。成功・失敗・SIGINT・SIGTERM 時は所有プロセスを止めてから一時領域を消す。
set -euo pipefail
exec node --input-type=module - "$0" "$@" <<'NODE'
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [script, revision = 'HEAD', ...extra] = process.argv.slice(2);
const source = resolve(dirname(script), '..');
const abort = new AbortController();
const groups = new Set();
const roots = new Set();
const children = [];
const tools = {};
let work;
let clone;
let env;
let serverPort;
let stage = 'preflight';
const now = () => Number(process.hrtime.bigint()) / 1e9;
const timings = new Map();

function checked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function preflight() {
  if (extra.length) throw new Error('Usage: bash scripts/measure-bootstrap.sh [commit]');
  for (const tool of ['git', 'pnpm', 'swift', 'uv', 'uvx', 'bash', 'ps']) {
    tools[tool] = checked('/usr/bin/which', [tool]);
  }
  const manager = realpathSync(tools.pnpm);
  if (basename(manager) === 'vp') {
    // 一時 HOME に変える前に、vp の shim が選ぶ既存の pnpm 本体を解決する。
    tools.pnpm = checked(manager, ['env', 'which', 'pnpm']).split('\n')[0];
  }
  const disk = statfsSync(tmpdir());
  const free = disk.bavail * disk.bsize / 1e9;
  const load = loadavg()[0];
  const processes = checked(tools.ps, ['-axo', 'comm=']).split('\n').filter((line) => /(?:^|\/)swift-build$/.test(line.trim())).length;
  process.stderr.write(`Conditions: disk ${free.toFixed(2)} GB free; load ${load.toFixed(2)}; swift-build ${processes}\n`);
  if (free < 10 || load >= 4 || processes !== 0) {
    throw new Error('計測を開始しません: 空き 10 GB 以上・load 4 未満・swift-build 0 本が必要です');
  }
  return checked(tools.git, ['-C', source, 'rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
}

function start(command, args, options) {
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (child.pid !== undefined) roots.add(child.pid);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (child.pid !== undefined) roots.delete(child.pid);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code === null ? signal : code}`));
    });
  });
  // dev は起動待ちの最中にも終了し得るため、待機側へ渡すまで rejection を保持する。
  done.catch(() => {});
  children.push(done);
  return { child, done };
}

async function run(command, args, cwd = clone) {
  abort.signal.throwIfAborted();
  const process = start(command, args, { cwd });
  let interrupted;
  const cancelled = new Promise((_, reject) => {
    interrupted = () => reject(abort.signal.reason);
    abort.signal.addEventListener('abort', interrupted, { once: true });
  });
  try { await Promise.race([process.done, cancelled]); }
  finally { abort.signal.removeEventListener('abort', interrupted); }
}

async function measured(name, command, args, cwd = clone) {
  stage = name;
  const started = now();
  await run(command, args, cwd);
  timings.set(name, now() - started);
}

const wrapper = String.raw`
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { constants } from 'node:os';
const config = JSON.parse(process.env.LIVE_MINDMAP_MEASURE_CONFIG);
const [tool, ...original] = process.argv.slice(2);
let args = original;
let stage;
if (tool === 'pnpm') {
  args = ['--store-dir', join(config.work, 'pnpm-store'), '--state-dir', join(config.work, 'pnpm-state'), '--config.scriptShell=' + join(config.work, 'bin/bash'), ...original];
  if (original[0] === 'install') stage = 'install';
} else if (tool === 'swift') {
  args = [...original, '--cache-path', join(config.work, 'swift-cache'), '--config-path', join(config.work, 'swift-config'), '--security-path', join(config.work, 'swift-security')];
  if (original.includes('resolve')) stage = 'resolve';
  if (original.includes('build') && original.includes('release')) stage = 'release';
} else if (tool === 'uvx' && original.includes('compile')) stage = 'compile';
else if (tool === 'bash' && original.some((arg) => arg.endsWith('/build-webrtc-apm.sh'))) stage = 'aec3';
const now = () => Number(process.hrtime.bigint()) / 1e9;
const started = now();
// pnpm は scripts の PATH の先頭へ自分の bin を戻すため、scriptShell の入口でもラッパーを先頭に戻す。
const child = spawn(config.tools[tool], args, { stdio: 'inherit', env: { ...process.env, PATH: join(config.work, 'bin') + ':' + dirname(process.env.LIVE_MINDMAP_MEASURE_NODE) + ':' + process.env.PATH } });
const ownership = join(config.work, 'children', String(process.pid));
if (child.pid !== undefined) writeFileSync(ownership, String(child.pid));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('close', (code, signal) => {
  rmSync(ownership, { force: true });
  if (stage && code === 0) writeFileSync(join(config.work, stage + '.done'), JSON.stringify({ started, ended: now() }));
  process.exitCode = code === null ? 128 + constants.signals[signal] : code < 0 ? 1 : code;
});
`;

function prepare() {
  work = mkdtempSync(join(tmpdir(), 'live-mindmap-bootstrap-'));
  clone = join(work, 'repo');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  mkdirSync(join(work, 'children'));
  mkdirSync(join(work, 'home'));
  mkdirSync(join(work, 'config'));
  writeFileSync(join(work, 'wrapper.mjs'), wrapper);
  for (const tool of ['pnpm', 'swift', 'uvx', 'bash']) {
    writeFileSync(join(bin, tool), '#!/bin/bash\nexec "$LIVE_MINDMAP_MEASURE_NODE" "$LIVE_MINDMAP_MEASURE_WRAPPER" ' + tool + ' "$@"\n', { mode: 0o755 });
  }
  env = {
    ...process.env,
    HOME: join(work, 'home'),
    XDG_CONFIG_HOME: join(work, 'config'),
    PATH: `${bin}:${process.env.PATH}`,
    LIVE_MINDMAP_MEASURE_NODE: process.execPath,
    LIVE_MINDMAP_MEASURE_WRAPPER: join(work, 'wrapper.mjs'),
    LIVE_MINDMAP_MEASURE_CONFIG: JSON.stringify({ tools, work }),
    UV_CACHE_DIR: join(work, 'uv-cache'),
    XDG_CACHE_HOME: join(work, 'xdg-cache'),
    LIVE_MINDMAP_DEPS: join(work, 'deps'),
    LIVE_MINDMAP_HELPER_SPEAKER_MODEL_DIR: join(work, 'speaker-models'),
    LIVE_MINDMAP_SESSIONS: join(work, 'sessions'),
    LIVE_MINDMAP_HELPER: join(clone, 'helper/.build/release/live-mindmap-helper'),
    npm_config_cache: join(work, 'npm-cache'),
    LIVE_MINDMAP_PORT: '0',
  };
  process.stderr.write(`Temporary directory: ${work}\n`);
}

function readTiming(name) {
  const value = JSON.parse(readFileSync(join(work, name + '.done'), 'utf8'));
  return value.ended - value.started;
}

async function waitForServer(dev, announced) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (dev.child.exitCode !== null || dev.child.signalCode !== null) {
      await dev.done;
      throw new Error('dev exited before server startup');
    }
    const port = announced();
    if (port !== undefined) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/server`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const identity = await response.json();
          if (!Number.isInteger(identity.pid)) throw new Error('Invalid server identity');
          const tree = processTree();
          if (!descendsFrom(identity.pid, new Set([dev.child.pid]), tree)) throw new Error('Server identity is outside the measured dev process tree');
          return port;
        }
      } catch (error) {
        if (!(error instanceof TypeError || error.name === 'TimeoutError')) throw error;
      }
    }
    await delay(30);
  }
  throw new Error('Timed out waiting for the measured server');
}

async function execute(commit) {
  const started = now();
  await measured('clone', tools.git, ['clone', source, clone], source);
  await run(tools.git, ['checkout', '--detach', commit]);
  await measured('bootstrap 全体', 'pnpm', ['bootstrap']);
  stage = 'helper release / server startup';
  let port;
  const dev = start('pnpm', ['dev'], { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] });
  const readers = [dev.child.stdout, dev.child.stderr].map((stream) => {
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      process.stderr.write(line + '\n');
      const match = line.match(/live-mindmap サーバーを起動しました: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) port = Number(match[1]);
    });
    return lines;
  });
  serverPort = await waitForServer(dev, () => port);
  env.LIVE_MINDMAP_PORT = String(serverPort);
  const releaseEnd = JSON.parse(readFileSync(join(work, 'release.done'), 'utf8')).ended;
  timings.set('サーバー起動', now() - releaseEnd);
  await measured('モデル取得', 'bash', ['helper/scripts/fetch-speaker-models.sh']);
  await measured('Chromium', 'pnpm', ['cli', 'install', 'chromium']);
  await measured('Claude', 'pnpm', ['cli', 'install', 'claude']);
  timings.set('初回の計', now() - started);
  for (const [name, key] of [['install', 'install'], ['AEC3 全体', 'aec3'], ['AEC3 compile', 'compile'], ['Swift package resolve', 'resolve'], ['helper release build', 'release']]) {
    timings.set(name, readTiming(key));
  }
  timings.set('ビルドの計', timings.get('AEC3 compile') + timings.get('helper release build'));
  for (const reader of readers) reader.close();
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error.code !== 'ESRCH') {
      const members = checked(tools.ps, ['-axo', 'pid=,ppid=,pgid=,stat=']).split('\n').map((line) => line.trim().split(/\s+/)).filter((fields) => fields[2] === String(pid));
      // macOS はゾンビだけのグループへの signal に EPERM を返す。ChildProcess の終了待ちで回収する。
      if (error.code === 'EPERM' && members.length && members.every((fields) => fields[3].startsWith('Z'))) return;
      throw new Error(`kill group ${pid} ${signal}: ${error.message}; members: ${JSON.stringify(members)}`);
    }
  }
}

function processTree() {
  return checked(tools.ps, ['-axo', 'pid=,ppid=,pgid=']).split('\n').filter((line) => line.trim()).map((line) => {
    const [pid, parent, group] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group) };
  });
}

function descendsFrom(pid, owners, tree) {
  const byPid = new Map(tree.map((row) => [row.pid, row]));
  const visited = new Set();
  while (pid > 1 && !visited.has(pid)) {
    if (owners.has(pid)) return true;
    visited.add(pid);
    const row = byPid.get(pid);
    if (row === undefined) return false;
    pid = row.parent;
  }
  return false;
}

function collectGroups() {
  if (work === undefined) return;
  const owners = new Set(roots);
  const registered = existsSync(join(work, 'children')) ? readdirSync(join(work, 'children')) : [];
  for (const pid of registered) {
    try {
      const child = Number(readFileSync(join(work, 'children', pid), 'utf8'));
      owners.add(Number(pid));
      owners.add(child);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const tree = processTree();
  for (const row of tree) {
    if (descendsFrom(row.pid, owners, tree)) groups.add(row.group);
  }
}

function groupAlive(pid) {
  return checked(tools.ps, ['-axo', 'pgid=,stat=']).split('\n').some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return group === String(pid) && !state.startsWith('Z');
  });
}

async function cleanup() {
  collectGroups();
  try {
    if (serverPort !== undefined) {
      const stop = start('pnpm', ['cli', 'server', 'stop'], { cwd: clone });
      let timeout;
      try {
        await Promise.race([stop.done, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out stopping the measured server')), 20_000);
        })]);
      }
      finally { clearTimeout(timeout); }
    }
  } finally {
    collectGroups();
    for (const pid of groups) signalGroup(pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while ([...groups].some(groupAlive) && Date.now() < deadline) await delay(30);
    for (const pid of groups) signalGroup(pid, 'SIGKILL');
    const killedDeadline = Date.now() + 5000;
    while ([...groups].some(groupAlive) && Date.now() < killedDeadline) await delay(30);
    if ([...groups].some(groupAlive)) throw new Error('Owned processes did not exit; temporary directory retained: ' + work);
    await Promise.allSettled(children);
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    abort.abort(new Error(`Interrupted by ${signal}`));
  });
}
try {
  const commit = preflight();
  prepare();
  await execute(commit);
} catch (error) {
  process.stderr.write(`${stage}: ${error.message}\n`);
  process.exitCode = process.exitCode || 1;
} finally {
  try { await cleanup(); }
  catch (error) { process.stderr.write(`cleanup: ${error.message}\n`); process.exitCode = 1; }
}
if (!process.exitCode) {
  process.stdout.write('| 段 | 秒 | 目標（秒） |\n|---|---:|---:|\n');
  for (const name of ['clone', 'install', 'AEC3 全体', 'AEC3 compile', 'Swift package resolve', 'bootstrap 全体', 'helper release build', 'サーバー起動', 'モデル取得', 'Chromium', 'Claude', 'ビルドの計', '初回の計']) {
    const target = name === 'ビルドの計' ? '140' : name === '初回の計' ? '240' : '';
    process.stdout.write(`| ${name} | ${timings.get(name).toFixed(3)} | ${target} |\n`);
  }
}
NODE
