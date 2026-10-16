import AVFoundation
import Foundation
import Speech
import Testing
@testable import HelperCore

// FileReadingGate のテストが共有する道具（Issue #1092）。測る量は「これまでに読んだ一番先の位置」（invNoReadWhilePaused）。

struct GatePulled: Equatable {
    let reader: String
    let start: Double
    let end: Double
}

final class GatePullLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [GatePulled] = []
    func append(_ item: GatePulled) { lock.withLock { items.append(item) } }
    var values: [GatePulled] { lock.withLock { items } }
    func items(of reader: String) -> [GatePulled] { values.filter { $0.reader == reader } }
    func maxEnd(of reader: String) -> Double { items(of: reader).map(\.end).max() ?? 0 }
}

final class GateFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var set = false
    func raise() { lock.withLock { set = true } }
    var isRaised: Bool { lock.withLock { set } }
}

/// 引いた入力の位置を記録し、引くたびに `afterPull` を呼ぶ偽の役。
final class GateRecordingTranscriber: FileTranscriber, @unchecked Sendable {
    private let name: String
    private let log: GatePullLog
    private let afterPull: @Sendable (GatePulled) async throws -> Void

    init(_ name: String, log: GatePullLog, afterPull: @escaping @Sendable (GatePulled) async throws -> Void = { _ in }) {
        self.name = name
        self.log = log
        self.afterPull = afterPull
    }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        for try await input in inputs {
            let start = try #require(input.bufferStartTime).seconds
            let end = start + Double(input.buffer.frameLength) / input.buffer.format.sampleRate
            let pulled = GatePulled(reader: name, start: start, end: end)
            log.append(pulled)
            try await afterPull(pulled)
        }
        return AsyncThrowingStream { $0.finish() }
    }
}

func gateDrain(_ stream: AsyncThrowingStream<TranscriptionResult, Error>) async throws {
    for try await _ in stream {}
}

struct GateWaitTimedOut: Error, CustomStringConvertible {
    let condition: String
    var description: String { "待っていた条件が成り立たなかった: \(condition)" }
}

func gateWaitUntil(_ condition: String, _ check: @Sendable () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while !check() {
        if ContinuousClock.now >= deadline { throw GateWaitTimedOut(condition: condition) }
        try await Task.sleep(for: .milliseconds(25))
    }
}

func gateWaitUntilAsync(_ condition: String, _ check: @Sendable () async -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while !(await check()) {
        if ContinuousClock.now >= deadline { throw GateWaitTimedOut(condition: condition) }
        try await Task.sleep(for: .milliseconds(10))
    }
}

/// 音声の入力を裏で読み、`transcribe` はすぐ戻る偽の役。映像の読みを、音声が止められている間に走らせるために使う。
final class GateBackgroundTranscriber: FileTranscriber, @unchecked Sendable {
    private let name: String
    private let log: GatePullLog

    init(_ name: String, log: GatePullLog) {
        self.name = name
        self.log = log
    }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
        let name = name
        let log = log
        let task = Task {
            do {
                for try await input in inputs {
                    let start = try #require(input.bufferStartTime).seconds
                    let end = start + Double(input.buffer.frameLength) / input.buffer.format.sampleRate
                    log.append(GatePulled(reader: name, start: start, end: end))
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }
}

final class GateCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}
