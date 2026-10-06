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

    @Test("正規化後 3 文字未満の発言は、相手と時間が重なれば重複、重ならなければ重複でない")
    func shortFragmentUsesTimeOverlap() {
        let theirs = [result("はいはいはい", 0, 3)]
        #expect(isDuplicate(result("はい", 0, 1), among: theirs))
        #expect(!isDuplicate(result("はい", 10, 11), among: theirs))
    }

    @Test("句読点・空白・記号を除いて 3 文字未満になる発言も、内容ではなく時間の重なりで判定する")
    func shortFragmentAfterNormalizationUsesTimeOverlap() {
        let theirs = [result("はいはいはい", 0, 3)]
        #expect(isDuplicate(result("は、い。", 0, 1), among: theirs))
        #expect(isDuplicate(result("は い", 0, 1), among: theirs))
        #expect(isDuplicate(result("は!い", 0, 1), among: theirs))
    }

    @Test("正規化後 3 文字以上なら、時間が重なっても内容で判定する")
    func threeOrMoreCharactersUsesContent() {
        let theirs = [result("来週の火曜日に資料を送ります", 0, 3)]
        #expect(!isDuplicate(result("はいは", 0, 1), among: theirs))
        #expect(!isDuplicate(result("はいはい", 0, 1), among: theirs))
    }

    @Test("相手の発言がなければ重複でない")
    func noContext() {
        #expect(!isDuplicate(result("明日の会議は十時から始めます", 0, 3), among: []))
    }
}

private func partial(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: false, start: start, end: end)
}

@Suite("自分の途中結果の重複の判定")
struct IsDuplicatePartialTests {
    private let sentence = "明日の会議は十時から始めます"

    @Test("相手の確定結果とほぼ同じ内容なら重複")
    func matchesTheirFinal() async {
        let marker = DuplicateMarker()
        await marker.add(theirs: result(sentence, 10, 14))
        #expect(await marker.isDuplicate(partial: partial("明日の会議は十時", 10.5, 12)))
    }

    @Test("相手の最新の途中結果とほぼ同じ内容なら重複（確定結果がなくても）")
    func matchesTheirPartial() async {
        let marker = DuplicateMarker()
        await marker.add(theirPartial: partial(sentence, 10, 14))
        #expect(await marker.isDuplicate(partial: partial("明日の会議は十時", 10.5, 12)))
    }

    @Test("相手の途中結果は最新の 1 件だけが文脈になる（古い内容は上書きで消える）")
    func onlyLatestTheirPartial() async {
        let marker = DuplicateMarker()
        await marker.add(theirPartial: partial(sentence, 10, 12))
        await marker.add(theirPartial: partial("来週の火曜日に資料を送ります", 10, 13))
        #expect(!(await marker.isDuplicate(partial: partial("明日の会議は十時", 10.5, 12))))
        #expect(await marker.isDuplicate(partial: partial("来週の火曜日に資料", 10.5, 12)))
    }

    @Test("相手の確定結果が届いても、相手の最新の途中結果は文脈に残る")
    func theirPartialSurvivesFinal() async {
        let marker = DuplicateMarker()
        await marker.add(theirPartial: partial(sentence, 10, 14))
        await marker.add(theirs: result("来週の火曜日に資料を送ります", 30, 33))
        #expect(await marker.isDuplicate(partial: partial("明日の会議は十時", 10.5, 12)))
    }

    @Test("相手の途中結果は時間窓で絞らない（区間から遠くても文脈になる）")
    func theirPartialIsNotWindowed() async {
        let marker = DuplicateMarker()
        await marker.add(theirPartial: partial(sentence, 0, 3))
        #expect(await marker.isDuplicate(partial: partial("明日の会議は十時", 100, 102)))
    }

    @Test("確定結果は区間の前後 8 秒に重なるものだけが文脈になる（内側は重複、外側は重複でない）")
    func finalContextIsWindowed() async {
        let mine = partial(sentence, 20, 23)

        let before = DuplicateMarker()
        await before.add(theirs: result(sentence, 0, 3))
        #expect(!(await before.isDuplicate(partial: mine)))
        let beforeInside = DuplicateMarker()
        await beforeInside.add(theirs: result(sentence, 5, 13))
        #expect(await beforeInside.isDuplicate(partial: mine))

        let after = DuplicateMarker()
        await after.add(theirs: result(sentence, 35, 38))
        #expect(!(await after.isDuplicate(partial: mine)))
        let afterInside = DuplicateMarker()
        await afterInside.add(theirs: result(sentence, 30, 33))
        #expect(await afterInside.isDuplicate(partial: mine))
    }

    @Test("内容が違えば、文脈があっても重複でない")
    func differentContent() async {
        let marker = DuplicateMarker()
        await marker.add(theirs: result(sentence, 10, 14))
        await marker.add(theirPartial: partial(sentence, 14, 16))
        #expect(!(await marker.isDuplicate(partial: partial("了解です、少し確認します", 10, 14))))
    }

    @Test("文脈がなければ重複でない")
    func noContext() async {
        #expect(!(await DuplicateMarker().isDuplicate(partial: partial(sentence, 0, 3))))
    }

    @Test("正規化後 3 文字未満の途中結果は、相手の確定結果と時間が重なれば重複、重ならなければ重複でない")
    func shortPartialUsesTimeOverlapWithTheirRemark() async {
        let marker = DuplicateMarker()
        await marker.add(theirs: result("はいはいはい", 0, 3))
        #expect(await marker.isDuplicate(partial: partial("は、い。", 0, 1)))
        #expect(!(await marker.isDuplicate(partial: partial("は、い。", 10, 11))))
    }

    @Test("正規化後 3 文字未満の途中結果は、相手の最新の途中結果とも時間の重なりで判定する")
    func shortPartialUsesTimeOverlapWithTheirPartial() async {
        let marker = DuplicateMarker()
        await marker.add(theirPartial: partial("はいはいはい", 0, 3))
        #expect(await marker.isDuplicate(partial: partial("はい", 0, 1)))
        #expect(!(await marker.isDuplicate(partial: partial("はい", 10, 11))))
    }

    @Test("途中結果も、正規化後 3 文字以上なら時間が重なっても内容で判定する")
    func threeOrMoreCharactersPartialUsesContent() async {
        let marker = DuplicateMarker()
        await marker.add(theirs: result("来週の火曜日に資料を送ります", 0, 3))
        #expect(!(await marker.isDuplicate(partial: partial("はいは", 0, 1))))
    }

    @Test("確定結果と同じしきい値: 被覆率 0.5 は重複でなく、約 0.67 は重複")
    func threshold() async {
        let mine = partial("abcdefgh", 0, 2)
        let below = DuplicateMarker()
        await below.add(theirPartial: partial("abcdexyz", 0, 2))
        #expect(!(await below.isDuplicate(partial: mine)))
        let above = DuplicateMarker()
        await above.add(theirPartial: partial("abcdefxyz", 0, 2))
        #expect(await above.isDuplicate(partial: mine))
    }

    @Test("確定結果と途中結果の文脈は区切りなしで連結して数える（またぐ 3-gram も数える）")
    func spansFinalAndPartial() async {
        let marker = DuplicateMarker()
        await marker.add(theirs: result("abcd", 0, 1))
        await marker.add(theirPartial: partial("efgh", 1, 2))
        #expect(await marker.isDuplicate(partial: partial("abcdef", 0, 2)))
    }
}
