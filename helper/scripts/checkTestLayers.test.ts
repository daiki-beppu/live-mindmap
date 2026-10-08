import assert from "node:assert/strict";
import { test } from "node:test";
import { findRealResourceUses } from "./checkTestLayers.ts";

test("unit のファイルに WebRTCEchoCanceller( があれば、ファイル・行・文字列を返す", () => {
  const content = ["import Testing", "", "let c = try WebRTCEchoCanceller()"].join("\n");
  assert.deepEqual(findRealResourceUses("HelperCoreTests/FooTests.swift", content), [
    { path: "HelperCoreTests/FooTests.swift", line: 3, pattern: "WebRTCEchoCanceller(" },
  ]);
});

test("unit のファイルに SpeechAnalyzerTranscriber( があれば違反にする", () => {
  const violations = findRealResourceUses("FooTests.swift", "let t = SpeechAnalyzerTranscriber(locale: l)");
  assert.deepEqual(violations, [{ path: "FooTests.swift", line: 1, pattern: "SpeechAnalyzerTranscriber(" }]);
});

test("unit のファイルに WebSocketServer(port: があれば違反にする", () => {
  const violations = findRealResourceUses("FooTests.swift", "let s = WebSocketServer(port: 0)");
  assert.deepEqual(violations, [{ path: "FooTests.swift", line: 1, pattern: "WebSocketServer(port:" }]);
});

test("補助ファイル（EchoTestSupport.swift）も unit として扱い、temporaryDirectory を違反にする", () => {
  const violations = findRealResourceUses(
    "SttBenchTests/EchoTestSupport.swift",
    "let dir = FileManager.default.temporaryDirectory",
  );
  assert.deepEqual(violations, [
    { path: "SttBenchTests/EchoTestSupport.swift", line: 1, pattern: "FileManager.default.temporaryDirectory" },
  ]);
});

test("1 ファイルに複数の文字列があれば、それぞれ行付きで返す", () => {
  const content = [
    "let a = WebSocketServer(port: 0)",
    "let ok = 1",
    "let d = FileManager.default.temporaryDirectory",
  ].join("\n");
  assert.deepEqual(findRealResourceUses("FooTests.swift", content), [
    { path: "FooTests.swift", line: 1, pattern: "WebSocketServer(port:" },
    { path: "FooTests.swift", line: 3, pattern: "FileManager.default.temporaryDirectory" },
  ]);
});

test("1 行に複数の文字列があれば、それぞれ返す", () => {
  const content = "let x = (WebRTCEchoCanceller(), SpeechAnalyzerTranscriber(locale: l))";
  const patterns = findRealResourceUses("FooTests.swift", content).map((v) => v.pattern);
  assert.deepEqual(patterns.toSorted(), ["SpeechAnalyzerTranscriber(", "WebRTCEchoCanceller("]);
});

test("ITTests.swift で終わるファイルは、本物の資源を使っても違反にしない", () => {
  assert.deepEqual(findRealResourceUses("RelayITTests.swift", "let s = WebSocketServer(port: 0)"), []);
});

test("HeavyTests.swift で終わるファイルは、本物の資源を使っても違反にしない", () => {
  assert.deepEqual(findRealResourceUses("EchoCancellerHeavyTests.swift", "let c = try WebRTCEchoCanceller()"), []);
});

test("接尾辞が名前の途中にあるだけのファイルは unit として扱う", () => {
  assert.equal(findRealResourceUses("ITTests.swift.bak.swift", "WebRTCEchoCanceller(").length, 1);
  assert.equal(findRealResourceUses("HeavyTestsHelper.swift", "WebRTCEchoCanceller(").length, 1);
});

test("似ているが別の文字列だけなら、unit のファイルでも違反にしない", () => {
  const content = [
    "let a = RecordingEchoCanceller()",
    "func temporaryDirectory() -> URL { fatalError() }",
    "let d = try temporaryDirectory()",
    "try server.start()",
    "let m = MockSpeechAnalyzerTranscriber()",
  ].join("\n");
  assert.deepEqual(findRealResourceUses("FooTests.swift", content), []);
});

test("本物の資源を使わない unit のファイルは違反なし", () => {
  assert.deepEqual(findRealResourceUses("EventsTests.swift", "import Testing\n@Suite struct EventsTests {}\n"), []);
});

test("コメントの中の文字列も、文字列の判定として違反にする", () => {
  const violations = findRealResourceUses("FooTests.swift", "// WebRTCEchoCanceller( を使うな");
  assert.equal(violations.length, 1);
});
