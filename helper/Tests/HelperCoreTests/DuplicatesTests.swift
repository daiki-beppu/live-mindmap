import Testing
import HelperCore

private func result(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: true, start: start, end: end)
}

@Suite("文字 3-gram の被覆率")
struct CoverageTests {
    @Test("すべての 3-gram が文脈に現れれば 1")
    func full() {
        #expect(coverage(of: "abcdef", in: "xxabcdefxx") == 1.0)
    }

    @Test("現れる 3-gram の割合を返す（6 個中 4 個）")
    func partial() throws {
        let value = try #require(coverage(of: "abcdefgh", in: "abcdefxyz"))
        #expect(abs(value - 4.0 / 6.0) < 1e-9)
    }

    @Test("同じ 3-gram の繰り返しは集合として 1 個に数える")
    func countsDistinctGrams() {
        #expect(coverage(of: "aaaaaa", in: "aaa") == 1.0)
    }

    @Test("空白・句読点・記号を除き、小文字にしてから比べる")
    func normalizes() {
        #expect(coverage(of: "AB, cd。ef!", in: "abcdef") == 1.0)
    }

    @Test("正規化後に 3 文字未満なら nil")
    func tooShort() {
        #expect(coverage(of: "は、い。", in: "はいはいはい") == nil)
    }
}

@Suite("重複の判定")
struct IsDuplicateTests {
    @Test("重なる例: 相手と同じ内容で表記揺れが少しある自分の発言は重複")
    func overlapping() {
        let theirs = [result("明日の会議は十時から始めます", 10, 14)]
        let mine = result("明日の会議は10時から始めます", 10.5, 14.5)
        #expect(isDuplicate(mine, among: theirs))
    }

    @Test("重ならない例: 内容が違う自分の発言は重複でない")
    func notOverlapping() {
        let theirs = [result("明日の会議は十時から始めます", 10, 14)]
        let mine = result("来週の火曜日に資料を送ります", 15, 18)
        #expect(!isDuplicate(mine, among: theirs))
    }

    @Test("自分と相手が同時に話す例: 時間が重なっても内容が違えば重複でない")
    func speakingSimultaneously() {
        let theirs = [result("明日の会議は十時から始めます", 10, 14)]
        let mine = result("了解です、少し確認します", 10, 14)
        #expect(!isDuplicate(mine, among: theirs))
    }

    @Test("しきい値: 被覆率 0.5 は重複でなく、約 0.67 は重複")
    func threshold() {
        let mine = result("abcdefgh", 0, 2)
        #expect(!isDuplicate(mine, among: [result("abcdexyz", 0, 2)]))
        #expect(isDuplicate(mine, among: [result("abcdefxyz", 0, 2)]))
    }

    @Test("前 8 秒より前に終わった相手の発言は文脈に入れない")
    func beforeWindow() {
        let mine = result("明日の会議は十時から始めます", 20, 23)
        #expect(!isDuplicate(mine, among: [result("明日の会議は十時から始めます", 0, 3)]))
        #expect(isDuplicate(mine, among: [result("明日の会議は十時から始めます", 5, 13)]))
    }

    @Test("後 8 秒より後に始まった相手の発言は文脈に入れない")
    func afterWindow() {
        let mine = result("明日の会議は十時から始めます", 20, 23)
        #expect(!isDuplicate(mine, among: [result("明日の会議は十時から始めます", 35, 38)]))
        #expect(isDuplicate(mine, among: [result("明日の会議は十時から始めます", 30, 33)]))
    }

    @Test("相手の 2 つの発言をまたぐ 3-gram も数える（start 順に区切りなしで連結）")
    func spansAdjacentRemarks() {
        let mine = result("abcdef", 0, 2)
        // 渡す順序が start 順でなくても、start 順に連結される。
        let theirs = [result("efgh", 1, 2), result("abcd", 0, 1)]
        #expect(isDuplicate(mine, among: theirs))
    }

    @Test("3 文字未満の発言は、相手と同じでも重複にしない")
    func tooShort() {
        #expect(!isDuplicate(result("はい", 0, 1), among: [result("はい", 0, 1)]))
    }

    @Test("相手の発言がなければ重複でない")
    func noContext() {
        #expect(!isDuplicate(result("明日の会議は十時から始めます", 0, 3), among: []))
    }
}
