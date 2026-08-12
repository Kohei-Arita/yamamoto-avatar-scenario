# Setup And Operations

このファイルは、ローカル起動、Render 公開、動作確認、環境変数、X-Gate 運用メモをまとめた運用ドキュメントです。まず動かしたい人はここから読んでください。

## セットアップ

### 1. `.env` を作る

```bash
cp .env.example .env
```

最低限これを埋めれば、現在の標準構成で動きます。

```env
LIVEAVATAR_API_KEY=
OPENAI_API_KEY=
LIVEAVATAR_LANGUAGE=ja
LIVEAVATAR_SELF_CONTROLLED=true
```

補足:

- `OPENAI_API_KEY` はサーバー起動自体には必須扱いではありませんが、今の標準会話フローでは実質必須です
- `.env.example` には動作確認用の `LIVEAVATAR_AVATAR_ID` と `LIVEAVATAR_VOICE_ID` を入れているので、標準構成ならそのまま使えます
- 現在の `.env.example` では、内部の OpenAI 互換 API 呼び出しコストを抑えるために `OPENAI_MODEL=gpt-5-mini` を使っています
- 回答精度を優先したい場合は、`.env` の `OPENAI_MODEL` をより高性能なモデル名に書き換えてください
- 医療用語の文字起こし補正も同じく精度を上げたい場合は、`.env` の `RAG_LLM_TRANSCRIPT_NORMALIZATION_MODEL` も合わせて書き換えてください
- 例:

```env
OPENAI_MODEL=gpt-5
RAG_LLM_TRANSCRIPT_NORMALIZATION_MODEL=gpt-5
```

- `.env.example` の `LIVEAVATAR_USE_SANDBOX=false` は「今の共有設定」に合わせた例です。Sandbox の公開アバターで試すなら `true` にしてください
- `.env.example` は標準の self-controlled 構成でそのまま使う前提に絞っています

### 2. 依存関係を入れて起動する

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

### 3. Docker で起動する

```bash
docker compose up --build
```

`compose.yaml` は `.env` を読み、`HOST=0.0.0.0` で公開します。

ブラウザで開く URL は `http://localhost:3000` です。

`0.0.0.0` はサーバーの listen address であり、ブラウザで開くための URL ではありません。`http://0.0.0.0:3000` を直接開くと secure context 扱いにならず、Chrome でもマイク取得 API が使えません。

---

## まず確認するページ

- `http://localhost:3000/`
  - 現在のデフォルト表示です
  - `/xgate` にリダイレクトされます
  - X-Gate など外部ディスプレイ向けの表示 UI です
- `http://localhost:3000/xgate`
  - 表示寄りの UI を直接開きたい場合の URL です
  - `?controls=0&subtitles=1` のようなクエリで表示を調整できます
- `http://localhost:3000/index.html`
  - 開発用のデバッグ UI です
  - 接続状態、Runtime Log、RAG Log を見ながら切り分けできます

---

## Render で公開する

この repo には Render Blueprint 用の [`render.yaml`](../render.yaml) を入れています。`/xgate` は `/api/liveavatar/*` と `/api/rag/*` に依存するため、静的サイトではなく Web Service としてアプリ全体を公開してください。

### 前提

- 本番 URL は HTTPS で公開されます
  - マイク利用には secure context が必要です
- 現在の会話履歴と RAG ログはプロセス内メモリ保持です
  - そのため Render では最初は単一インスタンス運用を前提にし、`render.yaml` でも `numInstances: 1` にしています
- ヘルスチェックは `/api/health` を使います

### Render 側でやること

1. GitHub repo を Render に接続する
2. Blueprint としてこの repo を作成する
3. 初回作成時に `sync: false` の環境変数へ値を入れる
4. デプロイ完了後、`https://<your-service>.onrender.com/xgate?controls=0&subtitles=1` を開いて確認する

初回作成時に入力が必要な主な環境変数:

```env
LIVEAVATAR_API_KEY=...
LIVEAVATAR_AVATAR_ID=...
LIVEAVATAR_VOICE_ID=...
OPENAI_API_KEY=...
RAG_ENDPOINT_API_KEY=...
```

補足:

- `HOST=0.0.0.0` は `render.yaml` 側で固定しています
- `PORT` は Render が Web Service に自動設定します
- `RAG_ENDPOINT_API_KEY` は `/v1/chat/completions` を外部公開で使わないなら空でも動きます
- `sync: false` の変数は Blueprint 初回作成時だけ入力を促されます
  - 後から追加・変更する場合は Render Dashboard の Environment で手動更新してください
