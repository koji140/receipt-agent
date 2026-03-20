# receipt-agent

個人事業主・小規模法人向けの領収書自動処理AIエージェントシステム。

カスタムGPTに領収書を送るだけで、OCR抽出・勘定科目判定・Google Sheets登録・銀行照合までを自動で行う。

---

## 🤖 AIへの引き継ぎ（セッション開始時に必ず読ませること）

新しいAIセッションを始めるときは、以下のURLを渡してください：

- スキル定義・未解決課題：https://raw.githubusercontent.com/koji140/receipt-agent/main/docs/skill-receipt-agent-dev.md
- バグ取り記録・試行錯誤の経緯：https://raw.githubusercontent.com/koji140/receipt-agent/main/docs/receipt-agent-lessons.md

---

## 現在の状態・進捗確認

| ドキュメント | 用途 |
|------------|------|
| [未解決課題・開発Skill](docs/skill-receipt-agent-dev.md) | 次にやること・設定値・テスト関数 |
| [開発ノウハウ・バグ取り記録](docs/receipt-agent-lessons.md) | 苦労した点・解決策・教訓 |
| [要件定義書 v1.6](docs/requirements.md) | 何をするか |
| [技術仕様書 v1.6](docs/architecture.md) | どう実現するか |
| [設計意思決定ログ](docs/decisions/) | なぜそう決めたか |

---

## システム構成

    [ユーザー]
        ↓ 領収書・指示
    [カスタムGPT（フロントエンド）]
        ↓ POST
    [Cloudflare Workers（中継）]
        ↓ GET（バックグラウンド）
    [Google Apps Script（バックエンド）]
        ↓
    [Google Drive]  [Google Sheets]
        領収書保存      経費データ管理

Note: OpenAIからGASへの直接POSTはGoogleのインフラ制限で動作しない（2026年3月現在）。
Cloudflare Workersを中継として使用。詳細は docs/receipt-agent-lessons.md 参照。

---

## 主要機能

| 機能 | 概要 | 優先度 | 状態 |
|:--|:--|:--|:--|
| 領収書アップロード | 最大10件を一括処理 | P0 | 動作確認済み |
| OCR自動抽出 | OpenAI Vision で日付・金額・取引先等を抽出 | P0 | 動作確認済み |
| 勘定科目自動判定 | 信頼度0.8以上で自動確定 | P0 | 動作確認済み |
| 家事按分15%ルール | 対象科目・取引先ホワイトリストで自動適用 | P0 | 動作確認済み |
| 年額サブスク月割り | 前払費用として計上し月割り自動生成 | P0 | 未テスト |
| 外貨自動換算 | 77銀行仲値をOpenAI経由で動的取得 | P0 | 未テスト |
| 銀行照合 | GMO・MF・通帳写真と自動照合 | P0 | 未テスト |
| AIレビューモード | 月末にneedsReview案件を一括提示 | P1 | 未テスト |
| 全体レビュー | 横断的異常検知 | P1 | 未テスト |
| フィードバック学習 | ユーザー指摘をルールとして自動学習 | P1 | 未テスト |
| 定期経費自動入力 | 家賃等を月末トリガーで自動登録 | P1 | 未テスト |
| 交通費自動計算 | OpenAI経由でIC運賃を取得 | P1 | 未テスト |

---

## リポジトリ構成

    receipt-agent/
    ├── docs/
    │   ├── requirements.md               # 要件定義書 v1.6
    │   ├── architecture.md               # 技術仕様書 v1.6
    │   ├── skill-receipt-agent-dev.md    # 開発Skill・未解決課題（Claude.ai用）
    │   ├── receipt-agent-lessons.md      # 開発ノウハウ・バグ取り記録
    │   └── decisions/
    │       ├── 001_logical_delete.md
    │       ├── 002_reconcile_status.md
    │       ├── 003_mf_whitelist.md
    │       ├── 004_credit_account.md
    │       └── 005_home_office_rule.md
    ├── prompts/
    │   └── extraction_prompt.md          # カスタムGPTシステムプロンプト
    ├── schemas/
    │   └── receipt.json                  # OpenAI Actions APIスキーマ
    ├── scripts/gas/
    │   └── Code.gs                       # Google Apps Scriptコード（clasp使用時はCode.jsで同期）
    ├── workers/
    │   └── receipt-agent-proxy.js        # Cloudflare Workerコード
    └── test/
        └── sample.json                   # テストデータ

---

## 開発ロードマップ

| フェーズ | 内容 | ステータス |
|:--|:--|:--|
| Phase 1 | 仕様設計 | 完了 |
| Phase 2 | GAS基本実装・カスタムGPT連携 | 完了（2026-03-20） |
| Phase 3 | 銀行照合実装（reconcile） | 未着手 |
| Phase 4 | AIレビュー・全体レビュー実装 | 未着手 |
| Phase 5 | 定期経費・交通費自動化 | 未着手 |
| Phase 6 | フィードバック学習実装 | 未着手 |

---

## 会計基準

| 項目 | 内容 |
|:--|:--|
| 事業年度 | 8月1日〜7月31日 |
| 計上日基準 | 支払日（payment_date）優先 |
| 家事按分 | 15%ルール（ホワイトリスト管理） |
| 月割り方式 | 前払費用計上→月末自動振替 |
| 外貨換算 | 77銀行仲値レート（取引日基準・URL動的生成） |
| 削除方式 | 論理削除のみ（物理削除禁止） |

---

## 重要な設計決定

| 決定事項 | 結論 | 詳細 |
|:--|:--|:--|
| 削除方式 | 論理削除のみ | docs/decisions/001_logical_delete.md |
| 照合ステータス | 5段階管理 | docs/decisions/002_reconcile_status.md |
| MF照合方式 | ホワイトリスト＋照合済みID | docs/decisions/003_mf_whitelist.md |
| 貸方科目 | 短期借入金→照合後に普通預金 | docs/decisions/004_credit_account.md |
| 家事按分 | 15%ルール・ホワイトリスト管理 | docs/decisions/005_home_office_rule.md |
| GAS接続方式 | Cloudflare Workers中継 | docs/receipt-agent-lessons.md |