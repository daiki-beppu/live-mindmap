import CWebRTCAPM
import Darwin
import Foundation
import HelperCore
import Testing
@testable import stt_bench

@Suite("実録音の読み込みからエコー計測まで", .timeLimit(.minutes(2)))
struct RecordedEchoHeavyTests {
    @Test("追加候補の設定で native AEC3 を作り、複数の capture フレームを処理できる", arguments: [
        "suppress-lf-0.6", "delay-hint-40", "ep-gain-0.1",
    ])
    func processesEachCandidate(name: String) throws {
        let candidate = try #require(EchoCandidate(name))
        let canceller = try WebRTCEchoCanceller(settings: candidate.settings)
        let reference = [Float](repeating: 0.01, count: echoFrameSamples)
        var capture = [Float](repeating: 0.02, count: echoFrameSamples)
        for _ in 0..<4 {
            reference.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
            capture.withUnsafeMutableBufferPointer { canceller.processCapture($0.baseAddress!) }
            #expect(capture.allSatisfy { $0.isFinite })
        }
    }

    @Test("native 境界は未指定と 0〜500 ms を受け付ける", arguments: [-1, 0, 40, 500])
    func acceptsNativeDelayHint(delayMs: Int32) throws {
        var settings = nativeSettings(delayMs: delayMs, suppression: 0.4)
        let handle = try #require(apm_create(48_000, 1, &settings))
        defer { apm_destroy(handle) }
        let reference = [Float](repeating: 0, count: 480)
        var capture = [Float](repeating: 0.01, count: 480)
        for _ in 0..<4 {
            #expect(reference.withUnsafeBufferPointer { apm_process_reverse(handle, $0.baseAddress!, 480) } == 0)
            #expect(capture.withUnsafeMutableBufferPointer { apm_process_capture(handle, $0.baseAddress!, 480) } == 0)
        }
    }

    @Test("範囲外の遅延ヒントを native 境界で黙って補正しない", arguments: [-2, 501])
    func rejectsInvalidNativeDelayHint(delayMs: Int32) {
        var settings = nativeSettings(delayMs: delayMs, suppression: 0.4)
        let handle = apm_create(48_000, 1, &settings)
        defer { if let handle { apm_destroy(handle) } }
        #expect(handle == nil)
    }

    @Test("範囲外の抑制閾値を native 境界で黙って補正しない", arguments: [Float(-0.1), Float(100.1)])
    func rejectsInvalidNativeSuppression(suppression: Float) {
        var settings = nativeSettings(delayMs: -1, suppression: suppression)
        let handle = apm_create(48_000, 1, &settings)
        defer { if let handle { apm_destroy(handle) } }
        #expect(handle == nil)
    }

    private func nativeSettings(delayMs: Int32, suppression: Float) -> ApmEchoSettings {
        var settings = ApmEchoSettings()
        settings.ep_strength_default_gain = 0.01
        settings.suppressor_normal_mask_lf_enr_suppress = suppression
        settings.stream_delay_ms = delayMs
        return settings
    }

