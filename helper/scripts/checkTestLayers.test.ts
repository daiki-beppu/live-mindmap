import assert from "node:assert/strict";
import { test } from "node:test";
import { findRealResourceUses, findSuiteLayerMismatches, findSuitesMissingTimeLimit } from "./checkTestLayers.ts";

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

test("unit のファイルに SortformerSpeakerDiarizer( があれば違反にする", () => {
  const violations = findRealResourceUses("FooTests.swift", "let d = SortformerSpeakerDiarizer(modelDirectory: dir)");
  assert.deepEqual(violations, [{ path: "FooTests.swift", line: 1, pattern: "SortformerSpeakerDiarizer(" }]);
});

test("HeavyTests.swift と ITTests.swift は SortformerSpeakerDiarizer( を使っても違反にしない", () => {
  const content = "let d = SortformerSpeakerDiarizer()";
  assert.deepEqual(findRealResourceUses("SortformerSpeakerDiarizerHeavyTests.swift", content), []);
  assert.deepEqual(findRealResourceUses("SortformerSpeakerDiarizerITTests.swift", content), []);
});

test("unit のファイルに WeSpeakerEmbedder( があれば違反にする", () => {
  const violations = findRealResourceUses("FooTests.swift", "let e = WeSpeakerEmbedder(modelDirectory: dir)");
  assert.deepEqual(violations, [{ path: "FooTests.swift", line: 1, pattern: "WeSpeakerEmbedder(" }]);
});

test("HeavyTests.swift と ITTests.swift は WeSpeakerEmbedder( を使っても違反にしない", () => {
  const content = "let e = WeSpeakerEmbedder()";
  assert.deepEqual(findRealResourceUses("WeSpeakerEmbedderHeavyTests.swift", content), []);
  assert.deepEqual(findRealResourceUses("SlotMixITTests.swift", content), []);
});

test("FakeSpeakerEmbedder( のように語の途中にある別の型名は、unit でも違反にしない", () => {
  assert.deepEqual(findRealResourceUses("FooTests.swift", "let e = FakeSpeakerEmbedder()"), []);
});

test("MockSortformerSpeakerDiarizer( のように語の途中にある別の型名は、unit でも違反にしない", () => {
  assert.deepEqual(findRealResourceUses("FooTests.swift", "let d = MockSortformerSpeakerDiarizer()"), []);
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

test("unit のファイルに …HeavyTests の Suite があれば、ファイル・@Suite の行・型名を返す", () => {
  const content = ["import Testing", "", '@Suite("x")', "struct BarHeavyTests {}"].join("\n");
  assert.deepEqual(findSuiteLayerMismatches("HelperCoreTests/FooTests.swift", content), [
    { path: "HelperCoreTests/FooTests.swift", line: 3, suite: "BarHeavyTests" },
  ]);
});

test("軽い IT のファイルに unit の Suite があれば食い違いにする", () => {
  const violations = findSuiteLayerMismatches("RelayITTests.swift", "@Suite\nstruct BarTests {}");
  assert.deepEqual(violations, [{ path: "RelayITTests.swift", line: 1, suite: "BarTests" }]);
});

test("重い IT のファイルに軽い IT の Suite があれば食い違いにする", () => {
  const violations = findSuiteLayerMismatches("EchoCancellerHeavyTests.swift", "@Suite\nstruct FooITTests {}");
  assert.deepEqual(violations, [{ path: "EchoCancellerHeavyTests.swift", line: 1, suite: "FooITTests" }]);
});

test("unit のファイルに …ITTests の Suite があれば食い違いにする", () => {
  const violations = findSuiteLayerMismatches("FooTests.swift", "@Suite\nstruct FooITTests {}");
  assert.deepEqual(violations, [{ path: "FooTests.swift", line: 1, suite: "FooITTests" }]);
});

test("層の接尾辞がそろっていれば、型名の前半がファイル名と違っても通す", () => {
  const cases: [string, string][] = [
    ["DuplicatesTests.swift", '@Suite("a")\nstruct CoverageTests {}\n\n@Suite\nstruct IsDuplicateTests {}'],
    ["RelayITTests.swift", "@Suite\nstruct MultiTrackRelayITTests {}"],
    ["EchoBenchITTests.swift", "@Suite\nstruct WriteWavITTests {}"],
    ["EchoCancellerHeavyTests.swift", "@Suite\nstruct EchoCancellerStartupHeavyTests {}"],
  ];
  for (const [path, content] of cases) assert.deepEqual(findSuiteLayerMismatches(path, content), [], path);
});

test("Tests で終わらない補助ファイルと型名は unit として扱う", () => {
  assert.deepEqual(findSuiteLayerMismatches("EchoTestSupport.swift", "@Suite\nstruct Helper {}"), []);
  assert.equal(findSuiteLayerMismatches("RelayITTests.swift", "@Suite\nstruct Helper {}").length, 1);
});

test("パスのディレクトリ名は層の判定に使わず、ファイル名だけで判定する", () => {
  assert.deepEqual(findSuiteLayerMismatches("HeavyTests/FooTests.swift", "@Suite\nstruct BarTests {}"), []);
});

test("1 ファイルに合う Suite と食い違う Suite があれば、食い違う 1 件だけ返す", () => {
  const content = ["@Suite", "struct OkTests {}", "", '@Suite("y")', "struct BadITTests {}"].join("\n");
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), [
    { path: "FooTests.swift", line: 4, suite: "BadITTests" },
  ]);
});

