import AVFoundation
import CoreAudio

public enum ProcessTapError: Error, CustomStringConvertible {
    case backlogExceeded(limit: Int)

    public var description: String {
        switch self {
        case .backlogExceeded(let limit): return "音声の処理が取得に追いつかず、未消費のバッファが上限（\(limit) 個）を超えた"
        }
    }
}

/// 選んだアプリのプロセスだけをタップして、音声バッファの流れにする。
/// タップ → 集約デバイス → IOProc の順に作り、停止時は逆順に破棄する。Mac 全体のタップは作らない。
/// `start()` と `stop()` は排他的に実行する。`start()` より前の `stop()` も記録し、以後の `start()` は何も作らず終わった流れを返す。
/// 未消費のバッファが上限を超えたら、音声を捨てずに `ProcessTapError.backlogExceeded` で流れを終わらせる。
public final class ProcessTap {
    // 2048 個: 1 個あたり約 10 ms 前後の IO バッファを想定して約 22 秒分。通常の遅れは吸収し、処理が止まった場合だけ超える。
    private static let backlogLimit = 2048

    private let lock = NSLock()
    private var stopRequested = false
    private let targets: [AudioProcess]
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var deviceStarted = false
    private var continuation: AsyncThrowingStream<AVAudioPCMBuffer, Error>.Continuation?
    private let queue = DispatchQueue(label: "live-mindmap.process-tap")

    public init(targets: [AudioProcess]) {
        self.targets = targets
    }

    /// タップを開始する。途中で失敗したら、そこまでに作った資源を破棄してから throw する。
    /// 先に `stop()` が呼ばれていた場合は、資源を作らず、要素のない終わった流れを返す。
    public func start() throws -> AsyncThrowingStream<AVAudioPCMBuffer, Error> {
        lock.lock()
        defer { lock.unlock() }
        if stopRequested {
            let (stream, continuation) = AsyncThrowingStream.makeStream(of: AVAudioPCMBuffer.self, throwing: Error.self)
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

    private func startUnchecked() throws -> AsyncThrowingStream<AVAudioPCMBuffer, Error> {
        // 対象のプロセスを必ず指定する（stereoMixdownOfProcesses）。全体タップの初期化は使わない。
        let description = CATapDescription(stereoMixdownOfProcesses: targets.map(\.objectID))
        description.uuid = UUID()
        description.name = "live-mindmap-helper"
        description.muteBehavior = .unmuted
        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { throw CoreAudioError.status("プロセスタップの作成", status) }

        var asbd = try audioProperty(tapID, kAudioTapPropertyFormat, default: AudioStreamBasicDescription())
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError.status("タップの音声形式の解釈", -1)
        }

        let outputDevice = try audioProperty(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice,
            default: AudioObjectID(kAudioObjectUnknown))
        let outputUID = try audioProperty(outputDevice, kAudioDevicePropertyDeviceUID, default: "" as CFString) as String

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "live-mindmap-helper tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { throw CoreAudioError.status("集約デバイスの作成", status) }

        let limit = Self.backlogLimit
        let (stream, continuation) = AsyncThrowingStream.makeStream(
            of: AVAudioPCMBuffer.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(limit))
        self.continuation = continuation

        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) { _, input, _, _, _ in
            guard let copy = Self.copyBuffer(input, format: format) else { return }
            // 満杯で入らなかったバッファは捨てずに、エラーで流れを終わらせる（時刻の意味を保つため）。
            if case .dropped = continuation.yield(copy) {
                continuation.finish(throwing: ProcessTapError.backlogExceeded(limit: limit))
            }
        }
        guard status == noErr else { throw CoreAudioError.status("IOProc の作成", status) }

        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else { throw CoreAudioError.status("音声取得の開始", status) }
        deviceStarted = true
        return stream
    }

    /// IOProc のバッファは再利用されるので、コピーして流す。
    private static func copyBuffer(_ list: UnsafePointer<AudioBufferList>, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard let first = source.first, first.mDataByteSize > 0 else { return nil }
        let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
        let frames = AVAudioFrameCount(first.mDataByteSize / bytesPerFrame)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        let destination = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        for index in 0..<min(source.count, destination.count) {
            guard let from = source[index].mData, let to = destination[index].mData else { continue }
            memcpy(to, from, Int(min(source[index].mDataByteSize, destination[index].mDataByteSize)))
        }
        return buffer
    }

    /// 取得を止めて、作った資源を逆順に破棄する。どのスレッドから何度呼んでもよい。音声の流れは終わる。
    /// `start()` の実行中に呼ばれたら、開始が終わるまで待ってから破棄する。
    public func stop() {
        lock.lock()
        defer { lock.unlock() }
        stopRequested = true
        releaseResources()
    }

    private func releaseResources() {
        if deviceStarted, let ioProcID {
            AudioDeviceStop(aggregateID, ioProcID)
            deviceStarted = false
        }
        if let ioProcID {
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        continuation?.finish()
        continuation = nil
    }
}
