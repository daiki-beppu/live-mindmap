import Foundation
import FoundationModels

public struct AppleGenerationRequest: Sendable {
    public let system: String
    public let prompt: String
    public let schema: Data
    public let maximumResponseTokens: Int
}

public struct AppleGenerationResult: Sendable {
    public let content: String
    // トークン数は SDK 27 の `Response.usage` から取る。古い SDK でビルドしたときは無い
    public let inputTokens: Int?
    public let cachedTokens: Int?
    public let outputTokens: Int?
    public init(content: String, inputTokens: Int?, cachedTokens: Int?, outputTokens: Int?) {
        self.content = content; self.inputTokens = inputTokens
        self.cachedTokens = cachedTokens; self.outputTokens = outputTokens
    }
}

public enum AppleGeneration {
    public static func availability() -> [String: Any] {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let os = "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
        var status: [String: String]
        if #available(macOS 27, *) {
            switch SystemLanguageModel.default.availability {
            case .available: status = ["status": "available"]
            case .unavailable(let reason):
                let name: String
                switch reason {
                case .appleIntelligenceNotEnabled: name = "appleIntelligenceNotEnabled"
                case .deviceNotEligible: name = "deviceNotEligible"
                case .modelNotReady: name = "modelNotReady"
                @unknown default: name = String(describing: reason)
                }
                status = ["status": "unavailable", "reason": name]
            }
        } else {
            status = ["status": "unavailable", "reason": "unsupportedOS"]
        }
        return ["osVersion": os, "availability": status]
    }

    @available(macOS 27, *)
    public static func prepare() async throws {
        let model = SystemLanguageModel.default
        guard case .available = model.availability else { throw AppleError.invalid("Apple Intelligence: \(model.availability)") }
        guard model.contextSize == 8192 else { throw AppleError.invalid("文脈長が 8192 ではありません: \(model.contextSize)") }
        // 実生成の完了を待ち、prewarm の開始だけを準備完了としない。
        let schema = try GenerationSchema(root: DynamicGenerationSchema(type: String.self, guides: [.constant("ready")]), dependencies: [])
        _ = try await LanguageModelSession(model: model).respond(to: "Return ready.", schema: schema, options: GenerationOptions(maximumResponseTokens: 8))
    }

    public static func generate(system: String, prompt: String, schema: Data, maximumResponseTokens: Int) async throws -> AppleGenerationResult {
        guard #available(macOS 27, *) else { throw AppleError.invalid("macOS 27 以上が必要です") }
        guard maximumResponseTokens > 0 else { throw AppleError.invalid("出力上限は正の整数である必要があります") }
        let model = SystemLanguageModel.default
        guard case .available = model.availability, model.contextSize == 8192 else { throw AppleError.invalid("Apple Intelligence を利用できません: \(model.availability), contextSize=\(model.contextSize)") }
        let converted = try appleGenerationSchemaJSON(schema)
        let original = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        FileHandle.standardError.write(Data("Apple generation: schema start\n".utf8))
        let object = try JSONSerialization.jsonObject(with: converted) as! [String: Any]
        let dynamic = try makeDynamic(object)
        let generationSchema = try GenerationSchema(root: dynamic, dependencies: [])
        FileHandle.standardError.write(Data("Apple generation: schema complete\n".utf8))
        let session = LanguageModelSession(model: model, instructions: system)
        FileHandle.standardError.write(Data("Apple generation: respond start\n".utf8))
        let response = try await session.respond(to: prompt, schema: generationSchema, options: GenerationOptions(temperature: 0.2, maximumResponseTokens: maximumResponseTokens))
        FileHandle.standardError.write(Data("Apple generation: respond complete; validation start\n".utf8))
        // `Response.usage` は SDK 27（Swift 6.4 の Xcode）から。CI の macos-26 の SDK には無いので、コンパイラの版で分ける
        #if compiler(>=6.4)
        let usage: (input: Int?, cached: Int?, output: Int?) = (response.usage.input.totalTokenCount, response.usage.input.cachedTokenCount, response.usage.output.totalTokenCount)
        #else
        let usage: (input: Int?, cached: Int?, output: Int?) = (nil, nil, nil)
        #endif
        do {
            try validateAppleResponse(response.content.jsonString, schema: original)
        } catch AppleError.invalid(let reason) {
            FileHandle.standardError.write(Data("Apple generation: validation failed: \(reason); outputTokens=\(usage.output.map(String.init) ?? "unknown"), maximumResponseTokens=\(maximumResponseTokens)\n".utf8))
            throw AppleError.invalid(reason)
        }
        FileHandle.standardError.write(Data("Apple generation: validation complete\n".utf8))
        return AppleGenerationResult(content: response.content.jsonString, inputTokens: usage.input, cachedTokens: usage.cached, outputTokens: usage.output)
    }
}

@available(macOS 27, *)
private func makeDynamic(_ node: [String: Any]) throws -> DynamicGenerationSchema {
    let supported: Set<String> = ["type", "title", "description", "properties", "required", "additionalProperties", "x-order",
        "items", "minItems", "maxItems", "anyOf", "enum", "const", "minLength", "maxLength", "$schema"]
    guard Set(node.keys).isSubset(of: supported) else { throw AppleError.invalid("対応していない schema キーワード: \(Set(node.keys).subtracting(supported))") }
    let description = node["description"] as? String
    if let choices = node["anyOf"] as? [[String: Any]] {
        return DynamicGenerationSchema(name: node["title"] as! String, description: description, anyOf: try choices.map(makeDynamic))
    }
    if let constant = node["const"] as? String {
        return DynamicGenerationSchema(type: String.self, guides: [.constant(constant)])
    }
    switch node["type"] as? String {
    case "object":
        guard let properties = node["properties"] as? [String: [String: Any]],
              let order = node["x-order"] as? [String] else { throw AppleError.invalid("object のプロパティが不正です") }
        let required = node["required"] as? [String] ?? []
        guard Set(required).isSubset(of: Set(order)), node["additionalProperties"] == nil || node["additionalProperties"] as? Bool == false else {
            throw AppleError.invalid("object の必須プロパティまたは additionalProperties が不正です")
        }
        return DynamicGenerationSchema(name: node["title"] as! String, description: description, properties: try order.map { key in
            let property = properties[key]!
            var descriptions = (property["description"] as? String).map { [$0] } ?? []
            // pattern guide は複合分類で生成が完了しないため、長さは説明と生成後検証で保証する。
            if let min = property["minLength"] as? Int { descriptions.append("文字列は Unicode code point で \(min) 文字以上。") }
            if let max = property["maxLength"] as? Int { descriptions.append("文字列は Unicode code point で \(max) 文字以内。短く要約する。") }
            return DynamicGenerationSchema.Property(name: key, description: descriptions.isEmpty ? nil : descriptions.joined(separator: "\n"),
                schema: try makeDynamic(property), isOptional: !required.contains(key))
        })
    case "array":
        guard let items = node["items"] as? [String: Any] else { throw AppleError.invalid("items が不正です") }
        return DynamicGenerationSchema(arrayOf: try makeDynamic(items), minimumElements: node["minItems"] as? Int, maximumElements: node["maxItems"] as? Int)
    case "string":
        var guides: [GenerationGuide<String>] = []
        if let values = node["enum"] as? [String] { guides.append(.anyOf(values)) }
        return DynamicGenerationSchema(type: String.self, guides: guides)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    case "number": return DynamicGenerationSchema(type: Double.self)
    default: throw AppleError.invalid("対応していない schema 型です")
    }
}
