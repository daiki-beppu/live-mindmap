import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL_RESOURCE_PATTERNS = [
  "WebRTCEchoCanceller(",
  "SpeechAnalyzerTranscriber(",
  "SortformerSpeakerDiarizer(",
  "WeSpeakerEmbedder(",
  "FileManager.default.temporaryDirectory",
  "WebSocketServer(port:",
] as const;

const NON_UNIT_SUFFIXES = ["ITTests.swift", "HeavyTests.swift"] as const;

export type Violation = { path: string; line: number; pattern: string };

function containsAtWordStart(text: string, pattern: string): boolean {
  for (let from = text.indexOf(pattern); from !== -1; from = text.indexOf(pattern, from + 1)) {
    if (from === 0 || !/[A-Za-z0-9_]/.test(text[from - 1] ?? "")) return true;
  }
  return false;
}

export function findRealResourceUses(path: string, content: string): Violation[] {
  if (NON_UNIT_SUFFIXES.some((suffix) => path.endsWith(suffix))) return [];
  const violations: Violation[] = [];
  content.split("\n").forEach((text, index) => {
    for (const pattern of REAL_RESOURCE_PATTERNS) {
      if (containsAtWordStart(text, pattern)) violations.push({ path, line: index + 1, pattern });
    }
  });
  return violations;
}

export type SuiteMismatch = { path: string; line: number; suite: string };

// swift の --skip 'ITTests/|HeavyTests/' は、この 2 つの接尾辞以外（Tests で終わらない名前も）を unit として回す。
function layerOf(name: string): "unit" | "it" | "heavy" {
  if (name.endsWith("HeavyTests")) return "heavy";
  if (name.endsWith("ITTests")) return "it";
  return "unit";
}

const SUITE_ATTRIBUTE = /^[ \t]*@Suite\b/gm;
const TYPE_DECLARATION = /\b(?:struct|class|enum|actor)\s+([A-Za-z_]\w*)/y;

function skipBlockComment(content: string, from: number): number {
  let depth = 1;
  let i = from + 2;
  while (i < content.length && depth > 0) {
    if (content.startsWith("/*", i)) depth++, i += 2;
    else if (content.startsWith("*/", i)) depth--, i += 2;
    else i++;
  }
  return i;
}

function skipString(content: string, from: number, opening: string): number {
  const hashes = opening.slice(0, opening.indexOf('"'));
  const delimiter = opening.slice(hashes.length) + hashes;
  const escape = "\\" + hashes;
  let i = from + opening.length;
  while (i < content.length) {
    if (content.startsWith(delimiter, i)) return i + delimiter.length;
    if (content.startsWith(escape, i)) i += escape.length + 1;
    else i++;
  }
  return i;
}

function maskNonCode(content: string): string {
  const parts: string[] = [];
  const openings = /\/\/|\/\*|#*(?:"""|")/g;
  let from = 0;
  for (let match = openings.exec(content); match; match = openings.exec(content)) {
    const start = match.index;
    let end: number;
    if (match[0] === "//") {
      const newline = content.indexOf("\n", start);
      end = newline === -1 ? content.length : newline;
    } else if (match[0] === "/*") end = skipBlockComment(content, start);
    else end = skipString(content, start, match[0]);
    parts.push(content.slice(from, start), content.slice(start, end).replace(/[^\r\n]/g, " "));
    from = openings.lastIndex = end;
  }
  parts.push(content.slice(from));
  return parts.join("");
}

function skipArguments(content: string, from: number): number {
  let i = from;
  while (/\s/.test(content[i] ?? "")) i++;
  if (content[i] !== "(") return from;
  let depth = 0;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return content.length;
}

function findDeclaredTypeName(content: string, from: number): string | undefined {
  for (let i = from; i < content.length; i++) {
    if (/[{};]/.test(content[i] ?? "") || content.startsWith("@Suite", i)) return undefined;
    if (content[i] === "@") {
      const name = /[A-Za-z_]\w*/y;
      name.lastIndex = i + 1;
      if (name.test(content)) i = skipArguments(content, name.lastIndex) - 1;
    } else {
      TYPE_DECLARATION.lastIndex = i;
      const name = TYPE_DECLARATION.exec(content)?.[1];
      if (name !== undefined) return name;
    }
  }
  return undefined;
}

function findSuites(content: string) {
  const code = maskNonCode(content);
  return [...code.matchAll(SUITE_ATTRIBUTE)].flatMap((attribute) => {
    const start = attribute.index + attribute[0].length;
    const end = skipArguments(code, start);
    const suite = findDeclaredTypeName(code, end);
    if (suite === undefined) return [];
    return [{ suite, line: code.slice(0, attribute.index).split("\n").length, traits: code.slice(start, end) }];
  });
}

export function findSuiteLayerMismatches(path: string, content: string): SuiteMismatch[] {
  const fileLayer = layerOf((path.split("/").pop() ?? path).replace(/\.swift$/, ""));
  return findSuites(content)
    .filter(({ suite }) => layerOf(suite) !== fileLayer)
    .map(({ suite, line }) => ({ path, line, suite }));
}

export function findSuitesMissingTimeLimit(path: string, content: string): SuiteMismatch[] {
  return findSuites(content)
    .filter(({ suite, traits }) => layerOf(suite) !== "unit" && !/\.timeLimit\s*\(/.test(traits))
    .map(({ suite, line }) => ({ path, line, suite }));
}

function listSwiftFiles(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) return listSwiftFiles(child);
    return entry.name.endsWith(".swift") ? [fileURLToPath(child)] : [];
  });
}

if (import.meta.main) {
  const testsDir = new URL("../Tests/", import.meta.url);
  const helperDir = fileURLToPath(new URL("../", import.meta.url));
  const files = listSwiftFiles(testsDir).map((file) => ({
    path: file.slice(helperDir.length),
    content: readFileSync(file, "utf8"),
  }));
  const violations = files.flatMap((f) => findRealResourceUses(f.path, f.content));
  const mismatches = files.flatMap((f) => findSuiteLayerMismatches(f.path, f.content));
  const missingTimeLimits = files.flatMap((f) => findSuitesMissingTimeLimit(f.path, f.content));
  for (const suite of missingTimeLimits) console.error(`${suite.path}:${suite.line}: ${suite.suite}`);
  if (missingTimeLimits.length > 0) {
    console.error("ITTests の @Suite に .timeLimit(.minutes(1))、HeavyTests の @Suite に .timeLimit(.minutes(2)) を付けてください。");
    process.exitCode = 1;
  }
  for (const m of mismatches) console.error(`${m.path}:${m.line}: ${m.suite}`);
  if (mismatches.length > 0) {
    console.error(
      "ファイル名の層と @Suite の型名の層が食い違っています。ファイル名か型名を …Tests / …ITTests / …HeavyTests の接尾辞に合わせてください。",
    );
    process.exitCode = 1;
  }
  for (const v of violations) console.error(`${v.path}:${v.line}: ${v.pattern}`);
  if (violations.length > 0) {
    console.error(
      "unit のテストファイルで本物の資源を使っています。ファイルを …ITTests.swift か …HeavyTests.swift へ移してください。",
    );
    process.exitCode = 1;
  }
}
