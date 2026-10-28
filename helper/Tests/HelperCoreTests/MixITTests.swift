import AVFoundation
import Foundation
import Testing
@testable import HelperCore

enum MixTestSupport {
    static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-mix-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func writeRecording(_ url: URL, seconds: Double, frequency: Double = 440, noise: Bool = false) throws {
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

    static func topLevelBoxes(of url: URL) throws -> [(type: String, size: Int)] {
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

    static func writeEmptyRecording(_ url: URL) async throws {
        do {
            _ = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000,
            ])
        }
        let size = try #require(try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
        #expect(size > 0)
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        let duration = try await asset.load(.duration)
        #expect(tracks.isEmpty || !duration.isNumeric || duration <= .zero)
    }

    final class SkippedLines: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String] = []
        var lines: [String] { lock.lock(); defer { lock.unlock() }; return storage }
        func append(_ line: String) { lock.lock(); storage.append(line); lock.unlock() }
    }

    struct Session {
        let directory: URL
        var output: URL { directory.appendingPathComponent("out").appendingPathComponent("mix.m4a") }

        /// 相手 3 秒・440 Hz（最長）、自分 2 秒・1320 Hz、相手-2 1 秒・880 Hz、自分-3 0.5 秒・1760 Hz。入力ごとに周波数が違う。
        static func make() throws -> Session {
            let directory = try MixTestSupport.temporaryDirectory()
            try FileManager.default.createDirectory(at: directory.appendingPathComponent("out"), withIntermediateDirectories: true)
            try MixTestSupport.writeRecording(directory.appendingPathComponent("相手.m4a"), seconds: 3.0, frequency: 440)
            try MixTestSupport.writeRecording(directory.appendingPathComponent("相手-2.m4a"), seconds: 1.0, frequency: 880)
            try MixTestSupport.writeRecording(directory.appendingPathComponent("自分.m4a"), seconds: 2.0, frequency: 1320)
            try MixTestSupport.writeRecording(directory.appendingPathComponent("自分-3.m4a"), seconds: 0.5, frequency: 1760)
            return Session(directory: directory)
        }
    }
}

private typealias Support = MixTestSupport

@Suite("録音の混合", .timeLimit(.minutes(1)))
struct MixITTests {

    @Test("出力は moov が mdat より前（先頭側）にある")
    func moovPrecedesMdat() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }

        try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)

        let types = try Support.topLevelBoxes(of: session.output).map(\.type)
        let moov = try #require(types.firstIndex(of: "moov"))
        let mdat = try #require(types.firstIndex(of: "mdat"))
        #expect(moov < mdat)
    }

    // MARK: 入力の選択

    private func makeNamedFiles(_ names: [String]) throws -> URL {
        let directory = try Support.temporaryDirectory()
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
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        let output = session.directory.appendingPathComponent("nope").appendingPathComponent("mix.m4a")

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: output)
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }

    @Test("出力のファイルが既にあれば throw し、中身を書き換えない")
    func existingOutputThrows() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try Data("keep".utf8).write(to: session.output)

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)
        }
        #expect(try Data(contentsOf: session.output) == Data("keep".utf8))
    }

    @Test("読めない入力（壊れた m4a）が混ざっていたら throw する")
    func unreadableInputThrows() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try Data("not audio".utf8).write(to: session.directory.appendingPathComponent("自分-4.m4a"))

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output)
        }
    }

    // MARK: 空の録音

    @Test("既定の報告先は標準エラーで、飛ばしたファイル名が 1 ファイル 1 行で届く")
    func defaultReportGoesToStandardError() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try await Support.writeEmptyRecording(session.directory.appendingPathComponent("相手-5.m4a"))
        try await Support.writeEmptyRecording(session.directory.appendingPathComponent("自分-6.m4a"))
        let capture = session.directory.appendingPathComponent("stderr.txt")
        let inputs = try mixInputs(inSession: session.directory, track: nil)

        // 標準エラー（fd 2）を一時ファイルへ向けて、既定のクロージャの出力を受ける。
        let saved = dup(2)
        let fd = open(capture.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        #expect(saved >= 0 && fd >= 0)
        dup2(fd, 2)
        close(fd)
        do {
            try await mixRecordings(inputs, to: session.output)
        } catch {
            dup2(saved, 2)
            close(saved)
            throw error
        }
        dup2(saved, 2)
        close(saved)

        let lines = try String(contentsOf: capture, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(lines.filter { $0.contains("相手-5.m4a") }.count == 1)
        #expect(lines.filter { $0.contains("自分-6.m4a") }.count == 1)
        #expect(!lines.contains { $0.contains("相手-5.m4a") && $0.contains("自分-6.m4a") })
    }

    @Test("全部が空なら MixError で失敗し、出力は作られず、終了コードは 0 以外")
    func allEmptyThrows() async throws {
        let directory = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await Support.writeEmptyRecording(directory.appendingPathComponent("相手.m4a"))
        try await Support.writeEmptyRecording(directory.appendingPathComponent("自分.m4a"))
        let output = directory.appendingPathComponent("mix.m4a")

        do {
            try await mixRecordings(mixInputs(inSession: directory, track: nil), to: output, reportSkipped: { _ in })
            Issue.record("全部が空なのに成功した")
        } catch {
            #expect(error is MixError)
            #expect(exitCode(for: error) != 0)
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }

    @Test("壊れた入力は、空の録音が一緒にあっても失敗し、空として報告しない")
    func unreadableInputIsNotSkippedAsEmpty() async throws {
        let session = try Support.Session.make()
        defer { try? FileManager.default.removeItem(at: session.directory) }
        try await Support.writeEmptyRecording(session.directory.appendingPathComponent("相手-5.m4a"))
        try Data("not audio".utf8).write(to: session.directory.appendingPathComponent("自分-4.m4a"))
        let skipped = Support.SkippedLines()

        await #expect(throws: (any Error).self) {
            try await mixRecordings(mixInputs(inSession: session.directory, track: nil), to: session.output, reportSkipped: { skipped.append($0) })
        }
        #expect(!skipped.lines.contains { $0.contains("自分-4.m4a") })
        #expect(!FileManager.default.fileExists(atPath: session.output.path))
    }
}
