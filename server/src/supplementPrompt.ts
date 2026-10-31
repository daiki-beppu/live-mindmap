import { Schema } from "effect";
import { SupplementOutput, type SupplementInput } from "./core/supplement.ts";

export const SUPPLEMENT_SYSTEM = `あなたは会議で出そうな質問に、聞かれる前に補足を添える係です。
対象ノードについて、補足を追加・全文で言い直す・消去する操作を0〜1件だけ返してください。不要ならopとcategoryをnullにします。
区分は、用語（用語・略語の意味）、背景（議題の背景と目的）、案の違い、理由（決定・却下の理由）、前の決定とのつながり（食い違いを含む）、未確認、推奨の7つです。用語ならtermに説明した語を入れます。
既存の補足がある対象にはupdateかdeleteだけを使います。updateは全文を返します。
根拠evidenceは、添える先の根拠のうち、補足が答える話の出てきた発言のidから選びます。発言本文と話者名を読み、話されなかったこと（共有画面にだけ映ったものを含む）には付けません。
originは「会議の中」か「会議の外」です。会議の外は広く定まった一般の知識だけ。意味を絞れない語や社内固有の語には外部説明を添えません。
carriedTermsは引き継いだ語彙です。生成対象の語を選ぶためには使わず、会議の外の説明を出さない語の判定にだけ使います。社内語・引き継いだ語は会議内で説明されたときだけ「会議の中」として添えます。
explainedTermsは消した語と保留中の語も含む説明済み語です。同じ会議で同じ語を新たに説明し直しません。対象の既存補足の言い直し・消去はできます。
推測だけでは出しません。推奨は発言か確かな一般的事実を根拠として本文に明示し、判断軸に照らした良し悪しを根拠にしません。
誰かが引き受けた「調べておく」はTODOなので言い直しません。要らなければ何もしません。`;
export const SUPPLEMENT_JSON_SCHEMA = Schema.toJsonSchemaDocument(SupplementOutput, { onExcessProperty: "error" }).schema;
export const supplementPrompt = (input: SupplementInput): string => JSON.stringify(input);
