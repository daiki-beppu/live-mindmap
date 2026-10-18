import AVFoundation
import CoreAudio
import Foundation
import HelperCore

// 音声ファイルを実時間のペースで認識に流し、結果ごとに 1 行の JSONL を出す。
// 速く流すと、認識が音声に追いつくまでの待ちが測れない。100 ms ずつ読み、壁時計が音声の時刻に追いつくまで待ってから渡す。

private let chunkSeconds = 0.1

struct ResultLine: Encodable {
    var track: String
    var arrival: Double
    var isFinal: Bool
    var start: Double
    var end: Double
    var text: String
}

/// `url` の音声を、流し始めを 0 とする実時間で `CapturedAudio` の流れにする。`hostTime` は、そのバッファの先頭の音声の時刻（`origin` + ファイル内の位置）。
/// これで、baseline の `TrackTimeline` による補正が 0 になり、補正のない候補と結果の時刻の基準がそろう。
func pacedAudio(from url: URL, origin: UInt64) throws -> AsyncThrowingStream<CapturedAudio, Error> {
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    let chunk = AVAudioFrameCount(format.sampleRate * chunkSeconds)
    return AsyncThrowingStream { continuation in
        let task = Task {
            let clock = ContinuousClock()
            let start = clock.now
            var fed = 0.0
            do {
                while file.framePosition < file.length {  // 終わりで read を呼ぶと、0 フレームではなく例外になる
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { break }
                    try file.read(into: buffer, frameCount: chunk)
                    let bufferStart = fed
                    fed += Double(buffer.frameLength) / format.sampleRate
                    let wait = Duration.seconds(fed) - (clock.now - start)  // 音声の時刻に壁時計が追いつくまで待つ
                    if wait > .zero { try await Task.sleep(for: wait) }
                    continuation.yield(CapturedAudio(buffer: buffer, hostTime: origin + AudioConvertNanosToHostTime(UInt64(bufferStart * 1e9))))
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

/// 準備済みの `transcriber` で 1 本の音声を認識して、結果を `emit` に渡す。到着時刻は `start`（音声を流し始めた時刻）が 0。
func recognize(_ audio: URL, with transcriber: any Transcriber, start: ContinuousClock.Instant, emit: (@Sendable (ResultLine) -> Void)?) async throws {
    let origin = AudioGetCurrentHostTime()
    let results = try await transcriber.transcribe(try pacedAudio(from: audio, origin: origin), origin: origin)
    for try await result in results {
        let arrival = (ContinuousClock.now - start).seconds
        emit?(ResultLine(track: "相手", arrival: arrival, isFinal: result.isFinal, start: result.start, end: result.end, text: result.text))
    }
}

struct SegmentLine: Encodable {
    var arrival: Double
    var start: Double
    var end: Double
    var slot: Int
    var isFinal: Bool
}

/// 話者分離（本物の Sortformer）を同じ音声に掛け、区間が届くたびに `out` へ 1 行の JSONL を書く（Issue #1020）。到着時刻は `start` が 0。
/// STT の結果の出力（標準出力）とは別のファイルに書く。モデルの準備は計測に含めない（呼び出し側で済ませる）。
func diarize(_ audio: URL, with diarizer: any SpeakerDiarizer, start: ContinuousClock.Instant, out: FileHandle) async throws {
    let origin = AudioGetCurrentHostTime()
    let segments = try await diarizer.diarize(try pacedAudio(from: audio, origin: origin), origin: origin)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    for try await item in segments {
        // 確定済みの位置のイベントは、区間の到着の計測には載せない
        guard case .segment(let segment) = item else { continue }
        let line = SegmentLine(arrival: (ContinuousClock.now - start).seconds, start: segment.start, end: segment.end, slot: segment.slot, isFinal: segment.isFinal)
        out.write(try encoder.encode(line) + Data("\n".utf8))
    }
}

extension Duration {
    var seconds: Double {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}

private let outputLock = NSLock()

/// JSON の 1 行を標準出力に書く（並行して呼ばれても行が混ざらない）。
func printJSON(_ json: String) {
    outputLock.lock()
    print(json)
    fflush(stdout)
    outputLock.unlock()
}

/// 結果の JSON を 1 行ずつ標準出力に書く。
func printLine(_ line: ResultLine) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(line), let json = String(data: data, encoding: .utf8) else { return }
    printJSON(json)
}

// MARK: --events（Issue #1031）

/// ヘルパーのイベントの JSON に、届いた時刻 `arrival`（`start` を 0 とする秒）を足した 1 行。speakerReplay --offline がそのまま読める形。
func eventLine(_ event: HelperEvent, arrival: Double) throws -> String {
    let object = try JSONSerialization.jsonObject(with: Data(event.jsonString().utf8))
    guard var fields = object as? [String: Any] else { throw EventLineError.notObject }
    fields["arrival"] = arrival
    let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
    guard let json = String(data: data, encoding: .utf8) else { throw EventLineError.notObject }
    return json
}

private enum EventLineError: Error { case notObject }

/// `url` の音声を認識し、結果（remark / partial。語・語の区間つき）を `track` のイベントとして届いた時刻つきで `emit` に渡す。
private func recognizeEvents(_ audio: URL, with transcriber: any Transcriber, track: Track, start: ContinuousClock.Instant, emit: @escaping @Sendable (String) -> Void) async throws {
    let origin = AudioGetCurrentHostTime()
    let results = try await transcriber.transcribe(try pacedAudio(from: audio, origin: origin), origin: origin)
    for try await result in results {
        emit(try eventLine(event(from: result, track: track), arrival: (ContinuousClock.now - start).seconds))
    }
}

/// 同じ音声に話者分離を掛け、区間・確定済みの位置・混入・重心のすべてを 相手 のイベントとして届いた時刻つきで `emit` に渡す。
private func diarizeEvents(_ audio: URL, with diarizer: any SpeakerDiarizer, start: ContinuousClock.Instant, emit: @escaping @Sendable (String) -> Void) async throws {
    let origin = AudioGetCurrentHostTime()
    let items = try await diarizer.diarize(try pacedAudio(from: audio, origin: origin), origin: origin)
    for try await item in items {
        emit(try eventLine(event(from: item, track: .相手), arrival: (ContinuousClock.now - start).seconds))
    }
}

/// 相手の音声の認識と話者分離、あれば 自分 の音声の認識を、同じ起点から実時間のペースで並行して流し、
/// 届いた時刻 arrival つきのイベントを 1 行 1 イベントで `emit` に渡す。どれかが失敗したら全体を失敗にする（話者なしで黙って続けない）。
func streamEvents(
    audio: URL, selfAudio: URL?,
    transcriber: any Transcriber, selfTranscriber: (any Transcriber)?,
    diarizer: any SpeakerDiarizer, start: ContinuousClock.Instant,
    emit: @escaping @Sendable (String) -> Void
) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask { try await recognizeEvents(audio, with: transcriber, track: .相手, start: start, emit: emit) }
        group.addTask { try await diarizeEvents(audio, with: diarizer, start: start, emit: emit) }
        if let selfAudio, let selfTranscriber {
            group.addTask { try await recognizeEvents(selfAudio, with: selfTranscriber, track: .自分, start: start, emit: emit) }
        }
        try await group.waitForAll()
    }
}

/// `run --events` の本体。認識はライブと同じ `SilenceFilteringTranscriber` で包む。モデルの準備は計測に含めない。
func runEvents(variant: Variant, audio: URL, selfAudio: URL?, vocabulary: Vocabulary? = nil) async throws {
    let transcriber = SilenceFilteringTranscriber(wrapping: makeTranscriber(variant, vocabulary: vocabulary))
    try await transcriber.prepare()
    var selfTranscriber: SilenceFilteringTranscriber?
    if selfAudio != nil {
        let t = SilenceFilteringTranscriber(wrapping: makeTranscriber(variant, vocabulary: vocabulary))
        try await t.prepare()
        selfTranscriber = t
    }
    let diarizer = SortformerSpeakerDiarizer()
    try await diarizer.prepare()
    try await streamEvents(audio: audio, selfAudio: selfAudio, transcriber: transcriber, selfTranscriber: selfTranscriber, diarizer: diarizer, start: ContinuousClock.now) { printJSON($0) }
}

/// 計測の 1 回分。`load` があれば、2 本目を並行して認識に流す（2 本同時の負荷。2 本目の結果は出さない）。
/// モデルの準備は計測に含めない。どちらも準備が済んでから、同時に流し始める。`diarizeTo` があれば、主の音声に話者分離も並行して掛け、区間を別ファイルに書く。
func runBench(variant: Variant, audio: URL, load: URL?, vocabulary: Vocabulary? = nil, diarizeTo: URL? = nil) async throws {
    let main = makeTranscriber(variant, vocabulary: vocabulary)
    try await main.prepare()
    var background: (any Transcriber)?
    if load != nil {
        let t = makeTranscriber(variant, vocabulary: vocabulary)
        try await t.prepare()
        background = t
    }
    var diarization: (diarizer: SortformerSpeakerDiarizer, out: FileHandle)?
    if let diarizeTo {
        let diarizer = SortformerSpeakerDiarizer()
        try await diarizer.prepare()
        FileManager.default.createFile(atPath: diarizeTo.path, contents: nil)
        diarization = (diarizer, try FileHandle(forWritingTo: diarizeTo))
    }
    defer { try? diarization?.out.close() }
    let start = ContinuousClock.now
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask { try await recognize(audio, with: main, start: start) { printLine($0) } }
        if let load, let background {
            group.addTask { try await recognize(load, with: background, start: start, emit: nil) }
        }
        if let diarization {
            group.addTask { try await diarize(audio, with: diarization.diarizer, start: start, out: diarization.out) }
        }
        try await group.waitForAll()
    }
}
