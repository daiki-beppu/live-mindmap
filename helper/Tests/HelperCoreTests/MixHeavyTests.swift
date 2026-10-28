import AVFoundation
import Foundation
import Testing
@testable import HelperCore

private typealias Support = MixTestSupport

private func duration(of url: URL) throws -> Double {
    let file = try AVAudioFile(forReading: url)
    return Double(file.length) / file.processingFormat.sampleRate
}

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

private func writeTracklessRecording(_ url: URL) async throws {
    func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)] }
    func box(_ type: String, _ payload: [UInt8]) -> [UInt8] { be32(UInt32(8 + payload.count)) + Array(type.utf8) + payload }
    let identity: [UInt8] = be32(0x0001_0000) + [UInt8](repeating: 0, count: 12) + be32(0x0001_0000) + [UInt8](repeating: 0, count: 12) + be32(0x4000_0000)
    let mvhd = [UInt8](repeating: 0, count: 4) + [UInt8](repeating: 0, count: 8) + be32(1000) + be32(0)
        + be32(0x0001_0000) + [0x01, 0x00] + [UInt8](repeating: 0, count: 10) + identity
        + [UInt8](repeating: 0, count: 24) + be32(2)
    let ftyp = box("ftyp", Array("M4A ".utf8) + be32(0) + Array("M4A mp42isom".utf8))
    try Data(ftyp + box("moov", box("mvhd", mvhd))).write(to: url)
    let tracks = try await AVURLAsset(url: url).loadTracks(withMediaType: .audio)
    #expect(tracks.isEmpty)
}

@Suite("録音の混合", .timeLimit(.minutes(2)))
struct MixHeavyTests {
    @Test("全トラックの全ファイルを 0 秒から重ね、一番長い入力の長さの AAC・モノラルが 1 本できる")
    func mixesAllTracksToLongest() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        let inputs = try mixInputs(inSession: session.directory, track: nil)
        try await mixRecordings(inputs, to: session.output)

        let file = try AVAudioFile(forReading: session.output)
        #expect(file.fileFormat.settings[AVFormatIDKey] as? UInt32 == kAudioFormatMPEG4AAC)
        #expect(file.fileFormat.channelCount == 1)
        #expect(file.fileFormat.sampleRate == 24_000)
        // 一番長い入力（相手 3 秒）の長さ。足し算（3 + 1 + 2 + 0.5）や、一番短い入力の長さにはならない
        #expect(abs(try duration(of: session.output) - 3.0) < 0.1)
    }

    @Test("自分 だけの指定では、相手 のファイルを重ねない（長さは 自分 の一番長い 2 秒）")
    func selfTrackExcludesOther() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        let inputs = try mixInputs(inSession: session.directory, track: .自分)
        #expect(inputs.map(\.lastPathComponent).sorted() == ["自分-3.m4a", "自分.m4a"])
        try await mixRecordings(inputs, to: session.output)

        // 相手（3 秒）を混ぜたら 3 秒になる。絞り込みが効いていれば 2 秒
        #expect(abs(try duration(of: session.output) - 2.0) < 0.1)
    }

    @Test("入力ごとの音が、それぞれの長さの間だけ 0 秒から重なって出力に入る")
    func overlaysEveryInputFromZero() async throws {
        let session = try Support.Session.make()
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
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: .自分), to: session.output)

        #expect(try amplitude(of: session.output, at: 1320, from: 0.1, to: 0.4) > 0.05)
        #expect(try amplitude(of: session.output, at: 1760, from: 0.1, to: 0.4) > 0.05)
        #expect(try amplitude(of: session.output, at: 440, from: 0.1, to: 0.4) < 0.02)
        #expect(try amplitude(of: session.output, at: 880, from: 0.1, to: 0.4) < 0.02)
    }

    @Test("出力のビットレートは 40 kbps 未満（入力の 64 kbps ではない）")
    func bitRateIsAtMost40kbps() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)

        let mdat = try #require(try Support.topLevelBoxes(of: session.output).first { $0.type == "mdat" })
        let bitsPerSecond = Double((mdat.size - 8) * 8) / (try duration(of: session.output))
        // 目標は 32 kbps。入力が純音だと、エンコーダは目標より少ないビットで足りるので、下限は緩める（入力の 64 kbps の形式では出ない上限が効く）
        #expect(bitsPerSecond > 8_000)
        #expect(bitsPerSecond < 40_000)
    }

    @Test("雑音の入力でも出力のビットレートは 24〜40 kbps（32 kbps の指定が効いている）")
    func bitRateIsAbout32kbpsForNoise() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Support.writeRecording(directory.appendingPathComponent("相手.m4a"), seconds: 3, noise: true)
        let output = directory.appendingPathComponent("mix.m4a")

        try await mixRecordings(mixInputs(inSession: directory, track: nil), to: output)

        let mdat = try #require(try Support.topLevelBoxes(of: output).first { $0.type == "mdat" })
        let bitsPerSecond = Double((mdat.size - 8) * 8) / (try duration(of: output))
        #expect(bitsPerSecond > 24_000)
        #expect(bitsPerSecond < 40_000)
    }

    @Test("混ぜた結果に音が入っている（無音のファイルではない）")
    func outputIsAudible() async throws {
        let session = try Support.Session.make()
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

    @Test("空の録音（音声なし）は飛ばして残りを重ね、飛ばしたファイル名を 1 ファイル 1 行で報告する")
    func skipsEmptyRecordings() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try await Support.writeEmptyRecording(session.directory.appendingPathComponent("相手-5.m4a"))
        try await Support.writeEmptyRecording(session.directory.appendingPathComponent("自分-6.m4a"))
        let skipped = Support.SkippedLines()

        let inputs = try mixInputs(inSession: session.directory, track: nil)
        #expect(inputs.count == 6)
        try await mixRecordings(inputs, to: session.output, reportSkipped: { skipped.append($0) })

        #expect(abs(try duration(of: session.output) - 3.0) < 0.1)
        for frequency in [440.0, 880, 1320, 1760] {
            #expect(try amplitude(of: session.output, at: frequency, from: 0.1, to: 0.4) > 0.05)
        }
        let lines = skipped.lines
        #expect(lines.count == 2)
        #expect(lines.filter { $0.contains("相手-5.m4a") }.count == 1)
        #expect(lines.filter { $0.contains("自分-6.m4a") }.count == 1)
        for kept in ["相手.m4a", "相手-2.m4a", "自分.m4a", "自分-3.m4a"] {
            #expect(!lines.contains { $0.contains(kept) })
        }
    }

    @Test("音声のトラックが 1 本も無い m4a も飛ばし、残りを混ぜて、ファイル名を報告する")
    func skipsTracklessRecording() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try await writeTracklessRecording(session.directory.appendingPathComponent("相手-5.m4a"))
        let skipped = Support.SkippedLines()

        let inputs = try mixInputs(inSession: session.directory, track: nil)
        try await mixRecordings(inputs, to: session.output, reportSkipped: { skipped.append($0) })

        #expect(abs(try duration(of: session.output) - 3.0) < 0.1)
        for frequency in [440.0, 880, 1320, 1760] {
            #expect(try amplitude(of: session.output, at: frequency, from: 0.1, to: 0.4) > 0.05)
        }
        #expect(skipped.lines.count == 1)
        #expect(skipped.lines.filter { $0.contains("相手-5.m4a") }.count == 1)
    }
}
