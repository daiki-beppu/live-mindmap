import CoreAudio
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// 共有画面の取り込み（Issue #278, ADR 0011）。ScreenCaptureKit で、`--app` の bundle id のウィンドウを直接撮る。
// システムのウィンドウピッカーも非公開 API も使わない。変化の判定は ScreenChange.swift の純粋な部分に任せる。
// 画面が取れなくても、ここからは throw しない。標準エラーに 1 行出して終わるだけで、音声の取り込みには影響させない。

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
    private var waiter: CheckedContinuation<Void, Never>?

    public init(bundleID: String, origin: UInt64) {
        self.bundleID = bundleID
        self.origin = origin
        self.emitter = ScreenEventEmitter(bundleID: bundleID)
    }

    /// 取り込みを始め、`stop()` か取り込みの終わりまで待つ。失敗は標準エラーに 1 行出すだけで、throw しない。
    public func run() async {
        defer { emitter.close() }
        let stream: SCStream
        do {
            stream = try await makeStream()
            try await stream.startCapture()
        } catch {
            printScreenError("共有画面を取り込めない（音声だけで続ける）: \(error)")
            return
        }
        // タブの切り替えに追従するため、ブラウザのときだけ取り込みの間タイトルを読み直す。
        let titleRefresh = screenBrowserBundleIDs.contains(bundleID) ? Task { await self.refreshWindowTitle() } : nil
        defer { titleRefresh?.cancel() }
        await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
            let alreadyEnded = lock.withLock { () -> Bool in
                if !ended { waiter = waiting }
                return ended
            }
            if alreadyEnded { waiting.resume() }
        }
        try? await stream.stopCapture()
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
            lock.withLock { windowTitle = window.title }
        }
    }

    private func makeStream() async throws -> SCStream {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = pickWindow(in: content) else {
            throw ScreenCaptureError.windowNotFound(bundleID)
        }
        lock.withLock {
            windowID = window.windowID
            windowTitle = window.title
        }

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

    private func pickWindow(in content: SCShareableContent) -> SCWindow? {
        let candidates = content.windows.map {
            ScreenWindowCandidate(
                id: $0.windowID,
                bundleID: $0.owningApplication?.bundleIdentifier,
                isOnScreen: $0.isOnScreen,
                width: $0.frame.width,
                height: $0.frame.height
            )
        }
        guard let chosen = selectScreenWindow(bundleID: bundleID, among: candidates) else { return nil }
        return content.windows.first { $0.windowID == chosen.id }
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
        let windowStillThere = content?.windows.contains { $0.windowID == id } ?? true
        if windowStillThere {
            printScreenError("共有画面の取り込みが止まった（音声だけで続ける）: \(error)")
            emitter.emitCaptureStopped(at: offsetSeconds(from: origin, to: AudioGetCurrentHostTime()))
        } else {
            printScreenError("共有していたウィンドウが無くなった（音声だけで続ける）")
            reportWindowGone()
        }
        finish()
    }
}

private enum ScreenCaptureError: Error, CustomStringConvertible {
    case windowNotFound(String)

    var description: String {
        switch self {
        case .windowNotFound(let bundleID): return "画面に出ている \(bundleID) のウィンドウが見つからない"
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
