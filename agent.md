# agent.md

このファイルは、このリポジトリで作業するエージェント向けの運用ガイドです。
README を置き換えるものではありません。ここには、毎回守るべきことだけを書きます。

## 目的

- 変更を小さく保ち、この repo の標準構成を壊さずに改善する
- 実装、設定、README の説明を常に一致させる
- デモとしての会話体験とシナリオ進行(台本駆動)の流れを崩さない

## このプロジェクトの前提

- Node.js 20 / ESM の Express アプリです
- 主な体験は `HeyGen LiveAvatar + LiveKit + シナリオ状態機械` です
- 現在の標準経路は `LIVEAVATAR_SELF_CONTROLLED=true` を前提にした self-controlled 構成です
- ブラウザは表示だけでなく、transcription の集約、対話API呼び出し、avatar への speak 制御も担います
- ルート `/` と不明パスは `/xgate` へリダイレクトされます

詳細な構成、環境変数、運用手順は必ず `README.md` を参照してください。

## 最初に確認する場所

変更前に、対象に応じて次を優先的に読んでください。

1. `README.md`
2. `src/server.js`
3. `src/app.js`
4. `public/xgate.js`
5. `public/liveavatar-self-controller.js`
6. `src/features/liveavatar/`
7. `src/features/scenario/` と `src/features/dialogue/`
8. `.env.example`

## 変更の基本ルール

- まず既存の実装方針に合わせる。設計を変えるのは、必要性が明確なときだけにする
- 目的に直接関係ないリファクタや命名変更を混ぜない
- 挙動を変える場合は、コードだけでなく `README.md` と必要なら `.env.example` も同じ作業で更新する
- 新しい環境変数を増やす場合は、用途と既定値を README に追記する
- 既存の API 形状、SSE イベント名、フロントとサーバーの責務分担を不用意に変えない

## この repo で特に守ること

### 1. 標準経路を壊さない

- まず守るべき主経路は `browser -> /api/liveavatar/* -> LiveKit -> /api/dialogue/respond/stream -> avatar.speak_text` です
- built-in 会話や custom LLM 用のコードは残っていますが、現在の標準構成ではありません
- 変更時は self-controlled 構成が引き続き成立するかを優先して確認してください

### 2. README と実装をずらさない

- この repo の README は詳細な運用マニュアルとして使われています
- 次の変更は README 更新を必須とします
  - 起動手順
  - 環境変数
  - ルートや責務
  - ファイル構造
  - シナリオ進行(状態機械)の処理フロー
  - npm scripts

### 3. 医療デモとしての制約を意識する

- 回答生成は `data/processed/lung-cancer-guideline-hybrid.jsonl` を根拠にする前提です
- 検索やプロンプトを変える場合は、「なぜその断片が選ばれたか」を追いやすい性質を落とさない
- 一般知識で自由に補完する方向より、取得断片ベースの説明を優先する

### 4. フロントとサーバーの境界を崩しすぎない

- ブラウザ側の会話制御は `public/` にあります
- LiveAvatar API 呼び出しやシナリオエンジン本体は `src/features/` にあります
- 変更時は、責務がどちらにあるべきかを確認してから実装する

### 5. 秘密情報を増やさない

- API キーや機微情報をコード、README、サンプル値に直書きしない
- `.env.example` には共有してよい例だけを書く

## 推奨ワークフロー

1. まず `README.md` で対象機能の説明を読む
2. 関連する `public/` または `src/features/` の実装を確認する
3. 変更を最小差分で入れる
4. 関連テストを実行する。必要ならテストを追加する
5. README / `.env.example` の差分を確認する

## 完了前チェック

- `npm test` が通るか、少なくとも変更箇所に関係するテストを実行したか
- 画面挙動を変えたなら `/xgate` を確認したか
- API や SSE を変えたなら、ブラウザ側とサーバー側の両方を確認したか
- 環境変数や運用を変えたなら `README.md` と `.env.example` を更新したか
- デフォルトのリダイレクトや標準会話フローを壊していないか

## 禁止事項

- README を更新せずに仕様変更だけを入れる
- 無関係な大規模整形や広範囲リネームを同じ変更に含める
- self-controlled 構成を壊す変更を、説明や移行手順なしで入れる
- 検証なしでシナリオJSONのスキーマや API 契約(SSE `speech_segment` 形式)を変える

不足があれば、このファイルに何でも足すのではなく、「繰り返し指摘が必要だったルール」だけを追加してください。
