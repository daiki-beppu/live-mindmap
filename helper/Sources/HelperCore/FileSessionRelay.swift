import Foundation

/// 録画セッションの読み手1本分の入力。開始位置はファイル上の秒。
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

/// 録画セッションを、相手と任意の自分の入力から流す。
/// 映像は相手を優先し、全読み手の開始位置の最大から読む。
/// 時刻 t の screen は end > t の partial・remark より先に送る。音声は映像の判定済み時刻を越えて入力を渡さない。
/// 話者分離は相手だけに適用し、自分がある場合だけ音声位置の時計で重複を判定する。
/// 正常終了・失敗後に時計を閉じ、残った保留を待たせない。
public func relayFileSession(
    theirs: FileSessionSource, mine: FileSessionSource?, to server: WebSocketServer,
    gate: FileReadingGate? = nil, theirsDiarization: FileDiarizationFeed? = nil
) async throws {
    try await relayFileSession(
        theirs: theirs, mine: mine, to: server, gate: gate, theirsDiarization: theirsDiarization, relayScreen: nil)
}

/// 映像を流す処理。映像ファイルと判定の進みの操作口を受け取る。
typealias FileScreenRelay = @Sendable (URL, FileReadingAlignment.Screen) async -> Void

/// 映像を遅らせて音声との順序を確かめるため、テストでは画面処理を差し替えられる。
func relayFileSession(
    theirs: FileSessionSource, mine: FileSessionSource?, to server: WebSocketServer,
    gate: FileReadingGate? = nil, theirsDiarization: FileDiarizationFeed? = nil, relayScreen: FileScreenRelay?
) async throws {
    let alignment = FileReadingAlignment()
    // 全読み手と映像の進みを、どの読み手も開始する前に登録する。
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
            // 最初の失敗でグループを抜け、残りの子タスクを取り消す。
            for try await _ in group {}
        }
    } catch {
        await alignment.close()
        throw error
    }
    await alignment.close()
}
