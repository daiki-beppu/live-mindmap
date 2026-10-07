// 正解ファイル（--truth）の読み込み。cli の eval と bench の sttReplay が共有する。
// 失敗は InvalidTruthFile にし、表示（日本語の 1 行）は各入口が持つ。
import { readFileSync } from "node:fs";
import { Effect, Predicate, Schema, SchemaIssue } from "effect";
import { Truth } from "./core/index.ts";

class InvalidTruthFile extends Schema.TaggedError<InvalidTruthFile>()("InvalidTruthFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}
export { InvalidTruthFile };

// 入口の 1 行は 1 行に保つ（stderr を読む側は 1 行だけを期待する）
export const oneLine = (text: string): string => text.replaceAll(/\r?\n/g, " ");
export const describe = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));

export const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const readTextFile = (path: string) => Effect.try({ try: () => readFileSync(path, "utf8"), catch: describe });

// 正解ファイルの decode の失敗を 1 行の理由にする。文面は core/evaluate.ts の Truth が正本で、ここは場所だけを足す
// （path は [種別] か [種別, 件目, ...]。どこを直すかは種別と件目で足りるので、field 名は添えない）。
// union や配列の要素は 1 つの誤りから複数の issue になるため、同じ行になったものは 1 つにまとめる
const truthReason = (error: Schema.SchemaError): string =>
  oneLine(
    [
      ...new Set(
        formatIssues(error.issue).issues.map(({ message, path }) => {
          const [kind, index] = (path ?? []).map((segment) => (Predicate.isObject(segment) ? segment.key : segment));
          if (!Predicate.isString(kind)) return message;
          return Predicate.isNumber(index) ? `「${kind}」の ${index + 1} 件目: ${message}` : `「${kind}」${message}`;
        }),
      ),
    ].join(" / "),
  );

// 正解ファイルの検証は段 1 の Truth の Schema が 1 つだけ持つ
export const readTruthFile = (path: string) =>
  readTextFile(path).pipe(
    Effect.mapError((reason) => new InvalidTruthFile({ path, reason })),
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Truth))(text).pipe(
        Effect.mapError((e) => new InvalidTruthFile({ path, reason: truthReason(e) })),
      ),
    ),
  );