test("入れ子の括弧を含む @Suite の引数があっても、型名を取り出す", () => {
  const content = '@Suite("x", .timeLimit(.minutes(1)), .disabled(if: env["CI"] != nil, "why"))\nstruct BarHeavyTests {}';
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), [
    { path: "FooTests.swift", line: 1, suite: "BarHeavyTests" },
  ]);
});

test("同じ行の @Suite struct、final class、enum も対象にする", () => {
  assert.equal(findSuiteLayerMismatches("FooTests.swift", "@Suite struct AHeavyTests {}").length, 1);
  assert.equal(findSuiteLayerMismatches("FooTests.swift", "@Suite\nfinal class AHeavyTests {}").length, 1);
  assert.equal(findSuiteLayerMismatches("FooTests.swift", "@Suite\nenum AHeavyTests {}").length, 1);
});

test("インデントされた @Suite も対象にする", () => {
  const violations = findSuiteLayerMismatches("FooTests.swift", "enum Outer {\n    @Suite\n    struct AHeavyTests {}\n}");
  assert.deepEqual(violations, [{ path: "FooTests.swift", line: 2, suite: "AHeavyTests" }]);
});

test("コメント内の行の途中にある @Suite と、@Suite の付かない型は対象にしない", () => {
  const content = [
    "/// 重い処理でも @Suite の時間制限で止まらない",
    "@Suite",
    "struct OkTests {",
    "    struct UpstreamFailure {}",
    "    enum Call {}",
    "}",
    "struct SomeHeavyTests {}",
  ].join("\n");
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), []);
});

test("Suite が無いファイルは食い違いなし", () => {
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", "import Testing\n"), []);
});

test("@Suite の表示名に型宣言風の文字列があっても、実際の型名で判定する", () => {
  const content = '@Suite("struct FakeTests")\nstruct BarHeavyTests {}';
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), [
    { path: "FooTests.swift", line: 1, suite: "BarHeavyTests" },
  ]);
});

test("@Suite と型宣言の間のコメントにある型宣言風の語ではなく、実際の型名で判定する", () => {
  const content = "@Suite\n// struct FakeTests\nstruct BarHeavyTests {}";
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), [
    { path: "FooTests.swift", line: 1, suite: "BarHeavyTests" },
  ]);
});

