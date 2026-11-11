import Foundation

public actor FileReadingGate {
    private var paused = false
    private var stopped = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    public init() {}

    public var isPaused: Bool { paused }

    public func pause() {
        paused = true
    }

    public func resume() {
        paused = false
        let released = waiters
        waiters = [:]
        for (_, waiter) in released { waiter.resume() }
    }

    public func stop() {
        stopped = true
        let released = waiters
        waiters = [:]
        for (_, waiter) in released { waiter.resume(throwing: CancellationError()) }
    }

    public func waitOpen() async throws {
        let id = UUID()
        while paused || stopped {
            try Task.checkCancellation()
            if stopped { throw CancellationError() }
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        waiters[id] = continuation
                    }
                }
            } onCancel: {
                Task { await self.cancelWaiter(id) }
            }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    public static func requestedState(in message: String, token: String) -> Bool? {
        SelfPause.instructedState(in: message, type: "reading-pause", token: token)
    }
}

public func serveFileReadingRequests<Messages: AsyncSequence>(
    _ messages: Messages, token: String, gate: FileReadingGate
) async where Messages.Element == String {
    do {
        for try await message in messages {
            guard let paused = FileReadingGate.requestedState(in: message, token: token) else { continue }
            if paused { await gate.pause() } else { await gate.resume() }
        }
    } catch {}
}
