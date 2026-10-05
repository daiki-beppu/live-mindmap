import AVFoundation
import Foundation

// 下流（文字起こし）へ渡す未消費のバッファの上限。ProcessTap と同じ。
private let backlogLimit = 2048

/// 音声の流れを、同じ要素・同じ順で届く 2 つの流れに分ける（`AsyncThrowingStream` は 1 か所でしか読めないため）。
/// 上流が終わると（正常・エラーとも）両方が同じ終わり方で終わる。片方が読むのをやめても、もう片方には流し続け、
/// 両方がやめたら上流の読み取りを止める。未消費のバッファが上限を超えた流れは、音声を捨てずにエラーで終わらせる。
/// 2 本目の流れには、中身ごと複製したバッファを渡す。2 つの流れが同じ `AVAudioPCMBuffer` を共有すると、別々のスレッドで
/// 読まれているうちに片方の読み取りがヌルの中身を読んで落ちた（Issue #160。62 分・12 分で落ち、複製すると 162 分落ちなかった。
/// どこが中身を書き換えているかは特定できていない）。
public func split(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>
) -> (AsyncThrowingStream<CapturedAudio, Error>, AsyncThrowingStream<CapturedAudio, Error>) {
    let (first, firstContinuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(backlogLimit))
    let (second, secondContinuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(backlogLimit))
    let reader = Task {
        do {
            for try await audio in upstream {
                for (continuation, element) in [(firstContinuation, audio), (secondContinuation, copyCaptured(audio))] {
                    if case .dropped = continuation.yield(element) {
                        continuation.finish(throwing: TranscriberError.backlogExceeded(limit: backlogLimit))
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

/// まだ読んでいる下流の数。0 になったとき `release()` が true を返す。
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

/// バッファの中身ごと複製する。複製のバッファを作れなければ（確保の失敗など）、元をそのまま返す。
private func copyCaptured(_ audio: CapturedAudio) -> CapturedAudio {
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
