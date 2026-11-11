public func relayScreenEvents(_ events: AsyncStream<HelperEvent>, to server: WebSocketServer) async {
    for await event in events {
        await server.send(event)
    }
}
