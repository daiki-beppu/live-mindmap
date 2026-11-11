import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jobLines } from "./fixtures/checkWorkflow.ts";

const root = resolve(import.meta.dirname, "../..");
const library = ".deps/webrtc-apm/lib/libwebrtc-audio-processing-2.a";

function withBuildFixture(check: (fixture: ReturnType<typeof buildFixture>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "build-apm-"));
  try {
    check(buildFixture(join(dir, "helper")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildFixture(dir: string) {
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const path of [bin, home, join(dir, "scripts"), dirname(join(dir, library))]) {
    mkdirSync(path, { recursive: true });
  }
  copyFileSync(join(root, "helper/scripts/build-webrtc-apm.sh"), join(dir, "scripts/build-webrtc-apm.sh"));
  copyFileSync(join(root, "helper/package.json"), join(dir, "package.json"));
  writeFileSync(join(home, "empty.npmrc"), "");
  writeFileSync(join(bin, "swift"), `#!/bin/bash
set -eu
case " $* " in
  *" dump-package "*)
    if [ -f "$APM_TEST_ROOT/manifest-error" ]; then
      echo "invalid manifest" >&2
      exit 1
    fi
    cat "$APM_TEST_ROOT/manifest.json"
    ;;
  *" build "*) cat "$APM_TEST_ROOT/${library}" >> "$APM_TEST_ROOT/links" ;;
  *) echo "unexpected swift command: $*" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/bash
set -eu
case " $* " in
  *" rev-parse "*) exit 1 ;;
  *" init "*|*" fetch "*|*" checkout "*) exit 0 ;;
  *) echo "unexpected git command: $*" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "uvx"), `#!/bin/bash
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    setup)
      mkdir -p "$2" "$3/subprojects/abseil-cpp-fixture"
      exit 0
      ;;
    compile)
      printf '%s\\n' "$MACOSX_DEPLOYMENT_TARGET" >> "$APM_TEST_ROOT/compiles"
      if [ -f "$APM_TEST_ROOT/fail-compile" ]; then exit 37; fi
      printf '%s\\n' "$MACOSX_DEPLOYMENT_TARGET" > "$3/libwebrtc-audio-processing-2.a"
      exit 0
      ;;
  esac
  shift
done
echo "unexpected uvx command" >&2
exit 99
`, { mode: 0o755 });
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: home,
    npm_config_userconfig: join(home, "empty.npmrc"),
    npm_config_globalconfig: join(home, "empty.npmrc"),
    PNPM_CONFIG_OFFLINE: "true",
    APM_TEST_ROOT: dir,
  };
  return {
    manifest(platform: string | null) {
      writeFileSync(join(dir, "Package.swift"), `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "26.0", platforms: [${platform === null ? "" : `.macOS("${platform}")`}])
`);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({
        name: "26.0",
        platforms: platform === null ? [] : [{ options: [], platformName: "macos", version: platform }],
      }));
    },
    breakManifest() {
      writeFileSync(join(dir, "Package.swift"), "invalid swift manifest\n");
      writeFileSync(join(dir, "manifest-error"), "");
    },
    seedLibrary() { writeFileSync(join(dir, library), "unverified\n"); },
    failCompile() { writeFileSync(join(dir, "fail-compile"), ""); },
    allowCompile() { rmSync(join(dir, "fail-compile")); },
    compiledTargets() {
      return existsSync(join(dir, "compiles")) ? readFileSync(join(dir, "compiles"), "utf8").trim().split("\n") : [];
    },
    installedTarget() { return readFileSync(join(dir, library), "utf8").trim(); },
    runWorkflow(inputs: CacheInputs) {
      return runApmWorkflow({ dir, env, inputs });
    },
    runScript() {
      return spawnSync("bash", ["scripts/build-webrtc-apm.sh"], { cwd: dir, env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    },
    runPackageScript() {
      const pnpm = process.env.npm_execpath;
      if (!pnpm) throw new Error("Run through the project's pnpm test script");
      const isJavaScript = /\.[cm]?js$/.test(pnpm);
      const command = isJavaScript ? process.execPath : pnpm;
      const args = isJavaScript ? [pnpm, "run", "build-apm"] : ["run", "build-apm"];
      return spawnSync(command, args, { cwd: dir, env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    },
  };
}

function expectSuccess(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
}

function expectFailure(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stdout)).not.toBeNull();
  expect(result.status, String(result.stdout)).not.toBe(0);
}

type CacheInputs = { "restore-caches": boolean; "save-shared-caches": boolean };

const helperSteps = jobLines("helper").join("\n").split(/^      - /m).slice(1).map((block) => block.split("\n"));
const field = (step: string[], name: string) => step.map((line) => line.trim())
  .find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
const requiredField = (step: string[], name: string): string => {
  const value = field(step, name);
  if (value === undefined) throw new Error(`Missing workflow field: ${name}`);
  return value;
};

function apmCacheKey(step: string[], workspace: string): string {
  return requiredField(step, "key").replace(/\$\{\{ (.*?) \}\}/g, (_, expression: string) => {
    if (expression === "runner.os") return "macOS";
    const args = expression.match(/^hashFiles\((.*)\)$/)?.[1];
    if (args === undefined) throw new Error(`Unsupported APM key expression: ${expression}`);
    const paths = [...args.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    if (paths.length === 0) throw new Error(`Missing APM hash inputs: ${expression}`);
    const hash = createHash("sha256");
    for (const path of paths.toSorted()) {
      hash.update(createHash("sha256").update(readFileSync(join(workspace, path))).digest());
    }
    return hash.digest("hex");
  });
}

function apmStepEnabled(step: string[], inputs: CacheInputs, hits: Map<string, string>): boolean {
  const condition = field(step, "if");
  if (condition === undefined) return true;
  return condition.split(" && ").every((term) => {
    const input = term.match(/^(!?)inputs\.(restore-caches|save-shared-caches)$/);
    if (input) {
      const value = input[2] === "restore-caches" ? inputs["restore-caches"] : inputs["save-shared-caches"];
      return input[1] === "!" ? !value : value;
    }
    const hit = term.match(/^steps\.([\w-]+)\.outputs\.cache-hit != 'true'$/);
    if (hit) return hits.get(hit[1]!) !== "true";
    throw new Error(`Unsupported APM step condition: ${term}`);
  });
}

function isApmStep(step: string[]): boolean {
  const run = field(step, "run");
  return field(step, "path") === "helper/.deps/webrtc-apm"
    || field(step, "uses")?.startsWith("astral-sh/setup-uv@") === true
    || run === "bash helper/scripts/build-webrtc-apm.sh"
    || run?.startsWith("swift build ") === true;
}

function runApmWorkflow({ dir, env, inputs }: { dir: string; env: NodeJS.ProcessEnv; inputs: CacheInputs }) {
  const workspace = dirname(dir);
  const hits = new Map<string, string>();
  const restored: string[] = [];
  const saved: string[] = [];
  const postSave: string[][] = [];
  const cachePath = (step: string[]) => join(workspace, "cache", apmCacheKey(step, workspace));
  const save = (step: string[]) => {
    const cache = cachePath(step);
    if (!existsSync(cache)) cpSync(join(workspace, requiredField(step, "path")), cache, { recursive: true });
    saved.push(apmCacheKey(step, workspace));
  };
  const restoreOrSave = (step: string[]) => {
    const uses = requiredField(step, "uses");
    if (uses.startsWith("actions/cache/save@")) {
      save(step);
      return;
    }
    const cache = cachePath(step);
    const hit = existsSync(cache);
    hits.set(requiredField(step, "id"), String(hit));
    if (hit) {
      cpSync(cache, join(workspace, requiredField(step, "path")), { recursive: true });
      restored.push(apmCacheKey(step, workspace));
    } else if (uses.startsWith("actions/cache@")) {
      postSave.push(step);
    }
  };
  rmSync(join(dir, ".deps/webrtc-apm"), { recursive: true, force: true });
  writeFileSync(join(dir, "links"), "");
  let status: number | null = 0;
  let output = "";
  let uvInstalled = false;
  for (const step of helperSteps.filter(isApmStep)) {
    const uses = field(step, "uses");
    const isCache = field(step, "path") === "helper/.deps/webrtc-apm";
    const isUv = uses?.startsWith("astral-sh/setup-uv@");
    if (!apmStepEnabled(step, inputs, hits)) continue;
    if (isCache) {
      restoreOrSave(step);
    } else if (isUv) {
      uvInstalled = true;
    } else {
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", requiredField(step, "run")], {
        cwd: join(workspace, field(step, "working-directory") ?? "."), env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
      });
      expect(result.error).toBeUndefined();
      output += `${result.stdout}${result.stderr}`;
      status = result.status;
      if (status !== 0) break;
    }
  }
  if (status === 0) for (const step of postSave) save(step);
  return { status, output, restored, saved, uvInstalled, linked: readFileSync(join(dir, "links"), "utf8").trim().split("\n").filter(Boolean) };
}

const prInputs: CacheInputs = { "restore-caches": true, "save-shared-caches": true };
const nightlyInputs: CacheInputs = { "restore-caches": true, "save-shared-caches": false };

describe("CI の APM キャッシュと配備先", () => {
  it.each([prInputs, nightlyInputs])("同じ manifest は再利用し、配備先だけ変更したら新版をリンク入力にする (%j)", (inputs) => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      const seed = fixture.runWorkflow(prInputs);
      expect(seed.status, seed.output).toBe(0);
      expect(seed.saved).toHaveLength(1);
      expect(seed.linked).toEqual(["26.0"]);
      const same = fixture.runWorkflow(inputs);
      expect(same.status).toBe(0);
      expect(same.restored).toEqual(seed.saved);
      expect(same.uvInstalled).toBe(false);
      expect(same.linked).toEqual(["26.0"]);
      expect(fixture.compiledTargets()).toEqual(["26.0"]);
      fixture.manifest("27.0");
      const changed = fixture.runWorkflow(inputs);
      expect(changed.status).toBe(0);
      expect(changed.restored).toEqual([]);
      expect(changed.uvInstalled).toBe(true);
      expect(changed.linked).toEqual(["27.0"]);
      expect(fixture.compiledTargets()).toEqual(["26.0", "27.0"]);
      expect(changed.saved).toHaveLength(inputs["save-shared-caches"] ? 1 : 0);
    });
  });

  it("保存専用のキーは両復元経路と一致し、manifest の配備先変更で変わる", () => {
    withBuildFixture((fixture) => {
      const saves = ["26.0", "27.0"].map((platform) => {
        fixture.manifest(platform);
        const saved = fixture.runWorkflow({ "restore-caches": false, "save-shared-caches": true });
        expect(saved.status).toBe(0);
        expect(saved.restored).toEqual([]);
        expect(saved.uvInstalled).toBe(true);
        expect(saved.linked).toEqual([platform]);
        expect(saved.saved).toHaveLength(1);
        for (const inputs of [prInputs, nightlyInputs]) {
          const restored = fixture.runWorkflow(inputs);
          expect(restored.status).toBe(0);
          expect(restored.restored).toEqual(saved.saved);
          expect(restored.linked).toEqual([platform]);
        }
        return saved.saved[0];
      });
      expect(saves[0]).not.toBe(saves[1]);
      expect(fixture.compiledTargets()).toEqual(["26.0", "27.0"]);
    });
  });

  it("復元も保存もしない Weekly は既存キャッシュがあっても現在版をビルドする", () => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      expect(fixture.runWorkflow(prInputs).status).toBe(0);
      const weekly = fixture.runWorkflow({ "restore-caches": false, "save-shared-caches": false });
      expect(weekly.status).toBe(0);
      expect(weekly.restored).toEqual([]);
      expect(weekly.saved).toEqual([]);
      expect(weekly.uvInstalled).toBe(true);
      expect(weekly.linked).toEqual(["26.0"]);
      expect(fixture.compiledTargets()).toEqual(["26.0", "26.0"]);
    });
  });

  it.each([prInputs, nightlyInputs, { "restore-caches": false, "save-shared-caches": true }])("新版ビルドの失敗後はリンクも成功保存もしない (%j)", (inputs) => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      const seed = fixture.runWorkflow(prInputs);
      expect(seed.status).toBe(0);
      expect(seed.linked).toEqual(["26.0"]);
      expect(seed.saved).toHaveLength(1);
      fixture.manifest("27.0");
      fixture.failCompile();
      const failed = fixture.runWorkflow(inputs);
      expect(failed.status).toBe(37);
      expect(failed.restored).toEqual([]);
      expect(failed.linked).toEqual([]);
      expect(failed.saved).toEqual([]);
      fixture.allowCompile();
      const retry = fixture.runWorkflow(inputs);
      expect(retry.status).toBe(0);
      expect(retry.restored).toEqual([]);
      expect(retry.linked).toEqual(["27.0"]);
      expect(fixture.compiledTargets()).toEqual(["26.0", "27.0", "27.0"]);
    });
  });
});

describe("APM の macOS 配備先", () => {
  it("パッケージ名ではなく macOS の宣言値をビルドと配置済みライブラリに反映する", () => {
    withBuildFixture((fixture) => {
      fixture.manifest("27.0");
      expectSuccess(fixture.runScript());
      expect(fixture.installedTarget()).toBe("27.0");
      expectSuccess(fixture.runScript());
      expect(fixture.compiledTargets()).toEqual(["27.0"]);
      expect(fixture.installedTarget()).toBe("27.0");
    });
  });

  it("build-apm は同じ版を再利用し、同じキャッシュで版を上げたら既存ライブラリを作り直す", () => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      expectSuccess(fixture.runPackageScript());
      expect(fixture.installedTarget()).toBe("26.0");
      expectSuccess(fixture.runPackageScript());
      expect(fixture.compiledTargets()).toEqual(["26.0"]);
      fixture.manifest("27.0");
      expectSuccess(fixture.runPackageScript());
      expect(fixture.compiledTargets()).toEqual(["26.0", "27.0"]);
      expect(fixture.installedTarget()).toBe("27.0");
    });
  });

  it.each(["missing", "empty"])("配備先が %s なら既存ライブラリがあっても失敗し、ビルドを始めない", (kind) => {
    withBuildFixture((fixture) => {
      fixture.manifest(kind === "missing" ? null : "");
      fixture.seedLibrary();
      expectFailure(fixture.runScript());
      expect(fixture.compiledTargets()).toEqual([]);
      expect(fixture.installedTarget()).toBe("unverified");
    });
  });

  it("成功したキャッシュがあっても manifest の評価失敗を隠さない", () => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      expectSuccess(fixture.runScript());
      fixture.breakManifest();
      expectFailure(fixture.runScript());
      expect(fixture.compiledTargets()).toEqual(["26.0"]);
      expect(fixture.installedTarget()).toBe("26.0");
    });
  });

  it("成功印がないライブラリは再利用せずビルドする", () => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      fixture.seedLibrary();
      expectSuccess(fixture.runScript());
      expect(fixture.compiledTargets()).toEqual(["26.0"]);
      expect(fixture.installedTarget()).toBe("26.0");
    });
  });

  it("版変更後のビルド失敗で古い成功印を無効化し、元の版に戻しても再ビルドする", () => {
    withBuildFixture((fixture) => {
      fixture.manifest("26.0");
      expectSuccess(fixture.runScript());
      fixture.manifest("27.0");
      fixture.failCompile();
      expectFailure(fixture.runScript());
      fixture.allowCompile();
      fixture.manifest("26.0");
      expectSuccess(fixture.runScript());
      expect(fixture.compiledTargets()).toEqual(["26.0", "27.0", "26.0"]);
      expect(fixture.installedTarget()).toBe("26.0");
    });
  });
});
