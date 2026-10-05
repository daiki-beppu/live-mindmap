import Testing
import HelperCore

// Issue #161: `run` の引数解釈を HelperCore の純粋関数へ抽出したもののテスト（main.swift にはテストターゲットがないため）。
// 既存の引数（--app・--port・--audio-dir、不明な引数、--app 欠落）の受理・既定値・拒否は変えない（CT-HELPER-ARGS）。
// 新しい引数（--origin・--audio-index）の異常系も、既存と同じ「usage を伴って拒否する」扱いに揃える。

@Suite("run の引数解釈（parseRunArguments）")
struct RunArgumentsTests {
    @Test("--app だけでも起動できる。既定値は port=8765・audioDir=nil・origin=nil・audioIndex=1")
    func defaults() throws {
        let result = parseRunArguments(["--app", "us.zoom.xos"])
        let args = try result.get()
        #expect(args.app == "us.zoom.xos")
        #expect(args.port == 8765)
        #expect(args.audioDir == nil)
        #expect(args.origin == nil)
        #expect(args.audioIndex == 1)
    }

    @Test("--port は指定した値になる")
    func explicitPort() throws {
        let args = try parseRunArguments(["--app", "x", "--port", "12345"]).get()
        #expect(args.port == 12345)
    }

    @Test("--audio-dir は指定した値になる")
    func explicitAudioDir() throws {
        let args = try parseRunArguments(["--app", "x", "--audio-dir", "/tmp/session"]).get()
        #expect(args.audioDir == "/tmp/session")
    }

    @Test("--app がないと拒否される")
    func missingApp() {
        let result = parseRunArguments(["--port", "1234"])
        #expect(throws: RunArgumentsError.self) { try result.get() }
    }

    @Test("不明な引数は拒否される（既存の振る舞い）")
    func unknownArgument() {
        let result = parseRunArguments(["--app", "x", "--mystery", "1"])
        #expect(throws: RunArgumentsError.self) { try result.get() }
    }

    @Test("--port が範囲外（0〜65535 の整数でない）なら拒否される")
    func invalidPort() {
        for value in ["0x1", "-1", "65536", "abc"] {
            let result = parseRunArguments(["--app", "x", "--port", value])
            #expect(throws: RunArgumentsError.self) { try result.get() }
        }
    }

    @Test("--origin は UInt64 の値をそのまま受け取る（2^53 を超えても桁が落ちない）")
    func explicitOrigin() throws {
        let args = try parseRunArguments(["--app", "x", "--origin", "9007199254740993"]).get()
        #expect(args.origin == 9_007_199_254_740_993)
    }

    @Test("--origin が UInt64 として読めない値は拒否される")
    func invalidOrigin() {
        for value in ["-1", "abc", ""] {
            let result = parseRunArguments(["--app", "x", "--origin", value])
            #expect(throws: RunArgumentsError.self) { try result.get() }
        }
    }

    @Test("--audio-index は 1 以上の整数を受け取る")
    func explicitAudioIndex() throws {
        let args = try parseRunArguments(["--app", "x", "--audio-index", "3"]).get()
        #expect(args.audioIndex == 3)
    }

    @Test("--audio-index が 1 未満・非数値なら拒否される（新しい引数の異常系も既存と同じ扱い）")
    func invalidAudioIndex() {
        for value in ["0", "-1", "abc"] {
            let result = parseRunArguments(["--app", "x", "--audio-index", value])
            #expect(throws: RunArgumentsError.self) { try result.get() }
        }
    }
}
