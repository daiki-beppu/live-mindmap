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
        if result.isFinal {
            await duplicates.add(theirs: result)
        } else {
            await duplicates.add(theirPartial: result)
        }
        await server.broadcast(try event(from: result, track: .相手).jsonString())
    }
    await duplicates.finishTheirs()
}

/// 判定の済んだ `自分` の結果のイベント。確定結果は `remark`、途中結果は `partial`。
private func mineEvent(_ decision: MineDecision) -> HelperEvent {
    let result = decision.result
    if result.isFinal {
        return .remark(
            track: .自分, start: result.start, end: result.end, text: result.text, duplicate: decision.duplicate)
    }
    return .partial(
        track: .自分, start: result.start, end: result.end, text: result.text, duplicate: decision.duplicate)
}

/// `自分` の途中結果は、区間が重なる `相手` の文字が届くか保留の上限（1 秒）に達するまで保留し、その時点の文脈で判定して印を付けて流す
/// （捨てない）。発言になっていない直前の途中結果は、`相手` の文字が届くたびに照らし直す。確定結果は判定を待つ間、順序を保って保留する。
/// 判定の済んだ途中結果と確定結果は、どちらも判定器の `mineDecisions` に積み、そこを読む 1 タスクだけが送る
/// （同じ発話の `partial` が `remark` を追い越さない）。保留中の分がすべて流れるまで戻らない。
private func relayMine<Results: AsyncSequence>(
    _ results: Results, to server: WebSocketServer, duplicates: DuplicateMarker
) async throws where Results.Element == TranscriptionResult {
    let (held, heldContinuation) = AsyncStream.makeStream(of: (TranscriptionResult, ContinuousClock.Instant).self)
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            for await (result, heldSince) in held {
                let duplicate = await duplicates.resolve(result, heldSince: heldSince)
                // 他トラックのエラーなどでキャンセルされたら、判定が途中でも出力へ渡さずに終える。
                if Task.isCancelled { break }
                await duplicates.emit(resolvedRemark: result, duplicate: duplicate)
            }
            // 確定結果の判定はここで終わる。送る側の流れを閉じて、読み手を終わらせる。
            await duplicates.finishMineDecisions()
        }
        group.addTask {
            for await decision in duplicates.mineDecisions {
                // 他トラックのエラーなどでキャンセルされたら、判定が済んでいても送らずに終える。
                if Task.isCancelled { return }
                await server.broadcast(try mineEvent(decision).jsonString())
            }
        }
        group.addTask {
            defer { heldContinuation.finish() }
            for try await result in results {
                if result.isFinal {
                    // 保留中の途中結果を先に流してから確定結果を渡す（この順で積まれた順序がそのまま送信順になる）。
                    await duplicates.emitHeldPartialAndEndRecheck()
                    heldContinuation.yield((result, .now))
                } else {
                    await duplicates.hold(minePartial: result)
                }
            }
            // 流れが正常に終わったら、保留中の途中結果を捨てずに流す。
            await duplicates.finishMine()
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