- Free プラン相当のスリープ運用は会話デモと相性が悪いです
  - X-Gate 常設表示なら常時起動プランを使う方が安全です

### 公開後の確認

- `https://<your-service>.onrender.com/api/health` が `{"ok":true,"service":"yamamotoavator-demo"}` を返す
- `https://<your-service>.onrender.com/` で表示 UI が開く
- `https://<your-service>.onrender.com/index.html` でデバッグ UI が開く
- マイク権限を許可するとセッション開始まで進む

### 将来やる可能性があること

- `/xgate` を既定ルートにする
- Basic 認証や IP 制限を前段に置く
- 会話状態を Redis などに逃がして複数インスタンス対応する

---

## 動作確認

### ヘルスチェック

```bash
curl http://127.0.0.1:3000/api/health
```

### OpenAI 互換 RAG endpoint

`RAG_ENDPOINT_API_KEY` を設定している場合だけ `Authorization` ヘッダーを付けます。

この endpoint は、入力形式を OpenAI の `chat/completions` 風にしてあるだけで、中ではこの repo の RAG ロジックが動きます。

```bash
curl "http://127.0.0.1:3000/v1/chat/completions" \
  -H "content-type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "EGFR陽性の非小細胞肺癌の一次治療は？" }
    ],
    "metadata": {
      "sessionId": "manual-debug"
    }
  }'
```

```bash
curl "http://127.0.0.1:3000/api/rag/logs?sessionId=manual-debug"
```

### ブラウザ実会話

`/index.html` を開いて `Start Session` を押します。確認しやすい観点は次です。

- Runtime Log に `RAG answer` と回答本文 preview が出る
- RAG Log に `rag_hit` か `no_rag` が残る
- `routeReason` と `retrievalStage` が埋まる
- 挨拶だけなら `no_rag`、治療質問なら `rag_hit` になりやすい

### テスト

RAG の回帰確認には次を使います。

```bash
npm test
```

現状は少なくとも次を固定しています。

- ASR 補正で `ハイリスク分` と `背門部` が補正される
- `喀痰細胞診は有用ですか` で `CQ2` が最上位に来る
- `ハイリスク群を対象とした肺門部肺癌の検出に、喀痰細胞診は有用か？` 系で `CQ2` が最上位に来る

---

## 環境変数

### 通常運用でよく使うもの

