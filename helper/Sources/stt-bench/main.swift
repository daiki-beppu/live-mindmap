import Foundation

// 使い方:
//   stt-bench synth <台本.json> <出力フォルダ> [--only <名前>] [--gap <秒>]
//   stt-bench run --variant <名前> <音声.wav> [--load <音声2.wav>]   （結果を 1 行 1 結果の JSONL で標準出力へ）
//   stt-bench echo <meeting.wav> <self.wav> --self-lines <self.lines.json> [--delays 40,200,300] [--at 5,30,60] [--leak-gain-db -10] [--candidate <名前,…>] [--out <フォルダ>]
//     AEC3 が開始直後に話者の声を削るかを測る（結果は 1 行 1 結果の JSONL）。候補: baseline、production、bypass-<秒>
//   stt-bench variants
// 合成した音声・計測の出力はリポジトリの外に置く。

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func option(_ name: String, in args: inout [String]) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    guard i + 1 < args.count else { fail("\(name) には値が要る") }
    let value = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return value
}

struct MissingValue: Error {}

extension Optional {
    func orThrow() throws -> Wrapped {
        guard let self else { throw MissingValue() }
        return self
    }
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: stt-bench <synth|run|echo|variants> ...") }
args.removeFirst()

do {
    switch command {
    case "synth":
        let only = option("--only", in: &args)
        let gap = option("--gap", in: &args).flatMap(Double.init)
        guard args.count == 2 else { fail("usage: stt-bench synth <台本.json> <出力フォルダ> [--only <名前>] [--gap <秒>]") }
        let scenarios = try JSONDecoder().decode([String: Scenario].self, from: Data(contentsOf: URL(fileURLWithPath: args[0])))
        for (name, scenario) in scenarios.sorted(by: { $0.key < $1.key }) where only == nil || only == name {
            try synthesize(name: name, scenario: scenario, gapOverride: gap, outDir: URL(fileURLWithPath: args[1]))
            print("\(name): \(scenario.lines.count) 行")
        }
    case "run":
        guard let name = option("--variant", in: &args) else { fail("--variant が要る（stt-bench variants で一覧）") }
        guard let variant = variants.first(where: { $0.name == name }) else { fail("候補 \(name) はない（stt-bench variants で一覧）") }
        let load = option("--load", in: &args).map { URL(fileURLWithPath: $0) }
        guard args.count == 1 else { fail("usage: stt-bench run --variant <名前> <音声.wav> [--load <音声2.wav>]") }
        try await runBench(variant: variant, audio: URL(fileURLWithPath: args[0]), load: load)
    case "echo":
        let usage = "usage: stt-bench echo <meeting.wav> <self.wav> --self-lines <self.lines.json> [--delays 40,200,300] [--at 5,30,60] [--leak-gain-db -10] [--candidate <名前,…>] [--out <フォルダ>]"
        guard let selfLines = option("--self-lines", in: &args) else { fail("--self-lines が要る\n\(usage)") }
        var options = EchoOptions(meeting: URL(fileURLWithPath: ""), selfVoice: URL(fileURLWithPath: ""), selfLines: URL(fileURLWithPath: selfLines))
        if let value = option("--delays", in: &args) {
            guard let delays = try? value.split(separator: ",").map({ try Int(String($0)).orThrow() }), !delays.isEmpty, delays.allSatisfy({ $0 >= 0 }) else { fail("--delays は 0 以上の ms のカンマ区切り") }
            options.delaysMs = delays
        }
        if let value = option("--at", in: &args) {
            guard let times = try? value.split(separator: ",").map({ try Double(String($0)).orThrow() }), !times.isEmpty, times.allSatisfy({ $0.isFinite && $0 >= 0 }) else { fail("--at は 0 以上の有限な秒のカンマ区切り") }
            options.atSeconds = times
        }
        if let value = option("--leak-gain-db", in: &args) {
            guard let db = Double(value) else { fail("--leak-gain-db は数値（-inf で漏れ無しの対照）") }
            options.leakGainDb = db
        }
        if let value = option("--candidate", in: &args) {
            guard let candidates = try? value.split(separator: ",").map({ try EchoCandidate(String($0)).orThrow() }), !candidates.isEmpty else {
                fail("--candidate は baseline、production、bypass-<秒> のカンマ区切り")
            }
            options.candidates = candidates
        }
        options.out = option("--out", in: &args).map { URL(fileURLWithPath: $0) }
        guard args.count == 2 else { fail(usage) }
        options.meeting = URL(fileURLWithPath: args[0])
        options.selfVoice = URL(fileURLWithPath: args[1])
        try runEcho(options)
    case "variants":
        for v in variants { print("\(v.name)\t\(v.detail)") }
    default:
        fail("未対応のコマンド: \(command)")
    }
} catch {
    fail("\(error)")
}
