import Foundation

// 共有画面のイベントの送出（Issue #278）。判定器の更新と `events` への送出を、同じ排他区間で行う。
// 判定が確定した順（画像 → 消失の null）と、`events` に出る順が常に一致する。
// 呼び出し側へイベントを返さないので、判定と送出の間に別スレッドの送出が入り込めない。

public final class ScreenEventEmitter: @unchecked Sendable {
    public let events: AsyncStream<HelperEvent>
    private let continuation: AsyncStream<HelperEvent>.Continuation
    private let lock = NSLock()
    private var detector: ScreenChangeDetector
    private var closed = false
    private var captureStopped = false

    public init(bundleID: String) {
        detector = ScreenChangeDetector(bundleID: bundleID)
        (events, continuation) = AsyncStream<HelperEvent>.makeStream()
    }

    /// フレームを判定し、送るときだけ `encode` で画像（base64）を作って送出する。ブラウザが会議以外のタブになったときは `image: null` を 1 回送出する。終了後は何もしない（`encode` も呼ばない）。
    public func emit(_ frame: ScreenFrame, encode: () -> String?) {
        lock.withLock {
            if closed { return }
            if let event = detector.screenEvent(for: frame, encode: encode) {
                continuation.yield(event)
            }
        }
    }

    /// ウィンドウが無くなった。画像を送った後なら `image: null` を 1 回だけ送出する。終了後は何もしない。
    public func emitWindowGone(at time: Double) {
        lock.withLock {
            if closed { return }
            if let event = detector.screenEvent(windowGoneAt: time) {
                continuation.yield(event)
            }
        }
    }

    /// 取り込みが途中で止まった（ウィンドウは残っている）。画像を送った後なら `image: null` を送り、続けて `screen-off`（許可なし）を 1 回だけ送出する。
    /// 同じ排他区間で送るので、順序が保たれる。2 回目以降と終了後は何もしない。
    public func emitCaptureStopped(at time: Double) {
        lock.withLock {
            if closed || captureStopped { return }
            captureStopped = true
            if let event = detector.screenEvent(windowGoneAt: time) {
                continuation.yield(event)
            }
            continuation.yield(.screenOff(start: time, reason: .許可なし))
        }
    }

    /// `events` を終わらせる。2 回目以降は何もしない。
    public func close() {
        lock.withLock {
            if closed { return }
            closed = true
            continuation.finish()
        }
    }
}
