import Foundation

public struct FileSessionSource {
    public let url: URL
    public let transcriber: any FileTranscriber
    public let from: Double

    public init(url: URL, transcriber: any FileTranscriber, from: Double) {
        self.url = url
        self.transcriber = transcriber
        self.from = from
    }
}

public func relayFileSession(
    theirs: FileSessionSource, mine: FileSessionSource?, to server: WebSocketServer,
    gate: FileReadingGate? = nil, theirsDiarization: FileDiarizationFeed? = nil
) async throws {
    try await relayFileSession(
        theirs: theirs, mine: mine, to: server, gate: gate, theirsDiarization: theirsDiarization, relayScreen: nil)
}

typealias FileScreenRelay = @Sendable (URL, FileReadingAlignment.Screen) async -> Void

func relayFileSession(
    theirs: FileSessionSource, mine: FileSessionSource?, to server: WebSocketServer,
    gate: FileReadingGate? = nil, theirsDiarization: FileDiarizationFeed? = nil, relayScreen: FileScreenRelay?
) async throws {
    let alignment = FileReadingAlignment()
    let theirsReader = await alignment.addReader(from: theirs.from)
    let mineReading: (source: FileSessionSource, reader: FileReadingAlignment.Reader)?
    if let mine {
        mineReading = (mine, await alignment.addReader(from: mine.from))
    } else {
        mineReading = nil
    }
    let video = await selectFileVideo(theirs: theirs.url, mine: mine?.url)
    let screenFrom = mine.map { max(theirs.from, $0.from) } ?? theirs.from
    let screen = video == nil ? nil : await alignment.addScreen(from: screenFrom)
    do {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                let results = try await transcribeFile(
                    at: theirs.url, with: theirs.transcriber, alignment: theirsReader, from: theirs.from,
                    gate: gate, diarization: theirsDiarization)
                var tracks: [(Track, AsyncThrowingStream<TranscriptionResult, Error>)] = [(.相手, results)]
                let duplicates: DuplicateMarker?
                if let (source, reader) = mineReading {
                    let mineResults = try await transcribeFile(
                        at: source.url, with: source.transcriber, alignment: reader, from: source.from, gate: gate)
                    tracks.append((.自分, mineResults))
                    duplicates = DuplicateMarker(sleep: { try await alignment.sleep($0) }, now: { await alignment.now() })
                } else {
                    duplicates = nil
                }
                try await relay(tracks: tracks, to: server, duplicates: duplicates)
            }
            if let video, let screen {
                group.addTask {
                    if let relayScreen {
                        await relayScreen(video, screen)
                    } else {
                        await relayFileScreen(from: video, to: server, progress: screen, startingAt: screenFrom, gate: gate)
                    }
                }
            }
            for try await _ in group {}
        }
    } catch {
        await alignment.close()
        throw error
    }
    await alignment.close()
}
