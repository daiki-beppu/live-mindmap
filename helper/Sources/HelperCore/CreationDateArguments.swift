import Foundation

// `creation-date` サブコマンドの引数の解釈。純粋関数にして `HelperCoreTests` から検証できるようにする。流儀は `parseTranscribeFileArguments` と同じ。

/// `arguments` は `creation-date` の語の後に続く引数の列（`--file` とその値）。成功したらファイルのパスを返す。
public func parseCreationDateArguments(_ arguments: [String]) -> Result<String, RunArgumentsError> {
    var file: String?
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--file" where index + 1 < arguments.count:
            file = arguments[index + 1]
            index += 2
        default:
            return .failure(RunArgumentsError("不明な引数: \(arguments[index])"))
        }
    }
    guard let file else {
        return .failure(RunArgumentsError("--file が必要"))
    }
    return .success(file)
}
