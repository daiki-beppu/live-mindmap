import CoreAudio
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

public final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    public var events: AsyncStream<HelperEvent> { emitter.events }
    private let emitter: ScreenEventEmitter
    private let log: (String) -> Void
    private let bundleID: String
    private let origin: UInt64
    private let queue = DispatchQueue(label: "live-mindmap.screen-capture")
    private let imageContext = CIContext()
    private var lastRendered: (luma: [UInt8], image: CGImage)?

    private let lock = NSLock()
    private var windowID: UInt32 = 0
    private var windowTitle: String?
    private var ended = false
    private var lost = false
    private var waitGeneration = 0
    private var waiter: CheckedContinuation<Void, Never>?

    public convenience init(bundleID: String, origin: UInt64) {
        self.init(bundleID: bundleID, origin: origin, emitter: ScreenEventEmitter(bundleID: bundleID), log: printScreenError)
    }

    init(bundleID: String, origin: UInt64, emitter: ScreenEventEmitter, log: @escaping (String) -> Void) {
        self.bundleID = bundleID
        self.origin = origin
        self.emitter = emitter
        self.log = log
    }

    public func run() async {
        defer { emitter.close() }
        var state = ScreenWindowSearchState.notStarted
        var announcedRetry = false
        while !lock.withLock({ ended }) {
            let content: SCShareableContent
            do {
                content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            } catch {
                log("共有画面を取り込めない（音声だけで続ける）: \(error)")
                return
            }
            switch nextScreenWindowAction(bundleID: bundleID, state: state, among: windowCandidates(in: content)) {
            case .nothing:
                return
            case .retry(let seconds):
                if !announcedRetry {
                    log("画面に出ている \(bundleID) のウィンドウが見つからない（見つかるまで \(Int(seconds)) 秒ごとに探し直す）")
                    announcedRetry = true
                }
                await wait(timeout: seconds, wakeOnLost: false)
            case .startCapture(let id):
                guard let window = content.windows.first(where: { $0.windowID == id }) else { continue }
                guard let stream = await startCapture(of: window) else { return }
                state = .capturing(windowID: id)
                let titleRefresh = screenBrowserBundleIDs.contains(bundleID) ? Task { await self.refreshWindowTitle() } : nil
                await wait(timeout: nil, wakeOnLost: true)
                titleRefresh?.cancel()
                try? await stream.stopCapture()
                state = .windowGone
                announcedRetry = true
            }
        }
    }

    public func stop() {
        finish()
    }

    private func finish() {
        lock.lock()
        ended = true
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume()
        emitter.close()
    }

    private func markWindowLost() {
        lock.lock()
        lost = true
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume()
    }

    private func wait(timeout: Double?, wakeOnLost: Bool) async {
        let generation = lock.withLock { () -> Int in
            waitGeneration += 1
            return waitGeneration
        }
        var timer: Task<Void, Never>?
        await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
            let wakeNow = lock.withLock { () -> Bool in
                let done = ended || (wakeOnLost && lost)
                if !done { waiter = waiting }
                return done
            }
            if wakeNow {
                waiting.resume()
            } else if let seconds = timeout {
                timer = Task {
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    if Task.isCancelled { return }
                    self.wakeWaiter(generation: generation)
                }
            }
        }
        timer?.cancel()
    }

    private func wakeWaiter(generation: Int) {
        let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard waitGeneration == generation else { return nil }
            let current = waiter
            waiter = nil
            return current
        }
        waiting?.resume()
    }

    private func refreshWindowTitle() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(screenTitleRefreshSeconds * 1_000_000_000))
            if Task.isCancelled { return }
            let id = lock.withLock { windowID }
            guard
                let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true),
                let window = content.windows.first(where: { $0.windowID == id })
            else { continue }
            lock.withLock {
                if !Task.isCancelled && windowID == id { windowTitle = window.title }
            }
        }
    }

    private func startCapture(of window: SCWindow) async -> SCStream? {
        lock.withLock {
            windowID = window.windowID
            windowTitle = window.title
            lost = false
        }
        queue.sync { lastRendered = nil }
        do {
            let stream = try makeStream(for: window)
            try await stream.startCapture()
            return stream
        } catch {
            log("共有画面を取り込めない（音声だけで続ける）: \(error)")
            return nil
        }
    }

    private func makeStream(for window: SCWindow) throws -> SCStream {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let info = SCShareableContent.info(for: filter)
        let scale = Double(info.pointPixelScale)
        let size = fitScreenSize(
            width: max(1, Int(info.contentRect.width * scale)),
            height: max(1, Int(info.contentRect.height * scale))
        )
        let configuration = SCStreamConfiguration()
        configuration.width = size.width
        configuration.height = size.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(screenFramesPerSecond))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.queueDepth = 3

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        return stream
    }

    private func windowCandidates(in content: SCShareableContent) -> [ScreenWindowCandidate] {
        content.windows.map {
            ScreenWindowCandidate(
                id: $0.windowID,
                bundleID: $0.owningApplication?.bundleIdentifier,
                isOnScreen: $0.isOnScreen,
                width: $0.frame.width,
                height: $0.frame.height
            )
        }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int
        else { return }
        let content: ScreenFrameContent
        switch SCFrameStatus(rawValue: rawStatus) {
        case .complete: content = .updated
        case .idle: content = .unchanged
        default: content = .unusable
        }
        guard let rendered = screenFrameToJudge(content, previous: lastRendered, render: { renderFrame(sampleBuffer) }) else { return }
        lastRendered = rendered

        let hostTime = CMClockConvertHostTimeToSystemUnits(sampleBuffer.presentationTimeStamp)
        let time = offsetSeconds(from: origin, to: hostTime)

        let title = lock.withLock { windowTitle }
        emitter.emit(ScreenFrame(luma: rendered.luma, time: time, title: title)) { screenShot(of: rendered.image) }
    }

    private func renderFrame(_ sampleBuffer: CMSampleBuffer) -> (luma: [UInt8], image: CGImage)? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = imageContext.createCGImage(image, from: image.extent), let luma = lumaGrid(of: cgImage) else { return nil }
        return (luma: luma, image: cgImage)
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task {
            await self.handleStop(error: error)
        }
    }

    public func streamDidBecomeInactive(_ stream: SCStream) {
        handleStreamInactive()
    }

    /// OS から inactive の通知が来た。ウィンドウが閉じたとは限らず、その後もフレームは届く（Issue #1174）。
    func handleStreamInactive() {
        log("OS から inactive の通知が来た（撮影は続けている）")
    }

    private func reportWindowGone() {
        let time = offsetSeconds(from: origin, to: AudioGetCurrentHostTime())
        emitter.emitWindowGone(at: time)
    }

    private func handleStop(error: Error) async {
        let id = lock.withLock { windowID }
        let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let action = content.map {
            nextScreenWindowAction(bundleID: bundleID, state: .capturing(windowID: id), among: windowCandidates(in: $0))
        } ?? .nothing
        if action == .nothing {
            log("共有画面の取り込みが止まった（音声だけで続ける）: \(error)")
            emitter.emitCaptureStopped(at: offsetSeconds(from: origin, to: AudioGetCurrentHostTime()))
            finish()
        } else {
            log("共有していたウィンドウが無くなった（見つかるまで \(Int(screenWindowRetryInterval)) 秒ごとに探し直す）")
            reportWindowGone()
            markWindowLost()
        }
    }
}
