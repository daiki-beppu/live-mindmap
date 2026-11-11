import AVFoundation

public protocol Transcriber {
    func prepare() async throws
    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error>
}
