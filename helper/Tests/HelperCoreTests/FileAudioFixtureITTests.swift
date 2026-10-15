import AVFoundation
import CoreGraphics
import CoreText
import Foundation
import Testing

// 録画のファイルから音声を書く経路（FileAudioExport）と作成日時の読み取り（FileCreationDate）の IT が共有する、合成ファイルの作り方。

enum FileAudioTestSupport {
    static let sampleRate = 16_000.0

    static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-file-audio-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// 前半 `loudSeconds` 秒が 440 Hz のサイン波、後半 `silentSeconds` 秒が完全な無音の WAV。
    static func writeWAV(_ url: URL, loudSeconds: Double, silentSeconds: Double) throws {
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1))
        let frames = AVAudioFrameCount(sampleRate * (loudSeconds + silentSeconds))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try #require(buffer.floatChannelData)[0]
        let loudFrames = Int(sampleRate * loudSeconds)
        for i in 0..<Int(frames) {
            samples[i] = i < loudFrames ? 0.5 * Float(sin(2 * Double.pi * 440 * Double(i) / sampleRate)) : 0
        }
        let file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
        ])
        try file.write(from: buffer)
    }

    /// 合成する映像の中身（10 fps。`.text` だけ 1280x720、ほかは 64x64）。
    enum Video {
        /// 全編が黒。
        case black
        /// 0 秒から `switchAt` 秒の手前までが黒、`switchAt` 秒からが白（スライドが切り替わる）。
        case slides(switchAt: Double)
        /// 映像のトラックはあるが、コーデックを BGRA に復号できない（未知の FourCC のサンプルだけを書く）。
        case undecodable
        /// 全編が白地で、黒い文字を `lines` の上から順に 1 行ずつ描く（1280x720。OCR が読める大きさ）。
        case text([String])

        /// 映像の幅と高さ。
        var size: (width: Int, height: Int) {
            if case .text = self { return (1280, 720) }
            return (64, 64)
        }
    }

    /// 音声（`audio`）と映像（既定は黒い 64x64 を `videoSeconds` 秒。`video` で中身を選ぶ）を持つ mov。`creationDate` を渡すと QuickTime の作成日時のメタデータを付ける。
    /// `audioStartSeconds` を渡すと、音声のトラックを movie の 0 秒ではなくその秒から始める。
    /// `moreAudio` を渡すと、`audio` の後ろに 2 本目以降の音声のトラックとして順に加える（どれも 0 秒から始める）。
    static func writeMovie(_ url: URL, audio: URL, videoSeconds: Int, creationDate: String? = nil, audioStartSeconds: Double = 0, moreAudio: [URL] = [], video content: Video = .black) async throws {
        let video = url.deletingLastPathComponent().appendingPathComponent("video-\(UUID().uuidString).mov")
        try await writeVideo(video, seconds: videoSeconds, content: content)
        let composition = AVMutableComposition()
        let videoAsset = AVURLAsset(url: video)
        let audioAsset = AVURLAsset(url: audio)
        let videoTrack = try #require(try await videoAsset.loadTracks(withMediaType: .video).first)
        let audioTrack = try #require(try await audioAsset.loadTracks(withMediaType: .audio).first)
        let videoDuration = try await videoAsset.load(.duration)
        let audioDuration = try await audioAsset.load(.duration)
        try #require(composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid))
            .insertTimeRange(CMTimeRange(start: .zero, duration: videoDuration), of: videoTrack, at: .zero)
        try #require(composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid))
            .insertTimeRange(CMTimeRange(start: .zero, duration: audioDuration), of: audioTrack, at: CMTime(seconds: audioStartSeconds, preferredTimescale: 600))
        for extra in moreAudio {
            let extraAsset = AVURLAsset(url: extra)
            let extraTrack = try #require(try await extraAsset.loadTracks(withMediaType: .audio).first)
            let extraDuration = try await extraAsset.load(.duration)
            try #require(composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid))
                .insertTimeRange(CMTimeRange(start: .zero, duration: extraDuration), of: extraTrack, at: .zero)
        }
        let session = try #require(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough))
        if let creationDate {
            let item = AVMutableMetadataItem()
            item.identifier = .quickTimeMetadataCreationDate
            item.dataType = kCMMetadataBaseDataType_UTF8 as String
            item.value = creationDate as NSString
            session.metadata = [item]
        }
        try await session.export(to: url, as: .mov)
    }

    private static func writeVideo(_ url: URL, seconds: Int, content: Video) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        if case .undecodable = content {
            try await writeUndecodableVideo(writer, seconds: seconds)
            return
        }
        let (width, height) = content.size
        // Why: H.264 だと、ハードウェアのエンコーダの無い CI のランナーで最初のフレームが粗く（黒が明るさ 4）なり、
        // 次のフレームで黒に締まるのを画面の切り替わりと数えた（#1090）。フレームごとに独立した JPEG の最高品質なら、単色はどこでもそのまま戻る。
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.jpeg, AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoQualityKey: 1.0],
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for i in 0..<(seconds * 10) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
            let pixels = try #require(buffer)
            if case .slides(let switchAt) = content, Double(i) / 10 >= switchAt { fillWhite(pixels) }
            if case .text(let lines) = content { drawText(lines, on: pixels) }
            adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 10))
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }

    private static func fillWhite(_ buffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        memset(base, 0xFF, CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer))
    }

    /// 白地に黒い文字を 1 行ずつ描く。描き方は ScreenTextITTests と同じ（Hiragino Sans 72pt、x=80、行は上から 160 ずつ下げる）。
    private static func drawText(_ lines: [String], on buffer: CVPixelBuffer) {
        fillWhite(buffer)
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let height = CVPixelBufferGetHeight(buffer)
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer), width: CVPixelBufferGetWidth(buffer), height: height,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: CTFontCreateWithName("Hiragino Sans" as CFString, 72, nil),
            .foregroundColor: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
        ]
        for (index, line) in lines.enumerated() {
            let ctLine = CTLineCreateWithAttributedString(NSAttributedString(string: line, attributes: attributes))
            context.textPosition = CGPoint(x: 80, y: CGFloat(height) - 160 - CGFloat(index) * 160)
            CTLineDraw(ctLine, context)
        }
    }

    /// 未知の FourCC（`zzzz`）のサンプルだけを書く映像のトラック。トラックとしては読めるが、BGRA には復号できない。
    private static func writeUndecodableVideo(_ writer: AVAssetWriter, seconds: Int) async throws {
        var description: CMFormatDescription?
        CMVideoFormatDescriptionCreate(allocator: nil, codecType: 0x7A7A_7A7A, width: 64, height: 64, extensions: nil, formatDescriptionOut: &description)
        let format = try #require(description)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: format)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        let payload = [UInt8](repeating: 0x5A, count: 64)
        for i in 0..<(seconds * 10) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var block: CMBlockBuffer?
            CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: payload.count, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: payload.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
            let data = try #require(block)
            CMBlockBufferReplaceDataBytes(with: payload, blockBuffer: data, offsetIntoDestination: 0, dataLength: payload.count)
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 10), presentationTimeStamp: CMTime(value: CMTimeValue(i), timescale: 10), decodeTimeStamp: .invalid)
            var size = payload.count
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReady(allocator: nil, dataBuffer: data, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
            input.append(try #require(sample))
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }

    /// `from`〜`to` 秒の二乗平均平方根（0〜1）。
    static func rms(of url: URL, from: Double, to: Double) throws -> Double {
        let file = try AVAudioFile(forReading: url)
        let rate = file.processingFormat.sampleRate
        file.framePosition = AVAudioFramePosition(from * rate)
        let frames = AVAudioFrameCount((to - from) * rate)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
        try file.read(into: buffer, frameCount: frames)
        let channel = try #require(buffer.floatChannelData)[0]
        var sum = 0.0
        for i in 0..<Int(buffer.frameLength) { sum += Double(channel[i]) * Double(channel[i]) }
        return buffer.frameLength == 0 ? 0 : (sum / Double(buffer.frameLength)).squareRoot()
    }
}
