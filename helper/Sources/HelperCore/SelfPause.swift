import Foundation

public let helperControlTokenEnvironmentKey = "LIVE_MINDMAP_HELPER_CONTROL_TOKEN"

/// サーバーが self-pause の指示に振る番号（セッションの中で 1 から）。`.none` は、このプロセスがまだ指示を処理していないこと。
public struct SelfPauseSeq: Sendable, Equatable {
    public let value: Int
    public static let none = SelfPauseSeq(value: 0)

    public init(value: Int) { self.value = value }

    /// 1 以上の JSON の整数だけを読む。
    init?(json: Any?) {
        guard let number = json as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let value = Int(exactly: number.doubleValue), value >= 1
        else { return nil }
        self.value = value
    }
}

public struct SelfPausePress: Sendable, Equatable {
    public let paused: Bool
    public let seq: SelfPauseSeq

    public init(paused: Bool, seq: SelfPauseSeq) {
        self.paused = paused
        self.seq = seq
    }
}

public final class SelfPause: @unchecked Sendable {
    private let lock = NSLock()
    private var requested: Bool
    private var applied: Bool
    private var boundaries: [(hostTime: UInt64, paused: Bool)] = []

    public init(paused: Bool = false) {
        self.requested = paused
        self.applied = paused
    }

    public func request(_ paused: Bool, at hostTime: UInt64) -> Bool {
        lock.withLock {
            guard requested != paused else { return false }
            requested = paused
            boundaries.append((hostTime, paused))
            return true
        }
    }

    func resolve(at hostTime: UInt64) -> (paused: Bool, enteredPause: Bool) {
        lock.withLock {
            var entered = false
            while let boundary = boundaries.first, boundary.hostTime <= hostTime {
                boundaries.removeFirst()
                applied = boundary.paused
                if boundary.paused { entered = true }
            }
            return (applied, entered)
        }
    }

    public static func requestedPress(in message: String, token: String) -> SelfPausePress? {
        guard let object = authenticated(message, type: "self-pause", token: token),
              let paused = boolean(object["paused"]),
              let seq = SelfPauseSeq(json: object["seq"])
        else { return nil }
        return SelfPausePress(paused: paused, seq: seq)
    }

    static func instructedState(in message: String, type: String, token: String) -> Bool? {
        authenticated(message, type: type, token: token).flatMap { boolean($0["paused"]) }
    }

    private static func authenticated(_ message: String, type: String, token: String) -> [String: Any]? {
        guard !token.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              object["type"] as? String == type,
              let sent = object["token"] as? String,
              constantTimeEqual(sent, token)
        else { return nil }
        return object
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf8), right = Array(rhs.utf8)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }
}

public func announceSelfPause(_ rule: SelfPauseRule, at hostTime: UInt64, origin: UInt64, emit: (HelperEvent) async -> Void) async {
    await emit(.selfPause(rule.state, start: offsetSeconds(from: origin, to: hostTime)))
    await emit(.selfPauseState(rule.carryOver, handled: .none))
}

public func serveSelfPauseRequests<Messages: AsyncSequence>(
    _ messages: Messages, token: String, request: (SelfPausePress) -> Void
) async where Messages.Element == String {
    do {
        for try await message in messages {
            guard let press = SelfPause.requestedPress(in: message, token: token) else { continue }
            request(press)
        }
    } catch {}
}
