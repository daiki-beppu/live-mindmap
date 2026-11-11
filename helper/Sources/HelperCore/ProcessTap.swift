import AVFoundation
import CoreAudio

func bufferHasFrames(_ buffer: AVAudioPCMBuffer) -> Bool {
    buffer.frameLength > 0
}

public enum ProcessTapError: Error, CustomStringConvertible {
    case backlogExceeded(limit: Int)

    public var description: String {
        switch self {
        case .backlogExceeded(let limit): return "音声の処理が取得に追いつかず、未消費のバッファが上限（\(limit) 個）を超えた"
        }
    }
}

public final class ProcessTap {

    private let lock = NSLock()
    private var stopRequested = false
    private let targets: [AudioProcess]
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var deviceStarted = false
    private var continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation?
    private let queue = DispatchQueue(label: "live-mindmap.process-tap")
    private let stateLock = NSLock()
    private var receivedFrames = false
    private var mainSubDeviceUID: String?

    public init(targets: [AudioProcess]) {
        self.targets = targets
    }

    public var aggregateMainSubDeviceUID: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return mainSubDeviceUID
    }

    public var hasReceivedFrames: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return receivedFrames
    }

    private func markFramesReceived() {
        stateLock.lock()
        receivedFrames = true
        stateLock.unlock()
    }

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

        stateLock.lock()
        mainSubDeviceUID = outputUID
        stateLock.unlock()

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

        let limit = downstreamBacklogLimit
        let (stream, continuation) = AsyncThrowingStream.makeStream(
            of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(limit))
        self.continuation = continuation

        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) { [weak self] _, input, inputTime, _, _ in
            guard let copy = Self.copyBuffer(input, format: format) else { return }
            if bufferHasFrames(copy) { self?.markFramesReceived() }
            let hostTime = inputTime.pointee.mFlags.contains(.hostTimeValid) ? inputTime.pointee.mHostTime : AudioGetCurrentHostTime()
            let captured = CapturedAudio(buffer: copy, hostTime: hostTime)
            if case .dropped = continuation.yield(captured) {
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
