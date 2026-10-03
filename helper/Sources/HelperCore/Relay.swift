/// STT の結果をイベントにして、WebSocket の全クライアントへ流す。結果の流れが終わるまで戻らない。
/// `duplicates` が nil なら、重複の印は付けない（`duplicate` は常に false）。
/// 非 nil なら、`相手` の確定結果と最新の途中結果を判定器に渡し、`自分` の確定結果と途中結果に印を付けて流す（捨てない）。
public func relay<Results: AsyncSequence>(
    _ results: Results, track: Track, to server: WebSocketServer, duplicates: DuplicateMarker?
) async throws where Results.Element == TranscriptionResult {
    guard let duplicates else {
        for try await result in results {
            await server.broadcast(try event(from: result, track: track).jsonString())
        }
        return
    }
    switch track {
    case .相手: try await relayTheirs(results, to: server, duplicates: duplicates)
    case .自分: try await relayMine(results, to: server, duplicates: duplicates)
    }
}

/// `相手` の結果は保留せず流し、確定結果と途中結果は判定器の文脈にも加える。`相手` の途中結果の `duplicate` は常に false。
private func relayTheirs<Results: AsyncSequence>(
    _ results: Results, to server: WebSocketServer, duplicates: DuplicateMarker
) async throws where Results.Element == TranscriptionResult {
    for try await result in results {
        // 確定か途中かの振り分けは判定器の中で行う。ここで if / else の両方に await を置くと、CI（Xcode 26.6）の swift test がクラッシュした
        await duplicates.observe(theirs: result)
        await server.broadcast(try event(from: result, track: .相手).jsonString())
    }
    await duplicates.finishTheirs()
}

/// `自分` の途中結果は保留せず、届いた時点の文脈で判定して印を付け、すぐ流す。確定結果は判定を待つ間、順序を保って保留し、保留中の分がすべて流れるまで戻らない。
private func relayMine<Results: AsyncSequence>(
    _ results: Results, to server: WebSocketServer, duplicates: DuplicateMarker
) async throws where Results.Element == TranscriptionResult {
    let (held, heldContinuation) = AsyncStream.makeStream(of: (TranscriptionResult, ContinuousClock.Instant).self)
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            for await (result, heldSince) in held {
                let duplicate = await duplicates.resolve(result, heldSince: heldSince)
                // 他トラックのエラーなどでキャンセルされたら、判定が途中でも送らずに終える。
                if Task.isCancelled { return }
                let remark = HelperEvent.remark(
                    track: .自分, start: result.start, end: result.end, text: result.text, duplicate: duplicate)
                await server.broadcast(try remark.jsonString())
            }
        }
        group.addTask {
            defer { heldContinuation.finish() }
            for try await result in results {
                if result.isFinal {
                    heldContinuation.yield((result, .now))
                } else {
                    // 判定は先に取り出す。引数の式の途中で await すると、CI の Swift でタスクのメモリ管理が壊れてクラッシュした
                    let duplicate = await duplicates.isDuplicate(partial: result)
                    let partial = HelperEvent.partial(
                        track: .自分, start: result.start, end: result.end, text: result.text, duplicate: duplicate)
                    await server.broadcast(try partial.jsonString())
                }
            }
        }
        for try await _ in group {}
    }
}

/// 複数トラックの結果の流れを並行して `relay` する。すべて正常に終わると戻る。
/// どれかがエラーで終わったら、最初に throw されたエラーを返し、残りの流れはキャンセルする。
public func relay(
    tracks: [(Track, AsyncThrowingStream<TranscriptionResult, Error>)], to server: WebSocketServer,
    duplicates: DuplicateMarker?
) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        for (track, results) in tracks {
            group.addTask { try await relay(results, track: track, to: server, duplicates: duplicates) }
        }
        // 最初のエラーで抜ける。グループを抜けるときに、残りのタスクはキャンセルされる。
        for try await _ in group {}
    }
}
