import Foundation
import CoreFoundation

// Apple の生成が壊す 2 つの形を、検証の前に直す（Issue #795）。
// - 文字列の終わりで `"` の代わりに `」` を出し、続けて `}], ` などを文字列の中に書く。`」}` から後ろを捨てる
// - maxLength を超える。超えた分を Unicode code point で切り詰める（途中で切れた文が出るのは受け入れる）
// 直した文字列が無ければ、内容をそのまま返す。
func repairAppleResponse(_ content: String, schema: [String: Any]) throws -> (content: String, repaired: Bool) {
    let value = try JSONSerialization.jsonObject(with: Data(content.utf8), options: .fragmentsAllowed)
    var repaired = false
    let result = repairResponseValue(value, schema: schema, repaired: &repaired)
    guard repaired else { return (content, false) }
    let data = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
    return (String(decoding: data, as: UTF8.self), true)
}

private func repairResponseValue(_ value: Any, schema: [String: Any], repaired: inout Bool) -> Any {
    if let branches = schema["anyOf"] as? [[String: Any]] {
        for branch in branches {
            var changed = false
            let candidate = repairResponseValue(value, schema: branch, repaired: &changed)
            if (try? validateResponseValue(candidate, schema: branch, path: "$")) != nil {
                if changed { repaired = true }
                return candidate
            }
        }
        return value
    }
    switch schema["type"] as? String {
    case "object":
        guard var object = value as? [String: Any], let properties = schema["properties"] as? [String: [String: Any]] else { return value }
        for (key, child) in properties {
            if let field = object[key] { object[key] = repairResponseValue(field, schema: child, repaired: &repaired) }
        }
        return object
    case "array":
        guard let array = value as? [Any], let items = schema["items"] as? [String: Any] else { return value }
        return array.map { repairResponseValue($0, schema: items, repaired: &repaired) }
    case "string", nil:
        guard var string = value as? String, schema["const"] == nil, schema["enum"] == nil else { return value }
        if let broken = string.range(of: "」}") { string = String(string[..<broken.lowerBound]) }
        if let max = schema["maxLength"] as? Int, string.unicodeScalars.count > max {
            string = String(String.UnicodeScalarView(string.unicodeScalars.prefix(max)))
        }
        if string != value as? String { repaired = true }
        return string
    default:
        return value
    }
}

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
