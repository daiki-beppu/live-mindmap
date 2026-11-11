import Testing
import HelperCore

@Suite("readings の引数解釈（parseReadingsArguments）")
struct ReadingsArgumentsTests {
    @Test("引数ごとに 1 語として、渡した順のまま返す")
    func keepsOrder() throws {
        let words = try parseReadingsArguments(["港南店", "Zendesk", "野々村"]).get()
        #expect(words == ["港南店", "Zendesk", "野々村"])
    }

    @Test("1 語でも解釈できる")
    func single() throws {
        let words = try parseReadingsArguments(["会議"]).get()
        #expect(words == ["会議"])
    }

    @Test("0 語は拒否する")
    func rejectsEmpty() {
        #expect(throws: RunArgumentsError.self) {
            _ = try parseReadingsArguments([]).get()
        }
    }
}