| 変数                                       | 用途                                   | 既定値                                                                                                |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `HOST`                                     | listen host                            | `127.0.0.1`                                                                                           |
| `PORT`                                     | listen port                            | `3000`                                                                                                |
| `LIVEAVATAR_API_KEY`                       | LiveAvatar API 認証                    | なし                                                                                                  |
| `LIVEAVATAR_AVATAR_ID`                     | 使用するアバター ID                    | `dd73ea75-1218-4ef3-92ce-606d5f7fbc0a`                                                                |
| `LIVEAVATAR_VOICE_ID`                      | voice 上書き                           | 空                                                                                                    |
| `LIVEAVATAR_LANGUAGE`                      | avatar persona の言語                  | `en`                                                                                                  |
| `LIVEAVATAR_MODE`                          | LiveAvatar session mode                | `FULL`                                                                                                |
| `LIVEAVATAR_USE_SANDBOX`                   | Sandbox 利用                           | コード既定値は `true`、`.env.example` は `false`                                                      |
| `LIVEAVATAR_VIDEO_QUALITY`                 | video quality                          | `medium`                                                                                              |
| `LIVEAVATAR_VIDEO_ENCODING`                | video encoding                         | `H264`                                                                                                |
| `LIVEAVATAR_SELF_CONTROLLED`               | self-controlled 有効化                 | `false`                                                                                               |
| `LIVEAVATAR_VOICE_MODEL`                   | ElevenLabs TTS モデル名                | `eleven_multilingual_v2`                                                                              |
| `LIVEAVATAR_VOICE_SPEED`                   | TTS 読み上げ速度                       | `0.9`                                                                                                 |
| `LIVEAVATAR_VOICE_STABILITY`               | TTS 安定性 (0〜1)                      | `0.75`                                                                                                |
| `LIVEAVATAR_VOICE_SIMILARITY_BOOST`        | TTS 類似性ブースト (0〜1)              | `0.75`                                                                                                |
| `LIVEAVATAR_VOICE_STYLE`                   | TTS スタイル強度 (0〜1)                | `0.15`                                                                                                |
| `LIVEAVATAR_TRANSCRIPT_DEBOUNCE_MS`        | transcription まとめ時間               | `1200`                                                                                                |
| `LIVEAVATAR_TRANSCRIPT_CONTINUATION_MS`    | 発話継続とみなして前回文と連結する時間 | `1800`                                                                                                |
| `LIVEAVATAR_ASSISTANT_NAME`                | 応答の人格名                           | `山本`                                                                                                |
| `LIVEAVATAR_ASSISTANT_PERSONA`             | 応答の人格説明                         | `肺がん専門の内科医`                                                                                  |
| `LIVEAVATAR_OPENING_GREETING`              | 開始時の初回発話                       | コード既定値は `内科医の山本です。ガイドラインをもとに一般的な説明をします。今日はどうされましたか？` |
| `OPENAI_API_BASE_URL`                      | 上流 OpenAI 互換 API                   | `https://api.openai.com/v1`                                                                           |
| `OPENAI_API_KEY`                           | 上流 LLM 認証                          | なし                                                                                                  |
| `OPENAI_MODEL`                             | 上流モデル名                           | コード既定値は `gpt-4.1-mini`、`.env.example` は `gpt-5-mini`                                         |
| `RAG_ENABLED`                              | RAG 全体の有効化                       | `true`                                                                                                |
| `RAG_DATA_PATH`                            | JSONL データパス                       | `./data/processed/lung-cancer-guideline-hybrid.jsonl`                                                 |
| `RAG_TOP_K`                                | 取得件数                               | `6`                                                                                                   |
| `RAG_MIN_SCORE`                            | strict hit の下限点                    | `2`                                                                                                   |
| `RAG_LLM_TRANSCRIPT_NORMALIZATION_ENABLED` | 医療用語の LLM 補正                    | `true`                                                                                                |
| `RAG_LLM_TRANSCRIPT_NORMALIZATION_MODEL`   | 補正に使うモデル名                     | `OPENAI_MODEL` と同じ。両方未設定なら `gpt-4.1-mini`                                                  |
| `RAG_LOG_LIMIT`                            | 保存ログ件数                           | `200`                                                                                                 |
| `RAG_CONVERSATION_HISTORY_LIMIT`           | 会話履歴保持数                         | `12`                                                                                                  |
| `RAG_SESSION_LIMIT`                        | セッション保持数                       | `200`                                                                                                 |
| `RAG_ENDPOINT_API_KEY`                     | `/v1/chat/completions` 保護用          | 空                                                                                                    |

### built-in 会話 / custom LLM に戻したいときだけ使うもの

| 変数                              | 用途                                 |
| --------------------------------- | ------------------------------------ |
| `LIVEAVATAR_CONTEXT_ID`           | LiveAvatar built-in 会話コンテキスト |
| `LIVEAVATAR_LLM_CONFIGURATION_ID` | LiveAvatar custom LLM 設定 ID        |

補足:

- built-in 会話
  - LiveAvatar サービス側に返答も任せる使い方です
- custom LLM
  - LiveAvatar から外部の OpenAI 互換 API を呼ばせる使い方です
  - `scripts/provision-liveavatar-custom-llm.mjs` や `scripts/update-liveavatar-llm.mjs` では、公開 URL を `--base-url` / `--url` で渡すか、必要に応じて `LIVEAVATAR_PUBLIC_BASE_URL` を個別に `.env` へ追加します
- 今の標準構成では、そのどちらでもなく、ブラウザ経由で自前の `/api/rag/respond/stream` を叩いています

---

## X-Gate メモ

X-Gate 実機で使うときは、次の URL を基準にすると運用しやすいです。

```text
http://localhost:3000/xgate?controls=0&subtitles=1
```

- `controls=0`
  - HUD を自動で隠します
- `subtitles=1`
  - 字幕表示を有効にします
  - 標準の self-controlled 構成では、サーバーから返った `speech_segment` の subtitle を表示します
- `autostart=1`
  - 自動開始を試せますが、初回はブラウザのマイク許可で止まることがあります

X-Gate 実機での接続手順を順番に見たい場合は [X-GATE_connection.md](../X-GATE_connection.md) を参照してください。

---

## 制約と未実装

- ベクトル検索は未実装です
- 永続 DB は未実装です
- テストは一部だけ入っていますが、全体を十分にカバーしているわけではありません
- RAG データは現状 `data/processed/lung-cancer-guideline-hybrid.jsonl` 前提で、内訳は 2025 CQ + 2024 `souron` / `meta` です
- Sandbox を使う場合は、利用可能アバターやセッション時間に制限があります
