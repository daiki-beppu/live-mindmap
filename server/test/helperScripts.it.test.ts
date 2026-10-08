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

// Issue #550: Suite の型名の接尾辞（…Tests＝unit、…ITTests＝軽い IT、…HeavyTests＝重い IT）で層を選ぶ script。
// どの層も typecheck のビルドを 1 回だけ使い、swift test は 1 回で --skip-build 付きにする
const testScripts = ["test", "test:it", "test:it:heavy", "test:it:all"];

// テスト ID は `<ターゲット>.<型名>/<関数名>()`。層は型名の接尾辞で決まる
const testIds = {
  unit: ["HelperCoreTests.StreamSplitTests/split()", "SttBenchTests.SynthTimelineTests/build()"],
  it: ["HelperCoreTests.RelayITTests/relay()", "SttBenchTests.BuildMicrophoneITTests/build()"],
  heavy: [
    "HelperCoreTests.EchoCancellerHeavyTests/cancel()",
    "HelperCoreTests.SpeechAnalyzerTranscriberHeavyTests/transcribe()",
  ],
};
const layers: Record<string, string[]> = {
  test: ["unit"],
  "test:it": ["it"],
  "test:it:heavy": ["heavy"],
  "test:it:all": ["it", "heavy"],
};

// swift test の --skip / --filter を 1 つだけ取り出し、テスト ID が実行されるかを返す述語にする
const selection = (name: string): ((id: string) => boolean) => {
  const options = [...swiftTest(name)[0]!.matchAll(/--(skip|filter)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g)];
  if (options.length !== 1) {
    throw new Error(`${name}: --skip / --filter はちょうど 1 回必要だが ${options.length} 回ある`);
  }
  const [, kind, single, double, bare] = options[0]!;
  const pattern = new RegExp(single ?? double ?? bare!);
  return kind === "skip" ? (id) => !pattern.test(id) : (id) => pattern.test(id);
};

describe("helper の typecheck と test のビルド", () => {
  it("typecheck は swift build --build-tests でテストターゲットまでビルドする", () => {
    const [build, ...rest] = swiftBuild("typecheck");
    expect(rest).toEqual([]);
    expect(build).toMatch(/^swift build\b.*--build-tests/);
  });

  it("Command Line Tools だけの環境でマクロが解決できるよう、ビルドの引数に testing の plugin-path を含める", () => {
    expect(swiftBuild("typecheck")[0]).toContain(
      "-Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing",
    );
  });

  it("AEC3 のライブラリを用意する build-apm を、typecheck と各テスト script がビルドより先に呼ぶ", () => {
    expect(scripts["build-apm"]).toContain("libwebrtc-audio-processing-2.a");
    for (const name of ["typecheck", ...testScripts]) {
      const steps = expand(name);
      expect(steps[0]).toBe(scripts["build-apm"]);
      expect(steps.findIndex((c) => c.startsWith("swift build"))).toBeGreaterThan(0);
    }
  });

  it("--build-system native を使わない", () => {
    for (const name of ["typecheck", ...testScripts]) {
      for (const command of swiftCommands(name)) {
        expect(command).not.toMatch(/--build-system(?:\s+|=)native\b/);
      }
    }
  });
});

describe("helper の層ごとの test script", () => {
  it.each(testScripts)("%s は typecheck と同じ引数の swift build を 1 回だけ、swift test より先に呼ぶ", (name) => {
    expect(swiftBuild(name)).toEqual(swiftBuild("typecheck"));
    expect(swiftBuild(name)).toHaveLength(1);
    const order = swiftCommands(name);
    expect(order.findIndex((c) => c.startsWith("swift build"))).toBe(0);
    expect(order.findIndex((c) => c.startsWith("swift test"))).toBe(1);
  });

  it.each(testScripts)("%s は swift test を 1 回、--skip-build 付きで呼ぶ", (name) => {
    expect(swiftTest(name)).toHaveLength(1);
    expect(swiftTest(name)[0]).toMatch(/^swift test\b.*--skip-build/);
  });

  // 層の選択は表記ではなく結果で確かめる: script の --skip / --filter を取り出し、代表的なテスト ID が選ばれるかを見る
  it.each(Object.keys(layers))("%s は定義どおりの層だけを選ぶ", (name) => {
    const selects = selection(name);
    for (const [layer, ids] of Object.entries(testIds)) {
      for (const id of ids) {
        expect(selects(id), `${name}: ${id} (${layer})`).toBe(layers[name]!.includes(layer));
      }
    }
  });

  it("test は --skip、他の script は --filter で選ぶ", () => {
    expect(swiftTest("test")[0]).toContain("--skip ");
    for (const name of ["test:it", "test:it:heavy", "test:it:all"]) {
      expect(swiftTest(name)[0]).toContain("--filter ");
    }
  });
});
