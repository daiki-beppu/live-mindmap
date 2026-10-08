import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// unit の Swift テストファイルに置いてはいけない、本物の資源を使う文字列。
// Swift の import はモジュール単位なので、ソースの文字列で近い判定をする。
const REAL_RESOURCE_PATTERNS = [
  "WebRTCEchoCanceller(",
  "SpeechAnalyzerTranscriber(",
  "FileManager.default.temporaryDirectory",
  "WebSocketServer(port:",
] as const;

const NON_UNIT_SUFFIXES = ["ITTests.swift", "HeavyTests.swift"] as const;

export type Violation = { path: string; line: number; pattern: string };

// 識別子の途中（MockSpeechAnalyzerTranscriber( など）に現れる一致は、別の型名なので除く。
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
  const violations = listSwiftFiles(testsDir).flatMap((file) =>
    findRealResourceUses(file.slice(helperDir.length), readFileSync(file, "utf8")),
  );
  for (const v of violations) console.error(`${v.path}:${v.line}: ${v.pattern}`);
  if (violations.length > 0) {
    console.error(
      "unit のテストファイルで本物の資源を使っています。ファイルを …ITTests.swift か …HeavyTests.swift へ移してください。",
    );
    process.exitCode = 1;
  }
}