test("コメントの型名が食い違っても、実際の型名の層がそろっていれば違反にしない", () => {
  const content = "@Suite\n// class FooHeavyTests\nstruct OkTests {}";
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), []);
});

test("ブロックコメント・行末コメント・引数の後の文書コメントを読み飛ばして型名を取る", () => {
  for (const content of [
    "@Suite /* struct FakeTests */\nstruct BarHeavyTests {}",
    "@Suite // struct FakeTests\nstruct BarHeavyTests {}",
    '@Suite("x")\n/// The class under test\nstruct BarHeavyTests {}',
  ]) {
    assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), [
      { path: "FooTests.swift", line: 1, suite: "BarHeavyTests" },
    ]);
  }
});

test("@Suite と型宣言の間の別属性の引数の文字列にある型宣言風の語ではなく、実際の型名で判定する", () => {
  const content = '@Suite\n@available(*, deprecated, message: "use the actor FakeTests")\nstruct BarHeavyTests {}';
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), [
    { path: "FooTests.swift", line: 1, suite: "BarHeavyTests" },
  ]);
});

test("別属性の引数の文字列にある食い違う型名は違反にしない", () => {
  const content = '@Suite\n@available(*, deprecated, message: "replaced by class FooHeavyTests")\nstruct OkTests {}';
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", content), []);
});

test("引数のない属性を挟んでも、続く型宣言の型名で判定する", () => {
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", "@Suite\n@MainActor\nstruct BarHeavyTests {}"), [
    { path: "FooTests.swift", line: 1, suite: "BarHeavyTests" },
  ]);
  assert.deepEqual(findSuiteLayerMismatches("FooTests.swift", "@Suite\n@MainActor\nstruct BarTests {}"), []);
});

test("時間制限のない IT suite をパス・属性の行・型名付きで返す", () => {
  const content = 'import Testing\n@Suite("転送")\nstruct RelayITTests {}';
  assert.deepEqual(findSuitesMissingTimeLimit("HelperCoreTests/RelayITTests.swift", content), [
    { path: "HelperCoreTests/RelayITTests.swift", line: 2, suite: "RelayITTests" },
  ]);
});

test("表示名とコメントの時間制限では IT suite の欠落を免除しない", () => {
  const content = '@Suite(".timeLimit(.minutes(1))", /* .timeLimit(.minutes(1)) */ .serialized)\nstruct RelayITTests {}';
  assert.deepEqual(findSuitesMissingTimeLimit("RelayITTests.swift", content), [
    { path: "RelayITTests.swift", line: 1, suite: "RelayITTests" },
  ]);
});

test("同じファイルの Heavy suite ごとに時間制限を点検する", () => {
  const content = [
    "@Suite(.timeLimit(.minutes(2))) struct AHeavyTests {}",
    "@Suite struct BHeavyTests {}",
    "@Suite(.timeLimit(.minutes(2))) struct CHeavyTests {}",
  ].join("\n");
  assert.deepEqual(findSuitesMissingTimeLimit("MixHeavyTests.swift", content), [
    { path: "MixHeavyTests.swift", line: 2, suite: "BHeavyTests" },
  ]);
});

test("複数行と入れ子の括弧を持つ時間制限を欠落と誤認しない", () => {
  const content = [
    "@Suite(",
    '  "重い処理", .timeLimit(.minutes(2)),',
    '  .disabled(if: false, "理由")',
    ")",
    "struct AHeavyTests {}",
  ].join("\n");
  assert.deepEqual(findSuitesMissingTimeLimit("AHeavyTests.swift", content), []);
});

test("時間制限のない unit suite と接尾辞が途中にある型を許可する", () => {
  const content = "@Suite struct EventsTests {}\n@Suite struct ITTestsHelper {}\n@Suite struct HeavyTestsHelper {}";
  assert.deepEqual(findSuitesMissingTimeLimit("EventsTests.swift", content), []);
});

