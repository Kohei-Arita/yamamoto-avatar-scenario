# アーキテクチャ（シナリオ駆動版）

肺癌学会ステージ企画向けに、架空症例（76歳男性・右下葉扁平上皮癌・UIPパターンIP併存）の台本に沿ってのみ問診・検査説明・治療方針説明を行うAIアバターです。旧ガイドラインRAG版のアーキテクチャ資料は `docs/archive/` にあります（現行実装とは一致しません）。

## 会話経路

```
利用者(模擬患者)の音声
  → LiveAvatarが文字起こし
  → ブラウザが発話断片を結合・非発話の断片(句読点のみ等)とエコー(スピーカー回り込み)を除外
     (public/liveavatar-self-controller.js)
  → POST /api/dialogue/respond/stream (結合再送時は revision フラグ付き)
  → transcript-normalizer でASR補正
  → scenario-engine:
       ├─ 非発話の断片 → kind="ignored"。進行も発話もしない(サーバー側の二重防御)
       ├─ 現在ノードに対する患者発話を intent-matcher で分類
       │    ├─ 想定内 → 次ノードの医師セリフを確定
       │    ├─ 想定外だが軽微 → 受け止め一文 + 現在ノードの質問を再提示
       │    └─ 台本外(予後断定要求・雑談など) → deviation-handler の定型文で台本へ復帰
       └─ 判定中にoperator操作が入っていた → kind="superseded"。判定を破棄し発話しない
  → セリフ確定(既定: doctorLines固定文。SCENARIO_SPEECH_MODE=paraphrase でLLM言い換え+禁止語チェック)
  → streaming-speech で文単位に分割
  → SSE speech_segment
  → ブラウザ読み上げキュー → avatar.speak_text
```

進行の主導権は常にサーバー側の「現在ノード」にあります。発話される内容はシナリオJSONのノード定義から生成されたテキストのみです。

## ディレクトリ

```
src/features/scenario/    状態機械(engine)・ローダー・スキーマ検証・intent分類・逸脱処理
                          ・非発話フィルタ(utterance-filter)・進行状態store
src/features/dialogue/    SSE入出力・発話整形(読み仮名/字幕/文分割)・会話履歴・進行ログ
                          ・セッション登録簿(session-registry)・OpenAIクライアント
src/features/operator/    オペレーターAPI (/api/operator/*, Bearer認証)
src/features/liveavatar/  LiveAvatarセッション管理
data/scenarios/           シナリオ定義JSON (haigan-2026.json)
public/operator.*         オペレーター画面
public/transcript-*.js    非発話フィルタ・エコーガード(ブラウザ側の一次防御)
```

## シナリオ定義 (data/scenarios/haigan-2026.json)

- ノードは有向グラフ。各ノードは `id` / `scene` / `doctorLines[]` / `advance[]` を持つ。
- `advance` の遷移条件:
  - `patient_any`: 患者が何か発話したら次へ
  - `patient_intent`: intent分類結果で分岐（`keywords` によるルール層 → 不一致時のみLLM分類）
  - `operator`: オペレーター操作でのみ遷移（Voting分岐）
  - `auto`: 発話後に待たず次ノードへ連結
- `advance: []` は終端ノード。
- `placeholder: true` は監修前の仮置きテキスト。**監修後はJSONの該当ノードのテキストを差し替えるだけで更新できる（コード変更不要）**。
- 逸脱時の定型応答は `globalDeviationReplies`（ノード単位は `onDeviation` で上書き）。

## intent-matcher（2段構え）

1. ルール層: NFKC正規化後のキーワード部分一致。マッチ数が多いadvanceを採用、同点は定義順。
2. LLM層（`SCENARIO_INTENT_LLM=true` かつルール不一致時のみ）: 選択肢 or `OFF_SCRIPT` を返すJSON強制の分類プロンプト。回答生成はさせない。

判定結果・根拠は `dialogue-log.store` に記録され、オペレーター画面・`/api/dialogue/logs` で確認できます。

## 発話生成の2モード（SCENARIO_SPEECH_MODE）

| モード                    | 動作                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `fixed`（既定・本番推奨） | doctorLinesをそのまま読み上げ。LLMはintent分類のみに使用。逸脱リスクゼロ                                             |
| `paraphrase`              | 意味を変えない制約付きプロンプトで言い換え。出力後に数値・禁止薬剤名チェックを行い、不合格なら固定文へフォールバック |

## API

