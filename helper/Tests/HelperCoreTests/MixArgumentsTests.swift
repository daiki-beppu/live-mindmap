import Testing
import HelperCore

// `mix` サブコマンドの引数解釈（main.swift にはテストターゲットがないため、純粋関数として検証する）。
// 不正な引数は `run` と同じく RunArgumentsError（usage を伴って終了コード 2）にする。

@Suite("mix の引数解釈（parseMixArguments）")
struct MixArgumentsTests {
    @Test("--session と --out だけで解釈できる。--track は nil（全トラックを混ぜる）")
    func required() throws {
        let args = try parseMixArguments(["--session", "/tmp/s", "--out", "/tmp/o.m4a"]).get()
        #expect(args.session == "/tmp/s")
        #expect(args.out == "/tmp/o.m4a")
        #expect(args.track == nil)
    }

    @Test("--track 自分 は 自分 トラックの指定になる。引数の順番は問わない")
    func trackSelf() throws {
        let args = try parseMixArguments(["--track", "自分", "--out", "o.m4a", "--session", "s"]).get()
        #expect(args.track == .自分)
        #expect(args.session == "s")
        #expect(args.out == "o.m4a")
    }

    @Test("--track 相手 は拒否する（指定できるのは 自分 だけ）")
    func rejectsOtherTrack() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseMixArguments(["--session", "s", "--out", "o", "--track", "相手"]).get()
        }
    }

    @Test("--track の値が不明なら拒否する")
    func rejectsUnknownTrack() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseMixArguments(["--session", "s", "--out", "o", "--track", "all"]).get()
        }
    }

    @Test("--session が無ければ拒否する")
    func missingSession() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseMixArguments(["--out", "o"]).get()
        }
    }

    @Test("--out が無ければ拒否する")
    func missingOut() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseMixArguments(["--session", "s"]).get()
        }
    }

    @Test("値が無いフラグは拒否する")
    func flagWithoutValue() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseMixArguments(["--session", "s", "--out"]).get()
        }
    }

    @Test("不明な引数は拒否する")
    func unknownArgument() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseMixArguments(["--session", "s", "--out", "o", "--bogus", "x"]).get()
        }
    }
}
