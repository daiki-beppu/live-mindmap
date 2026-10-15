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

    // Issue #280: --no-screen は値を取らないフラグ。付けると共有画面の取り込みも許可の確認もしない。
    @Test("--no-screen を付けないときは noScreen=false（既定は共有画面を使う）")
    func noScreenDefaultsToFalse() throws {
        let args = try parseRunArguments(["--app", "x"]).get()
        #expect(args.noScreen == false)
    }

    @Test("--no-screen を付けると noScreen=true になる")
    func noScreenFlag() throws {
        let args = try parseRunArguments(["--app", "x", "--no-screen"]).get()
        #expect(args.noScreen == true)
    }

    @Test("--no-screen は値を取らない（次のフラグを食わず、他の引数はそのまま読める）")
    func noScreenTakesNoValue() throws {
        let args = try parseRunArguments(["--no-screen", "--app", "x", "--port", "12345", "--audio-index", "2"]).get()
        #expect(args.noScreen == true)
        #expect(args.app == "x")
        #expect(args.port == 12345)
        #expect(args.audioIndex == 2)
    }

    // Issue #1071: 起動し直した helper が、手動・基準・最後に読めた値・待ちの進み具合を引き継ぐための引数（既定の値は渡さない）
    @Test("自分の休止の引き継ぎは、無ければ初期状態（手動なし・基準なし・読めた値なし・待ち 0）")
    func selfPauseCarryOverDefaults() throws {
        #expect(try parseRunArguments(["--app", "x"]).get().selfPauseCarryOver == .initial)
    }

    @Test("--self-manual・--self-basis・--self-last-known・--self-idle-for を読む。順序は問わず、他の引数と混ぜてよい")
    func selfPauseCarryOverFlags() throws {
        let args = try parseRunArguments([
            "--self-idle-for", "1.5", "--app", "x", "--self-manual", "pause", "--port", "1234",
            "--self-last-known", "idle", "--self-basis", "using",
        ]).get()
        #expect(args.selfPauseCarryOver == SelfPauseCarryOver(manual: .pause, basis: .using, lastKnown: .idle, idleFor: 1.5))
        #expect(args.app == "x")
        #expect(args.port == 1234)
        let take = try parseRunArguments(["--app", "x", "--self-manual", "take", "--self-basis", "idle", "--self-last-known", "using"]).get()
        #expect(take.selfPauseCarryOver == SelfPauseCarryOver(manual: .take, basis: .idle, lastKnown: .using, idleFor: 0))
    }

    @Test("引き継ぎの引数の値が不正なら、使い方の誤りとして拒否する",
          arguments: [
              ["--self-manual", "resume"], ["--self-manual", "unknown"],
              ["--self-basis", "pause"], ["--self-basis", "unknown"],
              ["--self-last-known", "take"], ["--self-last-known", "unknown"],
              ["--self-idle-for", "abc"], ["--self-idle-for", "-1"], ["--self-idle-for", ""],
          ])
    func invalidCarryOverValuesAreRejected(flag: [String]) {
        guard case .failure = parseRunArguments(["--app", "x"] + flag) else {
            Issue.record("\(flag) を受け付けた")
            return
        }
    }

    @Test("値が無い引き継ぎの引数は、不明な引数として拒否する")
    func carryOverFlagWithoutValueIsRejected() {
        for flag in ["--self-manual", "--self-basis", "--self-last-known", "--self-idle-for"] {
            guard case .failure = parseRunArguments(["--app", "x", flag]) else {
                Issue.record("\(flag) を値なしで受け付けた")
                return
            }
        }
    }

    // 置き換えた旧形式（休止の真偽だけを渡す --self-paused）は受け付けない
    @Test("--self-paused は廃止した。不明な引数として拒否する")
    func legacySelfPausedFlagIsRejected() {
        #expect(parseRunArguments(["--app", "x", "--self-paused"]) == .failure(RunArgumentsError("不明な引数: --self-paused")))
    }
}
