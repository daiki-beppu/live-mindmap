import Foundation
import Testing
import HelperCore

// `transcribe-file --file <path> [--port <n>]` の引数解釈（main.swift にはテストターゲットがないので、HelperCore の純粋関数で確かめる）。
// 流儀は `run` の parseRunArguments と同じ: 不正な引数は usage を伴って拒否する。

@Suite("transcribe-file の引数解釈（parseTranscribeFileArguments）")
struct TranscribeFileArgumentsTests {
    @Test("--file だけで起動できる。port の既定は run と同じ 8765")
    func defaults() throws {
        let args = try parseTranscribeFileArguments(["--file", "/tmp/meeting.m4a"]).get()
        #expect(args.file == "/tmp/meeting.m4a")
        #expect(args.port == 8765)
    }

    @Test("--port は指定した値になる")
    func explicitPort() throws {
        let args = try parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--port", "12345"]).get()
        #expect(args.port == 12345)
    }

    @Test("--file がないと拒否される")
    func missingFile() {
        let result = parseTranscribeFileArguments(["--port", "1234"])
        #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
    }

    @Test("不明な引数は拒否される")
    func unknownArgument() {
        let result = parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--app", "us.zoom.xos"])
        #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
    }

    @Test("--port が 0〜65535 の整数でないと拒否される")
    func invalidPort() {
        for value in ["-1", "65536", "abc"] {
            let result = parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--port", value])
            #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
        }
    }
}

@Suite("file-duration イベント")
struct FileDurationEventTests {
    @Test("録画の全体の長さ（秒）を type と duration だけの JSON にする")
    func json() throws {
        #expect(try HelperEvent.fileDuration(duration: 3484.5).jsonString() == "{\"duration\":3484.5,\"type\":\"file-duration\"}")
    }
}
