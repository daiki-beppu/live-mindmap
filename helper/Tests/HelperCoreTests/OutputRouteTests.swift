import Testing
import HelperCore

/// Core Audio の four-char code（例: 'bltn'）を UInt32 にする。
private func fourCC(_ code: String) -> UInt32 {
    code.utf8.reduce(0) { $0 << 8 | UInt32($1) }
}

@Suite("出力先の分類")
struct OutputRouteTests {
    @Test("内蔵で DataSource がスピーカー（ispk）なら内蔵スピーカー")
    func builtInSpeaker() {
        #expect(outputRoute(transportType: fourCC("bltn"), dataSource: fourCC("ispk")) == .builtInSpeaker)
    }

    @Test("内蔵で DataSource が読めないときは内蔵スピーカー（スピーカーしかない Mac）")
    func builtInWithoutDataSource() {
        #expect(outputRoute(transportType: fourCC("bltn"), dataSource: nil) == .builtInSpeaker)
    }

    @Test("内蔵で DataSource がヘッドフォン（hdpn）ならイヤホン")
    func headphones() {
        #expect(outputRoute(transportType: fourCC("bltn"), dataSource: fourCC("hdpn")) == .headphones)
    }

    @Test("Bluetooth（blue / blea）は DataSource にかかわらず Bluetooth")
    func bluetooth() {
        #expect(outputRoute(transportType: fourCC("blue"), dataSource: nil) == .bluetooth)
        #expect(outputRoute(transportType: fourCC("blea"), dataSource: nil) == .bluetooth)
        #expect(outputRoute(transportType: fourCC("blue"), dataSource: fourCC("ispk")) == .bluetooth)
    }

    @Test("USB・HDMI などは外部スピーカーとして other")
    func other() {
        #expect(outputRoute(transportType: fourCC("usb "), dataSource: nil) == .other)
        #expect(outputRoute(transportType: fourCC("hdmi"), dataSource: nil) == .other)
    }

    @Test("重複の判定をかけるのは、内蔵スピーカーと other だけ（イヤホン・Bluetooth はかけない）")
    func marksDuplicates() {
        #expect(OutputRoute.builtInSpeaker.marksDuplicates)
        #expect(OutputRoute.other.marksDuplicates)
        #expect(!OutputRoute.headphones.marksDuplicates)
        #expect(!OutputRoute.bluetooth.marksDuplicates)
    }
}
