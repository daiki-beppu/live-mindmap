import Foundation
import AppleIntelligenceCore

@main
struct AppleMain {
    static func emit(_ object: [String: Any]) throws {
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: object))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard args == ["availability"] || args == ["serve"] else {
                throw NSError(domain: "live-mindmap-apple", code: 1, userInfo: [NSLocalizedDescriptionKey: "usage: live-mindmap-apple availability|serve"])
            }
            let state = AppleGeneration.availability()
            if args == ["availability"] {
                try emit(state)
                return
            }
            guard #available(macOS 27, *), (state["availability"] as? [String: String])?["status"] == "available" else {
                try emit(state)
                return
            }
            try await AppleGeneration.prepare()
            let server = AppleHTTPServer(generate: { request in
                try await AppleGeneration.generate(system: request.system, prompt: request.prompt, schema: request.schema, maximumResponseTokens: request.maximumResponseTokens)
            })
            defer { withExtendedLifetime(server) {} }
            let port = try await server.start()
            try emit(["type": "ready", "url": "http://127.0.0.1:\(port)/v1", "contextSize": 8192])
            // 親がセッション Scope の終了で SIGTERM を送り、プロセスの終了が listener も閉じる。
            while true { try await Task.sleep(for: .seconds(3600)) }
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
