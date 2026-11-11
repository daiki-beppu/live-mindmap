import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSources, reportViolations, type SourceFile } from "../../server/scripts/sourceFiles.ts";

type TextSpan = { text: string; offset: number };
type Violation = { path: string; line: number; message: string };

const MARKER_CLASSES = new Set(["evidence__meta", "review-seek__preview-chapter"]);
const CSS_PATH = "web/src/styles.css";
const lineAt = (source: string, offset: number): number => source.slice(0, offset).split("\n").length;

function stringLiterals(source: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;
  const quoted = (quote: string): void => {
    const start = ++cursor;
    while (cursor < source.length && source[cursor] !== quote) {
      cursor += source[cursor] === "\\" ? 2 : 1;
    }
    spans.push({ text: source.slice(start, cursor), offset: start });
    cursor++;
  };
  const template = (): void => {
    let start = ++cursor;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
      } else if (source[cursor] === "`" || source.startsWith("${", cursor)) {
        spans.push({ text: source.slice(start, cursor), offset: start });
        if (source[cursor++] === "`") return;
        cursor++;
        code(true);
        start = cursor;
      } else {
        cursor++;
      }
    }
  };
  const regex = (): void => {
    let inClass = false;
    cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === "\\") cursor++;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) return;
    }
  };
  const token = (): boolean => {
    const char = source[cursor];
    if (source.startsWith("//", cursor)) {
      const end = source.indexOf("\n", cursor);
      cursor = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'") quoted(char);
    else if (char === "`") template();
    else if (char === "/" && /(?:^|[=(:,\[!&|?{};]|=>|\b(?:return|throw|case|void|typeof|delete|yield|await))\s*$/.test(source.slice(0, cursor))) regex();
    else return false;
    return true;
  };
  const code = (interpolation: boolean): void => {
    let depth = 0;
    while (cursor < source.length) {
      if (token()) continue;
      const char = source[cursor++];
      if (char === "{") depth++;
      if (char === "}" && depth-- === 0 && interpolation) return;
    }
  };
  code(false);
  return spans;
}

const words = (text: string) => [...text.matchAll(/[\w-]+/g)].filter((match) => /^[a-zA-Z_]/.test(match[0]));
const maskCss = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (text) => text.replace(/[^\n]/g, " "));
const hexKey = (hex: string): string => (hex.length === 4 ? "#" + [...hex.slice(1)].map((char) => char + char).join("") : hex).toLowerCase();

function cssRules(source: string) {
  return [...maskCss(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    selectorOffset: match.index + match[1]!.search(/\S/),
    declarations: [...match[2]!.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?:;|$)/g)].map((declaration) => ({
      name: declaration[1]!,
      value: declaration[2]!.trim(),
      offset: match.index + match[1]!.length + 1 + declaration.index,
    })),
  }));
}

function checkClasses(files: readonly SourceFile[], classes: ReadonlyMap<string, number>, css: string): Violation[] {
  const references = files.flatMap(({ path, content }) => stringLiterals(content).flatMap((span) => words(span.text).map((match) => ({
    name: match[0], path, line: lineAt(content, span.offset + match.index),
  }))));
  const names = new Set(references.map((reference) => reference.name));
  const undefinedClasses = references.filter(({ name }) => (name.includes("__") || name.includes("--")) && !classes.has(name) && !MARKER_CLASSES.has(name));
  const unusedClasses = [...classes].filter(([name]) => !names.has(name) && !MARKER_CLASSES.has(name));
  return [
    ...undefinedClasses.map(({ name, path, line }) => ({ path, line, message: `CSS にクラス ${name} がありません` })),
    ...unusedClasses.map(([name, offset]) => ({ path: CSS_PATH, line: lineAt(css, offset), message: `未使用のクラス ${name}` })),
  ];
}

function checkDeclarations(rules: ReturnType<typeof cssRules>, css: string): Violation[] {
  const tokens = new Set(rules.filter((rule) => rule.selector === ":root").flatMap((rule) => rule.declarations.filter((declaration) => declaration.name.startsWith("--")).flatMap((declaration) => [...declaration.value.matchAll(/#[\da-f]{3,8}\b/gi)].map((match) => hexKey(match[0])))));
  return rules.flatMap((rule) => rule.declarations.flatMap((declaration) => {
    const violations: Violation[] = [];
    const location = { path: CSS_PATH, line: lineAt(css, declaration.offset) };
    if (rule.selector !== ":root") {
      for (const match of declaration.value.matchAll(/#[\da-f]{3,8}\b/gi)) {
        if (tokens.has(hexKey(match[0]))) violations.push({ ...location, message: `トークンと同じ hex ${match[0]} は var(--color-…) で参照してください` });
      }
    }
    if (declaration.name.toLowerCase() === "box-shadow" && declaration.value.replace(/\s*!important\s*$/i, "").toLowerCase() !== "none") {
      violations.push({ ...location, message: `box-shadow は none だけです: ${declaration.value}` });
    }
    return violations;
  }));
}

const root = join(import.meta.dirname, "../..");
const css = readFileSync(join(root, CSS_PATH), "utf8");
const rules = cssRules(css);
const classes = new Map(rules.flatMap((rule) => [...rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => [match[1]!, rule.selectorOffset + match.index] as const)));
const files = readSources(root, "web/src", [".ts", ".tsx"]).filter((file) => !/\.test\.tsx?$/.test(file.path));
reportViolations([...checkClasses(files, classes, css), ...checkDeclarations(rules, css)]);
