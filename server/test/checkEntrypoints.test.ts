import { describe, expect, it } from "vitest";
import { findEntrypointViolations } from "../scripts/check-entrypoints.ts";
import type { SourceFile } from "../scripts/sourceFiles.ts";

const BENCH = ["bench/sessionStats.ts", "bench/sttAccuracy.ts", "bench/sttLatency.ts", "bench/sttReplay.ts", "bench/edgeJudge.ts", "bench/mapShape.ts", "bench/siblingJudge.ts"];
const BENCH_BODY = "NodeRuntime.runMain({ teardown: exitNaturally })(main);\n";

const validTree = (): SourceFile[] => [
  { path: "src/server.ts", content: "NodeRuntime.runMain(program);\n" },
  { path: "src/cli.ts", content: "NodeRuntime.runMain(program);\n" },
  ...BENCH.map((path) => ({ path, content: BENCH_BODY })),
  { path: "src/core/review.ts", content: "const r = Effect.runSync(x);\n" },
  { path: "src/other.ts", content: "export const a = 1;\n" },
];

const withFile = (path: string, content: string): SourceFile[] => [
  ...validTree().filter((f) => f.path !== path),
  { path, content },
];

const withExtra = (path: string, content: string): SourceFile[] => [...validTree(), { path, content }];

