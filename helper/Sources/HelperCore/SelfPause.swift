import Foundation

public let helperControlTokenEnvironmentKey = "LIVE_MINDMAP_HELPER_CONTROL_TOKEN"

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

    public static func requestedState(in message: String, token: String) -> Bool? {
        instructedState(in: message, type: "self-pause", token: token)
    }

    static func instructedState(in message: String, type: String, token: String) -> Bool? {
        guard !token.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              object["type"] as? String == type,
              let sent = object["token"] as? String,
              constantTimeEqual(sent, token),
              let value = object["paused"] as? NSNumber,
              CFGetTypeID(value) == CFBooleanGetTypeID()
        else { return nil }
        return value.boolValue
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
    await emit(.selfPause(paused: rule.paused, reason: rule.reason, start: offsetSeconds(from: origin, to: hostTime)))
    await emit(.selfPauseState(rule.carryOver))
}

public func serveSelfPauseRequests<Messages: AsyncSequence>(
    _ messages: Messages, token: String, request: (Bool) -> Void
) async where Messages.Element == String {
    do {
        for try await message in messages {
            guard let paused = SelfPause.requestedState(in: message, token: token) else { continue }
            request(paused)
        }
    } catch {}
}
