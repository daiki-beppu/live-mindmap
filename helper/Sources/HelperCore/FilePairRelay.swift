import Foundation

/// 録画の 2 本（`相手` と `自分`。`cli recorded --self`）を、ライブと同じ 2 トラックで流す。
/// 2 本の読み手は、それぞれ `theirsFrom`・`mineFrom` から読み始め、同じ音声の時刻に揃え、`自分` は `DuplicateMarker` に通す。保留（1 秒・8 秒）は、読んだ位置の時計で測る。
/// 映像は `max(theirsFrom, mineFrom)` から読み、メインにあればメインの、なければ自分用の映像を選び（どちらにもなければ流さない）、音声と並行して読んで `screen` として流す。
/// 音声の読み手は、映像の判定が済んだ時刻を越えて入力を渡さない。`screen`（start = t）は、end > t の `partial`・`remark` より前に流れる。
/// 映像が読めなくても音声だけで続ける。流し終えた後・失敗した後に時計を閉じ、途中結果の保留のタイマーを残さない。
public func relayFilePair(
    theirs theirsURL: URL, mine mineURL: URL,
    theirsTranscriber: any FileTranscriber, mineTranscriber: any FileTranscriber,
    to server: WebSocketServer, theirsFrom: Double = 0, mineFrom: Double = 0, gate: FileReadingGate? = nil
) async throws {
    try await relayFilePair(
        theirs: theirsURL, mine: mineURL, theirsTranscriber: theirsTranscriber, mineTranscriber: mineTranscriber, to: server,
        theirsFrom: theirsFrom, mineFrom: mineFrom, gate: gate,
        relayScreen: { video, progress in
            await relayFileScreen(from: video, to: server, progress: progress, startingAt: max(theirsFrom, mineFrom), gate: gate)
        })
}

/// 映像を流す処理（映像のファイルと、判定の進みの操作口を受け取る）。
typealias FileScreenRelay = @Sendable (URL, FileReadingAlignment.Screen) async -> Void

/// `relayFilePair` の本体。映像の処理を差し替えられる（映像を遅らせて、音声との順序を確かめるため）。
func relayFilePair(
    theirs theirsURL: URL, mine mineURL: URL,
    theirsTranscriber: any FileTranscriber, mineTranscriber: any FileTranscriber,
    to server: WebSocketServer, theirsFrom: Double = 0, mineFrom: Double = 0, gate: FileReadingGate? = nil, relayScreen: @escaping FileScreenRelay
) async throws {
    // 読み手は 2 本ともここで足してから読み始める（`theirsFrom`・`mineFrom` はそれぞれの読み始める音声の時刻。起動し直しのとき 0 より後ろ）
    // 映像は両トラックの先読みの境（大きい方）から読む。それより前の画面は、前の回がすでに溜まりへ入れている
    let alignment = FileReadingAlignment()
    let theirsReader = await alignment.addReader(from: theirsFrom)
    let mineReader = await alignment.addReader(from: mineFrom)
    let video = await selectFileVideo(theirs: theirsURL, mine: mineURL)
    // 映像があるときだけ、読み始める前に映像の進みも足す
    let screen = video == nil ? nil : await alignment.addScreen(from: max(theirsFrom, mineFrom))
    do {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                let theirs = try await transcribeFile(at: theirsURL, with: theirsTranscriber, alignment: theirsReader, from: theirsFrom, gate: gate)
                let mine = try await transcribeFile(at: mineURL, with: mineTranscriber, alignment: mineReader, from: mineFrom, gate: gate)
                try await relay(
                    tracks: [(.相手, theirs), (.自分, mine)], to: server,
                    duplicates: DuplicateMarker(sleep: { try await alignment.sleep($0) }, now: { await alignment.now() }))
            }
            if let video, let screen {
                group.addTask { await relayScreen(video, screen) }
            }
            // 最初の失敗でグループを抜ける（残りの子タスクは取り消される。`waitForAll()` は失敗後も残りの完了を待つ）
            for try await _ in group {}
        }
    } catch {
        await alignment.close()
        throw error
    }
    await alignment.close()
}