describe("findEntrypointViolations", () => {
  it("決まりを守っているツリーでは違反が空", () => {
    expect(findEntrypointViolations(validTree())).toEqual([]);
  });

  describe("runMain", () => {
    it("許していないファイルの runMain を、その行番号つきで報告する", () => {
      const violations = findEntrypointViolations(withExtra("src/other.ts", "const a = 1;\nNodeRuntime.runMain(x);\n"));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: "src/other.ts", line: 2 });
    });

    it("許したファイルが runMain を呼んでいないと、そのファイルを報告する", () => {
      const violations = findEntrypointViolations(withFile("src/cli.ts", "export const a = 1;\n"));
      expect(violations.map((v) => v.path)).toEqual(["src/cli.ts"]);
    });
  });

  describe("runPromise", () => {
    it.each(["Effect.runPromise(x)", "Effect.runPromiseExit(x)"])("%s を行番号つきで報告する", (call) => {
      const violations = findEntrypointViolations(withExtra("src/other.ts", `// header\n${call};\n`));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: "src/other.ts", line: 2 });
    });

    it("入口のファイルでも runPromise は違反", () => {
      const violations = findEntrypointViolations(
        withFile("src/server.ts", "NodeRuntime.runMain(program);\nEffect.runPromise(x);\n"),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: "src/server.ts", line: 2 });
    });
  });

  describe("runSync", () => {
    it.each(["Effect.runSync(x)", "Effect.runSyncExit(x)"])("許していないファイルの %s を行番号つきで報告する", (call) => {
      const violations = findEntrypointViolations(withExtra("src/other.ts", `${call};\n`));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: "src/other.ts", line: 1 });
    });

    it("core/review.ts が runSync を呼んでいないと、そのファイルを報告する", () => {
      const violations = findEntrypointViolations(withFile("src/core/review.ts", "export const a = 1;\n"));
      expect(violations.map((v) => v.path)).toEqual(["src/core/review.ts"]);
    });
  });

  describe("server.ts", () => {
    it("process.exit を行番号つきで報告する", () => {
      const violations = findEntrypointViolations(
        withFile("src/server.ts", "NodeRuntime.runMain(program);\nprocess.exit(1);\n"),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: "src/server.ts", line: 2 });
    });

    it("onExit の呼び出しを行番号つきで報告する", () => {
      const violations = findEntrypointViolations(
        withFile("src/server.ts", "NodeRuntime.runMain(program);\nconst t = onExit(x);\n"),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: "src/server.ts", line: 2 });
    });
  });

  describe.each(BENCH)("%s", (path) => {
    it("process.exit を行番号つきで報告する", () => {
      const violations = findEntrypointViolations(withFile(path, `${BENCH_BODY}process.exit(1);\n`));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path, line: 2 });
    });

    it("runMain に teardown: exitNaturally を渡していないと報告する", () => {
      const violations = findEntrypointViolations(withFile(path, "NodeRuntime.runMain({})(main);\n"));
      expect(violations.map((v) => v.path)).toEqual([path]);
    });

    it("runMain の引数が複数行でも teardown: exitNaturally を認める", () => {
      const violations = findEntrypointViolations(
        withFile(path, "NodeRuntime.runMain({\n  teardown: exitNaturally,\n})(main);\n"),
      );
      expect(violations).toEqual([]);
    });
  });

  describe("改行をまたぐ呼び出し", () => {
    it("process.exit と onExit は、括弧の前で改行されていても元の行番号で報告する", () => {
      const server = findEntrypointViolations(
        withFile("src/server.ts", "NodeRuntime.runMain(program);\nprocess.exit\n(1);\nonExit\n(x);\n"),
      );
      expect(server.map((v) => v.line)).toEqual([2, 4]);
      const bench = findEntrypointViolations(withFile("bench/sttLatency.ts", `${BENCH_BODY}process.exit\n(1);\n`));
      expect(bench).toHaveLength(1);
      expect(bench[0]).toMatchObject({ path: "bench/sttLatency.ts", line: 2 });
    });
  });

  describe("複数の違反の並び順", () => {
    it("runMain の呼び出し元 → runMain を呼んでいない → runSync の同じ 2 つ → runPromise → server → bench の各入口（process.exit → exitNaturally）の順に報告する", () => {
      const files: SourceFile[] = [
        { path: "src/server.ts", content: "NodeRuntime.runMain(program);\nprocess.exit(1);\nconst t = onExit(x);\n" },
        { path: "src/cli.ts", content: "export const a = 1;\n" },
        { path: "bench/sessionStats.ts", content: "NodeRuntime.runMain({})(main);\nprocess.exit(1);\n" },
        { path: "bench/mapShape.ts", content: BENCH_BODY },
        { path: "bench/sttAccuracy.ts", content: BENCH_BODY },
        { path: "bench/sttLatency.ts", content: BENCH_BODY },
        { path: "bench/sttReplay.ts", content: BENCH_BODY },
        { path: "bench/edgeJudge.ts", content: BENCH_BODY },
        { path: "bench/siblingJudge.ts", content: BENCH_BODY },
        { path: "src/other.ts", content: "NodeRuntime.runMain(x);\nEffect.runSync(y);\nEffect.runPromise(z);\n" },
      ];
      const violations = findEntrypointViolations(files);
      expect(violations.map((v) => [v.path, v.line, v.message.split(" ")[0]])).toEqual([
        ["src/other.ts", 1, "NodeRuntime.runMain"],
        ["src/cli.ts", undefined, "NodeRuntime.runMain"],
        ["src/other.ts", 2, "Effect.runSync（runSyncExit"],
        ["src/core/review.ts", undefined, "Effect.runSync（runSyncExit"],
        ["src/other.ts", 3, "Effect.runPromise（runPromiseExit"],
        ["src/server.ts", 2, "process.exit"],
        ["src/server.ts", 3, "teardown"],
        ["bench/sessionStats.ts", 2, "process.exit"],
        ["bench/sessionStats.ts", undefined, "runMain"],
      ]);
    });

    it("同じ種類の違反は、ファイルの渡した順、その中では行番号の順に報告する", () => {
      const violations = findEntrypointViolations([
        ...validTree(),
        { path: "src/b.ts", content: "Effect.runPromise(a);\nEffect.runPromiseExit(b);\n" },
        { path: "src/a.ts", content: "\nEffect.runPromise(c);\n" },
      ]);
      expect(violations.map((v) => [v.path, v.line])).toEqual([["src/b.ts", 1], ["src/b.ts", 2], ["src/a.ts", 2]]);
    });

    it("許可リストの入口が入力に無ければ、runMain を呼んでいない違反として許可リストの順に報告する", () => {
      const violations = findEntrypointViolations(validTree().filter((f) => f.path !== "src/server.ts" && f.path !== "bench/mapShape.ts"));
      expect(violations.map((v) => [v.path, v.line])).toEqual([["src/server.ts", undefined], ["bench/mapShape.ts", undefined]]);
    });
  });

  describe("コメント行", () => {
    it.each([
      "// Effect.runPromise(x)",
      "  // Effect.runSync(x)",
      "// NodeRuntime.runMain(x)",
      "// process.exit(1)",
      "// onExit(x)",
    ])("%s は違反にしない", (comment) => {
      expect(findEntrypointViolations(withExtra("src/other.ts", `${comment}\n`))).toEqual([]);
      expect(
        findEntrypointViolations(withFile("src/server.ts", `${comment}\nNodeRuntime.runMain(program);\n`)),
      ).toEqual([]);
      expect(findEntrypointViolations(withFile("bench/sttLatency.ts", `${comment}\n${BENCH_BODY}`))).toEqual([]);
    });

    it("コメント行にしか runMain が無い入口は、呼んでいないものとして報告する", () => {
      const violations = findEntrypointViolations(withFile("src/cli.ts", "// NodeRuntime.runMain(program);\n"));
      expect(violations.map((v) => v.path)).toEqual(["src/cli.ts"]);
    });

    it("コメントを除く前の行番号で報告する", () => {
      const violations = findEntrypointViolations(withExtra("src/other.ts", "// a\n// b\nEffect.runPromise(x);\n"));
      expect(violations[0]).toMatchObject({ path: "src/other.ts", line: 3 });
    });
  });
});
