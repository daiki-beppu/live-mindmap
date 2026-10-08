import CoreAudio
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// 共有画面の取り込み（Issue #278, ADR 0011）。ScreenCaptureKit で、`--app` の bundle id のウィンドウを直接撮る。
// システムのウィンドウピッカーも非公開 API も使わない。変化の判定は ScreenChange.swift の純粋な部分に任せる。
// 画面が取れなくても、ここからは throw しない。標準エラーに 1 行出すだけで、音声の取り込みには影響させない。
// 会議アプリのウィンドウが無い間は探し直し、見つかったら取り込みを始める（Issue #421）。

private func printScreenError(_ message: String) {
    FileHandle.standardError.write(Data(("screen: " + message + "\n").utf8))
}

/// `run()` が終わるまで、変化した画面を `events` に流す。`origin` は発言と同じ時刻の原点（host time）。
public final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    public var events: AsyncStream<HelperEvent> { emitter.events }
    private let emitter: ScreenEventEmitter
    private let bundleID: String
    private let origin: UInt64
    private let queue = DispatchQueue(label: "live-mindmap.screen-capture")
    private let imageContext = CIContext()
    /// 最後に判定へ入れた輝度と画像。`queue` の上でだけ触る（idle のフレームで、輝度の画像を作り直さずに使う）。
    private var lastRendered: (luma: [UInt8], image: CGImage)?

    private let lock = NSLock()
    private var windowID: UInt32 = 0
    private var windowTitle: String?
    private var ended = false
    /// 撮っているウィンドウが無くなった（`handleStop` が立て、取り込みを始めるたびに下ろす）。
    private var lost = false
    /// 時限付きの待ちの世代。古い待ちのタイマーが、後の待ちを起こさないようにする。
    private var waitGeneration = 0
    private var waiter: CheckedContinuation<Void, Never>?

    public init(bundleID: String, origin: UInt64) {
        self.bundleID = bundleID
        self.origin = origin
        self.emitter = ScreenEventEmitter(bundleID: bundleID)
    }

    /// 取り込みを始め、`stop()` まで待つ。会議アプリのウィンドウが見つからない間と、撮っていたウィンドウが無くなった後は、
    /// `screenWindowRetryInterval` ごとに探し直し、見つかったら取り込みを始める（上限なし、`screen-off` は流さない）。
    /// 失敗は標準エラーに 1 行出すだけで、throw しない。
    public func run() async {
        defer { emitter.close() }
        var state = ScreenWindowSearchState.notStarted
        var announcedRetry = false
        while !lock.withLock({ ended }) {
            let content: SCShareableContent
            do {
                content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            } catch {
                printScreenError("共有画面を取り込めない（音声だけで続ける）: \(error)")
                return
            }
            switch nextScreenWindowAction(bundleID: bundleID, state: state, among: windowCandidates(in: content)) {
            case .nothing:
                return // 未開始と無くなった状態では返らない
            case .retry(let seconds):
                if !announcedRetry {
                    printScreenError("画面に出ている \(bundleID) のウィンドウが見つからない（見つかるまで \(Int(seconds)) 秒ごとに探し直す）")
                    announcedRetry = true
                }
                await wait(timeout: seconds, wakeOnLost: false)
            case .startCapture(let id):
                guard let window = content.windows.first(where: { $0.windowID == id }) else { continue }
                guard let stream = await startCapture(of: window) else { return }
                state = .capturing(windowID: id)
                // タブの切り替えに追従するため、ブラウザのときだけ取り込みの間タイトルを読み直す。
                let titleRefresh = screenBrowserBundleIDs.contains(bundleID) ? Task { await self.refreshWindowTitle() } : nil
                await wait(timeout: nil, wakeOnLost: true)
                titleRefresh?.cancel()
                try? await stream.stopCapture()
                // 無くなった旨の 1 行は `handleStop` が出し済み。
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

    /// 撮っていたウィンドウが無くなった。待ちを起こして、`run()` に探し直させる。
    private func markWindowLost() {
        lock.lock()
        lost = true
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume()
    }

    /// `timeout` 秒たつか、`stop()` か、（`wakeOnLost` のとき）ウィンドウが無くなるまで待つ。
    /// 待ちの再開は、lock の中で `waiter` を取り出した側だけが行う（2 回再開しない）。
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
                // 登録の後に起動する（登録前に期限が来て取りこぼすのを防ぐ）。
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

    /// `screenTitleRefreshSeconds` ごとに、撮っているウィンドウのタイトルを公開 API で読み直す。
    /// 読み直しに失敗したときや、ウィンドウが見つからないときは、前のタイトルを保つ（ウィンドウが無くなったことは別の経路が扱う）。
    private func refreshWindowTitle() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(screenTitleRefreshSeconds * 1_000_000_000))
            if Task.isCancelled { return }
            let id = lock.withLock { windowID }
            guard
                let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true),
                let window = content.windows.first(where: { $0.windowID == id })
            else { continue }
            // 取り消された後や、取り込み直して撮るウィンドウが変わった後に、古い読み取りの結果で上書きしない。
            lock.withLock {
                if !Task.isCancelled && windowID == id { windowTitle = window.title }
            }
        }
    }

    /// 選んだウィンドウのストリームを作って取り込みを始める。失敗したら標準エラーに 1 行出して nil。
    private func startCapture(of window: SCWindow) async -> SCStream? {
        lock.withLock {
            windowID = window.windowID
            windowTitle = window.title
            lost = false
        }
        // 前のウィンドウの輝度と画像を、idle のフレームで使い回さない。
        queue.sync { lastRendered = nil }
        do {
            let stream = try makeStream(for: window)
            try await stream.startCapture()
            return stream
        } catch {
            printScreenError("共有画面を取り込めない（音声だけで続ける）: \(error)")
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

    // MARK: SCStreamOutput

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int
        else { return }
        // OS のフレームの状態は、輝度の画像を作り直す手間を省くためだけに使う（判定の根拠にしない）。idle でも時刻は判定器へ進める。
        let content: ScreenFrameContent
        switch SCFrameStatus(rawValue: rawStatus) {
        case .complete: content = .updated
        case .idle: content = .unchanged
        default: content = .unusable
        }
        guard let rendered = screenFrameToJudge(content, previous: lastRendered, render: { renderFrame(sampleBuffer) }) else { return }
        lastRendered = rendered

        // サンプルの時刻は host time の時計。発言と同じ原点からの秒にする。
        let hostTime = CMClockConvertHostTimeToSystemUnits(sampleBuffer.presentationTimeStamp)
        let time = offsetSeconds(from: origin, to: hostTime)

        // 判定・JPEG 生成・送出は emitter が 1 回の排他区間で行う（間に「ウィンドウが無くなった」が入り込まないように）。
        let title = lock.withLock { windowTitle }
        emitter.emit(ScreenFrame(luma: rendered.luma, time: time, title: title)) {
            guard let jpeg = jpegData(of: rendered.image) else {
                printScreenError("JPEG を作れなかったので、この画面は送らない")
                return nil
            }
            return jpeg.base64EncodedString()
        }
    }

    /// サンプルの画像から、輝度の画像と送る画像（CGImage）を作る。画像が無い、または作れなければ nil。
    private func renderFrame(_ sampleBuffer: CMSampleBuffer) -> (luma: [UInt8], image: CGImage)? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = imageContext.createCGImage(image, from: image.extent), let luma = lumaGrid(of: cgImage) else { return nil }
        return (luma: luma, image: cgImage)
    }

    // MARK: SCStreamDelegate

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task {
            await self.handleStop(error: error)
        }
    }

    /// 共有中のウィンドウがすべて閉じた。ストリームは止まらない（開き直されれば続く）ので、`finish()` は呼ばない。
    public func streamDidBecomeInactive(_ stream: SCStream) {
        printScreenError("共有していたウィンドウが閉じた（音声だけで続ける）")
        reportWindowGone()
    }

    /// 画像を送った後に撮っていたウィンドウが無くなったら、原点からの秒で `image: null` を 1 回だけ流す。
    private func reportWindowGone() {
        let time = offsetSeconds(from: origin, to: AudioGetCurrentHostTime())
        emitter.emitWindowGone(at: time)
    }

    private func handleStop(error: Error) async {
        let id = lock.withLock { windowID }
        let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        // 読めないときは、ウィンドウはまだあるものとして扱う。
        let action = content.map {
            nextScreenWindowAction(bundleID: bundleID, state: .capturing(windowID: id), among: windowCandidates(in: $0))
        } ?? .nothing
        if action == .nothing {
            printScreenError("共有画面の取り込みが止まった（音声だけで続ける）: \(error)")
            emitter.emitCaptureStopped(at: offsetSeconds(from: origin, to: AudioGetCurrentHostTime()))
            finish()
        } else {
            printScreenError("共有していたウィンドウが無くなった（見つかるまで \(Int(screenWindowRetryInterval)) 秒ごとに探し直す）")
            reportWindowGone()
            markWindowLost()
        }
    }
}

/// 128×72 のグレーに縮めた輝度（行の並び）。
private func lumaGrid(of image: CGImage) -> [UInt8]? {
    var pixels = [UInt8](repeating: 0, count: screenGridWidth * screenGridHeight)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: screenGridWidth,
            height: screenGridHeight,
            bitsPerComponent: 8,
            bytesPerRow: screenGridWidth,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: screenGridWidth, height: screenGridHeight))
        return true
    }
    return drawn ? pixels : nil
}

/// ImageIO で JPEG にする。画像の大きさは取り込みの設定が 1280×720 に収めてある。
private func jpegData(of image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: screenJPEGQuality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}
