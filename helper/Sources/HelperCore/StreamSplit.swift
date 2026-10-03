import Foundation

// 下流（文字起こし）へ渡す未消費のバッファの上限。ProcessTap と同じ。
private let backlogLimit = 2048

/// 音声の流れを、同じ要素・同じ順で届く 2 つの流れに分ける（`AsyncThrowingStream` は 1 か所でしか読めないため）。
/// 上流が終わると（正常・エラーとも）両方が同じ終わり方で終わる。片方が読むのをやめても、もう片方には流し続け、
/// 両方がやめたら上流の読み取りを止める。未消費のバッファが上限を超えた流れは、音声を捨てずにエラーで終わらせる。
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
                for continuation in [firstContinuation, secondContinuation] {
                    if case .dropped = continuation.yield(audio) {
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
