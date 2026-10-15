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
        #expect(args.audioDir == nil)
        #expect(args.selfFile == nil)
        #expect(args.from == nil)
        #expect(args.selfFrom == nil)
    }

    @Test("--from は読み始める音声の時刻（秒）として解釈される。--audio-dir を渡さない起動し直しの形でも解釈できる")
    func from() throws {
        let args = try parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--self-file", "/tmp/me.m4a", "--from", "660"]).get()
        #expect(args.from == 660)
        #expect(args.audioDir == nil)
        #expect(args.selfFile == "/tmp/me.m4a")
    }

    @Test("--from は小数の秒と 0 も受け付ける。引数の順序にもよらない")
    func fromFractionAndZero() throws {
        #expect(try parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--from", "600.5"]).get().from == 600.5)
        #expect(try parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--from", "0"]).get().from == 0)
        #expect(try parseTranscribeFileArguments(["--from", "12", "--file", "/tmp/a.m4a"]).get().from == 12)
    }

    @Test("--from に値がない・数でない・負・有限でないと拒否される")
    func invalidFrom() {
        for value in ["abc", "-1", "nan", "inf", "-inf", ""] {
            let result = parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--from", value])
            #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
        }
        let withoutValue = parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--from"])
        #expect(throws: TranscribeFileArgumentsError.self) { try withoutValue.get() }
    }

    @Test("--self-from は自分用の録音の読み始める音声の時刻（秒）として解釈される。--from とは別の値を持つ")
    func selfFrom() throws {
        let args = try parseTranscribeFileArguments(["--file", "a.m4a", "--self-file", "b.m4a", "--from", "10", "--self-from", "2"]).get()
        #expect(args.from == 10)
        #expect(args.selfFrom == 2)
        #expect(try parseTranscribeFileArguments(["--file", "a.m4a", "--self-file", "b.m4a", "--self-from", "0.5"]).get().from == nil)
    }

    @Test("--self-from に値がない・数でない・負・有限でないと拒否される。--self-file が無い --self-from も拒否される")
    func invalidSelfFrom() {
        for value in ["abc", "-1", "nan", "inf", "-inf", ""] {
            let result = parseTranscribeFileArguments(["--file", "a.m4a", "--self-file", "b.m4a", "--self-from", value])
            #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
        }
        let withoutValue = parseTranscribeFileArguments(["--file", "a.m4a", "--self-file", "b.m4a", "--self-from"])
        #expect(throws: TranscribeFileArgumentsError.self) { try withoutValue.get() }
        let withoutSelfFile = parseTranscribeFileArguments(["--file", "a.m4a", "--self-from", "2"])
        #expect(throws: TranscribeFileArgumentsError.self) { try withoutSelfFile.get() }
    }

    @Test("--self-file は自分用の録音のファイルとして解釈される。--file は相手用のまま")
    func selfFile() throws {
        let args = try parseTranscribeFileArguments(["--file", "/tmp/them.m4a", "--self-file", "/tmp/me.m4a", "--audio-dir", "/tmp/session"]).get()
        #expect(args.file == "/tmp/them.m4a")
        #expect(args.selfFile == "/tmp/me.m4a")
        #expect(args.audioDir == "/tmp/session")
    }

    @Test("--self-file は引数の順序によらず解釈される")
    func selfFileBeforeFile() throws {
        let args = try parseTranscribeFileArguments(["--self-file", "/tmp/me.m4a", "--file", "/tmp/them.m4a"]).get()
        #expect(args == TranscribeFileArguments(file: "/tmp/them.m4a", selfFile: "/tmp/me.m4a"))
    }

    @Test("--self-file に値がないと拒否される")
    func selfFileWithoutValue() {
        let result = parseTranscribeFileArguments(["--file", "/tmp/a.m4a", "--self-file"])
        #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
    }

    @Test("--self-file だけで --file がないと拒否される")
    func selfFileWithoutFile() {
        let result = parseTranscribeFileArguments(["--self-file", "/tmp/me.m4a"])
        #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
    }

    @Test("--audio-dir は音声を書くフォルダとして解釈される")
    func audioDir() throws {
        let args = try parseTranscribeFileArguments(["--file", "/tmp/a.mp4", "--audio-dir", "/tmp/session"]).get()
        #expect(args.file == "/tmp/a.mp4")
        #expect(args.audioDir == "/tmp/session")
    }

    @Test("--audio-dir に値がないと拒否される")
    func audioDirWithoutValue() {
        let result = parseTranscribeFileArguments(["--file", "/tmp/a.mp4", "--audio-dir"])
        #expect(throws: TranscribeFileArgumentsError.self) { try result.get() }
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

@Suite("file-audio-tracks イベント")
struct FileAudioTracksEventTests {
    @Test("音声のトラックの本数を type と count だけの JSON にする")
    func json() throws {
        #expect(try HelperEvent.fileAudioTracks(count: 2).jsonString() == "{\"count\":2,\"type\":\"file-audio-tracks\"}")
    }
}
