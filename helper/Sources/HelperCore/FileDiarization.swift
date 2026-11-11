import AVFoundation
import CoreAudio
import Foundation

public actor FileDiarizationFeed {
    private var slot: CapturedAudio?
    private var finished = false
    private var released = false
    private var lastEnd = 0.0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public var position: Double { lastEnd }

    nonisolated func stream() -> AsyncThrowingStream<CapturedAudio, Error> {
        AsyncThrowingStream(unfolding: { try await self.next() })
    }

    func send(buffer: AVAudioPCMBuffer, start: Double) async throws {
        while slot != nil, !released { try await waitForChange() }
        if released || finished { return }
        let nanos = UInt64((max(0, start) * 1_000_000_000).rounded())
        slot = CapturedAudio(buffer: buffer, hostTime: AudioConvertNanosToHostTime(nanos)).ownedCopy()
        lastEnd = start + Double(buffer.frameLength) / buffer.format.sampleRate
        wake()
        while slot != nil, !released { try await waitForChange() }
    }

    func finish() {
        finished = true
        wake()
    }

    func release() {
        released = true
        slot = nil
        wake()
    }

    private func next() async throws -> CapturedAudio? {
        while true {
            if let audio = slot {
                slot = nil
                wake()
                return audio
            }
            if finished || released { return nil }
            try await waitForChange()
        }
    }

    private func waitForChange() async throws {
        try Task.checkCancellation()
        await withTaskCancellationHandler {
            await withCheckedContinuation { waiters.append($0) }
        } onCancel: {
            Task { await self.wake() }
        }
        try Task.checkCancellation()
    }

    private func wake() {
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }
}

public final class FileDiarization: @unchecked Sendable {
    public let feed: FileDiarizationFeed?
    private let diarizer: (any SpeakerDiarizer)?
    private let emit: @Sendable (HelperEvent) async -> Void

    private init(feed: FileDiarizationFeed?, diarizer: (any SpeakerDiarizer)?, emit: @escaping @Sendable (HelperEvent) async -> Void) {
        self.feed = feed
        self.diarizer = diarizer
        self.emit = emit
    }

    public static func prepare(
        _ diarizer: any SpeakerDiarizer, from: Double, emit: @escaping @Sendable (HelperEvent) async -> Void
    ) async -> FileDiarization {
        do {
            try await diarizer.prepare()
            return FileDiarization(feed: FileDiarizationFeed(), diarizer: diarizer, emit: emit)
        } catch {
            let reason = speakerOffReason(for: error)
            printDiarizationError("使えない（認識は続ける）: \(error)")
            await emit(.speakerOff(start: from, reason: reason))
            return FileDiarization(feed: nil, diarizer: nil, emit: emit)
        }
    }

    public func run() async {
        guard let feed, let diarizer else { return }
        do {
            let segments = try await diarizer.diarize(feed.stream(), origin: 0)
            do {
                for try await item in segments { await emit(event(from: item, track: .相手)) }
            } catch {
                if !Task.isCancelled {
                    printDiarizationError("途中で停止（認識は続ける）: \(error)")
                    await emit(.speakerOff(start: await feed.position, reason: .途中で停止))
                }
            }
        } catch {
            printDiarizationError("開始できない（認識は続ける）: \(error)")
            await emit(.speakerOff(start: await feed.position, reason: .読み込みに失敗))
        }
        await feed.release()
    }

    public func run(alongside transcription: @escaping @Sendable () async throws -> Void) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { await self.run() }
            group.addTask { try await transcription() }
            // 最初の失敗でグループを抜ける（残りの子タスクは取り消される。`waitForAll()` は失敗後も残りの完了を待つので使わない）
            for try await _ in group {}
        }
    }
}

func speakerOffReason(for error: Error) -> SpeakerOffReason {
    if case SpeakerDiarizerError.modelMissing = error { return .モデルなし }
    return .読み込みに失敗
}

private func printDiarizationError(_ message: String) {
    FileHandle.standardError.write(Data("speaker diarization: \(message)\n".utf8))
}
