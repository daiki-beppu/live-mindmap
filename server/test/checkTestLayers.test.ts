import { describe, expect, it } from "vitest";
import { findTestLayerViolations, type SourceFile } from "../scripts/check-test-layers.ts";

// この unit 自身も点検にかかる。指定子の字面を import の形のまま書かないよう、入力は変数から組み立てる。
const file = (path: string, content: string): SourceFile[] => [{ path, content }];
const UNIT = "test/a.test.ts";

const fromImport = (spec: string) => `import { x } from "${spec}";\n`;
const sideEffectImport = (spec: string) => `import "${spec}";\n`;
const reExport = (spec: string) => `export { x } from "${spec}";\n`;
const dynamicImport = (spec: string) => `const m = await import("${spec}");\n`;

describe("findTestLayerViolations", () => {
  describe("unit が本物の資源を import していると報告する", () => {
    it.each(["node:child_process", "node:fs", "node:fs/promises", "node:net", "node:http", "ws", "playwright"])(
      "%s の import を、ファイルと行番号と指定子つきで報告する",
      (spec) => {
        const violations = findTestLayerViolations(file(UNIT, `const a = 1;\n${fromImport(spec)}`));
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ path: UNIT, line: 2 });
        expect(violations[0]?.message).toContain(spec);
      },
    );

    it.each(["fs", "fs/promises", "child_process", "net", "http"])("node: の付かない %s も同じに扱う", (spec) => {
      const violations = findTestLayerViolations(file(UNIT, fromImport(spec)));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 1 });
    });

    it("tsx の unit も点検する", () => {
      const violations = findTestLayerViolations(file("test/a.test.tsx", fromImport("node:fs")));
      expect(violations.map((v) => v.path)).toEqual(["test/a.test.tsx"]);
    });

    it("副作用だけの import を報告する", () => {
      const violations = findTestLayerViolations(file(UNIT, sideEffectImport("ws")));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 1 });
    });

    it("export from を報告する", () => {
      const violations = findTestLayerViolations(file(UNIT, reExport("node:net")));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 1 });
    });

    it("動的 import を報告する", () => {
      const violations = findTestLayerViolations(file(UNIT, `const a = 1;\n${dynamicImport("node:child_process")}`));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 2 });
    });

    it("式の位置の typeof import は実行時に評価されるので報告する", () => {
      const spec = "node:fs";
      const content = `const a = 1;\nconst kind = typeof import("${spec}");\n`;
      const violations = findTestLayerViolations(file(UNIT, content));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 2 });
      expect(violations[0]?.message).toContain(spec);
    });

    it("比較式の < の後ろの typeof import は型引数ではないので報告する", () => {
      const spec = "node:fs";
      const content = `const a = 1;\nconst kind = "a" < typeof import("${spec}");\n`;
      const violations = findTestLayerViolations(file(UNIT, content));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 2 });
      expect(violations[0]?.message).toContain(spec);
    });

    it("< と > で挟まれていても、> の後に式が続けば報告する", () => {
      const spec = "node:fs";
      const content = `const kind = a < typeof import("${spec}") > b;\n`;
      const violations = findTestLayerViolations(file(UNIT, content));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ line: 1 });
    });

    it("オブジェクトリテラルと三項演算子の : の後の typeof import は報告する", () => {
      const spec = "node:fs";
      const content = `const o = f(a, { b, fs: typeof import("${spec}") });\nconst k = c ? a : typeof import("${spec}");\n`;
      const violations = findTestLayerViolations(file(UNIT, content));
      expect(violations.map((v) => v.line)).toEqual([1, 2]);
    });

    it("複数行の import は、指定子のある行の行番号で報告する", () => {
      const content = `import {\n  a,\n  b,\n} from "${"playwright"}";\n`;
      const violations = findTestLayerViolations(file(UNIT, content));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ path: UNIT, line: 4 });
    });

    it("違反が複数あれば、全部を報告する", () => {
      const content = `${fromImport("node:fs")}${sideEffectImport("ws")}`;
      const violations = findTestLayerViolations(file(UNIT, content));
      expect(violations.map((v) => v.line)).toEqual([1, 2]);
    });

    it("複数のファイルにまたがる違反を、それぞれのパスで報告する", () => {
      const violations = findTestLayerViolations([
        { path: "test/a.test.ts", content: fromImport("node:fs") },
        { path: "test/b.test.ts", content: fromImport("node:path") },
        { path: "test/c.test.ts", content: fromImport("node:net") },
      ]);
      expect(violations.map((v) => v.path)).toEqual(["test/a.test.ts", "test/c.test.ts"]);
    });
  });

  describe("違反にしないもの", () => {
    it("入力が空なら違反も空", () => {
      expect(findTestLayerViolations([])).toEqual([]);
    });

    it("型だけの import は実行時に消えるので違反にしない", () => {
      const spec = "node:net";
      const content = `import type { Server } from "${spec}";\nexport type { Socket } from "${spec}";\n`;
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it("型引数の typeof import と vi.mock の対象の指定は違反にしない", () => {
      const spec = "node:net";
      const content = [
        `vi.mock("${spec}", async (importOriginal) => ({`,
        `  ...(await importOriginal<typeof import("${spec}")>()),`,
        "}));",
        "",
      ].join("\n");
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it.each([
      (spec: string) => `type Fs = typeof import("${spec}");\n`,
      (spec: string) => `const fs: typeof import("${spec}") = real;\n`,
      (spec: string) => `const fs = real as typeof import("${spec}");\n`,
    ])("型エイリアス・型注釈・as の typeof import は違反にしない (%#)", (build) => {
      expect(findTestLayerViolations(file(UNIT, build("node:fs")))).toEqual([]);
    });

    it("パラメータの型注釈の typeof import は違反にしない", () => {
      const spec = "node:fs";
      const content = [
        `function f(fs: typeof import("${spec}")) {}`,
        `const g = (a: Map<string, number>, fs?: typeof import("${spec}")) => fs;`,
        "",
      ].join("\n");
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it("型注釈の中の型引数と satisfies の typeof import は違反にしない", () => {
      const spec = "node:fs";
      const content = [
        `const p: Promise<typeof import("${spec}")> = real;`,
        `const fs = real satisfies typeof import("${spec}");`,
        "",
      ].join("\n");
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it.each([
      (spec: string) => `function f(): typeof import("${spec}") { return real; }\n`,
      (spec: string) => `type U = A | typeof import("${spec}");\n`,
      (spec: string) => `interface I { m: typeof import("${spec}") }\n`,
      (spec: string) => `const m: Map<string, Promise<typeof import("${spec}")>> = real;\n`,
      (spec: string) => `const { a }: typeof import("${spec}") = real;\n`,
      (spec: string) => `type X<T> = typeof import("${spec}");\n`,
    ])("構文によらず、型の位置の typeof import は違反にしない (%#)", (build) => {
      expect(findTestLayerViolations(file(UNIT, build("node:fs")))).toEqual([]);
    });

    it("同じ字面でも、三項演算子とビット演算の式の位置なら報告する", () => {
      const spec = "node:fs";
      const content = `const k = c ? (a) : typeof import("${spec}");\nconst b = a | typeof import("${spec}");\n`;
      expect(findTestLayerViolations(file(UNIT, content)).map((v) => v.line)).toEqual([1, 2]);
    });

    it("JSX を含む tsx の unit で、実行時の import だけを報告する", () => {
      const content = `const el = <div>{x}</div>;\nconst m = await orig<typeof import("${"node:net"}")>();\n${fromImport("node:fs")}`;
      const violations = findTestLayerViolations(file("test/a.test.tsx", content));
      expect(violations.map((v) => [v.path, v.line])).toEqual([["test/a.test.tsx", 3]]);
    });

    it("多バイト文字の行の後でも、行番号がずれない", () => {
      const content = `// 本物の資源を使う前に日本語の説明を二十文字以上書いておく行です\n${fromImport("node:fs")}const a = 1;\n`;
      expect(findTestLayerViolations(file(UNIT, content)).map((v) => v.line)).toEqual([2]);
    });

    it("構文解析できない unit は、違反なしとして通さず例外にする", () => {
      expect(() => findTestLayerViolations(file(UNIT, "const = ;\n"))).toThrow(UNIT);
    });

    it("コメント行の import は違反にしない", () => {
      const content = `// ${fromImport("node:fs")}`;
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it("本物の資源でない module は違反にしない", () => {
      const content = `${fromImport("node:path")}${fromImport("node:events")}${fromImport("vitest")}`;
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it("指定子が資源の名前で始まるだけの別 module は違反にしない", () => {
      const content = `${fromImport("wsl-path")}${fromImport("./fs")}${fromImport("netmask")}`;
      expect(findTestLayerViolations(file(UNIT, content))).toEqual([]);
    });

    it.each(["test/a.it.test.ts", "test/a.heavy.test.ts", "test/setup.ts", "test/benchRun.ts", "test/fixtures/x.ts"])(
      "unit でない %s は本物の資源を import していても違反にしない",
      (path) => {
        const content = `${fromImport("node:fs")}${sideEffectImport("ws")}${dynamicImport("playwright")}`;
        expect(findTestLayerViolations(file(path, content))).toEqual([]);
      },
    );

    it.each(["test/a.it.test.tsx", "test/a.heavy.test.tsx"])("%s も unit ではない", (path) => {
      expect(findTestLayerViolations(file(path, fromImport("node:fs")))).toEqual([]);
    });
  });
});
