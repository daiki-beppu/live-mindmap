import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor, type ESTree } from "vite";

// Issue #557: テストの層はファイル名の接尾辞で決まる（foo.test.ts = unit、foo.it.test.ts = 軽い IT、foo.heavy.test.ts = 重い IT）。
// unit は偽物の Layer で組み、本物の資源（子プロセス・ファイル・ソケット・WebSocket・ブラウザ）を直接 import しない。
// 本物の資源が要るテストは .it.test.ts か .heavy.test.ts へ移す。import の推移はたどらない（偽物の Layer 経由や補助ファイル経由の利用は拾わない）。
export type SourceFile = { path: string; content: string };
export type Violation = { path: string; line: number; message: string };

// node: の付く書き方も付かない書き方も、同じ資源として扱う
const REAL_RESOURCES = new Set(["child_process", "fs", "fs/promises", "http", "net", "ws", "playwright", "playwright-core"]);

const isUnit = (path: string): boolean =>
  /\.test\.tsx?$/.test(path) && !path.includes(".it.test.") && !path.includes(".heavy.test.");

// 型の位置の `typeof import("x")` と式の位置のものは字面では区別できない（`): typeof import(…)` は返り値の型注釈にも三項演算子にも現れる）ので、
// 構文木で実行時に評価される import だけを集める。型の位置のものは別種のノード（TSImportType）になるので集まらない。`vi.mock("x", …)` も import 構文ではない
const specifiersIn = (path: string, content: string): Array<{ spec: string; line: number }> => {
  const { program, errors } = parseSync(path, content, { sourceType: "module" });
  const failure = errors.find((e) => e.severity === "Error");
  if (failure) throw new Error(`${path}: 構文解析できない: ${failure.message}`);

  const found: Array<{ spec: string; line: number }> = [];
  const collect = (source: ESTree.StringLiteral | ESTree.Expression | null) => {
    if (source?.type !== "Literal" || typeof source.value !== "string") return;
    found.push({ spec: source.value, line: content.slice(0, source.start).split("\n").length });
  };
  new Visitor({
    ImportDeclaration: (node) => {
      if (node.importKind !== "type") collect(node.source);
    },
    ExportNamedDeclaration: (node) => {
      if (node.exportKind !== "type") collect(node.source);
    },
    ExportAllDeclaration: (node) => {
      if (node.exportKind !== "type") collect(node.source);
    },
    ImportExpression: (node) => collect(node.source),
  }).visit(program);
  return found;
};

export const findTestLayerViolations = (files: ReadonlyArray<SourceFile>): Violation[] =>
  files
    .filter((f) => isUnit(f.path))
    .flatMap(({ path, content }) =>
      specifiersIn(path, content)
        .filter(({ spec }) => REAL_RESOURCES.has(spec.replace(/^node:/, "")))
        .map(({ spec, line }) => ({
          path,
          line,
          message: `unit が本物の資源 "${spec}" を import している。.it.test.ts か .heavy.test.ts へ移す`,
        })),
    )
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

const sources = (root: string, dir: string): SourceFile[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => {
      const path = join(dir, f);
      return { path, content: readFileSync(join(root, path), "utf8") };
    });

if (import.meta.main) {
  // server と web の typecheck から同じ script を呼ぶ。pnpm の script はパッケージのディレクトリで動くので、
  // import.meta.dirname（常に server/）ではなく cwd の test/ を点検する
  const violations = findTestLayerViolations(sources(process.cwd(), "test"));
  for (const v of violations) {
    console.error(`${v.path}:${v.line}: ${v.message}`);
  }
  if (violations.length > 0) process.exitCode = 1;
}
