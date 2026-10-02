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

extension Duration {
    var seconds: Double {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}

private let outputLock = NSLock()

/// 結果の JSON を 1 行ずつ標準出力に書く。
func printLine(_ line: ResultLine) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(line), let json = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    print(json)
    fflush(stdout)
    outputLock.unlock()
}

/// 計測の 1 回分。`load` があれば、2 本目を並行して認識に流す（2 本同時の負荷。2 本目の結果は出さない）。
/// モデルの準備は計測に含めない。どちらも準備が済んでから、同時に流し始める。
func runBench(variant: Variant, audio: URL, load: URL?) async throws {
    let main = makeTranscriber(variant)
    try await main.prepare()
    var background: (any Transcriber)?
    if load != nil {
        let t = makeTranscriber(variant)
        try await t.prepare()
        background = t
    }
    let start = ContinuousClock.now
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask { try await recognize(audio, with: main, start: start) { printLine($0) } }
        if let load, let background {
            group.addTask { try await recognize(load, with: background, start: start, emit: nil) }
        }
        try await group.waitForAll()
    }
}
