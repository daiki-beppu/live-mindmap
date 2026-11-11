import AVFoundation
import CoreImage
import Foundation

struct ScreenFrameThinner {
    private var lastSlot: Int?

    mutating func admits(_ time: Double) -> Bool {
        let slot = Int((time * Double(screenFramesPerSecond)).rounded(.down))
        if let lastSlot, slot <= lastSlot { return false }
        lastSlot = slot
        return true
    }
}

actor FileScreenReader {
    enum Opened {
        case noVideo
        case unreadable(String)
        case reading(FileScreenReader)
    }

    private nonisolated let queue: DispatchSerialQueue
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let imageContext = CIContext()
    private var thinner = ScreenFrameThinner()
    private var detector = ScreenChangeDetector.withoutTabDetection()
    private var lastTime: Double
    private var finished = false

    private init(reader: AVAssetReader, output: AVAssetReaderTrackOutput, startingAt: Double, queue: DispatchSerialQueue) {
        self.queue = queue
        self.reader = reader
        self.output = output
        self.lastTime = startingAt
    }

    isolated deinit {
        dispatchPrecondition(condition: .onQueue(queue))
        reader.cancelReading()
    }

    static func open(_ url: URL, startingAt: Double = 0) async -> Opened {
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .video)
        } catch {
            return .unreadable(error.localizedDescription)
        }
        guard let track = tracks.first else { return .noVideo }
        let queue = DispatchSerialQueue(label: "live-mindmap.file-screen")
        return await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: start(asset, track, startingAt: startingAt, queue: queue))
            }
        }
    }

    private static func start(_ asset: AVURLAsset, _ track: AVAssetTrack, startingAt: Double, queue: DispatchSerialQueue) -> Opened {
        do {
            dispatchPrecondition(condition: .onQueue(queue))
            let reader = try AVAssetReader(asset: asset)
            var started = false
            defer { if !started { reader.cancelReading() } }
            let output = AVAssetReaderTrackOutput(
                track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            guard reader.canAdd(output) else { return .unreadable("映像を BGRA として読み出せない") }
            reader.add(output)
            if startingAt > 0 { reader.timeRange = CMTimeRange(start: CMTime(seconds: startingAt, preferredTimescale: 600), duration: .positiveInfinity) }
            guard reader.startReading() else { return .unreadable(reader.error?.localizedDescription ?? "不明") }
            started = true
            return .reading(FileScreenReader(reader: reader, output: output, startingAt: startingAt, queue: queue))
        } catch {
            return .unreadable(error.localizedDescription)
        }
    }

    func cancel() {
        dispatchPrecondition(condition: .onQueue(queue))
        finished = true
        reader.cancelReading()
    }

    var readerStatus: AVAssetReader.Status {
        dispatchPrecondition(condition: .onQueue(queue))
        return reader.status
    }

    enum Step {
        case frame(events: [HelperEvent], time: Double, allEventsSentBefore: Double?)
        case end
    }

    func step() -> Step {
        dispatchPrecondition(condition: .onQueue(queue))
        func snapshot(_ events: [HelperEvent]) -> Step {
            .frame(events: events, time: lastTime, allEventsSentBefore: detector.fileProgress)
        }
        if finished || Task.isCancelled { return .end }
        if let sample = output.copyNextSampleBuffer() {
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard time.isFinite, thinner.admits(time), let rendered = render(sample) else { return snapshot([]) }
            lastTime = time
            let frame = ScreenFrame(luma: rendered.luma, time: time, title: nil)
            let events = detector.fileScreenEvent(for: frame, encode: { screenShot(of: rendered.image) })
            return snapshot(events)
        }
        finished = true
        guard !Task.isCancelled else { return .end }
        if reader.status == .failed {
            printScreenError("動画の映像を最後まで読めなかった（音声だけで続ける）: \(reader.error?.localizedDescription ?? "不明")")
            var events = detector.screenEvent(windowGoneAt: lastTime)
            events.append(.screenOff(start: lastTime, reason: .許可なし))
            return snapshot(events)
        }
        let events = detector.finish()
        return events.isEmpty ? .end : snapshot(events)
    }

    private func render(_ sample: CMSampleBuffer) -> (luma: [UInt8], image: CGImage)? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return nil }
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        let width = Int(source.extent.width)
        let height = Int(source.extent.height)
        guard width > 0, height > 0 else { return nil }
        let size = fitScreenSize(width: width, height: height)
        let fitted = (size.width, size.height) == (width, height)
            ? source
            : source.transformed(by: CGAffineTransform(scaleX: Double(size.width) / Double(width), y: Double(size.height) / Double(height)))
        let rect = CGRect(x: 0, y: 0, width: size.width, height: size.height)
        guard let image = imageContext.createCGImage(fitted, from: rect), let luma = lumaGrid(of: image) else { return nil }
        return (luma: luma, image: image)
    }
}

public func selectFileVideo(theirs: URL, mine: URL?) async -> URL? {
    if await hasVideoTrack(theirs) { return theirs }
    if let mine, await hasVideoTrack(mine) { return mine }
    return nil
}

private func hasVideoTrack(_ url: URL) async -> Bool {
    guard let tracks = try? await AVURLAsset(url: url).loadTracks(withMediaType: .video) else { return false }
    return !tracks.isEmpty
}

public func relayFileScreen(
    from url: URL, to server: WebSocketServer, progress: FileReadingAlignment.Screen, startingAt: Double = 0, gate: FileReadingGate? = nil
) async {
    await relayFileScreen(from: url, to: server, progress: progress, startingAt: startingAt, gate: gate, afterFrame: nil)
}

func relayFileScreen(
    from url: URL, to server: WebSocketServer, progress: FileReadingAlignment.Screen,
    startingAt: Double = 0, gate: FileReadingGate? = nil, afterFrame: (@Sendable (Double) async -> Void)?
) async {
    switch await FileScreenReader.open(url, startingAt: startingAt) {
    case .noVideo:
        break
    case .unreadable(let reason):
        printScreenError("動画の映像を読めない（音声だけで続ける）: \(reason)")
        await server.send(.screenOff(start: 0, reason: .許可なし))
    case .reading(let reading):
        await withTaskCancellationHandler {
            while !Task.isCancelled {
                do { try await gate?.waitOpen() } catch { break }
                guard case .frame(let events, let time, let allEventsSentBefore) = await reading.step() else { break }
                for event in events where !Task.isCancelled { await server.send(event) }
                if let allEventsSentBefore { await progress.sentAllScreenEvents(before: allEventsSentBefore) }
                await afterFrame?(time)
            }
        } onCancel: {
            Task { await reading.cancel() }
        }
        await reading.cancel()
    }
    await progress.finish()
}
