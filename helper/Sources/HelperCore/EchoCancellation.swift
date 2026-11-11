import AVFoundation
import Foundation

private let backlogLimit = 2048

private let echoFormat = AVAudioFormat(standardFormatWithSampleRate: Double(echoSampleRate), channels: 1)!

public func echoCancelled(
    microphone: AsyncThrowingStream<CapturedAudio, Error>,
    reference: AsyncThrowingStream<CapturedAudio, Error>
) throws -> AsyncThrowingStream<CapturedAudio, Error> {
    echoCancelledStream(microphone: microphone, reference: reference, canceller: try WebRTCEchoCanceller(settings: .production))
}

private enum EchoEvent: Sendable {
    case reference(CapturedAudio)
    case referenceEnd
    case microphone(CapturedAudio)
    case microphoneEnd(Error?)
}

func echoCancelledStream<Canceller: EchoCanceller>(
    microphone: AsyncThrowingStream<CapturedAudio, Error>,
    reference: AsyncThrowingStream<CapturedAudio, Error>,
    canceller: Canceller
) -> AsyncThrowingStream<CapturedAudio, Error> {
    AsyncThrowingStream(bufferingPolicy: .bufferingOldest(backlogLimit)) { continuation in
        let (events, eventInput) = AsyncStream.makeStream(of: EchoEvent.self, bufferingPolicy: .bufferingOldest(backlogLimit * 2))
        let post: @Sendable (EchoEvent) -> Void = { event in
            if case .dropped = eventInput.yield(event) {
                continuation.finish(throwing: TranscriberError.backlogExceeded(limit: backlogLimit * 2))
            }
        }
        let microphoneReader = Task {
            do {
                for try await audio in microphone { post(.microphone(audio)) }
                post(.microphoneEnd(nil))
            } catch {
                post(.microphoneEnd(error))
            }
        }
        let referenceReader = Task {
            do { for try await audio in reference { post(.reference(audio)) } } catch {}
            post(.referenceEnd)
        }
        let processor = Task {
            var aligner = EchoAligner(canceller: canceller)
            var microphoneConverter = EchoInputConverter()
            var referenceConverter = EchoInputConverter()
            var microphoneEnded = false
            var microphoneError: Error?
            var referenceEnded = false
            do {
                for await event in events {
                    switch event {
                    case .reference(let audio):
                        aligner.addReference(try referenceConverter.samples(audio), hostTime: audio.hostTime)
                    case .referenceEnd:
                        referenceEnded = true
                        aligner.referenceFinished()
                    case .microphone(let audio):
                        aligner.addCapture(try microphoneConverter.samples(audio), hostTime: audio.hostTime)
                    case .microphoneEnd(let error):
                        microphoneEnded = true
                        microphoneError = error
                    }
                    let finishing = microphoneEnded && (referenceEnded || microphoneError != nil)
                    for item in aligner.drain(force: finishing) {
                        try emit(item, to: continuation)
                    }
                    if finishing { break }
                }
                continuation.finish(throwing: microphoneError)
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in
            microphoneReader.cancel()
            referenceReader.cancel()
            processor.cancel()
            eventInput.finish()
        }
    }
}

private func emit(
    _ item: (samples: [Float], hostTime: UInt64),
    to continuation: AsyncThrowingStream<CapturedAudio, Error>.Continuation
) throws {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: echoFormat, frameCapacity: AVAudioFrameCount(item.samples.count)) else {
        throw TranscriberError.conversionFailed("出力バッファを作れない")
    }
    buffer.frameLength = AVAudioFrameCount(item.samples.count)
    item.samples.withUnsafeBufferPointer { source in
        buffer.floatChannelData![0].update(from: source.baseAddress!, count: item.samples.count)
    }
    if case .dropped = continuation.yield(CapturedAudio(buffer: buffer, hostTime: item.hostTime)) {
        throw TranscriberError.backlogExceeded(limit: backlogLimit)
    }
}

private struct EchoInputConverter {
    private var position = 0.0
    private var last: Float = 0

    mutating func samples(_ audio: CapturedAudio) throws -> [Float] {
        let buffer = audio.buffer
        let format = buffer.format
        guard format.commonFormat == .pcmFormatFloat32, let channelData = buffer.floatChannelData else {
            throw TranscriberError.conversionFailed("Float32 以外の形式は扱えない: \(format)")
        }
        let frames = Int(buffer.frameLength)
        let channels = Int(format.channelCount)
        guard frames > 0, channels > 0 else { return [] }

        let mono: [Float]
        if channels == 1 {
            mono = Array(UnsafeBufferPointer(start: channelData[0], count: frames))
        } else if format.isInterleaved {
            let interleaved = channelData[0]
            mono = (0..<frames).map { frame in
                var sum: Float = 0
                for channel in 0..<channels { sum += interleaved[frame * channels + channel] }
                return sum / Float(channels)
            }
        } else {
            mono = (0..<frames).map { frame in
                var sum: Float = 0
                for channel in 0..<channels { sum += channelData[channel][frame] }
                return sum / Float(channels)
            }
        }
        guard format.sampleRate != Double(echoSampleRate) else { return mono }

        let step = format.sampleRate / Double(echoSampleRate)
        var output: [Float] = []
        output.reserveCapacity(Int(Double(frames) / step) + 1)
        while position < Double(frames - 1) {
            let index = Int(position.rounded(.down))
            let fraction = Float(position - Double(index))
            let before = index < 0 ? last : mono[index]
            output.append(before + (mono[index + 1] - before) * fraction)
            position += step
        }
        position -= Double(frames)
        last = mono[frames - 1]
        return output
    }
}
