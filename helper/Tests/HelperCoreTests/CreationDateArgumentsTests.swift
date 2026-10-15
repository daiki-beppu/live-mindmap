import Testing
import HelperCore

// `creation-date --file <path>` の引数解釈（main.swift にはテストターゲットがないため、純粋関数として検証する）。
// 解釈の結果はファイルのパス。流儀は transcribe-file と同じで、不正な引数は拒否する。

@Suite("creation-date の引数解釈（parseCreationDateArguments）")
struct CreationDateArgumentsTests {
    @Test("--file の値をファイルのパスとして返す")
    func file() throws {
        let file = try parseCreationDateArguments(["--file", "/tmp/meeting.mov"]).get()
        #expect(file == "/tmp/meeting.mov")
    }

    @Test("--file がないと拒否される")
    func missingFile() {
        let result = parseCreationDateArguments([])
        #expect(throws: (any Error).self) { try result.get() }
    }

    @Test("--file に値がないと拒否される")
    func missingValue() {
        let result = parseCreationDateArguments(["--file"])
        #expect(throws: (any Error).self) { try result.get() }
    }

    @Test("不明な引数は拒否される")
    func unknownArgument() {
        let result = parseCreationDateArguments(["--file", "/tmp/a.mov", "--port", "1"])
        #expect(throws: (any Error).self) { try result.get() }
    }
}
