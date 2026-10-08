// 使い捨て（issue #380 の計測用）。Apple Intelligence（Foundation Models）を 1 行 1 要求の JSON で呼ぶ。
// 入力: {"reset":bool,"system":String,"prompt":String,"schema":<Apple の方言の JSON Schema>}
// 出力: {"content":String,"input":Int,"cached":Int,"output":Int} か {"error":String}
import Foundation
import FoundationModels

struct Req: Decodable { let reset: Bool; let system: String; let prompt: String; let schema: GenerationSchema }

var session: LanguageModelSession?
let model = SystemLanguageModel.default
FileHandle.standardError.write("availability=\(model.availability) contextSize=\(model.contextSize)\n".data(using: .utf8)!)

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

while let line = readLine(strippingNewline: true) {
  do {
    let req = try JSONDecoder().decode(Req.self, from: line.data(using: .utf8)!)
    if req.reset || session == nil { session = LanguageModelSession(model: model, instructions: req.system) }
    let res = try await session!.respond(to: req.prompt, schema: req.schema, options: GenerationOptions(temperature: 0.2))
    emit(["content": res.content.jsonString, "input": res.usage.input.totalTokenCount, "cached": res.usage.input.cachedTokenCount, "output": res.usage.output.totalTokenCount])
  } catch {
    session = nil
    emit(["error": String(describing: error)])
  }
}
