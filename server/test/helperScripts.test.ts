import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #549: helper の typecheck と test は、同じ引数の `swift build --build-tests` を先に呼び、テストは `swift test --skip-build` で回す。
// 引数が違うと別のビルド設定になり、`pnpm typecheck` と `cd helper && pnpm test` を交互に回すたびに 5〜10 秒の作り直しが起きる。
// helper/package.json の script を読み、`pnpm <script>` の参照を展開して、実際に走る swift コマンドの列を確かめる
const scripts = (
  JSON.parse(readFileSync(join(import.meta.dirname, "../../helper/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

const expand = (name: string): string[] =>
  (scripts[name] ?? "").split("&&").flatMap((part) => {
    const command = part.trim();
    const ref = /^pnpm (?:run )?([\w-]+)$/.exec(command);
    return ref ? expand(ref[1]!) : [command];
  });

const swiftCommands = (name: string): string[] => expand(name).filter((c) => c.startsWith("swift "));
const swiftBuild = (name: string): string[] => swiftCommands(name).filter((c) => c.startsWith("swift build"));
const swiftTest = (name: string): string[] => swiftCommands(name).filter((c) => c.startsWith("swift test"));

describe("helper の typecheck と test のビルド", () => {
  it("typecheck は swift build --build-tests でテストターゲットまでビルドする", () => {
    const [build, ...rest] = swiftBuild("typecheck");
    expect(rest).toEqual([]);
    expect(build).toMatch(/^swift build\b.*--build-tests/);
  });

  it("test が先に呼ぶ swift build の引数は typecheck と完全に同じ", () => {
    expect(swiftBuild("test")).toEqual(swiftBuild("typecheck"));
    expect(swiftBuild("test")).toHaveLength(1);
  });

  it("test は swift test --skip-build で回し、swift test 自身がビルドし直さない", () => {
    expect(swiftTest("test")).toHaveLength(1);
    expect(swiftTest("test")[0]).toMatch(/^swift test\b.*--skip-build/);
  });

  it("test では swift build が swift test より先に走る", () => {
    const order = swiftCommands("test");
    expect(order.findIndex((c) => c.startsWith("swift build"))).toBe(0);
    expect(order.findIndex((c) => c.startsWith("swift test"))).toBe(1);
  });

  it("Command Line Tools だけの環境でマクロが解決できるよう、ビルドの引数に testing の plugin-path を含める", () => {
    expect(swiftBuild("typecheck")[0]).toContain(
      "-Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing",
    );
  });

  it("AEC3 のライブラリを用意する build-apm を、両方の script がビルドより先に呼ぶ", () => {
    expect(scripts["build-apm"]).toContain("libwebrtc-audio-processing-2.a");
    for (const name of ["typecheck", "test"]) {
      const steps = expand(name);
      expect(steps[0]).toBe(scripts["build-apm"]);
      expect(steps.findIndex((c) => c.startsWith("swift build"))).toBeGreaterThan(0);
    }
  });

  it("--build-system native を使わない", () => {
    for (const name of ["typecheck", "test"]) {
      for (const command of swiftCommands(name)) {
        expect(command).not.toMatch(/--build-system(?:\s+|=)native\b/);
      }
    }
  });
});
