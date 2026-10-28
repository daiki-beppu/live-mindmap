import AVFoundation
import CoreAudio
import Foundation
import Testing
import HelperCore

// 本物の SpeechAnalyzer を使う。ja-JP のモデルがない・使えない環境では prepare() が失敗するので、その場合はテストも失敗する（環境の問題として報告する）。
// CI のランナーはモデルを持たず、テストのプロセスはモデルのダウンロードの状態も確かめられない（SFSpeechErrorDomain Code=1）ので、CI では流さない。

@Suite("SpeechAnalyzerTranscriber の停止", .timeLimit(.minutes(2)), .disabled(if: ProcessInfo.processInfo.environment["CI"] != nil, "CI のランナーには ja-JP の音声認識モデルが無い"))
struct SpeechAnalyzerTranscriberHeavyTests {
    private static let finishDeadline: Duration = .seconds(10)

    @Test("音声が一度も届かないまま入力が終わっても、結果の流れが一定時間内に、結果なしで正常に終わる")
    func finishesWithoutAnyAudio() async throws {
        let transcriber = SpeechAnalyzerTranscriber()
        try await transcriber.prepare()
        let audio = AsyncThrowingStream<CapturedAudio, Error> { $0.finish() }

        let results = try await transcriber.transcribe(audio, origin: 0)

        let outcome = await withTaskGroup(of: Int?.self) { group in
            group.addTask {
                var count = 0
                do {
                    for try await _ in results { count += 1 }
                } catch {
                    return nil
                }
                return count
            }
            group.addTask {
                try? await Task.sleep(for: Self.finishDeadline)
                return -1
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        #expect(outcome != -1, "音声が 0 件のとき、結果の流れが \(Self.finishDeadline) 以内に終わらなかった")
        #expect(outcome != nil, "音声が 0 件のとき、結果の流れがエラーで終わった")
        #expect(outcome == 0)
    }
}

// Issue #1019: 語ごとの区間。本物の SpeechAnalyzer の `audioTimeRange` から取り出した区間が、remark / partial の JSON に載る。
// `say` の声（Kyoko）で作った音声を、実時間に合わせて 0.1 秒ずつ流す（途中結果を出させるため）。

private struct WordTimeJSON {
    var location: Int
    var length: Int
    var start: Double
    var end: Double
}

private struct SpokenEvent {
    var type: String
    var start: Double
    var end: Double
    var text: String
    var wordTimes: [WordTimeJSON]
}

private func spokenEvents(_ sentence: String) async throws -> [SpokenEvent] {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wordtimes-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let aiff = dir.appendingPathComponent("speech.aiff")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", "Kyoko", "-o", aiff.path, sentence]
    try say.run()
    say.waitUntilExit()
    try #require(say.terminationStatus == 0, "say -v Kyoko が失敗した（Kyoko の声が入っていない）")

    let file = try AVAudioFile(forReading: aiff)
    let format = file.processingFormat
    let chunkFrames = AVAudioFrameCount(format.sampleRate / 10)

    let transcriber = SpeechAnalyzerTranscriber()
    try await transcriber.prepare()
    let origin = AudioGetCurrentHostTime()
    let audio = AsyncThrowingStream<CapturedAudio, Error> { continuation in
        let feeder = Task {
            do {
                var sent: AVAudioFramePosition = 0
                while sent < file.length {
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { break }
                    try file.read(into: buffer, frameCount: chunkFrames)
                    if buffer.frameLength == 0 { break }
                    let nanos = UInt64(Double(sent) / format.sampleRate * 1_000_000_000)
                    continuation.yield(CapturedAudio(buffer: buffer, hostTime: origin + AudioConvertNanosToHostTime(nanos)))
                    sent += AVAudioFramePosition(buffer.frameLength)
                    try await Task.sleep(for: .milliseconds(100))
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in feeder.cancel() }
    }

    var events: [SpokenEvent] = []
    for try await result in try await transcriber.transcribe(audio, origin: origin) {
        // 実際の経路と同じ組み立て（相手・自分のどちらでも形は同じ）
        let json = try event(from: result, track: .相手).jsonString()
        let object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let times = try #require(object["wordTimes"] as? [[String: Any]], "JSON に wordTimes が無い")
        events.append(SpokenEvent(
            type: try #require(object["type"] as? String),
            start: try #require(object["start"] as? Double),
            end: try #require(object["end"] as? Double),
            text: try #require(object["text"] as? String),
            wordTimes: try times.map {
                WordTimeJSON(
                    location: try #require($0["location"] as? Int), length: try #require($0["length"] as? Int),
                    start: try #require($0["start"] as? Double), end: try #require($0["end"] as? Double))
            }))
    }
    return events
}

@Suite("SpeechAnalyzerTranscriber の語ごとの区間", .timeLimit(.minutes(2)), .disabled(if: ProcessInfo.processInfo.environment["CI"] != nil, "CI のランナーには ja-JP の音声認識モデルが無い"))
struct SpeechAnalyzerTranscriberWordTimesHeavyTests {
    private static let tolerance = 0.05

    @Test("remark と partial の両方に wordTimes が載り、各語が発言の区間に収まり、開始の時刻順に並ぶ")
    func wordTimesAreWithinTheRemarkAndOrdered() async throws {
        let events = try await spokenEvents("明日の会議は十時から始めます。資料は事前に共有してください。")

        let remarks = events.filter { $0.type == "remark" }
        let partials = events.filter { $0.type == "partial" }
        #expect(!remarks.isEmpty, "確定結果が 1 件も出なかった")
        #expect(!partials.isEmpty, "途中結果が 1 件も出なかった")
        #expect(remarks.contains { !$0.wordTimes.isEmpty }, "remark に語の区間が載っていない")
        #expect(partials.contains { !$0.wordTimes.isEmpty }, "partial に語の区間が載っていない")

        for event in events {
            let utf16Length = event.text.utf16.count
            var previousStart = -Double.infinity
            for word in event.wordTimes {
                #expect(word.start <= word.end, "\(event.type): 語の start が end を超えている \(word)")
                #expect(word.start >= event.start - Self.tolerance, "\(event.type): 語が発言の開始より前 \(word) / \(event.start)")
                #expect(word.end <= event.end + Self.tolerance, "\(event.type): 語が発言の終了より後 \(word) / \(event.end)")
                #expect(word.start >= previousStart, "\(event.type): 語が開始の順に並んでいない \(word)")
                #expect(word.location >= 0 && word.length > 0 && word.location + word.length <= utf16Length, "\(event.type): 位置が本文の外 \(word) / \(utf16Length)")
                previousStart = word.start
            }
        }
    }
}
