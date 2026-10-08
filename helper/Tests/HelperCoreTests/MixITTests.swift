import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// セッションの録音（相手・自分の全ファイル）を、0 秒の位置から重ねて 1 本の 16 kbps モノラル m4a にする。
// 入力は、テストの中で作った短い m4a。

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-mix-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// `frequency` Hz（既定 440）のサイン波を `seconds` 秒分入れた m4a（AAC 64 kbps・モノラル。実際の録音と同じ形式）を作る。
private func writeRecording(_ url: URL, seconds: Double, frequency: Double = 440, noise: Bool = false) throws {
    let sampleRate = 48_000.0
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1))
    let frames = AVAudioFrameCount(sampleRate * seconds)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    let samples = try #require(buffer.floatChannelData)[0]
    var generator = SystemRandomNumberGenerator()
    for i in 0..<Int(frames) {
        samples[i] = noise
            ? Float.random(in: -0.5...0.5, using: &generator)
            : 0.5 * Float(sin(2 * Double.pi * frequency * Double(i) / sampleRate))
    }
    let file = try AVAudioFile(forWriting: url, settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 64_000,
    ])
    try file.write(from: buffer)
}

private func duration(of url: URL) throws -> Double {
    let file = try AVAudioFile(forReading: url)
    return Double(file.length) / file.processingFormat.sampleRate
}

/// ファイル直下のボックス（4 バイトの大きさ + 4 文字の型）の型を、先頭から順に返す。
private func topLevelBoxes(of url: URL) throws -> [(type: String, size: Int)] {
    let data = try Data(contentsOf: url)
    var boxes: [(type: String, size: Int)] = []
    var offset = 0
    while offset + 8 <= data.count {
        var size = 0
        for i in 0..<4 { size = size << 8 | Int(data[offset + i]) }
        let type = String(decoding: data[(offset + 4)..<(offset + 8)], as: UTF8.self)
        if size == 1 {
            #expect(offset + 16 <= data.count)
            size = 0
            for i in 8..<16 { size = size << 8 | Int(data[offset + i]) }
        } else if size == 0 {
            size = data.count - offset
        }
        #expect(size >= 8)
        boxes.append((type, size))
        offset += max(size, 8)
    }
    return boxes
}

/// 出力を読み、[start, end) 秒の区間に `frequency` Hz の成分がどれだけあるか（Goertzel 法。サイン波の振幅にほぼ等しい）。
private func amplitude(of url: URL, at frequency: Double, from start: Double, to end: Double) throws -> Double {
    let file = try AVAudioFile(forReading: url)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: buffer)
    let samples = try #require(buffer.floatChannelData)[0]
    let rate = file.processingFormat.sampleRate
    let from = Int(start * rate), to = min(Int(end * rate), Int(buffer.frameLength))
    let omega = 2 * Double.pi * frequency / rate
    var re = 0.0, im = 0.0
    for i in from..<to {
        re += Double(samples[i]) * cos(omega * Double(i))
        im += Double(samples[i]) * sin(omega * Double(i))
    }
    return 2 * (re * re + im * im).squareRoot() / Double(to - from)
}

private struct Session {
    let directory: URL
    var output: URL { directory.appendingPathComponent("out").appendingPathComponent("mix.m4a") }

    /// 相手 3 秒・440 Hz（最長）、自分 2 秒・1320 Hz、相手-2 1 秒・880 Hz、自分-3 0.5 秒・1760 Hz。入力ごとに周波数が違う。
    static func make() throws -> Session {
        let directory = try temporaryDirectory()
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("out"), withIntermediateDirectories: true)
        try writeRecording(directory.appendingPathComponent("相手.m4a"), seconds: 3.0, frequency: 440)
        try writeRecording(directory.appendingPathComponent("相手-2.m4a"), seconds: 1.0, frequency: 880)
        try writeRecording(directory.appendingPathComponent("自分.m4a"), seconds: 2.0, frequency: 1320)
        try writeRecording(directory.appendingPathComponent("自分-3.m4a"), seconds: 0.5, frequency: 1760)
        return Session(directory: directory)
    }
}

@Suite("録音の混合")
struct MixITTests {
    @Test("全トラックの全ファイルを 0 秒から重ね、一番長い入力の長さの AAC・モノラルが 1 本できる")
    func mixesAllTracksToLongest() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        let inputs = try mixInputs(inSession: session.directory, track: nil)
        try await mixRecordings(inputs, to: session.output)

