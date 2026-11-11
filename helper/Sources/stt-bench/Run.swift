import AVFoundation
import CoreAudio
import Foundation
import HelperCore

private let chunkSeconds = 0.1

struct ResultLine: Encodable {
    var track: String
    var arrival: Double
    var isFinal: Bool
    var start: Double
    var end: Double
    var text: String
}

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
                    let wait = Duration.seconds(fed) - (clock.now - start)
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

func diarize(_ audio: URL, with diarizer: any SpeakerDiarizer, start: ContinuousClock.Instant, out: FileHandle) async throws {
    let origin = AudioGetCurrentHostTime()
    let segments = try await diarizer.diarize(try pacedAudio(from: audio, origin: origin), origin: origin)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    for try await item in segments {
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

func printJSON(_ json: String) {
    outputLock.lock()
    print(json)
    fflush(stdout)
    outputLock.unlock()
}

func printLine(_ line: ResultLine) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(line), let json = String(data: data, encoding: .utf8) else { return }
    printJSON(json)
}

func eventLine(_ event: HelperEvent, arrival: Double) throws -> String {
    let object = try JSONSerialization.jsonObject(with: Data(event.jsonString().utf8))
    guard var fields = object as? [String: Any] else { throw EventLineError.notObject }
    fields["arrival"] = arrival
    let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
    guard let json = String(data: data, encoding: .utf8) else { throw EventLineError.notObject }
    return json
}

private enum EventLineError: Error { case notObject }

private func recognizeEvents(_ audio: URL, with transcriber: any Transcriber, track: Track, start: ContinuousClock.Instant, emit: @escaping @Sendable (String) -> Void) async throws {
    let origin = AudioGetCurrentHostTime()
    let results = try await transcriber.transcribe(try pacedAudio(from: audio, origin: origin), origin: origin)
    for try await result in results {
        emit(try eventLine(event(from: result, track: track), arrival: (ContinuousClock.now - start).seconds))
    }
}

private func diarizeEvents(_ audio: URL, with diarizer: any SpeakerDiarizer, start: ContinuousClock.Instant, emit: @escaping @Sendable (String) -> Void) async throws {
    let origin = AudioGetCurrentHostTime()
    let items = try await diarizer.diarize(try pacedAudio(from: audio, origin: origin), origin: origin)
    for try await item in items {
        emit(try eventLine(event(from: item, track: .相手), arrival: (ContinuousClock.now - start).seconds))
    }
}

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

func runEvents(variant: Variant, audio: URL, selfAudio: URL?, vocabulary: Vocabulary? = nil) async throws {
    let transcriber = SilenceFilteringTranscriber(wrapping: makeTranscriber(variant, vocabulary: vocabulary))
    try await transcriber.prepare()
    var selfTranscriber: SilenceFilteringTranscriber?
    if selfAudio != nil {
        let t = SilenceFilteringTranscriber(wrapping: makeTranscriber(variant, vocabulary: vocabulary))
        try await t.prepare()
        selfTranscriber = t
    }
    let diarizer = Nemotron3SpeakerDiarizer()
    try await diarizer.prepare()
    try await streamEvents(audio: audio, selfAudio: selfAudio, transcriber: transcriber, selfTranscriber: selfTranscriber, diarizer: diarizer, start: ContinuousClock.now) { printJSON($0) }
}

func runBench(variant: Variant, audio: URL, load: URL?, vocabulary: Vocabulary? = nil, diarizeTo: URL? = nil) async throws {
    let main = makeTranscriber(variant, vocabulary: vocabulary)
    try await main.prepare()
    var background: (any Transcriber)?
    if load != nil {
        let t = makeTranscriber(variant, vocabulary: vocabulary)
        try await t.prepare()
        background = t
    }
    var diarization: (diarizer: Nemotron3SpeakerDiarizer, out: FileHandle)?
    if let diarizeTo {
        let diarizer = Nemotron3SpeakerDiarizer()
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
