import AVFoundation
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

    /// 音声（`audio`）と映像（黒い 64x64 を `videoSeconds` 秒）を持つ mov。`creationDate` を渡すと QuickTime の作成日時のメタデータを付ける。
    /// `audioStartSeconds` を渡すと、音声のトラックを movie の 0 秒ではなくその秒から始める。
    /// `moreAudio` を渡すと、`audio` の後ろに 2 本目以降の音声のトラックとして順に加える（どれも 0 秒から始める）。
    static func writeMovie(_ url: URL, audio: URL, videoSeconds: Int, creationDate: String? = nil, audioStartSeconds: Double = 0, moreAudio: [URL] = []) async throws {
        let video = url.deletingLastPathComponent().appendingPathComponent("video-\(UUID().uuidString).mov")
        try await writeSilentVideo(video, seconds: videoSeconds)
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

    private static func writeSilentVideo(_ url: URL, seconds: Int) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
        ])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for i in 0..<(seconds * 10) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &buffer)
            adaptor.append(try #require(buffer), withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 10))
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
