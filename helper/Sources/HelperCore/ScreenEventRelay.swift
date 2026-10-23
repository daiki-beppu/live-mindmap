/// ScreenEventEmitterの順次出力を配送する。遅延画像は接続中へ届け、再接続用にはstartが最新の画面を残す。
public func relayScreenEvents(_ events: AsyncStream<HelperEvent>, to server: WebSocketServer) async {
    var latestStart: Double?
    for await event in events {
        guard let json = try? event.jsonString() else { continue }
        if case .screen(let start, _, _, _, _) = event {
            if let latestStart, start < latestStart {
                await server.broadcast(json)
            } else {
                latestStart = start
                await server.broadcastRetained(json, key: "screen")
            }
        } else {
            await server.broadcastRetained(json, key: "screen-off")
        }
    }
    await server.waitUntilSent()
}
