import Foundation
import Network

public actor AppleHTTPServer {
    private let generate: @Sendable (AppleGenerationRequest) async throws -> AppleGenerationResult
    private let queue = DispatchQueue(label: "live-mindmap.apple.http")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    public init(generate: @escaping @Sendable (AppleGenerationRequest) async throws -> AppleGenerationResult) {
        self.generate = generate
    }

    public func start() async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            Task { await self.accept(connection) }
        }
        return try await withCheckedThrowingContinuation { continuation in
            let once = HTTPResumeOnce()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard once.take() else { return }
                    if let port = listener.port?.rawValue { continuation.resume(returning: port) }
                    else { continuation.resume(throwing: AppleError.invalid("待受けポートを取得できません")) }
                case .failed(let error):
                    if once.take() { continuation.resume(throwing: error) }
                case .cancelled:
                    if once.take() { continuation.resume(throwing: CancellationError()) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    public func stop() {
        listener?.cancel()
        listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard listener != nil else { return connection.cancel() }
        connections[ObjectIdentifier(connection)] = connection
        connection.start(queue: queue)
        Task {
            do {
                let body = try await readRequest(connection)
                let request = try decodeRequest(body)
                let result = try await generate(request)
                var object: [String: Any] = [
                    "choices": [["message": ["role": "assistant", "content": result.content], "finish_reason": "stop"]],
                ]
                if let input = result.inputTokens, let output = result.outputTokens {
                    object["usage"] = ["prompt_tokens": input, "completion_tokens": output,
                        "prompt_tokens_details": ["cached_tokens": result.cachedTokens ?? 0]]
                }
                try await reply(connection, status: 200, object: object)
            } catch {
                do { try await reply(connection, status: 500, object: ["error": String(describing: error)]) }
                catch { /* 切断済みの接続へは応答できない。以下で必ず解放する。 */ }
            }
            connections.removeValue(forKey: ObjectIdentifier(connection))
            connection.cancel()
        }
    }

    private func readRequest(_ connection: NWConnection) async throws -> Data {
        var bytes = Data()
        while true {
            let (chunk, ended) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, Bool), Error>) in
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, ended, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: (data ?? Data(), ended)) }
                }
            }
            bytes.append(chunk)
            guard bytes.count <= 4 * 1024 * 1024 else { throw AppleError.invalid("HTTP 要求が大きすぎます") }
            if let separator = bytes.range(of: Data("\r\n\r\n".utf8)) {
                guard let header = String(data: bytes[..<separator.lowerBound], encoding: .utf8) else { throw AppleError.invalid("HTTP header が不正です") }
                let lines = header.components(separatedBy: "\r\n")
                guard lines.first == "POST /v1/chat/completions HTTP/1.1" else { throw AppleError.invalid("未対応の HTTP endpoint です") }
                let lengths = lines.dropFirst().filter { $0.lowercased().hasPrefix("content-length:") }
                guard lengths.count == 1, let length = Int(lengths[0].dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)),
                      length > 0, length <= 4 * 1024 * 1024,
                      !lines.contains(where: { $0.lowercased().hasPrefix("transfer-encoding:") }) else {
                    throw AppleError.invalid("Content-Length が不正です")
                }
                if bytes.count >= separator.upperBound + length { return bytes.subdata(in: separator.upperBound..<(separator.upperBound + length)) }
            }
            if ended { throw AppleError.invalid("HTTP 要求が不完全です") }
        }
    }

    private func decodeRequest(_ data: Data) throws -> AppleGenerationRequest {
        struct Message: Decodable { let role: String; let content: String }
        struct Format: Decodable {
            let type: String
        }
        struct Request: Decodable { let messages: [Message]; let max_tokens: Int?; let response_format: Format }
        let input = try JSONDecoder().decode(Request.self, from: data)
        guard input.response_format.type == "json_schema", input.messages.count == 2,
              input.messages[0].role == "system", input.messages[1].role == "user",
              input.max_tokens == nil || input.max_tokens! > 0 else { throw AppleError.invalid("構造化生成の要求が不正です") }
        // JSONDecoder で再直列化すると schema のプロパティ順が変わるため、元の JSON から切り出す。
        let schema = try schemaBytes(data)
        return AppleGenerationRequest(system: input.messages[0].content, prompt: input.messages[1].content,
            schema: schema, maximumResponseTokens: input.max_tokens ?? 600)
    }

    private func reply(_ connection: NWConnection, status: Int, object: [String: Any]) async throws {
        let body = try JSONSerialization.data(withJSONObject: object)
        var bytes = Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Internal Server Error")\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        bytes.append(body)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: bytes, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }
}

private final class HTTPResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if resumed { return false }
        resumed = true
        return true
    }
}
