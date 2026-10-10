import Foundation
import CoreFoundation

enum AppleError: Error, CustomStringConvertible {
    case invalid(String)
    var description: String {
        switch self { case .invalid(let reason): return reason }
    }
}

// JSONSerialization の辞書では入力の順序が失われる。構造の順序だけを保存し、
// 文字列の解釈と JSON の妥当性検証は Foundation に任せる。
private struct SchemaOrder {
    let bytes: [UInt8]
    var index = 0
    var keys: [String: [String]] = [:]
    var ranges: [String: Range<Int>] = [:]

    mutating func whitespace() {
        while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
    }
    mutating func string() throws -> String {
        let start = index
        index += 1
        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            if byte == 92 { index += 1 }
            else if byte == 34 {
                return try JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: .fragmentsAllowed) as! String
            }
        }
        throw AppleError.invalid("文字列が閉じられていません")
    }
    mutating func value(path: String) throws {
        whitespace()
        let start = index
        guard index < bytes.count else { throw AppleError.invalid("JSON が不完全です") }
        switch bytes[index] {
        case 123:
            index += 1
            whitespace()
            var order: [String] = []
            while bytes[index] != 125 {
                let key = try string()
                guard !order.contains(key) else { throw AppleError.invalid("重複したプロパティ: \(key)") }
                order.append(key)
                whitespace()
                index += 1 // コロンは事前の JSON 検証で保証される
                try value(path: path + "/" + key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1"))
                whitespace()
                if bytes[index] == 44 { index += 1; whitespace() } else { break }
            }
            index += 1
            keys[path] = order
        case 91:
            index += 1
            whitespace()
            var count = 0
            while bytes[index] != 93 {
                try value(path: path + "/\(count)")
                count += 1
                whitespace()
                if bytes[index] == 44 { index += 1; whitespace() } else { break }
            }
            index += 1
        case 34: _ = try string()
        default:
            while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
        }
        ranges[path] = start..<index
    }
}

func schemaBytes(_ data: Data) throws -> Data {
    _ = try JSONSerialization.jsonObject(with: data)
    var order = SchemaOrder(bytes: Array(data))
    try order.value(path: "")
    guard let range = order.ranges["/response_format/json_schema/schema"] else { throw AppleError.invalid("JSON Schema がありません") }
    return Data(order.bytes[range])
}

public func appleGenerationSchemaJSON(_ data: Data) throws -> Data {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw AppleError.invalid("schema は object である必要があります")
    }
    var order = SchemaOrder(bytes: Array(data))
    try order.value(path: "")
    func convert(_ node: [String: Any], name: String, path: String) throws -> [String: Any] {
        try validateSchemaNode(node)
        var result = node
        if let raw = node["anyOf"] {
            guard let choices = raw as? [[String: Any]], !choices.isEmpty else { throw AppleError.invalid("anyOf は空でない schema の配列である必要があります") }
            result["title"] = name
            result["anyOf"] = try choices.enumerated().map { index, child in
                var branch = try convert(child, name: "\(name)\(index)", path: path + "/anyOf/\(index)")
                branch["title"] = "\(name)\(index)"
                return branch
            }
        } else if node["type"] as? String == "object" {
            guard let properties = node["properties"] as? [String: [String: Any]],
                  let names = order.keys[path + "/properties"] else { throw AppleError.invalid("object に properties が必要です") }
            result["x-order"] = names
            result["title"] = name
            result["properties"] = try Dictionary(uniqueKeysWithValues: names.map { key in
                let escaped = key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
                return (key, try convert(properties[key]!, name: name + "_" + key, path: path + "/properties/" + escaped))
            })
        } else if node["type"] as? String == "array" {
            guard let items = node["items"] as? [String: Any] else { throw AppleError.invalid("array に items schema が必要です") }
            result["items"] = try convert(items, name: name + "Item", path: path + "/items")
        }
        return result
    }
    return try JSONSerialization.data(withJSONObject: convert(root, name: "R", path: ""))
}

private func validateSchemaNode(_ node: [String: Any]) throws {
    let metadata: Set<String> = ["title", "description", "$schema"]
    let fields: Set<String>
    if node["anyOf"] != nil {
        fields = ["anyOf"]
    } else {
        switch node["type"] as? String {
        case "object":
            fields = ["type", "properties", "required", "additionalProperties", "x-order"]
            guard let properties = node["properties"] as? [String: Any],
                  node["required"] == nil || node["required"] is [String] else {
                throw AppleError.invalid("object の schema が不正または未対応です")
            }
            if let raw = node["additionalProperties"] {
                guard let flag = raw as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), !flag.boolValue else {
                    throw AppleError.invalid("additionalProperties は false だけに対応しています")
                }
            }
            if let required = node["required"] as? [String], !Set(required).isSubset(of: Set(properties.keys)) {
                throw AppleError.invalid("required に未定義のプロパティがあります")
            }
        case "array":
            fields = ["type", "items", "minItems", "maxItems"]
            try validateBounds(node, minimum: "minItems", maximum: "maxItems")
        case "string", nil:
            guard node["type"] as? String == "string" || (node["type"] == nil && node["const"] is String) else {
                throw AppleError.invalid("schema の型が不正です")
            }
            fields = ["type", "enum", "const", "minLength", "maxLength"]
            try validateBounds(node, minimum: "minLength", maximum: "maxLength")
            if let values = node["enum"] {
                guard let choices = values as? [String], !choices.isEmpty else { throw AppleError.invalid("enum は空でない文字列の配列である必要があります") }
            }
            if let value = node["const"] {
                guard let constant = value as? String else { throw AppleError.invalid("const は文字列である必要があります") }
                if let choices = node["enum"] as? [String], !choices.contains(constant) { throw AppleError.invalid("const と enum が矛盾しています") }
                if let min = node["minLength"] as? Int, constant.unicodeScalars.count < min { throw AppleError.invalid("const が minLength を満たしません") }
                if let max = node["maxLength"] as? Int, constant.unicodeScalars.count > max { throw AppleError.invalid("const が maxLength を満たしません") }
            }
        case "boolean", "integer", "number": fields = ["type"]
        default: throw AppleError.invalid("対応していない schema 型です")
        }
    }
    guard Set(node.keys).isSubset(of: fields.union(metadata)) else {
        throw AppleError.invalid("対応していない schema キーワード: \(Set(node.keys).subtracting(fields.union(metadata)))")
    }
}

private func validateBounds(_ node: [String: Any], minimum: String, maximum: String) throws {
    for key in [minimum, maximum] {
        if let raw = node[key] {
            guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  let value = raw as? Int, value >= 0 else { throw AppleError.invalid("\(key) は非負の整数である必要があります") }
        }
    }
    if let min = node[minimum] as? Int, let max = node[maximum] as? Int, min > max { throw AppleError.invalid("schema の上下限が矛盾しています") }
}
