import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// 録画のファイルの音声だけを m4a に書く（exportFileAudio）の IT。ファイルはテストの中で作った合成のもの。
// 確かめること: WAV からも映像つきの mov からも音声だけの m4a ができる / 音声の先頭が 0 秒にそろう / 出力が既にあれば上書きせず失敗する。

private typealias Support = FileAudioTestSupport

@Suite("録画のファイルから音声を書く（exportFileAudio）", .timeLimit(.minutes(1)))
struct FileAudioExportITTests {
    @Test("WAV は、音声の長さが同じ m4a になり、音声のトラックだけを持つ")
    func wavToM4a() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("meeting.wav")
        try Support.writeWAV(input, loudSeconds: 2, silentSeconds: 2)
        let output = dir.appendingPathComponent("相手.m4a")

        try await exportFileAudio(from: input, to: output)

        let asset = AVURLAsset(url: output)
        let duration = try await asset.load(.duration).seconds
        #expect(abs(duration - 4) < 0.3)
        #expect(try await asset.loadTracks(withMediaType: .audio).count == 1)
        #expect(try await asset.loadTracks(withMediaType: .video).isEmpty)
    }

    @Test("音声の先頭が 0 秒にそろう: 前半の音は前半に、後半の無音は後半に残る")
    func alignedToZero() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("meeting.wav")
        try Support.writeWAV(input, loudSeconds: 2, silentSeconds: 2)
        let output = dir.appendingPathComponent("相手.m4a")

        try await exportFileAudio(from: input, to: output)

        #expect(try Support.rms(of: output, from: 0.3, to: 1.7) > 0.1)
        #expect(try Support.rms(of: output, from: 2.4, to: 3.6) < 0.02)
    }

    @Test("映像つきの mov からは音声だけを書く。映像のトラックは出力に無く、音声の長さは一致する")
    func movieToAudioOnly() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("source.wav")
        try Support.writeWAV(wav, loudSeconds: 2, silentSeconds: 1)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await Support.writeMovie(movie, audio: wav, videoSeconds: 3)
        let sources = try await AVURLAsset(url: movie).loadTracks(withMediaType: .video)
        #expect(sources.count == 1) // 前提: 入力は映像つき
        let output = dir.appendingPathComponent("相手.m4a")

        try await exportFileAudio(from: movie, to: output)

        let asset = AVURLAsset(url: output)
        #expect(abs(try await asset.load(.duration).seconds - 3) < 0.3)
        #expect(try await asset.loadTracks(withMediaType: .video).isEmpty)
        #expect(try await asset.loadTracks(withMediaType: .audio).count == 1)
    }

    @Test("音声のトラックが 2 本の mov からは、最初のトラックの音だけを書く。出力の音声は 1 本で、映像は無い")
    func firstOfTwoAudioTracksIsExported() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = dir.appendingPathComponent("first.wav") // 前半が音、後半が無音
        try Support.writeWAV(first, loudSeconds: 2, silentSeconds: 2)
        let second = dir.appendingPathComponent("second.wav") // 全体が音（混ぜた場合も 2 本目を読んだ場合も、後半の rms が上がる）
        try Support.writeWAV(second, loudSeconds: 4, silentSeconds: 0)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await Support.writeMovie(movie, audio: first, videoSeconds: 4, moreAudio: [second])
        #expect(try await AVURLAsset(url: movie).loadTracks(withMediaType: .audio).count == 2) // 前提: 音声のトラックが 2 本ある
        let output = dir.appendingPathComponent("相手.m4a")

        try await exportFileAudio(from: movie, to: output)

        let asset = AVURLAsset(url: output)
        #expect(try await asset.loadTracks(withMediaType: .audio).count == 1)
        #expect(try await asset.loadTracks(withMediaType: .video).isEmpty)
        #expect(try Support.rms(of: output, from: 0.3, to: 1.7) > 0.1)
        #expect(try Support.rms(of: output, from: 2.4, to: 3.6) < 0.02)
    }

    @Test("冒頭に空きのある mov でも、空きを残して文字起こしと同じ原点で書き、末尾も欠けない")
    func trackStartingAfterZero() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("source.wav")
        try Support.writeWAV(wav, loudSeconds: 2, silentSeconds: 2)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await Support.writeMovie(movie, audio: wav, videoSeconds: 5, audioStartSeconds: 1)
        let track = try #require(try await AVURLAsset(url: movie).loadTracks(withMediaType: .audio).first)
        let range = try await track.load(.timeRange)
        let output = dir.appendingPathComponent("相手.m4a")

        try await exportFileAudio(from: movie, to: output)

        let duration = try await AVURLAsset(url: output).load(.duration).seconds
        // 出力の長さはトラック自身の範囲の長さ（入力の 0 秒始まりを仮定して切り詰めない）
        #expect(abs(duration - range.duration.seconds) < 0.3)
        // 末尾の無音まで残っている: 前提の音声は 4 秒分ある
        #expect(duration > 3.7)
        // 音声の位置: 冒頭 1 秒の空きは出力にも残る（FileAudioInputs が読む PCM も、1 秒から音が始まる）。1 秒の音は 1〜3 秒、末尾の無音は 3 秒以降
        #expect(try Support.rms(of: output, from: 0.1, to: 0.8) < 0.02)
        #expect(try Support.rms(of: output, from: 1.3, to: 2.7) > 0.1)
        #expect(try Support.rms(of: output, from: 3.3, to: 3.9) < 0.02)
    }

    @Test("出力が既にあると失敗し、既にあるファイルは変わらない")
    func existingOutputFails() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("meeting.wav")
        try Support.writeWAV(input, loudSeconds: 1, silentSeconds: 1)
        let output = dir.appendingPathComponent("相手.m4a")
        try Data("既にある".utf8).write(to: output)

        await #expect(throws: (any Error).self) {
            try await exportFileAudio(from: input, to: output)
        }
        #expect(try Data(contentsOf: output) == Data("既にある".utf8))
    }

    @Test("読めない入力は失敗し、出力は残らない")
    func unreadableInputFails() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("broken.m4a")
        try Data("音声ではない".utf8).write(to: input)
        let output = dir.appendingPathComponent("相手.m4a")

        await #expect(throws: (any Error).self) {
            try await exportFileAudio(from: input, to: output)
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }

    // `cli recorded --self`: 2 本の入力から、ライブと同じ名前（相手.m4a・自分.m4a）の 2 本をセッションのフォルダへ書く
    @Test("相手用と自分用の 2 本から、相手.m4a と自分.m4a がフォルダに書かれる。入れ替わらず、それぞれ自分の入力の音になる")
    func exportsBothTracksUnderLiveNames() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav") // 前半が音、後半が無音
        try Support.writeWAV(theirs, loudSeconds: 2, silentSeconds: 2)
        let session = dir.appendingPathComponent("session", isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)

        // 自分用: 0〜2 秒が無音、2〜4 秒が音（相手用と逆）
        let mineSilentThenLoud = dir.appendingPathComponent("me-silent-then-loud.wav")
        try writeSilentThenLoud(mineSilentThenLoud, silentSeconds: 2, loudSeconds: 2)

        try await exportFileAudioTracks(theirs: theirs, mine: mineSilentThenLoud, into: session)

        let theirsOutput = session.appendingPathComponent(recordingFileName(track: .相手, attempt: 1))
        let mineOutput = session.appendingPathComponent(recordingFileName(track: .自分, attempt: 1))
        #expect(theirsOutput.lastPathComponent == "相手.m4a")
        #expect(mineOutput.lastPathComponent == "自分.m4a")
        #expect(try Support.rms(of: theirsOutput, from: 0.3, to: 1.7) > 0.1)
        #expect(try Support.rms(of: theirsOutput, from: 2.4, to: 3.6) < 0.02)
        #expect(try Support.rms(of: mineOutput, from: 0.3, to: 1.7) < 0.02)
        #expect(try Support.rms(of: mineOutput, from: 2.4, to: 3.6) > 0.1)
        let names = try FileManager.default.contentsOfDirectory(atPath: session.path).sorted()
        #expect(names == ["自分.m4a", "相手.m4a"].sorted())
    }

    @Test("自分用が無いとき（--self なし）は、相手.m4a だけを書き、自分.m4a は作らない")
    func exportsOnlyTheirsWithoutSelfFile() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(theirs, loudSeconds: 1, silentSeconds: 1)
        let session = dir.appendingPathComponent("session", isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)

        try await exportFileAudioTracks(theirs: theirs, mine: nil, into: session)

        #expect(try FileManager.default.contentsOfDirectory(atPath: session.path) == ["相手.m4a"])
    }

    @Test("自分用が動画でも、書かれる 自分.m4a は音声だけ（映像のトラックは無い）")
    func selfMovieIsExportedAsAudioOnly() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(theirs, loudSeconds: 1, silentSeconds: 1)
        let wav = dir.appendingPathComponent("source.wav")
        try Support.writeWAV(wav, loudSeconds: 2, silentSeconds: 1)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await Support.writeMovie(movie, audio: wav, videoSeconds: 3)
        let session = dir.appendingPathComponent("session", isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)

        try await exportFileAudioTracks(theirs: theirs, mine: movie, into: session)

        let asset = AVURLAsset(url: session.appendingPathComponent("自分.m4a"))
        #expect(try await asset.loadTracks(withMediaType: .video).isEmpty)
        #expect(try await asset.loadTracks(withMediaType: .audio).count == 1)
        #expect(abs(try await asset.load(.duration).seconds - 3) < 0.3)
    }

    @Test("自分用が読めないときは失敗する（相手.m4a だけが残ったまま成功扱いにならない）")
    func unreadableSelfFileFails() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(theirs, loudSeconds: 1, silentSeconds: 1)
        let broken = dir.appendingPathComponent("me.m4a")
        try Data("音声ではない".utf8).write(to: broken)
        let session = dir.appendingPathComponent("session", isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)

        await #expect(throws: (any Error).self) {
            try await exportFileAudioTracks(theirs: theirs, mine: broken, into: session)
        }
        #expect(!FileManager.default.fileExists(atPath: session.appendingPathComponent("自分.m4a").path))
    }
}

/// 前半 `silentSeconds` 秒が無音、後半 `loudSeconds` 秒が 440 Hz のサイン波の WAV。
private func writeSilentThenLoud(_ url: URL, silentSeconds: Double, loudSeconds: Double) throws {
    let rate = Support.sampleRate
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1))
    let frames = AVAudioFrameCount(rate * (silentSeconds + loudSeconds))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    let samples = try #require(buffer.floatChannelData)[0]
    let silentFrames = Int(rate * silentSeconds)
    for i in 0..<Int(frames) {
        samples[i] = i < silentFrames ? 0 : 0.5 * Float(sin(2 * Double.pi * 440 * Double(i) / rate))
    }
    let file = try AVAudioFile(forWriting: url, settings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    ])
    try file.write(from: buffer)
}
