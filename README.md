# yamamoto-avatar-scenario

肺癌学会ステージ企画向けの、**シナリオ駆動型AIアバター山本医師**デモです。

架空症例（76歳男性・右下葉扁平上皮癌・UIPパターン間質性肺炎併存）の台本に沿ってのみ、問診・検査説明・治療方針説明を行います。会場Voting（①追加問診項目、②治療選択肢）による分岐は、オペレーターが手動で選択して進行します。

> 本デモは学会の教育・演出用です。実診療・医学的助言は提供しません。

旧リポジトリ（ガイドラインRAG版 `yamamotoavator-demo-`）から映像・音声・会話制御パイプラインを引き継ぎ、RAG検索をシナリオ状態機械に置き換えたものです。設計詳細は [docs/architecture.md](docs/architecture.md) を参照してください。

## 構成

- **LiveAvatar + LiveKit**: アバター映像・音声・文字起こし（旧版から変更なし）
- **シナリオエンジン** (`src/features/scenario/`): `data/scenarios/haigan-2026.json` の有向グラフに沿って進行。台本外の発話には短い定型で受け止めて台本へ復帰
- **対話API** (`src/features/dialogue/`): SSE `speech_segment` ストリーミング（旧RAG版とイベント形式完全互換）
- **オペレーターAPI/画面** (`src/features/operator/`, `/operator`): Voting分岐選択・強制送り・再発話・ジャンプ・リセット

## セットアップ

```bash
npm install
cp .env.example .env
# .env に LIVEAVATAR_API_KEY / OPENAI_API_KEY / OPERATOR_TOKEN を設定
npm run dev
```

- 会場画面: `http://localhost:3000/xgate`（全画面・クロマキー対応。`?autostart=1&controls=0` 推奨）
- オペレーター画面: `http://localhost:3000/operator`（`OPERATOR_TOKEN` で接続）
- デバッグ画面: `http://localhost:3000/index.html`

X-Gateとの接続手順は [X-GATE_connection.md](X-GATE_connection.md) を参照。

## 主要な環境変数

| 変数                        | 説明                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `SCENARIO_ID`               | シナリオID（既定: `haigan-2026`）                                       |
| `SCENARIO_DIR`              | シナリオJSONの配置先（既定: `./data/scenarios`）                        |
| `SCENARIO_SPEECH_MODE`      | `fixed`（固定文・本番推奨）/ `paraphrase`（LLM言い換え+禁止語チェック） |
| `SCENARIO_INTENT_LLM`       | ルール不一致時にLLMでintent分類するか                                   |
| `OPERATOR_TOKEN`            | オペレーターAPIのBearerトークン（**必須**）                             |
| `LIVEAVATAR_*` / `OPENAI_*` | 旧版と同じ（`.env.example` 参照）                                       |

## シナリオの編集

台本は `data/scenarios/haigan-2026.json` にすべて入っています。**セリフの修正・監修反映はこのJSONの編集だけで完結し、コード変更は不要です。**

- `placeholder: true` が付いたノードは監修前の仮置きテキストです（Voting分岐の医学的内容を含む）。監修後に該当ノードの `doctorLines` を差し替えてください
- ノード形式・遷移条件は [docs/architecture.md](docs/architecture.md) を参照
- 起動時にスキーマ検証され、不正なJSONはエラーで停止します

## 進行オペレーション

1. `/operator` を開きトークンで接続
2. Voting待機ノードに達すると分岐ボタン（A/B/C）が表示される → 会場の投票結果に合わせて押す
3. 救済: 「次へ（強制）」「再発話」「ジャンプ」「リセット」
4. `/xgate?optoken=<OPERATOR_TOKEN>` では同一PCから `1/2/3`=分岐、`n`=次へ、`r`=再発話のショートカットも使える

**注意**: 進行状態はサーバーメモリのみで保持されます。再起動でリセットされるため、本番は単一インスタンスで運用し、復帰は「ジャンプ」を使ってください。

## テスト

```bash
npm test   # スキーマ / エンジン(9経路) / intent / 逸脱 / SSE互換 / operator認証 / paraphraseフォールバック
npm run lint
```

リハーサル用の手動チェックリストは [docs/rehearsal.md](docs/rehearsal.md)。

## デプロイ

Render（Docker, 単一インスタンス）を想定。`render.yaml` を参照。`OPERATOR_TOKEN` / `LIVEAVATAR_API_KEY` / `OPENAI_API_KEY` はダッシュボードで設定してください。

## 旧RAG版について

ガイドラインRAG関連のコード・データは削除済みです。旧設計資料は `docs/archive/` に残していますが現行実装とは一致しません。旧 `/api/rag/*` パスは互換aliasとして残っており、既存ブラウザコードはそのまま動作します。
