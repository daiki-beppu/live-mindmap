import Foundation
import Testing
@testable import AppleIntelligenceCore

@Suite("Apple 生成結果の元スキーマ検証")
struct AppleResponseValidationTests {
    private func validate(_ response: String, schema: String) throws {
        _ = try appleGenerationSchemaJSON(Data(schema.utf8))
        let object = try #require(JSONSerialization.jsonObject(with: Data(schema.utf8)) as? [String: Any])
        try validateAppleResponse(response, schema: object)
    }

    private let classification = #"""
    {"type":"object","properties":{
      "議題":{"type":"object","properties":{"id":{"type":"string","enum":["新しい議題"]},"題":{"type":"string","maxLength":20}},"required":["id","題"],"additionalProperties":false},
      "文":{"type":"array","minItems":1,"maxItems":1,"items":{"anyOf":[
        {"type":"object","properties":{"種類":{"const":"なし"}},"required":["種類"],"additionalProperties":false},
        {"type":"object","properties":{"種類":{"const":"説明"},"text":{"type":"string","minLength":1,"maxLength":40}},"required":["種類","text"],"additionalProperties":false}
      ]}},
      "済み":{"type":"string","enum":["なし"]}
    },"required":["議題","文","済み"],"additionalProperties":false}
    """#

    private func response(title: String, sentences: [[String: String]]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [
            "議題": ["id": "新しい議題", "題": title], "文": sentences, "済み": "なし",
        ])
        return try #require(String(data: data, encoding: .utf8))
    }

    @Test("一致する anyOf 枝の長さを満たす応答をそのまま受理する", arguments: [
        ["種類": "説明", "text": "面接官は3人です"],
        ["種類": "説明", "text": String(repeating: "あ", count: 40)],
        ["種類": "なし"],
    ])
    func acceptsClassification(_ sentence: [String: String]) throws {
        try validate(response(title: String(repeating: "あ", count: 20), sentences: [sentence]), schema: classification)
    }

    @Test("別の anyOf 枝があっても説明の文字列長違反を拒否する", arguments: ["", String(repeating: "あ", count: 41)])
    func rejectsSummaryLength(_ text: String) throws {
        let content = try response(title: "採用", sentences: [["種類": "説明", "text": text]])
        #expect(throws: AppleError.self) { try validate(content, schema: classification) }
    }

    @Test("不一致の枝の制約を診断し、応答の本文をエラーへ含めない")
    func diagnosesConstraintsWithoutContent() throws {
        let text = String(repeating: "応答本文", count: 20)
        let content = try response(title: "採用", sentences: [["種類": "説明", "text": text]])
        do {
            try validate(content, schema: classification)
            Issue.record("制約違反の応答が受理されました")
        } catch AppleError.invalid(let reason) {
            #expect(reason.contains("maxLength"))
            #expect(!reason.contains(text))
        }
    }

    @Test("21文字の議題名を拒否する")
    func rejectsTitleLength() throws {
        let content = try response(title: String(repeating: "あ", count: 21), sentences: [["種類": "なし"]])
        #expect(throws: AppleError.self) { try validate(content, schema: classification) }
    }

    @Test("分類配列の上下限違反を拒否する", arguments: [0, 2])
    func rejectsArrayLength(_ count: Int) throws {
        let content = try response(title: "採用", sentences: Array(repeating: ["種類": "なし"], count: count))
        #expect(throws: AppleError.self) { try validate(content, schema: classification) }
    }

    @Test("必須フィールド欠落・余分なフィールド・列挙値違反を拒否する", arguments: [
        #"{"議題":{"id":"新しい議題","題":"採用"},"文":[{"種類":"説明"}],"済み":"なし"}"#,
        #"{"議題":{"id":"新しい議題","題":"採用"},"文":[{"種類":"なし","text":"余分"}],"済み":"なし"}"#,
        #"{"議題":{"id":"不明","題":"採用"},"文":[{"種類":"なし"}],"済み":"なし"}"#,
        #"{"議題":{"id":"新しい議題","題":"採用"},"文":[{"種類":"なし"}]}"#,
        #"{"議題":{"id":"新しい議題","題":"採用"},"文":[{"種類":"なし"}],"済み":"済み"}"#,
    ])
    func rejectsClassification(_ content: String) throws {
        #expect(throws: AppleError.self) { try validate(content, schema: classification) }
    }

    @Test("JSON Schema の文字数は grapheme と UTF-16 長から独立している")
    func unicodeLength() throws {
        try validate(#""😀""#, schema: #"{"type":"string","minLength":1,"maxLength":1}"#)
        #expect(throws: AppleError.self) {
            try validate(#""e\u0301""#, schema: #"{"type":"string","maxLength":1}"#)
        }
        try validate(#""e\u0301""#, schema: #"{"type":"string","minLength":2,"maxLength":2}"#)
        try validate(#""a\nb""#, schema: #"{"type":"string","minLength":3,"maxLength":3}"#)
    }

    @Test("受理する scalar 型を保ち、boolean を数値として扱わない")
    func scalarTypes() throws {
        for (schema, valid, invalid) in [
            (#"{"type":"boolean"}"#, "true", "1"),
            (#"{"type":"integer"}"#, "2", "2.5"),
            (#"{"type":"number"}"#, "2.5", "true"),
            (#"{"type":"integer"}"#, "2.0", "false"),
            (#"{"type":"string","const":"説明"}"#, #""説明""#, #""なし""#),
            (#"{"type":"string"}"#, #""text""#, "null"),
            (#"{"type":"object","properties":{}}"#, "{}", "[]"),
            (#"{"type":"array","items":{"type":"string"}}"#, "[]", "{}"),
        ] {
            try validate(valid, schema: schema)
            #expect(throws: AppleError.self) { try validate(invalid, schema: schema) }
        }
    }

    @Test("任意プロパティを検証し、省略と許可された追加プロパティを保持する")
    func optionalProperties() throws {
        let schema = #"{"type":"object","properties":{"text":{"type":"string","maxLength":1}}}"#
        try validate("{}", schema: schema)
        try validate(#"{"extra":42}"#, schema: schema)
        try validate(#"{"text":"a"}"#, schema: schema)
        #expect(throws: AppleError.self) { try validate(#"{"text":"ab"}"#, schema: schema) }
    }

    @Test("不正な JSON 応答を拒否する")
    func malformedResponse() throws {
        #expect(throws: (any Error).self) { try validate("{", schema: classification) }
    }
}
