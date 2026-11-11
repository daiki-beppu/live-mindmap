import Foundation

public actor FileReadingAlignment {
    public struct Reader: Sendable {
        let id: Int
        let alignment: FileReadingAlignment

        func waitScreen(through position: Double) async throws {
            try await alignment.waitScreen(through: position)
        }

        func waitTurn(start: Double) async throws {
            try await alignment.waitTurn(of: id, start: start)
        }

        func advance(to position: Double) async {
            await alignment.advance(id, to: position)
        }

        func finish() async {
            await alignment.finish(id)
        }
    }

    public struct Screen: Sendable {
        let alignment: FileReadingAlignment

        public func advance(to time: Double) async {
            await alignment.advanceScreen(to: time)
        }

        public func finish() async {
            await alignment.finishScreen()
        }
    }

    private var positions: [Int: Double] = [:]
    private var finished: Set<Int> = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var closed = false
    private var screenRegistered = false
    private var screenFinished = false
    private var screenTime = 0.0

    public init() {}

    public func addReader(from: Double = 0) -> Reader {
        let id = positions.count
        positions[id] = from
        return Reader(id: id, alignment: self)
    }

    public func addScreen(from: Double = 0) -> Screen {
        screenRegistered = true
        screenTime = from
        return Screen(alignment: self)
    }

    public func now() -> Double {
        let running = positions.filter { !finished.contains($0.key) }.values
        return running.min() ?? positions.values.max() ?? 0
    }

    public func sleep(_ duration: Duration) async throws {
        let target = now() + (Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18)
        while !closed, now() < target {
            try await waitForChange()
        }
        try Task.checkCancellation()
    }

    public func close() {
        closed = true
        wake()
    }

    private func waitScreen(through position: Double) async throws {
        while screenRegistered, !screenFinished, screenTime < position - 1e-9 {
            try await waitForChange()
        }
    }

    private func advanceScreen(to time: Double) {
        screenTime = max(screenTime, time)
        wake()
    }

    private func finishScreen() {
        screenFinished = true
        wake()
    }

    private func waitTurn(of id: Int, start: Double) async throws {
        while !canProceed(id, start: start) {
            try await waitForChange()
        }
    }

    private func canProceed(_ id: Int, start: Double) -> Bool {
        positions.allSatisfy { other, position in other == id || finished.contains(other) || position >= start - 1e-9 }
    }

    private func advance(_ id: Int, to position: Double) {
        positions[id] = max(positions[id] ?? 0, position)
        wake()
    }

    private func finish(_ id: Int) {
        finished.insert(id)
        wake()
    }

    private func waitForChange() async throws {
        try Task.checkCancellation()
        await withTaskCancellationHandler {
            await withCheckedContinuation { waiters.append($0) }
        } onCancel: {
            Task { await self.wake() }
        }
        try Task.checkCancellation()
    }

    private func wake() {
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }
}
