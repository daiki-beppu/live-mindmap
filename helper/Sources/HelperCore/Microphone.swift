import AVFoundation
import CoreAudio

public enum MicrophoneError: Error, CustomStringConvertible {
    case permissionDenied
    case invalidInputFormat
    case backlogExceeded(limit: Int)

    public var description: String {
        switch self {
        case .permissionDenied: return "マイクの使用が許可されていない。システム設定のプライバシーとセキュリティで、起動したターミナルに許可を与える"
        case .invalidInputFormat: return "マイクの入力形式が使えない（サンプルレートまたはチャンネル数が 0）"
        case .backlogExceeded(let limit): return "音声の処理が取得に追いつかず、未消費のバッファが上限（\(limit) 個）を超えた"
        }
    }
}

/// マイクの許可を求める。拒否されたら `MicrophoneError.permissionDenied` を throw する。
public func requestMicrophonePermission() async throws {
    guard await AVAudioApplication.requestRecordPermission() else {
        throw MicrophoneError.permissionDenied
    }
}

/// マイク（AVAudioEngine の入力）を、時刻付きの音声バッファの流れにする。`ProcessTap` と同じ開始・停止の契約を持つ。
/// `start()` と `stop()` は排他的に実行する。`start()` より前の `stop()` も記録し、以後の `start()` は何も作らず終わった流れを返す。
/// 未消費のバッファが上限を超えたら、音声を捨てずに `MicrophoneError.backlogExceeded` で流れを終わらせる。
/// Apple の音声処理（エコーキャンセル）は有効にしない。有効にすると同じプロセスのプロセスタップが止まる。
public final class MicrophoneCapture {
    // 2048 個: ProcessTap の上限と同じ。通常の遅れは吸収し、処理が止まった場合だけ超える。
    private static let backlogLimit = 2048

    private let lock = NSLock()
    private var stopRequested = false
    private var engine: AVAudioEngine?
    private var continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation?

    public init() {}

    /// マイクの取得を開始する。失敗したら、作った資源を破棄してから throw する。
    /// 先に `stop()` が呼ばれていた場合は、マイクに触れず、要素のない終わった流れを返す。
    public func start() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        lock.lock()
        defer { lock.unlock() }
        if stopRequested {
            let (stream, continuation) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
            continuation.finish()
            return stream
        }
        do {
            return try startUnchecked()
        } catch {
            releaseResources()
            throw error
        }
    }

    private func startUnchecked() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw MicrophoneError.invalidInputFormat }

        let limit = Self.backlogLimit
        let (stream, continuation) = AsyncThrowingStream.makeStream(
            of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(limit))
        self.continuation = continuation

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, time in
            guard let copy = Self.copyBuffer(buffer) else { return }
            let hostTime = time.isHostTimeValid ? time.hostTime : AudioGetCurrentHostTime()
            // 満杯で入らなかったバッファは捨てずに、エラーで流れを終わらせる（時刻の意味を保つため）。
            if case .dropped = continuation.yield(CapturedAudio(buffer: copy, hostTime: hostTime)) {
                continuation.finish(throwing: MicrophoneError.backlogExceeded(limit: limit))
            }
        }
        try engine.start()
        return stream
    }

    /// タップのバッファは再利用されるので、コピーして流す。
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

    /// 取得を止めて、資源を破棄する。どのスレッドから何度呼んでもよい。音声の流れは終わる。
    /// `start()` の実行中に呼ばれたら、開始が終わるまで待ってから破棄する。
    public func stop() {
        lock.lock()
        defer { lock.unlock() }
        stopRequested = true
        releaseResources()
    }

    private func releaseResources() {
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        continuation?.finish()
        continuation = nil
    }
}
