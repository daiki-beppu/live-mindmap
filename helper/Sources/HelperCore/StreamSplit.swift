import AVFoundation
import Foundation


public func split(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>
) -> (AsyncThrowingStream<CapturedAudio, Error>, AsyncThrowingStream<CapturedAudio, Error>) {
    let (first, firstContinuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
    let (second, secondContinuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
    let reader = Task {
        do {
            for try await audio in upstream {
                for (continuation, element) in [(firstContinuation, audio), (secondContinuation, copyCaptured(audio))] {
                    if case .dropped = continuation.yield(element) {
                        continuation.finish(throwing: TranscriberError.backlogExceeded(limit: downstreamBacklogLimit))
                    }
                }
            }
            firstContinuation.finish()
            secondContinuation.finish()
        } catch {
            firstContinuation.finish(throwing: error)
            secondContinuation.finish(throwing: error)
        }
    }
    let readers = ReaderCount(2)
    let release: @Sendable (AsyncThrowingStream<CapturedAudio, Error>.Continuation.Termination) -> Void = { _ in
        if readers.release() { reader.cancel() }
    }
    firstContinuation.onTermination = release
    secondContinuation.onTermination = release
    return (first, second)
}

private final class ReaderCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count: Int

    init(_ count: Int) { self.count = count }

    func release() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        count -= 1
        return count == 0
    }
}

func copyCaptured(_ audio: CapturedAudio) -> CapturedAudio {
    let source = audio.buffer
    guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: max(source.frameLength, 1)) else { return audio }
    copy.frameLength = source.frameLength
    let from = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
    let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for index in 0..<min(from.count, to.count) {
        guard let fromData = from[index].mData, let toData = to[index].mData else { continue }
        memcpy(toData, fromData, Int(min(from[index].mDataByteSize, to[index].mDataByteSize)))
    }
    return CapturedAudio(buffer: copy, hostTime: audio.hostTime)
}
