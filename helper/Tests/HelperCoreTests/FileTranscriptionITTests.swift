import AVFoundation
import Foundation
import Speech
import Testing
@testable import HelperCore

// ファイル 1 本を文字にする経路（transcribeFile）の IT。文字にする役（FileTranscriber）は偽物で、結果の区間を台本で返す。
// ファイルは、テストの中で作った 4 秒の WAV（0〜2 秒は 440 Hz のサイン波、2〜4 秒は完全な無音）。
// 確かめること: 役へ渡る音声の位置がファイルの位置と一致すること、無音の区間の結果だけが捨てられること、測れない区間の結果は残ること。

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-file-transcription-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private let sampleRate = 16_000.0

/// 前半 `loudSeconds` 秒がサイン波、後半 `silentSeconds` 秒が無音の WAV。
private func writeRecording(_ url: URL, loudSeconds: Double, silentSeconds: Double) throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1))
    let frames = AVAudioFrameCount(sampleRate * (loudSeconds + silentSeconds))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    let samples = try #require(buffer.floatChannelData)[0]
    let loudFrames = Int(sampleRate * loudSeconds)
    for i in 0..<Int(frames) {
        samples[i] = i < loudFrames ? 0.5 * Float(sin(2 * Double.pi * 440 * Double(i) / sampleRate)) : 0
    }
    let file = try AVAudioFile(forWriting: url, settings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
    ])
    try file.write(from: buffer)
}

/// 渡された音声を全部受け取り、その長さと開始位置の記録を残してから、台本の結果を返す偽の役。
private final class ScriptedFileTranscriber: FileTranscriber, @unchecked Sendable {
    private let lock = NSLock()
    private var _receivedSeconds = 0.0
    private var _statedStarts: [Double] = []
    private let script: [TranscriptionResult]
    /// 読み始める位置（ファイルの秒）。入力が明示する開始位置は、この位置から読んだ長さを足した値と一致する。
    private let origin: Double

    init(script: [TranscriptionResult], origin: Double = 0) {
        self.script = script
        self.origin = origin
    }

    var receivedSeconds: Double { lock.withLock { _receivedSeconds } }
    var statedStarts: [Double] { lock.withLock { _statedStarts } }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        var position = 0.0
        for try await input in inputs {
            if let start = input.bufferStartTime {
                lock.withLock { _statedStarts.append(start.seconds - (origin + position)) }
            }
            position += Double(input.buffer.frameLength) / input.buffer.format.sampleRate
        }
        lock.withLock { _receivedSeconds = position }
        let script = self.script
        return AsyncThrowingStream { continuation in
            for result in script { continuation.yield(result) }
            continuation.finish()
        }
    }
}

private func result(_ text: String, isFinal: Bool, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: isFinal, start: start, end: end)
}

