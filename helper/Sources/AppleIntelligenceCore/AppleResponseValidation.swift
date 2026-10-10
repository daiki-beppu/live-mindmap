import Foundation
import CoreFoundation

// 入力 schema は appleGenerationSchemaJSON が受理した範囲に限る。
func validateAppleResponse(_ content: String, schema: [String: Any]) throws {
    let value = try JSONSerialization.jsonObject(with: Data(content.utf8), options: .fragmentsAllowed)
    try validateResponseValue(value, schema: schema, path: "$")
}

private func validateResponseValue(_ value: Any, schema: [String: Any], path: String) throws {
    if let branches = schema["anyOf"] as? [[String: Any]] {
        var failures: [String] = []
        for (index, branch) in branches.enumerated() {
            do {
                try validateResponseValue(value, schema: branch, path: path)
                return
            } catch AppleError.invalid(let reason) {
                failures.append("anyOf[\(index)]: \(reason)")
            }
        }
        throw AppleError.invalid("\(path): anyOf に一致しません; \(failures.joined(separator: "; "))")
    }
    func reject(_ constraint: String) throws -> Never {
        throw AppleError.invalid("\(path): \(constraint) を満たしません")
    }
    switch schema["type"] as? String {
    case "object":
        guard let object = value as? [String: Any],
              let properties = schema["properties"] as? [String: [String: Any]] else { try reject("object") }
        let required = schema["required"] as? [String] ?? []
        let missing = required.filter { object[$0] == nil }
        guard missing.isEmpty else { try reject("required (\(missing.joined(separator: ", ")))") }
        if schema["additionalProperties"] as? Bool == false,
           !Set(object.keys).isSubset(of: Set(properties.keys)) { try reject("additionalProperties") }
        for (key, child) in properties {
            if let field = object[key] { try validateResponseValue(field, schema: child, path: path + "." + key) }
        }
    case "array":
        guard let array = value as? [Any], let items = schema["items"] as? [String: Any] else { try reject("array") }
        if let min = schema["minItems"] as? Int, array.count < min { try reject("minItems") }
        if let max = schema["maxItems"] as? Int, array.count > max { try reject("maxItems") }
        for (index, item) in array.enumerated() {
            try validateResponseValue(item, schema: items, path: "\(path)[\(index)]")
        }
    case "string", nil:
        guard let string = value as? String else { try reject("string") }
        if let constant = schema["const"] as? String,
           !string.unicodeScalars.elementsEqual(constant.unicodeScalars) { try reject("const") }
        if let choices = schema["enum"] as? [String],
           !choices.contains(where: { string.unicodeScalars.elementsEqual($0.unicodeScalars) }) { try reject("enum") }
        // JSON Schema は Unicode code point を数える。Swift の grapheme 数や JS の UTF-16 長ではない。
        let length = string.unicodeScalars.count
        if let min = schema["minLength"] as? Int, length < min { try reject("minLength") }
        if let max = schema["maxLength"] as? Int, length > max { try reject("maxLength") }
    case "boolean":
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { try reject("boolean") }
    case "integer", "number":
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { try reject("number") }
        if schema["type"] as? String == "integer", number.doubleValue.rounded(.towardZero) != number.doubleValue { try reject("integer") }
    default:
        throw AppleError.invalid("\(path): 対応していない schema 型です")
    }
}
