# 会議中に補足を先回りで出す他製品・研究の先例

調査日: 2026-10-30。issue [#1736](https://github.com/daiki-beppu/live-mindmap/issues/1736)（map [#1733](https://github.com/daiki-beppu/live-mindmap/issues/1733)）。

問い: 会議中に、質問される前に補足（用語の説明、決定の理由、経緯のまとめ）を自動で出す先例はあるか。何を・いつ・どこに出し、出しすぎや誤りをどう抑えているか。利用者の反応（邪魔にならないか）の一次情報はあるか。

調べ方: 公式ヘルプ・公式ブログ・プレスリリース・論文（arXiv の本文）を読んだ。公式の頁が取れなかったもの（Zoom の support 記事、Otter の告知、Dialpad の一部）は、取れた範囲と出どころを明記した。製品は 2026-10 時点の公開文書で、実物は触っていない。

## 結論

- **会議ツールの大手（Zoom・Teams・Meet・Otter・Granola）は、会議中の補足を「聞かれたら答える」形に留めている。** 先回りで出すのは、一定間隔で更新されるメモ・要約（Teams Facilitator、Fireflies）と、議題・時間の通知（Facilitator）まで。用語の説明や決定の理由を、質問の前に自動で添える機能は見当たらなかった。
- **先回りの補足に一番近い製品の先例は、会議の外の 2 つ。** 電話窓口の支援（Google Agent Assist、Dialpad、Fireflies Sales Assist）は、会話から質問や語を検出して、登録済みの知識から答えのカードを自動で出す。Kindle の Word Wise は、難しい語の上に短い定義を自動で出し、出す量を利用者がスライダーで決める。
- **用語の説明を会議中に自動で出す研究は 2025 年に 2 本ある（ParseJargon、StopGap）。** どちらも「出しすぎ」と「知っている語の説明」が一番の邪魔になると報告している。ParseJargon は、利用者の背景で絞った版だけが理解・没入・価値のすべてで上がり、絞らない版は没入を基準より下げた（1 回の発表で 22.6 語 → 9.7 語、役に立った割合 47% → 78%）。
- **抑え方の共通の型:** (1) 1 つの語・話題は 1 回だけ出す、(2) 1 つの表示に最低の表示時間を置き、溢れた分は一覧に溜める、(3) 主の画面ではなく脇の面に出す（字幕の強調 + 脇の一覧、トースト、浮動パネル）、(4) 根拠が無いときは出さない（窓口支援は知識ベースに一致したときだけ答える）、(5) 量を利用者が調整できる、または利用者像で絞る。
- **頻度を上げると、成果が変わらなくても好まれなくなる。** プログラミング支援の比較（CHI 2025）では、提案を 20 秒 → 5 秒間隔・3 件 → 5 件にしただけで、好む人が約 90% から 47% に下がった。会議の振り返りの介入（CHI 2025）も、強い介入は議論に没頭している人の流れを乱すと報告している。
- **live-mindmap への含意（判断はしない、材料として）:** 先例は「会議の外の知識（用語）」側に集中し、「会議の中から分かる補足（決定の理由・経緯）」を先回りで添える例はほぼ無い（研究の InsightToast が外部文書を引く程度）。後者は既存製品との差になりうる一方、出す量の物差しは前者の研究しか無い。

## 製品ごと

### 会議ツール

| 製品 | 会議中に先回りで出すもの | 聞かれたら出すもの | どこに | 出しすぎ・誤りの扱い |
|---|---|---|---|---|
| Microsoft Teams Facilitator | 数分遅れで足されるライブのメモ、議題の追跡（話題にチェック）、時間切れの通知、何度も名前が出た欠席者への @mention | @mention での質問・追いつき・Web 検索 | Notes（Loop 頁）、会議の舞台のタイマー、会議チャット | メモは誰でもその場で編集できる。主催者・発表者が止められる（止めても既存メモは残る） |
| Zoom AI Companion | なし（会議中の機能は質問への応答） | 「Catch me up」「Was my name mentioned?」「What are the action items?」と自由な質問 | ツールバーから開くパネル | 答えは AI が有効だった間の会話だけから。主催者が誰が質問できるかを決める。答えに 👍/👎 |
| Google Meet（Take notes for me） | メモは会議後の文書。会議中は遅れて来た人向けの「Summary so far」 | — | Drive の文書・カレンダー | 要約は「incomplete, inaccurate, or not generated」になりうると明記。15 分〜8 時間を推奨 |
| Otter Meeting Agent | なし（「Hey Otter」で呼ぶと声で答える） | 社内の会議の記録から答える | 会議の音声 | 参加者全員が見られる記録だけを根拠にする（報道による） |
| Fireflies Live Assist | 会話に沿って更新される AI メモ、話し方の nudge、話題の候補ボタン。Sales Assist は「質問を検出」して知識ベースの答えを自動表示 | Catch Up（直近 1 分）、Summarize So Far、AskFred | 浮動パネル（既定で画面共有に映らない） | Sales Assist は知識ベースに一致したときだけ答え、無ければ手で聞くボタンを出す |
| Granola | なし（会議中は利用者のメモ。強化は会議の後） | 会議中もチャットで質問できる | — | AI の追記は灰色、利用者の文は黒で分ける |
| Read AI | 話す時間・関心度などの指標と、走る要約 | — | ライブのダッシュボード | — |

出典:

- Teams Facilitator: <https://support.microsoft.com/en-US/teams/copilot/facilitator-in-microsoft-teams-meetings>（「AI-generated notes won't appear immediately but will start a few minutes later」「will automatically track the agenda」「Turn off Facilitator … stops automated notetaking but won't remove notes that have already been taken」）、FAQ <https://support.microsoft.com/office/f7317b78-fd53-4cfe-88f0-f0a0751a4150>
- Zoom: 公式の support 記事は取得できず。大学 IT の解説（<https://services.newschool.edu/TDClient/32/Portal/KB/ArticleDet?ID=1387>、<https://uit.stanford.edu/service/zoom/ai>）による。「Questions can only be answered if the content was discussed while AI Companion is active」
- Google Meet: <https://support.google.com/meet/answer/14754724>（「Summary so far」、精度の注意、言語は 1 つずつで混在不可）
- Otter: 告知（BusinessWire 2025-03-25）は 403 で取得できず。報道 <https://venturebeat.com/ai/beyond-transcription-how-agentic-ai-is-set-to-change-enterprise-meetings>、<https://engadget.com/ai/otterais-meeting-agent-can-schedule-calls-and-write-emails-for-you-130048189.html>
- Fireflies: <https://guide.fireflies.ai/articles/2679406774-live-assist-sales-assist-fireflies-desktop-app-real-time-notes-answers-suggestions>（「1 Question detected」「displayed automatically in the panel」「the floating pane is not visible during screen sharing」）
- Granola: <https://help.granola.ai/article/ai-enhanced-notes>、<https://www.granola.ai/blog/get-the-best-from-granola>
- Read AI: <https://www.read.ai/meeting-tools>、<https://www.read.ai/articles/ai-meeting-coach>
- Teams Copilot が会議の会話から追加の質問を提案する機能（MC999448）は二次情報（<https://m365admin.handsontek.net/?p=11977>）しか見つからず、表には入れていない。

### 会議の外の先例

- **Google Cloud Agent Assist（Proactive generative knowledge assist）**: 窓口の担当者と顧客の会話を追い、文脈から検索クエリの候補と答えを先回りで出す。クエリだけ出して答えは出さない設定がある。`querySource` で担当者が打ったか自動の提案かを区別して記録する。V2 では「granular control over triggering events」。<https://docs.cloud.google.com/agent-assist/docs/generative-knowledge-assist>、<https://docs.cloud.google.com/agent-assist/docs/pgka-bp>、<https://docs.cloud.google.com/agent-assist/docs/release-notes>（本文は取得が不完全で、検索の抜粋による）
- **Dialpad Real-time Assist cards**: 管理者がカードに「trigger words」を登録し、顧客・担当者・両方の発話で発火する。ベストプラクティスは「For a card to be effective, it must be triggered under the correct context」として、言い換えへの対応や語の選び方を挙げる。<https://help.dialpad.com/docs/real-time-assist-cards>、<https://help.dialpad.com/docs/real-time-assist-cards-custom-moments-best-practices.md>（後者は 403、検索の抜粋による）
- **Kindle Word Wise**: 「Short and simple definitions automatically appear above difficult words」「You can adjust the number of definitions you see with a slider」「just tap on the word to quickly bring up a card」。自動の短い説明 + 量の調整 + 詳しくはタップ、の型。<https://press.aboutamazon.com/2014/11/new-features-for-kindle-e-readers-now-available>
- **Microsoft Viva Topics**（2025 年に廃止）: メール本文の語を話題として自動で強調し、脇にタグ付けの提案カードを出す。受けた人は強調にホバーして話題カードを見る。HAX Toolkit が指針 G4「Show contextually relevant information」の例に挙げる。<https://www.microsoft.com/en-us/haxtoolkit/example/viva-topics-g4-show-contextually-relevant-information-2>。Teams のチャットでは自動ではなく `#` で手で付ける方式だった <https://techcommunity.microsoft.com:443/t5/viva-topics-blog/april-2022-viva-topics-integrations-with-teams-syntex-outlook/ba-p/3285296>
- ブラウザの「用語を説明」（Edge の Copilot、Chrome の検索）は選択してから呼ぶ方式で、先回りではない。Cluely 等の「会議中に画面へ答えを重ねる」アプリは公式文書が無く、先回りか呼び出しかも資料で食い違うため扱わない。

## 研究

### ParseJargon: 会議中の用語の個人化された説明（Song, Au, Wong, Bailey, August。UIUC・Fujitsu Research of America。arXiv 2508.10239、ACL 2026 demo）

<https://arxiv.org/html/2508.10239v2>、<https://aclanthology.org/2026.acl-demo.61.pdf>

- 何を: ライブの字幕から LLM が用語を見つけ、利用者のプロフィール（背景の文章）で知っていそうな語を除いて、平易な定義を出す。「Each identified jargon term is defined only once throughout the meeting.」
- いつ: 字幕の 1 文ごとに自動。最新の語は最低 7 秒表示し、その間に見つかった語は一覧に積む。
- どこに: Zoom の Web 版向け Chrome 拡張。字幕の中の語を強調、最新の定義の面、溜まり続ける用語の一覧（脇）。
- 誤りの扱い: 定義に like/dislike を付けて次の判定に効かせる。現場での誤りは、字幕の誤り・速さのための小さいモデル・プロフィールの欠け（書いていない経験の語が除かれない）が原因と分析。
- 利用者の反応:
  - 日記調査（16 人・2 週間・47 会議・123 語）: 一番多い対処は「説明を待つ」（45.5%）だが役立ち度は最低（3.11/5）。話し手に聞くのが一番役立つ（4.5/5）が、場の空気とタイミングでほとんど使われない。会議中に検索すると気が散る（10 人）。
  - 比較実験（7 人、録画の発表）: 理解は 基準 3.07 / 一般 3.79 / 個人化 4.29、没入は 3.93 / 3.64 / 4.29、価値は 3.57 / 3.93 / 4.43。出した語は一般 22.57 / 個人化 9.71 語、役立った割合 47.03% / 77.51%。一般版は 6 人が圧倒されたと答え、「too many term definitions with very short reading time」。
  - 現場（10 人・45 分の定例 1 回、対照なし）: NASA-TLX の負荷は低く、「What I liked most was that it was automatic and non-intrusive.」。2 人は判定の精度で低く評価。

### StopGap: 動画の講義で用語の説明を時刻に合わせて出す（Liu, Shah, Ackerman, Saha。CHI 2025）

<https://arxiv.org/abs/2503.00715>、本文 <https://arxiv.org/html/2503.00715>

- 動画の書き起こしから用語を見つけ、再生に合わせてカードを自動で出す（動画は止めない）。カードの間は最低 5 秒。完全自動で、呼び出しの手段は無い。24 人の design probe（説明は人手で用意したもの）。
- 反応: 「It's overwhelming because it keeps prompting new information」(P2)、パネルに気を取られて動画を見なくなる (P21)、簡単すぎる語の説明は邪魔 (P7)。逆に、出ると思った語に出ないと待ってしまい集中が切れる (P24)。誤った比喩は理解を損なった (P13)。数値の認知負荷ははっきり上がらなかった。
- 利用者は、切る手段・字幕の語を押して出す・ホバーで出すなど、自動と自分で呼ぶの混合を求めた。著者は 6 つの設計次元（対象の利用者、表現の形式、データの出どころ、一度に出す数、個人化、自動・提案・利用者主導の対話の型）を挙げ、自動と自発の釣り合いは状況で変わると結論。対策の案に出典の明示と確信度を挙げる。

### InsightToast: 会議の脇の面に、根拠付きの情報を先回りで出す（Abolnejadian, Brehmer。UIST '26）

<https://arxiv.org/abs/2608.31115>

- 会話を聞いて話題と情報の必要を見つけ、RAG で根拠付きの短い文と小さな図を「peripheral interface as ephemeral toasts」で出す。16 人の研究で、自然な会話の流れを保ったまま情報に基づく判断に至ったと報告。抑え方の詳細は抄録に無い。

### 会議中の目標の振り返り（Chen, Tankelevitch ほか。Microsoft Research。CHI 2025）

<https://arxiv.org/abs/2504.01082>

- 15 人が自分の実会議のデータで、受け身（控えめな表示）と能動（介入して促す）の 2 つの probe を試した。受け身は「helped participants maintain focus through non-intrusive feedback」、能動はすぐの振り返りを促すが「risked disrupting the conversation flow」。介入の強さとタイミングの調整、利用者の制御が要ると結論。

### 先回りの提案の頻度（Chen ほか「Need Help? Designing Proactive AI Assistants for Programming」CHI 2025）

<https://arxiv.org/html/2410.04596v2>

- 打っている間は出さず、手が止まって 5 秒後、最大 20 秒に 1 回、3 件まで。これを 5 秒・5 件に上げた版は、成果（12〜18% 増）は同じでも、好む人が約 90% → 47% に下がり、提案の採用も減った（9.5 回開いて 2.1 回使う vs 6.4 回開いて 3.1 回）。「the non-proactive chat assistant was best because it didn't interrupt what I was doing」。利用者は頻度を変えられることを求めた。

### 設計指針（Amershi ほか「Guidelines for Human-AI Interaction」CHI 2019）

<https://www.microsoft.com/en-us/haxtoolkit/library/>、<https://doi.org/10.1145/3290605.3300233>

- 先回りの補足に直接効くのは G3「Time services based on context」、G4「Show contextually relevant information」、G8「Support efficient dismissal」、G9「Support efficient correction」、G10「Scope services when in doubt」（不確かなときは出す量を減らす）、G17「Provide global controls」。

## 見つからなかったもの

- 会議ツールで「決定の理由」「ここまでの経緯」を質問の前に自動で添える機能の一次資料。会議中の要約・追いつきは、どれも利用者が開くか押す形（Meet の Summary so far、Zoom の Catch me up、Fireflies の Catch Up）。
- ライブ字幕の製品（Teams・Zoom・Meet の字幕）が用語集から定義を出す機能。検索した範囲では見当たらなかった（研究の ParseJargon が字幕の中の語を強調して定義を出すのが一番近い）。
- 製品側の、先回りの表示が邪魔かどうかの公開データ。利用者の反応の一次情報は上の研究だけ。
