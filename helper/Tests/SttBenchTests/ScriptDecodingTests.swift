import Foundation
import Testing
@testable import stt_bench

@Suite("合成台本の読み込み")
struct ScriptDecodingTests {
    @Test("本文だけの行と決定・TODO の行を同じ台本から読み取る")
    func acceptsTwoAndFourElementLines() throws {
        let json = #"{"meeting":{"title":"確認","gap":0.5,"lines":[["A","TODO"],["B","進めます","決定","実施する"],["A","確認します","TODO","確認する"]]}}"#
        let scenarios = try JSONDecoder().decode([String: Scenario].self, from: Data(json.utf8))
        let scenario = try #require(scenarios["meeting"])
        #expect(scenario.title == "確認")
        #expect(scenario.gap == 0.5)
        #expect(scenario.lines.count == 3)
        #expect(scenario.lines.map { $0.speaker.rawValue } == ["A", "B", "A"])
        #expect(scenario.lines.map(\.text) == ["TODO", "進めます", "確認します"])
        #expect(scenario.lines.map { $0.speaker.voice } == ["Kyoko", "Reed", "Kyoko"])
        #expect(scenario.lines[0].truth == nil)
        let decision = try #require(scenario.lines[1].truth)
        #expect(decision.kind == .決定)
        #expect(decision.text == "実施する")
        let todo = try #require(scenario.lines[2].truth)
        #expect(todo.kind == .TODO)
        #expect(todo.text == "確認する")
    }

    @Test("不完全な行・余分な列・未知の話者と種類をデコード時に拒否する", arguments: [
        #"[]"#,
        #"["A"]"#,
        #"["A","本文","TODO"]"#,
        #"["A","本文","TODO","答え","余分"]"#,
        #"["C","本文"]"#,
        #"["A","本文","その他","答え"]"#,
        #"["A",12]"#,
        #"["A","本文","TODO",null]"#,
        #"{"speaker":"A","text":"本文"}"#,
        #"["A",["本文"]]"#,
        #"["A","本文""#,
    ])
    func rejectsInvalidLines(line: String) {
        let json = #"{"meeting":{"title":"確認","gap":0.5,"lines":["# + line + "]}}"
        #expect(throws: (any Error).self) {
            _ = try JSONDecoder().decode([String: Scenario].self, from: Data(json.utf8))
        }
    }
}
