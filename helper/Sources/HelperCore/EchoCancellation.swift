import AVFoundation
import Foundation

// 下流（文字起こし・録音）へ渡す未消費のバッファの上限。ProcessTap と同じ。
private let backlogLimit = 2048

private let echoFormat = AVAudioFormat(standardFormatWithSampleRate: Double(echoSampleRate), channels: 1)!

/// マイクの流れから、タップの音（参照）で、スピーカーから漏れたエコーを除いた流れを作る（WebRTC AEC3）。
/// 参照とマイクは `hostTime` で揃える。出力は 48 kHz・モノラルで、最初のバッファの `hostTime` は入力のマイクのまま。
/// 参照の流れがエラーで終わっても止めず、残りのマイクを無音の参照で処理する（参照のエラーは、その流れを読む側が扱う）。
/// マイクの流れのエラーは出力に伝える。マイクが正常に終わったときは、参照の流れが終わるのを待ってから終わる。
public func echoCancelled(
    microphone: AsyncThrowingStream<CapturedAudio, Error>,
    reference: AsyncThrowingStream<CapturedAudio, Error>
) throws -> AsyncThrowingStream<CapturedAudio, Error> {
    echoCancelledStream(microphone: microphone, reference: reference, canceller: try WebRTCEchoCanceller())
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
        // 2 つの流れを、それぞれの Task で読んで 1 本の事象の列にまとめる。時刻合わせの状態は、下の Task だけが持つ。
        // 合流点にも上限を置く（2 つの流れの上限の合計）。超えたら音声を捨てずに、エラーで終わらせる。
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
            // 参照のエラーは、同じ流れを読む `相手` の側で扱う。ここでは終わりとして扱う。
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
                    // マイクがエラーで終わったときは参照を待たない。正常に終わったときは、参照の流れが終わるまで待つ。
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
    // 満杯で入らなかったバッファは捨てずに、エラーで終わらせる（時刻の意味を保つため）。
    if case .dropped = continuation.yield(CapturedAudio(buffer: buffer, hostTime: item.hostTime)) {
        throw TranscriberError.backlogExceeded(limit: backlogLimit)
    }
}

/// 入力のバッファを 48 kHz・モノラルの Float サンプルにする（チャンネルの平均と線形補間）。
/// `AVAudioConverter` は内部に最大 85 ms ほどの音声を抱え込み、出力が入力の時刻からずれるため使わない。
/// 補間の位置は、バッファをまたいで引き継ぐ。
private struct EchoInputConverter {
    /// 次の出力サンプルの、現在のバッファの先頭を 0 とした入力上の位置（-1 は前のバッファの最後のサンプル）。
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
