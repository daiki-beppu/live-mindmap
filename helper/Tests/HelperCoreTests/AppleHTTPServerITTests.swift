import Foundation
import Testing
import AppleIntelligenceCore

private actor GenerationCalls {
    var requests: [AppleGenerationRequest] = []
    func add(_ request: AppleGenerationRequest) { requests.append(request) }
}

@Suite("Apple の OpenAI 互換 HTTP", .timeLimit(.minutes(1)))
struct AppleHTTPServerITTests {
    @Test("ループバック HTTP で受けた構造化生成の入力を運び、互換応答を返す")
    func chatCompletions() async throws {
        let calls = GenerationCalls()
        let server = AppleHTTPServer(generate: { request in
            await calls.add(request)
            return AppleGenerationResult(content: #"{"zeta":"先頭","answer":"はい","alpha":"末尾"}"#, inputTokens: 12, cachedTokens: 0, outputTokens: 5)
        })
        let port = try await server.start()
        do {
            // 辞書の再シリアライズに依存せず、HTTP 入力の順序を明示する。
            let schemaJSON = #"{"type":"object","properties":{"zeta":{"type":"string"},"answer":{"type":"string","enum":["はい"]},"alpha":{"type":"string"}},"required":["zeta","answer","alpha"],"additionalProperties":false}"#
            let schema = try #require(JSONSerialization.jsonObject(with: Data(schemaJSON.utf8)) as? NSDictionary)
            var request = URLRequest(url: try #require(URL(string: "http://127.0.0.1:\(port)/v1/chat/completions")))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = Data("""
            {"model":"apple","max_tokens":600,"temperature":0.2,"messages":[{"role":"system","content":"合成の指示"},{"role":"user","content":"合成の入力"}],"response_format":{"type":"json_schema","json_schema":{"name":"diff","strict":true,"schema":\(schemaJSON)}}}
            """.utf8)
            // 同じ listener を続けて使う。要求ごとに渡す入力が前の会話に置換されない。
            for _ in 0..<2 {
                let (data, response) = try await URLSession.shared.data(for: request)
                #expect((response as? HTTPURLResponse)?.statusCode == 200)
                let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let choices = try #require(body["choices"] as? [[String: Any]])
                let message = try #require(choices.first?["message"] as? [String: Any])
                #expect(message["role"] as? String == "assistant")
                let content = try #require(message["content"] as? String)
                let answer = try #require(JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: String])
                #expect(answer == ["zeta": "先頭", "answer": "はい", "alpha": "末尾"])
                let usage = try #require(body["usage"] as? [String: Any])
                #expect(usage["prompt_tokens"] as? Int == 12)
                #expect(usage["completion_tokens"] as? Int == 5)
            }
            let received = await calls.requests
            #expect(received.count == 2)
            for input in received {
                #expect(input.system == "合成の指示")
                #expect(input.prompt == "合成の入力")
                #expect(input.maximumResponseTokens == 600)
                let passedSchema = try #require(JSONSerialization.jsonObject(with: input.schema) as? NSDictionary)
                #expect(passedSchema == schema)
                let converted = try appleGenerationSchemaJSON(input.schema)
                let appleSchema = try #require(JSONSerialization.jsonObject(with: converted) as? [String: Any])
                #expect(appleSchema["x-order"] as? [String] == ["zeta", "answer", "alpha"])
            }
        } catch {
            await server.stop()
            throw error
        }
        await server.stop()
    }

    @Test("生成の失敗を成功の completions にせず HTTP で返す")
    func generationFailure() async throws {
        enum GenerationFailure: Error { case unavailable }
        let calls = GenerationCalls()
        let server = AppleHTTPServer(generate: { request in
            await calls.add(request)
            throw GenerationFailure.unavailable
        })
        let port = try await server.start()
        do {
            var request = URLRequest(url: try #require(URL(string: "http://127.0.0.1:\(port)/v1/chat/completions")))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = Data(#"{"model":"apple","max_tokens":600,"messages":[{"role":"system","content":"合成"},{"role":"user","content":"入力"}],"response_format":{"type":"json_schema","json_schema":{"name":"diff","strict":true,"schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}}}"#.utf8)
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = try #require((response as? HTTPURLResponse)?.statusCode)
            #expect(status >= 400)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(await calls.requests.count == 1)
            #expect(body["error"] != nil)
        } catch {
            await server.stop()
            throw error
        }
        await server.stop()
    }
}
