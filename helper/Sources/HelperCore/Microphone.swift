import AVFoundation
import CoreAudio

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
    private static let backlogLimit = 2048

    private let lock = NSLock()
    private var stopRequested = false
    private var engine: AVAudioEngine?
    private var continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation?
    private let notificationCenter: NotificationCenter
    private var configurationObserver: NSObjectProtocol?

    public init() {
        self.notificationCenter = .default
    }

    init(notificationCenter: NotificationCenter) {
        self.notificationCenter = notificationCenter
    }

    public func start() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        try startExclusively { try startUnchecked() }
    }

    func startWithoutMicrophone(configurationSource source: AnyObject) -> AsyncThrowingStream<CapturedAudio, Error> {
        try! startExclusively {
            let (stream, continuation) = makeStream()
            observeConfigurationChange(of: source, finishing: continuation)
            return stream
        }
    }

    var observesConfigurationChange: Bool {
        lock.lock()
        defer { lock.unlock() }
        return configurationObserver != nil
    }

    private func startExclusively(
        _ body: () throws -> AsyncThrowingStream<CapturedAudio, Error>
    ) throws -> AsyncThrowingStream<CapturedAudio, Error> {
        lock.lock()
        defer { lock.unlock() }
        if stopRequested {
            let (stream, continuation) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
            continuation.finish()
            return stream
        }
        do {
            return try body()
        } catch {
            releaseResources()
            throw error
        }
    }

    private func makeStream() -> (AsyncThrowingStream<CapturedAudio, Error>, AsyncThrowingStream<CapturedAudio, Error>.Continuation) {
        let (stream, continuation) = AsyncThrowingStream.makeStream(
            of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(Self.backlogLimit))
        self.continuation = continuation
        return (stream, continuation)
    }

    private func observeConfigurationChange(
        of source: AnyObject, finishing continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation
    ) {
        configurationObserver = notificationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: source, queue: nil
        ) { _ in
            continuation.finish(throwing: MicrophoneError.configurationChanged)
        }
    }

    private func startUnchecked() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw MicrophoneError.invalidInputFormat }

        let limit = Self.backlogLimit
        let (stream, continuation) = makeStream()

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, time in
            guard let copy = Self.copyBuffer(buffer) else { return }
            let hostTime = time.isHostTimeValid ? time.hostTime : AudioGetCurrentHostTime()
            if case .dropped = continuation.yield(CapturedAudio(buffer: copy, hostTime: hostTime)) {
                continuation.finish(throwing: MicrophoneError.backlogExceeded(limit: limit))
            }
        }
        try engine.start()
        observeConfigurationChange(of: engine, finishing: continuation)
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
        lock.lock()
        defer { lock.unlock() }
        stopRequested = true
        releaseResources()
    }

    private func releaseResources() {
        if let configurationObserver {
            notificationCenter.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        continuation?.finish()
        continuation = nil
    }
}