| パス                                | 内容                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /api/dialogue/session`        | セッション作成（直前セッションの進行を自動引き継ぎ）                                                   |
| `POST /api/dialogue/respond/stream` | 患者発話→SSE応答（`speech_segment`/`done`/`error`。`revision:true`で直前の患者遷移を巻き戻して再判定） |
| `GET /api/dialogue/logs`            | 進行ログ                                                                                               |
| `GET /api/dialogue/events`          | オペレーター発話をブラウザへpushするSSEチャンネル                                                      |
| `GET /api/operator/state`           | 現在ノード・分岐選択肢・履歴（要 `Authorization: Bearer <OPERATOR_TOKEN>`）                            |
| `POST /api/operator/branch`         | Voting分岐確定 `{branch: "voting1_A"}` 等                                                              |
| `POST /api/operator/next`           | 強制送り（患者が固まった場合の救済）                                                                   |
| `POST /api/operator/jump`           | 任意ノードへジャンプ `{nodeId}`（リハーサル・再起動復帰用）                                            |
| `POST /api/operator/reset`          | 先頭へ戻す                                                                                             |
| `POST /api/operator/say`            | セリフ再発話                                                                                           |

オペレーター操作で確定したセリフは `/api/dialogue/events` のSSE経由でブラウザの既存読み上げキューに投入されます（ブラウザ側は `subscribeDialogueEvents` で購読）。

## 進行状態の保持

会話履歴・進行状態はメモリのみです。**サーバー再起動で進行は先頭にリセットされます**。本番当日は単一インスタンスで運用してください（複数インスタンスでは状態が共有されません）。再起動時は `/operator` 画面の「ジャンプ」で中断地点へ復帰できます。

LiveAvatarセッションの切断・再接続（新しいsessionId）では、bind時に直前セッションの進行・会話履歴を自動で引き継ぎます（直近10分以内・entryノード以外まで進んでいた場合のみ）。

## 本番向けの保護機構

- **非発話フィルタ** (`public/transcript-filter.js` / `src/features/scenario/utterance-filter.js`): ASRが無音区間や発話の切れ目で出す「句読点だけ」「一音だけ」の断片を除外。これを通すと `patient_any` ノードが素通しされて台本が飛び、アバター発話中なら割り込みで音声が中断される。ブラウザ（送信前）とサーバー（`kind="ignored"`）の二段で防御し、「はい」「うん」等の短答は通す
- **エコーガード** (`public/transcript-echo-guard.js`): アバター発話がスピーカー→マイクで回り込んで文字起こしされたものを、文字2-gram一致率で検知して無視
- **発話中のマイクミュート** (`public/liveavatar-self-controller.js`): 応答中（LLM生成の開始〜全セグメントの発話完了まで）は `setMicrophoneEnabled(false)` で自分のマイクを止める。`LIVEAVATAR_ALLOW_INTERRUPT=false` は「受信した文字起こしを無視する」だけで、LiveAvatar側がマイク音声を独自のVADで検知して発話を止める経路は塞げない。音声の発行自体を止めることで、その経路も含めて確実に話し切らせる。ミュート/解除は直列化し、失敗時は再試行して実状態を追いつかせる（解除失敗を放置すると患者の声が二度と届かなくなるため）
- **revision巻き戻し**: 途切れた発話の結合再送時、サーバーが直前の患者遷移を取り消してから再判定（台本の二重前進を防止）
- **開始挨拶の確実化**: アバターの音声トラック到着（＝HeyGenエージェント入室）を待って挨拶を送信。入室前に送るとdata channelのコマンドが配送されず無音になる
- **発話ウォッチドッグ**: `speak_started` が返らなければ一度だけ再送し、それでも無応答なら発話中とみなして前進。`speak_ended` 未着時も推定発話時間の経過でキューを前進（無音のまま停止しない）
- **起動処理の世代管理**: Start処理中にStopが割り込んだ場合は起動を中断。sessionIdは起動時に確定した値を固定で使い、途中のStopでnull化しない
- **superseded破棄**: LLM intent分類の待機中にオペレーター操作が入った場合、古い判定は破棄
- **セッションID検証** (`src/features/dialogue/session-registry.js`): LiveAvatarセッションを発行済みのサーバーは、明示指定された未知のsessionIdからの対話APIを403で拒否（未指定は直近bindセッションへのフォールバックとして許可）
- **自動再接続**: `/xgate?autostart=1` は予期しない切断から最大3回自動で再接続
- **自動再生ブロック対応**: 音声がブラウザにブロックされた場合「タップして音声を有効にする」オーバーレイを表示

いずれもサーバーログ（`utterance_ignored` / `echo_ignored` / `revision_rewind` / `utterance_superseded`）とブラウザログ（`watchdog.*`）で発動を確認できます。

## 画面

- `/xgate` : 会場表示用全画面（`?optoken=<OPERATOR_TOKEN>` を付けると 1/2/3=分岐、n=次へ、r=再発話 のショートカットが有効）
- `/operator` : 進行担当者用画面（トークン入力後、状態表示・分岐ボタン・ログ）
- `/index.html` : デバッグ画面
