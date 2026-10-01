/// STT の結果をイベントにして、WebSocket の全クライアントへ流す。結果の流れが終わるまで戻らない。
public func relay<Results: AsyncSequence>(
    _ results: Results, track: Track, to server: WebSocketServer
) async throws where Results.Element == TranscriptionResult {
    for try await result in results {
        await server.broadcast(try event(from: result, track: track).jsonString())
    }
}
