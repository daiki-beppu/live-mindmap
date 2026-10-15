import Foundation
import Network

public enum WebSocketServerError: Error, CustomStringConvertible {
    case invalidPort(UInt16)
    case noPort

    public var description: String {
        switch self {
        case .invalidPort(let port): return "ポート \(port) は使えない"
        case .noPort: return "待ち受けポートを決められなかった"
        }
    }
}

/// `127.0.0.1` だけで待ち受ける WebSocket サーバー。接続中の全クライアントへテキストフレームを流す。
public actor WebSocketServer {
    private let requestedPort: UInt16
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private var stopped = false
    /// 最初のクライアントの接続を待っている呼び出し（`waitForClient`）。
    private var clientWaiters: [CheckedContinuation<Void, Never>] = []
    /// 送信を依頼して、まだ送り終わっていない（`contentProcessed` が来ていない）フレームの数と、その完了を待っている呼び出し（`waitUntilSent`）。
    private var pendingSends = 0
    private var sendWaiters: [CheckedContinuation<Void, Never>] = []
    private let queue = DispatchQueue(label: "live-mindmap.websocket")
    /// `broadcastRetained` で最後に送った内容。後から接続したクライアントにも送る（Issue #161）。
    /// 種類（`key`）ごとに最新の 1 件だけ覚える（`origin` と、共有画面の `screen`）。順序は、その種類を最初に覚えた順。
    private var retained: [(key: String, text: String)] = []
    /// クライアントから届いたテキストフレームを、届いた順に流す（Issue #1069。サーバーからの休止の指示）。`stop` で終わる。
    public nonisolated let messages: AsyncStream<String>
    private nonisolated let messageContinuation: AsyncStream<String>.Continuation

    /// `port` が 0 のときは空きポートを使う。
    public init(port: UInt16) {
        requestedPort = port
        (messages, messageContinuation) = AsyncStream.makeStream(of: String.self)
    }

    public var clientCount: Int { clients.count }

    /// 待ち受けを始め、実際のポートを返す。
    public func start() async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        guard let port = requestedPort == 0 ? NWEndpoint.Port.any : NWEndpoint.Port(rawValue: requestedPort) else {
            throw WebSocketServerError.invalidPort(requestedPort)
        }
        // loopback のアドレスに束縛して、外のインターフェースからは届かないようにする。
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        let listener = try NWListener(using: parameters)
        self.listener = listener

        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            Task { await self.accept(connection) }
        }
        let resumed = ResumeOnce()
        return try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard resumed.take() else { return }
                    if let port = listener.port?.rawValue {
                        continuation.resume(returning: port)
                    } else {
                        continuation.resume(throwing: WebSocketServerError.noPort)
                    }
                case .failed(let error):
                    if resumed.take() { continuation.resume(throwing: error) }
                case .cancelled:
                    if resumed.take() { continuation.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    /// 接続中の全クライアントにテキストフレームを送る。クライアントがいなくても失敗しない。
    public func broadcast(_ text: String) {
        for connection in clients.values {
            send(text, to: connection)
        }
    }

    /// `broadcast` と同じく今つながっているクライアント全員に送り、かつ内容を覚えておく。
    /// 後から接続したクライアントにも、接続した直後に同じ内容を送る（`register` から呼ぶ）。
    /// 同じ `key` で覚えさせると、前の内容を置き換える（別の `key` の内容は消えない）。
    public func broadcastRetained(_ text: String, key: String = "origin") {
        if let index = retained.firstIndex(where: { $0.key == key }) {
            retained[index].text = text
        } else {
            retained.append((key: key, text: text))
        }
        broadcast(text)
    }

    /// 最初のクライアントが接続するまで待つ（接続済みなら、すぐ戻る）。`broadcast` は接続前の送信を捨てるので、
    /// 保持（`broadcastRetained`）しないイベントを流す前に呼ぶ。`stop` でも戻る。
    public func waitForClient() async {
        if !clients.isEmpty || stopped { return }
        await withCheckedContinuation { clientWaiters.append($0) }
    }

    /// これまでに送った全フレームが、送り終わる（失敗を含む）まで待つ。`stop` は接続を cancel して送りかけのフレームを捨てうるので、
    /// 最後のイベントまで届けたい呼び出しは、`stop` の前にこれを待つ。
    public func waitUntilSent() async {
        if pendingSends == 0 || stopped { return }
        await withCheckedContinuation { sendWaiters.append($0) }
    }

    private func send(_ text: String, to connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        let id = ObjectIdentifier(connection)
        pendingSends += 1
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            Task { await self.sendFinished(id, failed: error != nil) }
        })
    }

    private func sendFinished(_ id: ObjectIdentifier, failed: Bool) {
        // `stop` が数を 0 に戻した後に届く完了通知で、数を負にしない
        guard !stopped else { return }
        pendingSends -= 1
        if failed { remove(id) }
        if pendingSends == 0 { resumeAll(&sendWaiters) }
    }

    private func resumeAll(_ waiters: inout [CheckedContinuation<Void, Never>]) {
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }

    /// 待ち受けと全接続を閉じる。以後、新しい接続は受け付けない。
    public func stop() {
        stopped = true
        listener?.cancel()
        listener = nil
        for connection in clients.values { connection.cancel() }
        clients.removeAll()
        messageContinuation.finish()
        // 待っている呼び出しは、止まった以上これ以上待てないので戻す
        resumeAll(&clientWaiters)
        pendingSends = 0
        resumeAll(&sendWaiters)
    }

    private func accept(_ connection: NWConnection) {
        guard !stopped else { return connection.cancel() }
        let id = ObjectIdentifier(connection)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                Task { await self.register(connection) }
            case .failed, .cancelled:
                Task { await self.remove(id) }
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func register(_ connection: NWConnection) {
        guard !stopped else { return connection.cancel() }
        clients[ObjectIdentifier(connection)] = connection
        for entry in retained { send(entry.text, to: connection) }
        resumeAll(&clientWaiters)
        receiveLoop(connection)
    }

    /// クライアントからの close フレームや切断を検知するために、受信を回し続ける。テキストフレームは `messages` に流す。
    private func receiveLoop(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if error != nil || metadata?.opcode == .close {
                Task { await self.remove(id) }
            } else {
                if metadata?.opcode == .text, let data { self.messageContinuation.yield(String(decoding: data, as: UTF8.self)) }
                Task { await self.continueReceiving(id) }
            }
        }
    }

    private func continueReceiving(_ id: ObjectIdentifier) {
        guard let connection = clients[id] else { return }
        receiveLoop(connection)
    }

    private func remove(_ id: ObjectIdentifier) {
        clients.removeValue(forKey: id)?.cancel()
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
