import Testing
@testable import HelperCore

@Suite("イベントの保持規則")
struct HelperEventDeliveryTests {
    @Test("保持する9種類は、それぞれ独立した仕様表の枠を返す")
    func retainedEventsUseTheirOwnSlots() {
        let examples: [(HelperEvent, HelperEventDelivery)] = [
            (.origin(hostTime: 42), .retain(.origin)),
            (.screen(start: 1, image: "image", lines: []), .retain(.screen)),
            (.screenOff(start: 1, reason: .許可なし), .retain(.screenOff)),
            (.tapSilent(start: 10), .retain(.tapSilent)),
            (.selfPause(paused: true, reason: .manual, start: 1), .retain(.selfPause)),
            (.selfPauseState(.initial), .retain(.selfPauseState)),
            (.speakerOff(start: 1, reason: .モデルなし), .retain(.speakerOff)),
            (.fileDuration(duration: 120), .retain(.fileDuration)),
            (.fileAudioTracks(count: 2), .retain(.fileAudioTracks)),
        ]
        for (event, expected) in examples {
            #expect(event.delivery(retained: nil) == expected)
        }
    }

    @Test("発言・途中結果・話者の6種類は、初回接続前だけ蓄積する")
    func transientEventsBufferUntilFirstClient() {
        let examples: [HelperEvent] = [
            .remark(track: .相手, start: 0, end: 1, text: "発言", duplicate: false, words: [], wordTimes: []),
            .partial(track: .自分, start: 0, end: 1, text: "途中", duplicate: false, words: [], wordTimes: []),
            .speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true),
            .speakerSettled(track: .相手, to: 1),
            .speakerMixed(track: .相手, slot: 0, start: 1),
            .speakerCentroid(track: .相手, slot: 0, centroid: [1, 0]),
        ]
        for event in examples {
            #expect(event.delivery(retained: nil) == .bufferUntilFirstClient)
        }
    }

    @Test("画面は保持済みstartより古いと接続中だけに送り、同時刻と新しい時刻は保持する", arguments: [0.0, 1, 2], [false, true])
    func screenRuleComparesRetainedStart(_ start: Double, _ absent: Bool) {
        let retained = HelperEvent.screen(start: 1, image: "retained", lines: [])
        let arriving = HelperEvent.screen(start: start, image: absent ? nil : "arriving", lines: nil)
        #expect(arriving.delivery(retained: retained) == (start < 1 ? .connectedOnly : .retain(.screen)))
    }
}
