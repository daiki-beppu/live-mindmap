import Foundation

// 使い方:
//   stt-bench synth <台本.json> <出力フォルダ> [--only <名前>] [--gap <秒>]
//   stt-bench tracks <会議フォルダ> <出力フォルダ> --self <話者>   （timeline.tsv・voices.json・lines/ のある合成会議を、<話者> の行だけの 自分.wav と、残りの 相手.wav に分ける）
//   stt-bench run --variant <名前> <音声.wav> [--load <音声2.wav>] [--vocab <語彙.txt>] [--vocab-at <秒>] [--diarize <区間.jsonl>]   （結果を 1 行 1 結果の JSONL で標準出力へ）
//     --vocab は 1 行 1 語。語彙を使う候補（vocab・vocab-init・dictation-vocab）のときだけ contextualStrings に渡す。--vocab-at を付けると、その秒まで流してから渡す
//     --diarize は同じ音声に Sortformer の話者分離も並行して掛け、区間（到着時刻・start・end・slot・isFinal）を 1 行 1 区間の JSONL でそのファイルに書く（標準出力の形は変えない）。事前に bash helper/scripts/fetch-speaker-models.sh
//   stt-bench run --variant <名前> <相手.wav> --events [--self <自分.wav>]   （認識と話者分離のイベントを arrival つきの JSONL で標準出力へ。speakerAccuracy が読む。--vocab・--load・--diarize とは併用しない）
//   stt-bench echo <meeting.wav> <self.wav> --self-lines <self.lines.json> [--microphone <AEC3前の録音>] [--delays 40,200,300] [--at 5,30,60] [--leak-gain-db -10] [--candidate <名前,…>] [--out <フォルダ>]
//     AEC3 の漏れと発話の残り方を測る（JSONL）。候補: baseline、production、bypass-<秒>、suppress-lf-0.6、delay-hint-40、ep-gain-0.1
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

func flag(_ name: String, in args: inout [String]) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i)
    return true
}

struct MissingValue: Error {}

extension Optional {
    func orThrow() throws -> Wrapped {
        guard let self else { throw MissingValue() }
        return self
    }
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: stt-bench <synth|tracks|run|echo|variants> ...") }
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
    case "tracks":
        guard let selfSpeaker = option("--self", in: &args) else { fail("--self が要る（進行役の話者）") }
        guard args.count == 2 else { fail("usage: stt-bench tracks <会議フォルダ> <出力フォルダ> --self <話者>") }
        try buildTracks(meeting: URL(fileURLWithPath: args[0]), outDir: URL(fileURLWithPath: args[1]), selfSpeaker: selfSpeaker)
    case "run":
        guard let name = option("--variant", in: &args) else { fail("--variant が要る（stt-bench variants で一覧）") }
        guard let variant = variants.first(where: { $0.name == name }) else { fail("候補 \(name) はない（stt-bench variants で一覧）") }
        let load = option("--load", in: &args).map { URL(fileURLWithPath: $0) }
        let diarizeTo = option("--diarize", in: &args).map { URL(fileURLWithPath: $0) }
        let selfAudio = option("--self", in: &args).map { URL(fileURLWithPath: $0) }
        let events = flag("--events", in: &args)
        let vocabAt = option("--vocab-at", in: &args).map { value -> Double in
            guard let seconds = Double(value), seconds.isFinite, seconds >= 0 else { fail("--vocab-at は 0 以上の秒") }
            return seconds
        } ?? 0
        let vocabulary = try option("--vocab", in: &args).map { path in
            let words = try String(contentsOfFile: path, encoding: .utf8).split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            return Vocabulary(strings: words, at: vocabAt)
        }
        if variant.usesVocabulary, vocabulary == nil { fail("候補 \(name) には --vocab が要る") }
        guard args.count == 1 else { fail("usage: stt-bench run --variant <名前> <音声.wav> [--load <音声2.wav>] [--vocab <語彙.txt>] [--vocab-at <秒>]") }
        if events {
            guard load == nil, diarizeTo == nil else { fail("--events は --load・--diarize と併用しない（話者分離は --events の出力に入る）") }
            try await runEvents(variant: variant, audio: URL(fileURLWithPath: args[0]), selfAudio: selfAudio, vocabulary: vocabulary)
            break
        }
        if selfAudio != nil { fail("--self は --events のときだけ使える") }
        try await runBench(variant: variant, audio: URL(fileURLWithPath: args[0]), load: load, vocabulary: vocabulary, diarizeTo: diarizeTo)
    case "echo":
        let usage = "usage: stt-bench echo <meeting.wav> <self.wav> --self-lines <self.lines.json> [--microphone <AEC3前の録音>] [--delays 40,200,300] [--at 5,30,60] [--leak-gain-db -10] [--candidate <名前,…>] [--out <フォルダ>]"
        guard let selfLines = option("--self-lines", in: &args) else { fail("--self-lines が要る\n\(usage)") }
        var options = EchoOptions(meeting: URL(fileURLWithPath: ""), selfVoice: URL(fileURLWithPath: ""), selfLines: URL(fileURLWithPath: selfLines))
        options.microphone = option("--microphone", in: &args).map { URL(fileURLWithPath: $0) }
        if options.microphone != nil, args.contains("--delays") || args.contains("--leak-gain-db") {
            fail("--microphone は --delays・--leak-gain-db と併用できない")
        }
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
                fail("--candidate は baseline、production、bypass-<秒>、suppress-lf-0.6、delay-hint-40、ep-gain-0.1 のカンマ区切り")
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
