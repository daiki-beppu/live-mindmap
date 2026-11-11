import AVFoundation
import CoreAudio
import Synchronization

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

    private struct Lifecycle {
        var stopRequested = false
        var tapID = AudioObjectID(kAudioObjectUnknown)
        var aggregateID = AudioObjectID(kAudioObjectUnknown)
        var ioProcID: AudioDeviceIOProcID?
        var deviceStarted = false
        var continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation?
    }

    private struct IOProcObservations {
        var receivedFrames = false
        var mainSubDeviceUID: String?
    }

    private let lifecycle = Mutex(Lifecycle())
    private let observations = Mutex(IOProcObservations())
    private let targets: [AudioProcess]
    private let queue = DispatchQueue(label: "live-mindmap.process-tap")

    public init(targets: [AudioProcess]) {
        self.targets = targets
    }

    public var aggregateMainSubDeviceUID: String? {
        observations.withLock { $0.mainSubDeviceUID }
    }

    public var hasReceivedFrames: Bool {
        observations.withLock { $0.receivedFrames }
    }

    private func markFramesReceived() {
        observations.withLock { $0.receivedFrames = true }
    }

    public func start() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        try lifecycle.withLock { state in
            if state.stopRequested {
                let (stream, continuation) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
                continuation.finish()
                return stream
            }
            do {
                return try startUnchecked(&state)
            } catch {
                releaseResources(&state)
                throw error
            }
        }
    }

    private func startUnchecked(_ state: inout Lifecycle) throws -> AsyncThrowingStream<CapturedAudio, Error> {
        let description = CATapDescription(stereoMixdownOfProcesses: targets.map(\.objectID))
        description.uuid = UUID()
        description.name = "live-mindmap-helper"
        description.muteBehavior = .unmuted
        var status = AudioHardwareCreateProcessTap(description, &state.tapID)
        guard status == noErr else { throw CoreAudioError.status("プロセスタップの作成", status) }

        var asbd = try audioProperty(state.tapID, kAudioTapPropertyFormat, default: AudioStreamBasicDescription())
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError.status("タップの音声形式の解釈", -1)
        }

        let outputDevice = try audioProperty(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice,
            default: AudioObjectID(kAudioObjectUnknown))
        let outputUID = try audioProperty(outputDevice, kAudioDevicePropertyDeviceUID, default: "" as CFString) as String

        observations.withLock { $0.mainSubDeviceUID = outputUID }

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
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &state.aggregateID)
        guard status == noErr else { throw CoreAudioError.status("集約デバイスの作成", status) }

        let limit = downstreamBacklogLimit
        let (stream, continuation) = AsyncThrowingStream.makeStream(
            of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(limit))
        state.continuation = continuation

        status = AudioDeviceCreateIOProcIDWithBlock(&state.ioProcID, state.aggregateID, queue) { [weak self] _, input, inputTime, _, _ in
            guard let copy = Self.copyBuffer(input, format: format) else { return }
            if bufferHasFrames(copy) { self?.markFramesReceived() }
            let hostTime = inputTime.pointee.mFlags.contains(.hostTimeValid) ? inputTime.pointee.mHostTime : AudioGetCurrentHostTime()
            let captured = CapturedAudio(buffer: copy, hostTime: hostTime)
            if case .dropped = continuation.yield(captured) {
                continuation.finish(throwing: ProcessTapError.backlogExceeded(limit: limit))
            }
        }
        guard status == noErr else { throw CoreAudioError.status("IOProc の作成", status) }

        status = AudioDeviceStart(state.aggregateID, state.ioProcID)
        guard status == noErr else { throw CoreAudioError.status("音声取得の開始", status) }
        state.deviceStarted = true
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
        lifecycle.withLock { state in
            state.stopRequested = true
            releaseResources(&state)
        }
    }

    private func releaseResources(_ state: inout Lifecycle) {
        if state.deviceStarted, let ioProcID = state.ioProcID {
            AudioDeviceStop(state.aggregateID, ioProcID)
            state.deviceStarted = false
        }
        if let ioProcID = state.ioProcID {
            AudioDeviceDestroyIOProcID(state.aggregateID, ioProcID)
            state.ioProcID = nil
        }
        if state.aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(state.aggregateID)
            state.aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if state.tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(state.tapID)
            state.tapID = AudioObjectID(kAudioObjectUnknown)
        }
        state.continuation?.finish()
        state.continuation = nil
    }
}
