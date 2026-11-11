enum ObservingLifetime {
    case whileConsumed
    case throughUpstreamEnd
}

func observing(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>,
    lifetime: ObservingLifetime = .whileConsumed,
    finish: @escaping @Sendable (Result<Void, Error>) throws -> Void = { try $0.get() },
    each: @escaping @Sendable (CapturedAudio) throws -> Void
) -> (stream: AsyncThrowingStream<CapturedAudio, Error>, finished: Task<Void, Error>) {
    let (stream, continuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
    let finished = Task {
        let outcome: Result<Void, Error>
        do {
            for try await captured in upstream {
                try each(captured)
                if case .dropped = continuation.yield(captured) {
                    throw TranscriberError.backlogExceeded(limit: downstreamBacklogLimit)
                }
            }
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        do {
            try finish(outcome)
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
            throw error
        }
    }
    if case .whileConsumed = lifetime {
        continuation.onTermination = { _ in finished.cancel() }
    }
    return (stream, finished)
}