    @Test("実マイクの音量を保った同じ録音に、二文を −20 と −30 dBFS で重ねて保存する")
    func runsRecordedPairAtBothVoiceLevels() throws {
        let rate = 48_000
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("recorded-echo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let reference = root.appendingPathComponent("reference.wav")
        let microphone = root.appendingPathComponent("microphone.wav")
        let voice = root.appendingPathComponent("voice.wav")
        let lines = root.appendingPathComponent("voice.lines.json")
        let out = root.appendingPathComponent("out")
        let raw: [Float] = (0..<(4 * rate)).map { i in
            0.01 * Float(sin(2 * Double.pi * 880 * Double(i) / Double(rate)))
        }
        let speech: [Float] = (0..<(2 * rate)).map { i in
            let t = Double(i) / Double(rate)
            if t < 0.5 { return 0.2 * Float(sin(2 * Double.pi * 440 * t)) }
            if t >= 0.75 && t < 1.25 { return 0.2 * Float(sin(2 * Double.pi * 660 * t)) }
            return 0
        }
        try writeWav((0..<(4 * rate)).map { i in
            0.4 * Float(sin(2 * Double.pi * 1_000 * Double(i) / Double(rate)))
        }, to: reference, sampleRate: Double(rate))
        try writeWav(raw, to: microphone, sampleRate: Double(rate))
        try writeWav(speech, to: voice, sampleRate: Double(rate))
        let recordedMicrophone = try readMono48k(microphone)
        let recordedSpeech = try readMono48k(voice)
        try JSONEncoder().encode([
            SynthesizedLine(speaker: "自分", text: "明日の会議を確認します。", start: 0, end: 0.5),
            SynthesizedLine(speaker: "自分", text: "資料を送ってください。", start: 0.75, end: 1.25),
        ]).write(to: lines)
        let candidates = ["bypass-10.0", "bypass-20.0"]
        let arguments = ["echo", reference.path, voice.path, "--self-lines", lines.path,
                         "--microphone", microphone.path, "--at", "1",
                         "--candidate", candidates.joined(separator: ","), "--out", out.path]
        let result = try runEchoCommand(arguments, root: root)
        try #require(result.status == 0, "\(result.stderr)")
        let rows = try result.stdout.split(whereSeparator: \.isNewline).map { line in
            try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        }
        #expect(rows.count == candidates.count * 3)
        for candidate in candidates {
            let candidateRows = rows.filter { $0["candidate"] as? String == candidate }
            let minute = try #require(candidateRows.first { $0["type"] as? String == "minute" })
            #expect(minute["startSeconds"] as? Double == 0)
            let end = try #require(minute["endSeconds"] as? Double)
            #expect(abs(end - 4) < 0.02)
            let inputDb = try #require(minute["inputRmsDbfs"] as? Double)
            #expect(abs(inputDb - 20 * log10(0.01 / sqrt(2))) < 0.01)
            let reduction = try #require(minute["leakReductionDb"] as? Double)
            #expect(abs(reduction) < 0.01)
            let retention = candidateRows.filter { $0["type"] as? String == "retention" }
            #expect(retention.compactMap { $0["voiceRmsDbfs"] as? Double }.sorted() == [-30, -20])
            for row in retention {
                #expect(row["atSeconds"] as? Double == 1)
                let db = try #require(row["retentionDb"] as? Double)
                #expect(abs(db) < 0.01)
            }
            for row in candidateRows {
                #expect(row["outputDelaySamples"] as? Int != nil)
                let settings = try #require(row["settings"] as? [String: Any])
                #expect(settings["epStrengthDefaultGain"] as? Double == 1)
                let suppression = try #require(settings["suppressorNormalMaskLfEnrSuppress"] as? Double)
                #expect(abs(suppression - 0.4) < 0.000001)
                #expect(settings["streamDelayMs"] == nil || settings["streamDelayMs"] is NSNull)
            }
        }

        let files = try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "wav" }
        #expect(files.count == 6)
        let speechEnd = Int(1.25 * Double(rate))
        let basisEnergy = recordedSpeech[..<speechEnd].reduce(0.0) { $0 + Double($1) * Double($1) }
        let speechRms = (basisEnergy / Double(speechEnd)).squareRoot()
        let pcm16Step = 1.0 / 32_768
        var gains: [Double] = []
        for file in files {
            let output = try readMono48k(file)
            try #require(output.count == raw.count)
            // AEC の効果を合否条件にせず、全区間 bypass で入力の受け渡しだけを観測する。
            #expect(zip(output[..<rate], recordedMicrophone[..<rate]).allSatisfy { abs(Double($0 - $1)) <= pcm16Step })
            var dot = 0.0
            for i in 0..<speechEnd { dot += Double(output[rate + i] - recordedMicrophone[rate + i]) * Double(recordedSpeech[i]) }
            let gain = dot / basisEnergy
            gains.append(gain)
            #expect((0..<speechEnd).allSatisfy { i in
                abs(Double(output[rate + i] - recordedMicrophone[rate + i]) - Double(recordedSpeech[i]) * gain) <= pcm16Step
            })
        }
        let expected = [0, 0,
                        pow(10, -30.0 / 20) / speechRms, pow(10, -30.0 / 20) / speechRms,
                        pow(10, -20.0 / 20) / speechRms, pow(10, -20.0 / 20) / speechRms]
        #expect(gains.count == expected.count)
        #expect(zip(gains.sorted(), expected).allSatisfy { abs($0 - $1) < 0.0001 })

        for conflict in [["--delays", "40"], ["--leak-gain-db", "-10"]] {
            let rejected = try runEchoCommand(arguments + conflict, root: root)
            #expect(rejected.status != 0)
            #expect(rejected.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @Test("無音の実マイクでも計測し、非有限な毎分レベルと低下量を JSON の null で出す")
    func serializesSilentMicrophoneMetricsAsNull() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("silent-echo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let reference = root.appendingPathComponent("reference.wav")
        let microphone = root.appendingPathComponent("microphone.wav")
        let voice = root.appendingPathComponent("voice.wav")
        let lines = root.appendingPathComponent("voice.lines.json")
        try writeWav([Float](repeating: 0.1, count: 48_000), to: reference, sampleRate: 48_000)
        try writeWav([Float](repeating: 0, count: 48_000), to: microphone, sampleRate: 48_000)
        try writeWav((0..<9_600).map { 0.1 * Float(sin(2 * Double.pi * 440 * Double($0) / 48_000)) },
                     to: voice, sampleRate: 48_000)
        try JSONEncoder().encode([
            SynthesizedLine(speaker: "自分", text: "会議を確認します。", start: 0, end: 0.05),
            SynthesizedLine(speaker: "自分", text: "資料を送ります。", start: 0.1, end: 0.15),
        ]).write(to: lines)
        let names = ["bypass-10", "production", "suppress-lf-0.6", "delay-hint-40", "ep-gain-0.1"]
        let result = try runEchoCommand([
            "echo", reference.path, voice.path, "--self-lines", lines.path,
            "--microphone", microphone.path, "--at", "0.3", "--candidate", names.joined(separator: ","),
        ], root: root)
        try #require(result.status == 0, "\(result.stderr)")
        let rows = try result.stdout.split(whereSeparator: \.isNewline).map { line in
            try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        }
        #expect(rows.count == names.count * 3)
        for name in names {
            let candidate = try #require(EchoCandidate(name))
            let candidateRows = rows.filter { $0["candidate"] as? String == candidate.name }
            #expect(candidateRows.count == 3)
            let expectedSettings = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(candidate.settings)) as? NSDictionary)
            for row in candidateRows {
                let settings = try #require(row["settings"] as? NSDictionary)
                #expect(settings == expectedSettings)
            }
            let minute = try #require(candidateRows.first { $0["type"] as? String == "minute" })
            let nullKeys = name == "bypass-10" ? ["inputRmsDbfs", "outputRmsDbfs", "leakReductionDb"] : ["inputRmsDbfs"]
            for key in nullKeys {
                #expect(minute[key] is NSNull, "\(key) は非有限値を null として出す")
            }
        }
    }
}