        let file = try AVAudioFile(forReading: session.output)
        #expect(file.fileFormat.settings[AVFormatIDKey] as? UInt32 == kAudioFormatMPEG4AAC)
        #expect(file.fileFormat.channelCount == 1)
        // 一番長い入力（相手 3 秒）の長さ。足し算（3 + 1 + 2 + 0.5）や、一番短い入力の長さにはならない
        #expect(abs(try duration(of: session.output) - 3.0) < 0.1)
    }

    @Test("自分 だけの指定では、相手 のファイルを重ねない（長さは 自分 の一番長い 2 秒）")
    func selfTrackExcludesOther() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        let inputs = try mixInputs(inSession: session.directory, track: .自分)
        #expect(inputs.map(\.lastPathComponent).sorted() == ["自分-3.m4a", "自分.m4a"])
        try await mixRecordings(inputs, to: session.output)

        // 相手（3 秒）を混ぜたら 3 秒になる。絞り込みが効いていれば 2 秒
        #expect(abs(try duration(of: session.output) - 2.0) < 0.1)
    }

    @Test("入力ごとの音が、それぞれの長さの間だけ 0 秒から重なって出力に入る")
    func overlaysEveryInputFromZero() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)

        // 先頭 0.1〜0.4 秒は 4 本すべてが鳴っている（0 秒から重なっている）
        for frequency in [440.0, 880, 1320, 1760] {
            #expect(try amplitude(of: session.output, at: frequency, from: 0.1, to: 0.4) > 0.05)
        }
        // 0.7〜0.9 秒: 1760 Hz（0.5 秒）は終わり、残り 3 本は鳴っている
        #expect(try amplitude(of: session.output, at: 1760, from: 0.7, to: 0.9) < 0.02)
        for frequency in [440.0, 880, 1320] {
            #expect(try amplitude(of: session.output, at: frequency, from: 0.7, to: 0.9) > 0.05)
        }
        // 1.2〜1.8 秒: 880 Hz（1 秒）が終わり、440 と 1320 が鳴っている
        #expect(try amplitude(of: session.output, at: 880, from: 1.2, to: 1.8) < 0.02)
        #expect(try amplitude(of: session.output, at: 440, from: 1.2, to: 1.8) > 0.05)
        #expect(try amplitude(of: session.output, at: 1320, from: 1.2, to: 1.8) > 0.05)
        // 2.2〜2.8 秒: 440 Hz（相手 3 秒）だけ
        #expect(try amplitude(of: session.output, at: 1320, from: 2.2, to: 2.8) < 0.02)
        #expect(try amplitude(of: session.output, at: 440, from: 2.2, to: 2.8) > 0.05)
    }

    @Test("自分 だけの指定では、出力に 相手 の音（440・880 Hz）が入らない")
    func selfTrackOutputHasNoOtherTone() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: .自分), to: session.output)

        #expect(try amplitude(of: session.output, at: 1320, from: 0.1, to: 0.4) > 0.05)
        #expect(try amplitude(of: session.output, at: 1760, from: 0.1, to: 0.4) > 0.05)
        #expect(try amplitude(of: session.output, at: 440, from: 0.1, to: 0.4) < 0.02)
        #expect(try amplitude(of: session.output, at: 880, from: 0.1, to: 0.4) < 0.02)
    }

    @Test("出力は moov が mdat より前（先頭側）にある")
    func moovPrecedesMdat() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)

        let types = try topLevelBoxes(of: session.output).map(\.type)
        let moov = try #require(types.firstIndex(of: "moov"))
        let mdat = try #require(types.firstIndex(of: "mdat"))
        #expect(moov < mdat)
    }

    @Test("出力のビットレートは約 16 kbps（入力の 64 kbps ではない）")
    func bitRateIsAbout16kbps() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)

        let mdat = try #require(try topLevelBoxes(of: session.output).first { $0.type == "mdat" })
        let bitsPerSecond = Double((mdat.size - 8) * 8) / (try duration(of: session.output))
        // 目標は 16 kbps。入力が純音だと、エンコーダは目標より少ないビットで足りるので、下限は緩める（入力の 64 kbps の形式では出ない上限が効く）
        #expect(bitsPerSecond > 8_000)
        #expect(bitsPerSecond < 20_000)
    }

    @Test("雑音の入力でも出力のビットレートは 12〜20 kbps（16 kbps の指定が効いている）")
    func bitRateIsAbout16kbpsForNoise() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try writeRecording(directory.appendingPathComponent("相手.m4a"), seconds: 3, noise: true)
        let output = directory.appendingPathComponent("mix.m4a")

        try await mixRecordings(mixInputs(inSession: directory, track: nil), to: output)

        let mdat = try #require(try topLevelBoxes(of: output).first { $0.type == "mdat" })
        let bitsPerSecond = Double((mdat.size - 8) * 8) / (try duration(of: output))
        #expect(bitsPerSecond > 12_000)
        #expect(bitsPerSecond < 20_000)
    }

    @Test("混ぜた結果に音が入っている（無音のファイルではない）")
    func outputIsAudible() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)

        let file = try AVAudioFile(forReading: session.output)
        let frames = AVAudioFrameCount(file.length)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
        try file.read(into: buffer)
        let samples = try #require(buffer.floatChannelData)[0]
        var peak: Float = 0
        for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(samples[i])) }
        #expect(peak > 0.1)
    }

    // MARK: 入力の選択

    private func makeNamedFiles(_ names: [String]) throws -> URL {
        let directory = try temporaryDirectory()
        for name in names {
            try Data("x".utf8).write(to: directory.appendingPathComponent(name))
        }
        return directory
    }

    @Test("名前の規則に合う録音（相手.m4a・相手-2.m4a・自分.m4a・自分-10.m4a）はすべて選ばれる")
    func selectsRecordingNames() throws {
        let directory = try makeNamedFiles(["相手.m4a", "相手-2.m4a", "自分.m4a", "自分-10.m4a"])
        defer { try? FileManager.default.removeItem(at: directory) }

        let names = try mixInputs(inSession: directory, track: nil).map(\.lastPathComponent).sorted()
        #expect(names == ["相手-2.m4a", "相手.m4a", "自分-10.m4a", "自分.m4a"].sorted())
    }

    @Test("名前の規則に合わないファイルは選ばれない")
    func ignoresNonRecordingNames() throws {
        let directory = try makeNamedFiles([
            "相手.m4a", "自分-10.m4a",
            "相手-1.m4a", "相手-02.m4a", "相手-x.m4a", "相手-99999999999999999999.m4a",
            "相手.wav", "相手-2.m4a.tmp", "mix.m4a", "log.jsonl",
        ])
        defer { try? FileManager.default.removeItem(at: directory) }

        let names = try mixInputs(inSession: directory, track: nil).map(\.lastPathComponent).sorted()
        #expect(names == ["相手.m4a", "自分-10.m4a"].sorted())
    }

    @Test("トラックを 自分 に絞ると、自分 のファイルだけが選ばれる")
    func selectionFiltersByTrack() throws {
        let directory = try makeNamedFiles(["相手.m4a", "相手-2.m4a", "自分.m4a", "自分-10.m4a"])
        defer { try? FileManager.default.removeItem(at: directory) }

        let names = try mixInputs(inSession: directory, track: .自分).map(\.lastPathComponent).sorted()
        #expect(names == ["自分-10.m4a", "自分.m4a"].sorted())
    }

    // MARK: 失敗

    @Test("セッションのフォルダが無ければ throw する")
    func missingSessionThrows() {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-mix-missing-\(UUID().uuidString)")
        #expect(throws: (any Error).self) { try mixInputs(inSession: missing, track: nil) }
    }

    @Test("混ぜる録音が 1 本も無ければ throw する")
    func noRecordingsThrows() throws {
        let directory = try makeNamedFiles(["log.jsonl"])
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(throws: (any Error).self) { try mixInputs(inSession: directory, track: nil) }
    }

    @Test("自分 を指定して 自分 の録音が無ければ throw する（相手 だけあっても）")
    func noSelfRecordingThrows() throws {
        let directory = try makeNamedFiles(["相手.m4a"])
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(throws: (any Error).self) { try mixInputs(inSession: directory, track: .自分) }
    }

    @Test("出力のフォルダが無ければ throw し、出力は作られない")
    func missingOutputDirectoryThrows() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        let output = session.directory.appendingPathComponent("nope").appendingPathComponent("mix.m4a")

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: output)
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }

    @Test("出力のファイルが既にあれば throw し、中身を書き換えない")
    func existingOutputThrows() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try Data("keep".utf8).write(to: session.output)

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)
        }
        #expect(try Data(contentsOf: session.output) == Data("keep".utf8))
    }

    @Test("読めない入力（壊れた m4a）が混ざっていたら throw する")
    func unreadableInputThrows() async throws {
        let session = try Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try Data("not audio".utf8).write(to: session.directory.appendingPathComponent("自分-4.m4a"))

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)
        }
    }
}
