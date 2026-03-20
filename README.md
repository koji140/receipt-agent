# receipt-agent

個人事業主・小規模法人向けの領収書自動処理AIエージェントシステム。

カスタムGPTに領収書を送るだけで、OCR抽出・勘定科目判定・Google Sheets登録・銀行照合までを自動で行う。

---

## システム構成

    [ユーザー]
        ↓ 領収書・指示
    [カスタムGPT（フロントエンド）]
        ↓ OpenAI Actions（HTTP POST）
    [Google Apps Script（バックエンド）]
        ↓
    [Google Drive]  [Google Sheets]
        領収書保存      経費データ管理

---

## 主要機能

| 機能 | 概要 | 優先度 |
|:--|:--|:--|
| 領収書アップロード | 最大10件を一括処理、アップロード中は質問なし | P0 |
| OCR自動抽出 | OpenAI Vision で日付・金額・取引先等を抽出 | P0 |
| 勘定科目自動判定 | 信頼度0.8以上で自動確定 | P0 |
| 年額サブスク月割り | 前払費用として計上し月割り自動生成 | P0 |
| 家事按分15%ルール | 対象科目・取引先ホワイトリストで自動適用 | P0 |
| 外貨自動換算 | 77銀行仲値をOpenAI経由で動的取得 | P0 |
| 銀行照合 | GMO・MF・通帳写真と自動照合 | P0 |
| AIレビューモード | 月末にneedsReview案件を一括提示（B+Cハイブリッド） | P1 |
| 全体レビュー | 横断的異常検知（重複・月次異常・為替整合性等） | P1 |
| フィードバック学習 | ユーザー指摘をルールとして自動学習 | P1 |
| 定期経費自動入力 | 家賃等を月末トリガーで自動登録 | P1 |
| 交通費自動計算 | OpenAI経由でIC運賃を取得・有効期間キャッシュ管理 | P1 |

---

## リポジトリ構成

```
receipt-agent/
├── docs/
│   ├── overview.md          # プロジェクト概要
│   ├── requirements.md      # 要件定義書 v1.5
│   ├── architecture.md      # 技術仕様書 v1.5
│   └── decisions/           # 設計意思決定ログ
│       ├── 001_logical_delete.md
│       ├── 002_reconcile_status.md
│       ├── 003_mf_whitelist.md
│       ├── 004_credit_account.md
│       └── 005_home_office_rule.md
├── prompts/
│   └── extraction_prompt.md # カスタムGPTシステムプロンプト
├── schemas/
│   └── receipt.json         # OpenAI Actions APIスキーマ
├── scripts/gas/
│   └── Code.gs              # Google Apps Scriptコード
└── test/
    └── sample.json          # テストデータ
```

---

## ドキュメント

- [プロジェクト概要](docs/overview.md)
- [要件定義書 v1.5](docs/requirements.md)
- [技術仕様書 v1.5](docs/architecture.md)
- [設計意思決定ログ](docs/decisions/)

---

## 対象口座・データソース

| 種別 | 名称 | 照合方法 |
|:--|:--|:--|
| 法人口座 | GMOあおぞらネット銀行 | CSV / PDF |
| 法人口座 | 東山口信用金庫 | 通帳写真 |
| 法人口座 | ゆうちょ銀行 | 通帳写真 |
| 家計簿アプリ | MoneyForward ME | CSV / PDF / 画像 |

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

## 開発ロードマップ

| フェーズ | 内容 | ステータス |
|:--|:--|:--|
| Phase 1 | 仕様設計 | ✅ 完了 |
| Phase 2 | GAS基本実装（stage / finalize） | 🔲 未着手 |
| Phase 3 | 銀行照合実装（reconcile） | 🔲 未着手 |
| Phase 4 | AIレビュー・全体レビュー実装 | 🔲 未着手 |
| Phase 5 | 定期経費・交通費自動化 | 🔲 未着手 |
| Phase 6 | フィードバック学習実装 | 🔲 未着手 |

---

## 重要な設計決定

| 決定事項 | 結論 | 詳細 |
|:--|:--|:--|
| 削除方式 | 論理削除のみ | [001](docs/decisions/001_logical_delete.md) |
| 照合ステータス | 5段階管理 | [002](docs/decisions/002_reconcile_status.md) |
| MF照合方式 | ホワイトリスト＋照合済みID | [003](docs/decisions/003_mf_whitelist.md) |
| 貸方科目 | 短期借入金→照合後に普通預金 | [004](docs/decisions/004_credit_account.md) |
| 家事按分 | 15%ルール・ホワイトリスト管理 | [005](docs/decisions/005_home_office_rule.md) |
