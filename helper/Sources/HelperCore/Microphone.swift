import AVFoundation
import CoreAudio
import Synchronization

public enum MicrophoneError: Error, CustomStringConvertible {
    case permissionDenied
    case invalidInputFormat
    case backlogExceeded(limit: Int)
    case configurationChanged

    public var description: String {
        switch self {
        case .permissionDenied: return "マイクの使用が許可されていない。システム設定のプライバシーとセキュリティで、起動したターミナルに許可を与える"
        case .invalidInputFormat: return "マイクの入力形式が使えない（サンプルレートまたはチャンネル数が 0）"
        case .backlogExceeded(let limit): return "音声の処理が取得に追いつかず、未消費のバッファが上限（\(limit) 個）を超えた"
        case .configurationChanged: return "マイクの入力の構成が変わった（入力の機器の切り替えなど）ため、取り込みを止めた。起動し直すと新しい機器で取り込む"
        }
    }
}

public func requestMicrophonePermission() async throws {
    guard await AVAudioApplication.requestRecordPermission() else {
        throw MicrophoneError.permissionDenied
    }
}

/// Apple の音声処理（エコーキャンセル）は有効にしない。有効にすると同じプロセスのプロセスタップが止まる。
public final class MicrophoneCapture {

    private struct Lifecycle {
        var stopRequested = false
        var engine: AVAudioEngine?
        var continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation?
        var configurationObserver: NSObjectProtocol?
    }

    private let lifecycle = Mutex(Lifecycle())
    private let notificationCenter: NotificationCenter

    public init() {
        self.notificationCenter = .default
    }

    init(notificationCenter: NotificationCenter) {
        self.notificationCenter = notificationCenter
    }

    public func start() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        try startExclusively { try startUnchecked(&$0) }
    }

    func startWithoutMicrophone(configurationSource source: AnyObject) -> AsyncThrowingStream<CapturedAudio, Error> {
        startExclusively { state in
            let (stream, continuation) = makeStream(&state)
            state.configurationObserver = Self.finishOnConfigurationChange(
                of: source, center: notificationCenter, finishing: continuation)
            return stream
        }
    }

    var observesConfigurationChange: Bool {
        lifecycle.withLock { $0.configurationObserver != nil }
    }

    private func startExclusively(
        _ body: (inout Lifecycle) throws -> AsyncThrowingStream<CapturedAudio, Error>
    ) rethrows -> AsyncThrowingStream<CapturedAudio, Error> {
        try lifecycle.withLock { state in
            if state.stopRequested {
                let (stream, continuation) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
                continuation.finish()
                return stream
            }
            do {
                return try body(&state)
            } catch {
                releaseResources(&state)
                throw error
            }
        }
    }

    private func makeStream(_ state: inout Lifecycle) -> (AsyncThrowingStream<CapturedAudio, Error>, AsyncThrowingStream<CapturedAudio, Error>.Continuation) {
        let (stream, continuation) = AsyncThrowingStream.makeStream(
            of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
        state.continuation = continuation
        return (stream, continuation)
    }

    private static func finishOnConfigurationChange(
        of source: AnyObject, center: NotificationCenter,
        finishing continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation
    ) -> NSObjectProtocol {
        center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: source, queue: nil
        ) { _ in
            continuation.finish(throwing: MicrophoneError.configurationChanged)
        }
    }

    private func startUnchecked(_ state: inout Lifecycle) throws -> AsyncThrowingStream<CapturedAudio, Error> {
        let engine = AVAudioEngine()
        state.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw MicrophoneError.invalidInputFormat }

        let limit = downstreamBacklogLimit
        let (stream, continuation) = makeStream(&state)

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, time in
            guard let copy = Self.copyBuffer(buffer) else { return }
            let hostTime = time.isHostTimeValid ? time.hostTime : AudioGetCurrentHostTime()
            if case .dropped = continuation.yield(CapturedAudio(buffer: copy, hostTime: hostTime)) {
                continuation.finish(throwing: MicrophoneError.backlogExceeded(limit: limit))
            }
        }
        try engine.start()
        state.configurationObserver = Self.finishOnConfigurationChange(
            of: engine, center: notificationCenter, finishing: continuation)
        return stream
    }

    private static func copyBuffer(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard source.frameLength > 0,
              let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength)
        else { return nil }
        copy.frameLength = source.frameLength
        let from = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<min(from.count, to.count) {
            guard let fromData = from[index].mData, let toData = to[index].mData else { continue }
            memcpy(toData, fromData, Int(min(from[index].mDataByteSize, to[index].mDataByteSize)))
        }
        return copy
    }

    public func stop() {
        lifecycle.withLock { state in
            state.stopRequested = true
            releaseResources(&state)
        }
    }

    private func releaseResources(_ state: inout Lifecycle) {
        if let configurationObserver = state.configurationObserver {
            notificationCenter.removeObserver(configurationObserver)
            state.configurationObserver = nil
        }
        if let engine = state.engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            state.engine = nil
        }
        state.continuation?.finish()
        state.continuation = nil
    }
}
