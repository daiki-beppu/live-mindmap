import Foundation
import Testing
import AppleIntelligenceCore

@Suite("本物の Foundation Models で構造化生成", .timeLimit(.minutes(2)), .disabled(if: ProcessInfo.processInfo.environment["CI"] != nil, "CI のランナー（macos-26）には Apple Intelligence が無い"))
struct AppleGenerationHeavyTests {
    @Test("分類の object・array・union・必須フィールドを満たす JSON を返す")
    func generatesClassification() async throws {
        guard #available(macOS 27, *) else { throw NSError(domain: "AppleGenerationHeavyTests", code: 1) }
        print("Apple heavy: prepare start")
        try await AppleGeneration.prepare()
        print("Apple heavy: prepare complete")
        let schema = Data(#"""
        {"type":"object","properties":{
          "議題":{"type":"object","properties":{"id":{"type":"string","enum":["新しい議題"]},"題":{"type":"string","maxLength":20}},"required":["id","題"],"additionalProperties":false},
          "文":{"type":"array","minItems":1,"maxItems":1,"items":{"anyOf":[
            {"type":"object","properties":{"種類":{"type":"string","enum":["なし"]}},"required":["種類"],"additionalProperties":false},
            {"type":"object","properties":{"種類":{"type":"string","enum":["説明"]},"text":{"type":"string","minLength":1,"maxLength":40}},"required":["種類","text"],"additionalProperties":false}
          ]}},
          "済み":{"type":"string","enum":["なし"]}
        },"required":["議題","文","済み"],"additionalProperties":false}
        """#.utf8)
        let result = try await AppleGeneration.generate(
            system: "会議の発言を指定された JSON に分類してください。議題の題は20文字以内、説明のtextは1文字以上40文字以内で短く要約してください。",
            prompt: "採用について説明します。面接官は3人です。新しい発言は1文です。",
            schema: schema,
            maximumResponseTokens: 600
        )
        let object = try #require(JSONSerialization.jsonObject(with: Data(result.content.utf8)) as? [String: Any])
        #expect(Set(object.keys) == Set(["議題", "文", "済み"]))
        let topic = try #require(object["議題"] as? [String: Any])
        #expect(Set(topic.keys) == Set(["id", "題"]))
        #expect(topic["id"] as? String == "新しい議題")
        let title = try #require(topic["題"] as? String)
        #expect(title.count <= 20)
        #expect(object["済み"] as? String == "なし")
        let sentences = try #require(object["文"] as? [[String: Any]])
        #expect(sentences.count == 1)
        let sentence = try #require(sentences.first)
        let kind = try #require(sentence["種類"] as? String)
        #expect(["なし", "説明"].contains(kind))
        if kind == "説明" {
            #expect(Set(sentence.keys) == Set(["種類", "text"]))
            let text = try #require(sentence["text"] as? String)
            #expect(!text.isEmpty && text.count <= 40)
        } else {
            #expect(Set(sentence.keys) == Set(["種類"]))
        }
    }
}