@Suite("ファイルを文字にする経路（transcribeFile）", .timeLimit(.minutes(1)))
struct FileTranscriptionITTests {
    @Test("全体の長さは、ファイルの音声の長さ（秒）")
    func durationOfFile() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)

        let seconds = try await fileDuration(of: url)

        #expect(abs(seconds - 4.0) < 0.01)
    }

    @Test("役へ渡る音声は、ファイルの 0 秒から途切れず最後まで続く。位置を明示する入力は、ファイル上の位置と一致する")
    func audioHandedOverIsContiguousFromZero() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)
        let transcriber = ScriptedFileTranscriber(script: [])

        let stream = try await transcribeFile(at: url, with: transcriber)
        for try await _ in stream {}

        #expect(abs(transcriber.receivedSeconds - 4.0) < 0.01)
        for drift in transcriber.statedStarts { #expect(abs(drift) < 0.001, "入力の開始位置がファイルの位置からずれている: \(drift)") }
    }

    @Test("開始位置（from）を渡すと、役へ渡る音声はその位置から途切れず最後まで続き、入力が明示する位置はファイル上の位置と一致する。結果の時刻はファイルの時刻のまま、無音の区間の結果だけが捨てられる")
    func audioHandedOverStartsAtFrom() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)
        let transcriber = ScriptedFileTranscriber(script: [
            result("大きい音です", isFinal: true, 1.2, 1.8),
            result("無音の幻です", isFinal: true, 2.5, 3.5),
        ], origin: 1.0)

        let stream = try await transcribeFile(at: url, with: transcriber, from: 1.0)
        var kept: [TranscriptionResult] = []
        for try await item in stream { kept.append(item) }

        // 1 秒から 4 秒までの 3 秒分が、途切れず渡る
        #expect(abs(transcriber.receivedSeconds - 3.0) < 0.01)
        #expect(!transcriber.statedStarts.isEmpty, "開始位置を明示する入力がある")
        for drift in transcriber.statedStarts { #expect(abs(drift) < 0.001, "入力の開始位置がファイルの位置からずれている: \(drift)") }
        #expect(kept == [result("大きい音です", isFinal: true, 1.2, 1.8)])
    }

    @Test("実ファイルの無音の区間の確定結果だけが捨てられる。大きい音の区間の結果と、測れない区間（ファイルの外）の結果は、時刻をそのままに残る")
    func silentIntervalResultsAreDropped() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)
        let transcriber = ScriptedFileTranscriber(script: [
            result("大きい音です", isFinal: true, 0.5, 1.5),
            result("無音の幻です", isFinal: true, 2.5, 3.5),
            result("ファイルの外", isFinal: true, 10, 11),
        ])

        let stream = try await transcribeFile(at: url, with: transcriber)
        var kept: [TranscriptionResult] = []
        for try await item in stream { kept.append(item) }

        #expect(kept == [
            result("大きい音です", isFinal: true, 0.5, 1.5),
            result("ファイルの外", isFinal: true, 10, 11),
        ])
    }

    @Test("映像つきの動画（音声のトラックは 1 本）でも、音のある区間の結果だけが残り、役へ渡る音声は 0 秒から最後まで続く。音声のトラックの本数は 1")
    func movieWithSingleAudioTrack() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("source.wav")
        try writeRecording(wav, loudSeconds: 2, silentSeconds: 2)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await FileAudioTestSupport.writeMovie(movie, audio: wav, videoSeconds: 4)
        let asset = AVURLAsset(url: movie)
        #expect(try await asset.loadTracks(withMediaType: .video).count == 1) // 前提: 入力は映像つき
        let transcriber = ScriptedFileTranscriber(script: [
            result("大きい音です", isFinal: true, 0.5, 1.5),
            result("無音の幻です", isFinal: true, 2.5, 3.5),
        ])

        let stream = try await transcribeFile(at: movie, with: transcriber)
        var kept: [TranscriptionResult] = []
        for try await item in stream { kept.append(item) }

        #expect(kept == [result("大きい音です", isFinal: true, 0.5, 1.5)])
        #expect(abs(transcriber.receivedSeconds - 4.0) < 0.1)
        #expect(try await readFileHeader(of: movie).audioTrackCount == 1)
    }

    @Test("音声のトラックが 2 本の動画では、最初のトラックだけで無音を判定する。本数は 2")
    func firstOfTwoAudioTracksIsUsed() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = dir.appendingPathComponent("first.wav") // 前半が音、後半が無音
        try writeRecording(first, loudSeconds: 2, silentSeconds: 2)
        let second = dir.appendingPathComponent("second.wav") // 前半が無音、後半が音（最初のトラックとは逆）
        try writeRecording(second, loudSeconds: 0, silentSeconds: 2)
        let secondTail = dir.appendingPathComponent("second-tail.wav")
        try writeRecording(secondTail, loudSeconds: 2, silentSeconds: 0)
        let reversed = try await Self.concatenated(second, secondTail, into: dir.appendingPathComponent("second-reversed.m4a"))
        let movie = dir.appendingPathComponent("meeting.mov")
        try await FileAudioTestSupport.writeMovie(movie, audio: first, videoSeconds: 4, moreAudio: [reversed])
        let tracks = try await AVURLAsset(url: movie).loadTracks(withMediaType: .audio)
        #expect(tracks.count == 2) // 前提: 音声のトラックが 2 本ある
        let transcriber = ScriptedFileTranscriber(script: [
            result("最初のトラックの音", isFinal: true, 0.5, 1.5),
            result("2 本目のトラックの音", isFinal: true, 2.5, 3.5),
        ])

        let stream = try await transcribeFile(at: movie, with: transcriber)
        var kept: [TranscriptionResult] = []
        for try await item in stream { kept.append(item) }

        #expect(kept == [result("最初のトラックの音", isFinal: true, 0.5, 1.5)])
        #expect(try await readFileHeader(of: movie).audioTrackCount == 2)
    }

    @Test("mp4 の動画（音声のトラックは 1 本）でも、音のある区間の結果だけが残り、役へ渡る音声は 0 秒から最後まで続く")
    func mp4WithSingleAudioTrack() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("source.wav")
        try writeRecording(wav, loudSeconds: 2, silentSeconds: 2)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await FileAudioTestSupport.writeMovie(movie, audio: wav, videoSeconds: 4)
        let mp4 = dir.appendingPathComponent("meeting.mp4")
        try await Self.remuxToMP4(movie, into: mp4)
        let asset = AVURLAsset(url: mp4)
        #expect(mp4.pathExtension == "mp4") // 前提: 入力は mp4
        #expect(try await asset.loadTracks(withMediaType: .video).count == 1) // 前提: 映像つき
        #expect(try await asset.loadTracks(withMediaType: .audio).count == 1) // 前提: 音声は 1 本
        let transcriber = ScriptedFileTranscriber(script: [
            result("大きい音です", isFinal: true, 0.5, 1.5),
            result("無音の幻です", isFinal: true, 2.5, 3.5),
        ])

        let stream = try await transcribeFile(at: mp4, with: transcriber)
        var kept: [TranscriptionResult] = []
        for try await item in stream { kept.append(item) }

        #expect(kept == [result("大きい音です", isFinal: true, 0.5, 1.5)])
        #expect(abs(transcriber.receivedSeconds - 4.0) < 0.1)
    }

    @Test("音声のトラックが 2 本の動画の情報は、file-duration → 本数 2 の file-audio-tracks の順で、後から接続したクライアントに届く")
    func headerOfTwoAudioTracksReachesLateClient() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let movie = try await Self.movieWithAudioTracks(2, in: dir)

        let (duration, tracks) = try await Self.receiveHeader(of: movie)

        #expect(tracks == "{\"count\":2,\"type\":\"file-audio-tracks\"}")
        #expect(duration == (try HelperEvent.fileDuration(duration: try await fileDuration(of: movie)).jsonString()))
    }

    @Test("音声のトラックが 1 本の動画の情報は、本数 1 の file-audio-tracks が届く")
    func headerOfSingleAudioTrackReachesLateClient() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let movie = try await Self.movieWithAudioTracks(1, in: dir)

        let (_, tracks) = try await Self.receiveHeader(of: movie)

        #expect(tracks == "{\"count\":1,\"type\":\"file-audio-tracks\"}")
    }

    /// 読む → 待ち受け中のサーバーに保持して流す → 後から接続して、受け取った 2 件（file-duration、file-audio-tracks）を返す。
    private static func receiveHeader(of url: URL) async throws -> (duration: String, tracks: String) {
        let header = try await readFileHeader(of: url)
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        await broadcastFileHeader(header, on: server)

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        return (try await receiveText(task), try await receiveText(task))
    }

    private static func receiveText(_ task: URLSessionWebSocketTask) async throws -> String {
        guard case .string(let text) = try await task.receive() else { throw CocoaError(.fileReadUnknown) }
        return text
    }

    /// 映像 1 本と、音声 `count`（1 か 2）本を持つ 4 秒の mov。
    private static func movieWithAudioTracks(_ count: Int, in dir: URL) async throws -> URL {
        let first = dir.appendingPathComponent("first.wav")
        try writeRecording(first, loudSeconds: 2, silentSeconds: 2)
        var more: [URL] = []
        if count == 2 {
            let second = dir.appendingPathComponent("second.wav")
            try writeRecording(second, loudSeconds: 2, silentSeconds: 2)
            more = [second]
        }
        let movie = dir.appendingPathComponent("meeting-\(count).mov")
        try await FileAudioTestSupport.writeMovie(movie, audio: first, videoSeconds: 4, moreAudio: more)
        let tracks = try await AVURLAsset(url: movie).loadTracks(withMediaType: .audio)
        #expect(tracks.count == count) // 前提: 音声のトラックの本数
        return movie
    }

    /// mov の映像と音声を、再エンコードせずに mp4 に入れ替える。
    private static func remuxToMP4(_ source: URL, into output: URL) async throws {
        let session = try #require(AVAssetExportSession(asset: AVURLAsset(url: source), presetName: AVAssetExportPresetPassthrough))
        try await session.export(to: output, as: .mp4)
    }

    /// 無音の WAV の後ろに音のある WAV をつないだ、4 秒の m4a。
    private static func concatenated(_ head: URL, _ tail: URL, into output: URL) async throws -> URL {
        let composition = AVMutableComposition()
        let track = try #require(composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid))
        var cursor = CMTime.zero
        for url in [head, tail] {
            let asset = AVURLAsset(url: url)
            let source = try #require(try await asset.loadTracks(withMediaType: .audio).first)
            let duration = try await asset.load(.duration)
            try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: cursor)
            cursor = CMTimeAdd(cursor, duration)
        }
        let session = try #require(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A))
        try await session.export(to: output, as: .m4a)
        return output
    }
}
