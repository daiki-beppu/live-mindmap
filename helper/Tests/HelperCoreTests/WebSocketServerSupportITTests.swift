import Foundation
@testable import HelperCore

extension WebSocketServer {
    init(port: UInt16, writeStderr: @escaping @Sendable (String) -> Void = { message in
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }) {
        self.init(port: port, closeDeadline: .seconds(3), writeStderr: writeStderr)
    }
}
