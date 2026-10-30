import { parseSync, Visitor, type ESTree } from "vite";
import { readSources, reportViolations, type SourceFile } from "./sourceFiles.ts";

export type Violation = { path: string; line: number; message: string };

const REAL_RESOURCES = new Set(["child_process", "fs", "fs/promises", "http", "net", "ws", "playwright", "playwright-core", "@anthropic-ai/claude-agent-sdk"]);

const isUnit = (path: string): boolean =>
  /\.test\.tsx?$/.test(path) && !path.includes(".it.test.") && !path.includes(".heavy.test.") && !path.includes(".external.test.");

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

if (import.meta.main) {
  // server と web の typecheck から同じ script を呼ぶ。pnpm の script はパッケージのディレクトリで動くので、
  // import.meta.dirname（常に server/）ではなく cwd の test/ を点検する
  reportViolations(findTestLayerViolations(readSources(process.cwd(), "test", [".ts", ".tsx"])));
}