test("文字列とコメント内の Heavy suite は実在する suite と扱わない", () => {
  const content = [
    'let example = "@Suite struct ExampleHeavyTests {}"',
    "/*",
    "@Suite struct OtherHeavyTests {}",
    "*/",
    "@Suite struct EventsTests {}",
  ].join("\n");
  assert.deepEqual(findSuitesMissingTimeLimit("EventsTests.swift", content), []);
});

test("時間制限の対象はファイル名ではなく suite の実型名で判定する", () => {
  const content = '@Suite("struct FakeTests")\nstruct RelayITTests {}\n@Suite struct EventsTests {}';
  assert.deepEqual(findSuitesMissingTimeLimit("EventsTests.swift", content), [
    { path: "EventsTests.swift", line: 1, suite: "RelayITTests" },
  ]);
  assert.deepEqual(findSuitesMissingTimeLimit("RelayHeavyTests.swift", "@Suite struct EventsTests {}"), []);
});

test("テスト関数や別属性の時間制限では suite の欠落を免除しない", () => {
  const content = [
    "@Suite",
    '@available(*, deprecated, message: ".timeLimit(.minutes(1))")',
    "struct RelayITTests {",
    "  @Test(.timeLimit(.minutes(1))) func relay() {}",
    "}",
  ].join("\n");
  assert.deepEqual(findSuitesMissingTimeLimit("RelayITTests.swift", content), [
    { path: "RelayITTests.swift", line: 1, suite: "RelayITTests" },
  ]);
});

test("別属性とコメントを挟むインデントされた suite の属性行を返す", () => {
  const content = [
    "enum Outer {",
    "  @Suite()",
    "  // struct FakeTests",
    "  @MainActor",
    "  final class RelayHeavyTests {}",
    "}",
  ].join("\n");
  assert.deepEqual(findSuitesMissingTimeLimit("RelayHeavyTests.swift", content), [
    { path: "RelayHeavyTests.swift", line: 2, suite: "RelayHeavyTests" },
  ]);
});

test("文字列と入れ子コメントの時間制限を suite の trait と扱わない", () => {
  for (const argument of [
    String.raw`"escaped \" .timeLimit(.minutes(1))"`,
    '#"raw " .timeLimit(.minutes(1))"#',
    '"""\n.timeLimit(.minutes(1))\n"""',
    ".serialized /* outer /* nested */ .timeLimit(.minutes(1)) */",
    ".serialized // .timeLimit(.minutes(1))\n",
  ]) {
    const content = `@Suite(${argument})\nstruct RelayITTests {}`;
    assert.deepEqual(
      findSuitesMissingTimeLimit("RelayITTests.swift", content),
      [{ path: "RelayITTests.swift", line: 1, suite: "RelayITTests" }],
      argument,
    );
  }
});

test("raw 文字列・複数行文字列・入れ子コメントの suite を読み飛ばして行番号を保つ", () => {
  for (const example of [
    'let example = #"@Suite struct FakeHeavyTests {}"#',
    'let example = """\n@Suite struct FakeHeavyTests {}\n"""',
    "/* outer /* nested */\n@Suite struct FakeHeavyTests {}\n*/",
  ]) {
    const content = [example, "@Suite struct RelayITTests {}"].join("\n");
    assert.deepEqual(
      findSuitesMissingTimeLimit("RelayITTests.swift", content),
      [{ path: "RelayITTests.swift", line: example.split("\n").length + 1, suite: "RelayITTests" }],
      example,
    );
  }
});

test("時間制限付き IT suite は欠落なし", () => {
  assert.deepEqual(
    findSuitesMissingTimeLimit("RelayITTests.swift", "@Suite(.timeLimit(.minutes(1))) struct RelayITTests {}"),
    [],
  );
});

test("suite のないソースは時間制限の欠落なし", () => {
  assert.deepEqual(findSuitesMissingTimeLimit("Support.swift", "import Testing\nstruct HelperHeavyTests {}"), []);
});
