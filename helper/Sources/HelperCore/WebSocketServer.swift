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
    private enum Lifecycle {
        case running
        case closing(deadline: Task<Void, Never>)
        case closed
    }
    private var lifecycle = Lifecycle.running
    private var isRunning: Bool {
        if case .running = lifecycle { return true }
        return false
    }
    /// 最初のクライアントの接続を待っている呼び出し（`waitForClient`）。
    private var clientWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []
    private let closeDeadline: Duration
    private let queue = DispatchQueue(label: "live-mindmap.websocket")
    private var retained: [HelperEventRetentionSlot: HelperEvent] = [:]
    /// nil は初回接続済み。全接続が切れても蓄積を再開しない。
    private var initialEvents: [HelperEvent]? = []
    private let writeStderr: @Sendable (String) -> Void
    /// クライアントから届いたテキストフレームを、届いた順に流す（Issue #1069。サーバーからの休止の指示）。`stop` で終わる。
    public nonisolated let messages: AsyncStream<String>
    private nonisolated let messageContinuation: AsyncStream<String>.Continuation

    /// `port` が 0 のときは空きポートを使う。
    public init(port: UInt16) {
        self.init(port: port, writeStderr: { message in
            FileHandle.standardError.write(Data((message + "\n").utf8))
        })
    }

    /// `closeDeadline` は、`stop` が受け手の close の返事を待つ上限。`contentProcessed` はバイトが出ていく前に返り、`cancel` は残りを捨てるので、
    /// 受け手が読み終えた証拠は close の返事しかない。返事をしない相手でも止まれるように上限を置き、3 秒は server の SIGKILL までの 5 秒（`HELPER_STOP_TIMEOUT_MS`）に収める。
    init(port: UInt16, closeDeadline: Duration = .seconds(3), writeStderr: @escaping @Sendable (String) -> Void) {
        requestedPort = port
        self.closeDeadline = closeDeadline
        self.writeStderr = writeStderr
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

    /// 種類に従って保持し、初回接続前の通常イベントも失わずに届ける。`stop` の前に送ったものは `stop` が届くまで待つ。`stop` の後に送ったものは捨てる。
    public func send(_ event: HelperEvent) {
        guard isRunning, let text = encode(event) else { return }
        switch event.delivery(retained: retained[.screen]) {
        case .retain(let slot): retained[slot] = event
        case .bufferUntilFirstClient: initialEvents?.append(event)
        case .connectedOnly: break
        }
        for connection in clients.values {
            send(text, to: connection)
        }
    }

    private func encode(_ event: HelperEvent) -> String? {
        do {
            return try event.jsonString()
        } catch {
            // EncodingError の内容には発言や画像が含まれうるので、種類名だけを記録する。
            let kind = String(describing: event).prefix { $0 != "(" }
            writeStderr("helper event \(kind): JSON にできなかったので送らない")
            return nil
        }
    }

    /// 録画の読み始めを接続後に揃える。接続済みならすぐ戻り、`stop` でも戻る。
    public func waitForClient() async {
        if !clients.isEmpty || !isRunning { return }
        await withCheckedContinuation { clientWaiters.append($0) }
    }

    private func send(_ text: String, to connection: NWConnection) {
        enqueue(Data(text.utf8), metadata: NWProtocolWebSocket.Metadata(opcode: .text), identifier: "text", to: connection)
    }

    private func sendClose(to connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = .protocolCode(.normalClosure)
        enqueue(nil, metadata: metadata, identifier: "close", to: connection)
    }

    private func enqueue(_ content: Data?, metadata: NWProtocolWebSocket.Metadata, identifier: String, to connection: NWConnection) {
        let context = NWConnection.ContentContext(identifier: identifier, metadata: [metadata])
        let id = ObjectIdentifier(connection)
        connection.send(content: content, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
            guard let self, error != nil else { return }
            Task { await self.remove(id) }
        })
    }

    private func resumeAll(_ waiters: inout [CheckedContinuation<Void, Never>]) {
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }

    /// 新しい接続を断り、接続ごとに、それまでに送ったフレームの後ろへ close を送る。全接続が返事をする（または上限が来る）まで戻らない。
    /// 戻ったとき `clientCount` は 0 で、`messages` は終わっている。同時に呼ぶと同じ閉じ方に相乗りし、閉じた後はすぐ戻る。
    public func stop() async {
        if isRunning { beginClosing() }
        guard case .closing = lifecycle else { return }
        await withCheckedContinuation { closeWaiters.append($0) }
    }

    private func beginClosing() {
        listener?.cancel()
        listener = nil
        initialEvents = nil
        // 待っている呼び出しは、止まった以上これ以上待てないので戻す
        resumeAll(&clientWaiters)
        lifecycle = .closing(deadline: Task {
            do { try await Task.sleep(for: closeDeadline) } catch { return }
            giveUpClosing()
        })
        for connection in clients.values { sendClose(to: connection) }
        finishClosingIfDrained()
    }

    private func giveUpClosing() {
        guard case .closing = lifecycle else { return }
        writeStderr("WebSocket: \(clients.count) 件の接続から \(closeDeadline) 待っても close の返事が来なかったので、届いたか確かめずに切る")
        for id in Array(clients.keys) { remove(id) }
    }

    private func finishClosingIfDrained() {
        guard case .closing(let deadline) = lifecycle, clients.isEmpty else { return }
        deadline.cancel()
        messageContinuation.finish()
        lifecycle = .closed
        resumeAll(&closeWaiters)
    }

    private func accept(_ connection: NWConnection) {
        guard isRunning else { return connection.cancel() }
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
        guard isRunning else { return connection.cancel() }
        clients[ObjectIdentifier(connection)] = connection
        for slot in HelperEventRetentionSlot.allCases {
            if let event = retained[slot], let text = encode(event) { send(text, to: connection) }
        }
        if let events = initialEvents {
            initialEvents = nil
            for event in events {
                if let text = encode(event) { send(text, to: connection) }
            }
        }
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
        finishClosingIfDrained()
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
