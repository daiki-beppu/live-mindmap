import Foundation
import Testing
import AppleIntelligenceCore

@Suite("Apple のスキーマ方言")
struct AppleSchemaTests {
    private func convert(_ json: String) throws -> [String: Any] {
        let data = try appleGenerationSchemaJSON(Data(json.utf8))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("object・array・anyOf の入れ子に順序と枝の title を付け、制約を保持する")
    func nestedClassification() throws {
        let schema = try convert(#"""
        {"type":"object","properties":{
          "議題":{"type":"object","properties":{"id":{"type":"string","enum":["新しい議題"]},"題":{"type":"string","maxLength":20}},"required":["id","題"],"additionalProperties":false},
          "文":{"type":"array","minItems":1,"maxItems":1,"items":{"anyOf":[
            {"type":"object","properties":{"種類":{"const":"なし"}},"required":["種類"],"additionalProperties":false},
            {"type":"object","properties":{"種類":{"type":"string","enum":["説明","問い"]},"text":{"type":"string","minLength":1,"maxLength":40}},"required":["種類","text"],"additionalProperties":false}
          ]}},
          "済み":{"type":"string","enum":["なし"]}
        },"required":["議題","文","済み"],"additionalProperties":false}
        """#)
        #expect(schema["x-order"] as? [String] == ["議題", "文", "済み"])
        #expect(schema["required"] as? [String] == ["議題", "文", "済み"])
        #expect(schema["additionalProperties"] as? Bool == false)
        let properties = try #require(schema["properties"] as? [String: [String: Any]])
        #expect(properties["議題"]?["x-order"] as? [String] == ["id", "題"])
        let topic = try #require(properties["議題"]?["properties"] as? [String: [String: Any]])
        #expect(topic["id"]?["enum"] as? [String] == ["新しい議題"])
        #expect(topic["題"]?["maxLength"] as? Int == 20)
        let sentences = try #require(properties["文"])
        #expect(sentences["minItems"] as? Int == 1)
        #expect(sentences["maxItems"] as? Int == 1)
        let items = try #require(sentences["items"] as? [String: Any])
        let branches = try #require(items["anyOf"] as? [[String: Any]])
        #expect(branches.count == 2)
        let titles = try branches.map { try #require($0["title"] as? String) }
        #expect(titles.allSatisfy { !$0.isEmpty })
        #expect(Set(titles).count == 2)
        #expect(branches[0]["x-order"] as? [String] == ["種類"])
        #expect(branches[1]["x-order"] as? [String] == ["種類", "text"])
        let first = try #require(branches[0]["properties"] as? [String: [String: Any]])
        #expect(first["種類"]?["const"] as? String == "なし")
        let second = try #require(branches[1]["properties"] as? [String: [String: Any]])
        #expect(second["種類"]?["enum"] as? [String] == ["説明", "問い"])
        #expect(second["text"]?["minLength"] as? Int == 1)
        #expect(second["text"]?["maxLength"] as? Int == 40)
    }

    @Test("キーワードと同じプロパティ名と説明文はスキーマの構造として変換しない")
    func literalKeywords() throws {
        let schema = try convert(#"""
        {"type":"object","description":"anyOf x-order title は説明文です","properties":{
          "title":{"type":"string","description":"anyOf"},
          "anyOf":{"type":"string","enum":["x-order","title"]},
          "x-order":{"type":"string","const":"anyOf"}
        },"required":["title","anyOf","x-order"]}
        """#)
        #expect(schema["description"] as? String == "anyOf x-order title は説明文です")
        #expect(schema["x-order"] as? [String] == ["title", "anyOf", "x-order"])
        let properties = try #require(schema["properties"] as? [String: [String: Any]])
        #expect(properties["title"]?["description"] as? String == "anyOf")
        #expect(properties["anyOf"]?["enum"] as? [String] == ["x-order", "title"])
        #expect(properties["x-order"]?["const"] as? String == "anyOf")
    }

    @Test("root と object のプロパティ直下の anyOf にも枝の title を付ける", arguments: [
        #"{"anyOf":[{"type":"string","enum":["なし"]},{"type":"string","enum":["済み"]}]}"#,
        #"{"type":"object","properties":{"状態":{"anyOf":[{"type":"string","enum":["なし"]},{"type":"string","enum":["済み"]}]}}}"#,
    ])
    func unionLocations(_ json: String) throws {
        let schema = try convert(json)
        let properties = schema["properties"] as? [String: [String: Any]]
        let union = properties == nil ? schema : try #require(properties?["状態"])
        let branches = try #require(union["anyOf"] as? [[String: Any]])
        let titles = try branches.map { try #require($0["title"] as? String) }
        #expect(titles.allSatisfy { !$0.isEmpty })
        #expect(Set(titles).count == 2)
        #expect(branches[0]["enum"] as? [String] == ["なし"])
        #expect(branches[1]["enum"] as? [String] == ["済み"])
    }

    @Test("不正な JSON と array・anyOf の不正な構造を無制約へ落とさず拒否する", arguments: [
        "{", #"{"type":"array"}"#, #"{"type":"array","items":42}"#,
        #"{"anyOf":[]}"#, #"{"anyOf":[42]}"#,
        #"{"type":"string","maxLength":"40"}"#,
        #"{"type":"string","minLength":41,"maxLength":40}"#,
        #"{"type":"string","enum":[42]}"#,
        #"{"type":"string","pattern":".*"}"#,
        #"{"type":"array","items":{"type":"string"},"minItems":true}"#,
        #"{"type":"object","properties":{},"required":["missing"]}"#,
        #"{"type":"object","properties":{},"additionalProperties":0}"#,
        #"{"type":42,"const":"なし"}"#,
    ])
    func invalidSchema(_ json: String) throws {
        #expect(throws: (any Error).self) { try appleGenerationSchemaJSON(Data(json.utf8)) }
    }
}
