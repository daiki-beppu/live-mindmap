/// STT の結果をイベントにして、WebSocket の全クライアントへ流す。結果の流れが終わるまで戻らない。
public func relay<Results: AsyncSequence>(
    _ results: Results, track: Track, to server: WebSocketServer
) async throws where Results.Element == TranscriptionResult {
    for try await result in results {
        await server.broadcast(try event(from: result, track: track).jsonString())
    }
}

/// 複数トラックの結果の流れを並行して `relay` する。すべて正常に終わると戻る。
/// どれかがエラーで終わったら、最初に throw されたエラーを返し、残りの流れはキャンセルする。
public func relay(
    tracks: [(Track, AsyncThrowingStream<TranscriptionResult, Error>)], to server: WebSocketServer
) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        for (track, results) in tracks {
            group.addTask { try await relay(results, track: track, to: server) }
        }
        // 最初のエラーで抜ける。グループを抜けるときに、残りのタスクはキャンセルされる。
        for try await _ in group {}
    }
}