private struct EchoCommandTimeout: Error {}

private func runEchoCommand(_ arguments: [String], root: URL) throws -> (status: Int32, stdout: String, stderr: String) {
    let invocation = root.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: invocation, withIntermediateDirectories: true)
    let home = invocation.appendingPathComponent("home")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    let stdout = invocation.appendingPathComponent("stdout")
    let stderr = invocation.appendingPathComponent("stderr")
    try Data().write(to: stdout)
    try Data().write(to: stderr)
    let output = try FileHandle(forWritingTo: stdout)
    defer { try? output.close() }
    let errors = try FileHandle(forWritingTo: stderr)
    defer { try? errors.close() }
    let process = Process()
    let helper = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    process.executableURL = helper.appendingPathComponent(".build/debug/stt-bench")
    process.arguments = arguments
    process.currentDirectoryURL = invocation
    process.environment = ["HOME": home.path, "TMPDIR": invocation.path, "LANG": "en_US.UTF-8"]
    process.standardOutput = output
    process.standardError = errors
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    try process.run()
    guard finished.wait(timeout: .now() + 45) == .success else {
        kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
        throw EchoCommandTimeout()
    }
    process.waitUntilExit()
    return (process.terminationStatus,
            try String(contentsOf: stdout, encoding: .utf8),
            try String(contentsOf: stderr, encoding: .utf8))
}
