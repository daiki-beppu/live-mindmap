/// ScreenEventEmitterの順次出力を配送する。遅延画像は接続中へ届け、再接続用にはstartが最新の画面を残す。
public func relayScreenEvents(_ events: AsyncStream<HelperEvent>, to server: WebSocketServer) async {
    for await event in events {
        await server.send(event)
    }
    await server.waitUntilSent()
}
