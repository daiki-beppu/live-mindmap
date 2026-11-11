import Foundation

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
