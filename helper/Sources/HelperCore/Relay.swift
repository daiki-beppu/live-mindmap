public func relay<Results: AsyncSequence>(
    _ results: Results, track: Track, to server: WebSocketServer, duplicates: DuplicateMarker?
) async throws where Results.Element == TranscriptionResult {
    guard let duplicates else {
        for try await result in results {
            await server.send(event(from: result, track: track))
        }
        return
    }
    switch track {
    case .相手: try await relayTheirs(results, to: server, duplicates: duplicates)
    case .自分: try await relayMine(results, to: server, duplicates: duplicates)
    }
}

private func relayTheirs<Results: AsyncSequence>(
    _ results: Results, to server: WebSocketServer, duplicates: DuplicateMarker
) async throws where Results.Element == TranscriptionResult {
    for try await result in results {
        if result.isFinal {
            await duplicates.add(theirs: result)
        } else {
            await duplicates.add(theirPartial: result)
        }
        await server.send(event(from: result, track: .相手))
    }
    await duplicates.finishTheirs()
}

private func relayMine<Results: AsyncSequence>(
    _ results: Results, to server: WebSocketServer, duplicates: DuplicateMarker
) async throws where Results.Element == TranscriptionResult {
    let (held, heldContinuation) = AsyncStream.makeStream(of: (TranscriptionResult, Double).self)
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            for await (result, heldSince) in held {
                let duplicate = await duplicates.resolve(result, heldSince: heldSince)
                if Task.isCancelled { break }
                await duplicates.emit(resolvedRemark: result, duplicate: duplicate)
            }
            await duplicates.finishMineDecisions()
        }
        group.addTask {
            for await decision in duplicates.mineDecisions {
                if Task.isCancelled { return }
                await server.send(event(from: decision.result, track: .自分, duplicate: decision.duplicate))
            }
        }
        group.addTask {
            defer { heldContinuation.finish() }
            for try await result in results {
                if result.isFinal {
                    await duplicates.emitHeldPartialAndEndRecheck()
                    heldContinuation.yield((result, await duplicates.now()))
                } else {
                    await duplicates.hold(minePartial: result)
                }
            }
            await duplicates.finishMine()
        }
        for try await _ in group {}
    }
}

public func relay(
    tracks: [(Track, AsyncThrowingStream<TranscriptionResult, Error>)], to server: WebSocketServer,
    duplicates: DuplicateMarker?
) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        for (track, results) in tracks {
            group.addTask { try await relay(results, track: track, to: server, duplicates: duplicates) }
        }
        for try await _ in group {}
    }
}
