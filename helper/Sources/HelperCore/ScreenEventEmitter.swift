import Foundation

public final class ScreenEventEmitter: @unchecked Sendable {
    public let events: AsyncStream<HelperEvent>
    private let continuation: AsyncStream<HelperEvent>.Continuation
    private let lock = NSLock()
    private var detector: ScreenChangeDetector
    private var closed = false
    private var captureStopped = false
    private var announcedTitle: String?
    private var announcedConfirmation = false
    private let writeStderr: (String) -> Void

    public init(bundleID: String, writeStderr: @escaping (String) -> Void = {
        FileHandle.standardError.write(Data($0.utf8))
    }) {
        self.writeStderr = writeStderr
        detector = ScreenChangeDetector(bundleID: bundleID)
        (events, continuation) = AsyncStream<HelperEvent>.makeStream()
    }

    public func emit(_ frame: ScreenFrame, encode: () -> ScreenShot?) {
        lock.withLock {
            if closed { return }
            publish(detector.screenEvent(for: frame, encode: encode))
        }
    }

    public func emitWindowGone(at time: Double) {
        lock.withLock {
            if closed { return }
            publish(detector.screenEvent(windowGoneAt: time))
        }
    }

    public func emitCaptureStopped(at time: Double) {
        lock.withLock {
            if closed || captureStopped { return }
            captureStopped = true
            publish(detector.screenEvent(windowGoneAt: time))
            continuation.yield(.screenOff(start: time, reason: .許可なし))
        }
    }

    public func close() {
        lock.withLock {
            if closed { return }
            closed = true
            publish(detector.finish())
            continuation.finish()
        }
    }

    private func publish(_ events: [HelperEvent]) {
        if let title = detector.rememberedTabTitle, title != announcedTitle {
            announcedTitle = title
            writeStderr("会議のタブ: \(title)\n")
        }
        if let title = detector.confirmedTabTitle, !announcedConfirmation {
            announcedConfirmation = true
            writeStderr("会議のタブを確定しました: \(title)\n")
        }
        for event in events { continuation.yield(event) }
    }
}
