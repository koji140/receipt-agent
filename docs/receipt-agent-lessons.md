---
name: receipt-agent-dev
description: 'receipt-agent開発支援。GASデプロイ・clasp・Script Properties・カスタムGPT連携・経費シート設定で迷ったら必ずこのSkillを参照すること。'
---

# Skill: receipt-agent 開発支援

## Claudeへの指示（必ず守ること）

- このプロジェクトはGASとカスタムGPTの二層構造。**OCR・判断はGPT側、永続化・照合はGAS側**。役割を混同しないこと
- コード変更後は必ず `clasp pull` → `git push` の順で同期すること
- `API_TOKEN` `OPENAI_API_KEY` などの機密値は**コードにもSKILL.mdにも絶対に書かない**。Script Propertiesで管理する
- スプレッドシートへの書き込みは `appendRow_` 経由のみ。直接 `setValues` しない
- 削除は**論理削除のみ**（`is_deleted=true`）。物理削除は禁止
- GASのスキーマに `oneOf` は使用禁止。OpenAI Actionsが対応していない。フラット構造にする
- `handleFinalize_` の中で `extractReceipt_` を呼ばないこと（旧スタブ。削除済みのはず）
- カスタムGPTがActionsを呼ばず自己完結する場合は、Instructionsの先頭に「callReceiptAgentアクションを必ず呼ぶこと」を追加させる

## プロジェクト概要

- リポジトリ: https://github.com/koji140/receipt-agent
- フロントエンド: カスタムGPT（OpenAI）
- バックエンド: Google Apps Script（GAS）
- ストレージ: Google Drive / Google Sheets
- ドキュメント: docs/requirements.md（v1.6）、docs/architecture.md（v1.6）

| 担当 | 処理内容 |
|------|---------|
| GPT | OCR・情報抽出・勘定科目判定・為替レート取得・ユーザー対話 |
| GAS | シート登録・Drive保存・銀行照合・ログ・タイムトリガー |

## 開発環境セットアップ

### claspインストール（初回のみ）

```bash
npm install -g @google/clasp
clasp --version
clasp login
Copy
リポジトリクローン
Copy# macOS
cd ~/Documents
git clone https://github.com/koji140/receipt-agent.git
cd receipt-agent

# Windows
cd C:\Users\{username}\github
git clone https://github.com/koji140/receipt-agent.git
cd receipt-agent
GASプロジェクトとのリンク
Copycd scripts/gas
clasp clone {SCRIPT_ID}
clasp pull
Windowsで コード.js などの日本語ファイル名が生成された場合は del または ren でリネーム・削除する。

同期エイリアス（macOS）
Copyalias gas-sync="cd ~/Documents/receipt-agent/scripts/gas && clasp pull && cd ~/Documents/receipt-agent && git add -A && git commit -m 'sync: GASから同期' && git push"
日常の作業フロー
GASエディタで編集 → clasp pull → git add/commit/push（macは gas-sync 一発）

Script Properties（必須キー）
キー	値・取得方法
API_TOKEN	任意の文字列（推測されにくいもの）
OPENAI_API_KEY	https://platform.openai.com/api-keys
SPREADSHEET_ID	スプレッドシートURLの /d/ と /edit の間
DRIVE_FOLDER_ID	DriveフォルダURLの /folders/ 以降
DRIVE_DELETED_FOLDER_ID	deletedフォルダのID
AUDIT_LOG_FOLDER_ID	audit-logsフォルダのID
CREDIT_CORPORATE	短期借入金
CREDIT_PERSONAL	短期借入金
CREDIT_GMO	普通預金（GMOあおぞら）
CREDIT_HIGASHI	普通預金（東山口）
CREDIT_YUCHO	普通預金（ゆうちょ）
MAIN_MODEL	gpt-4o
FX_RATE_MODEL	gpt-4o
FARE_MODEL	gpt-4o
HOME_OFFICE_ACCOUNTS	地代家賃,水道光熱費,通信費
HOME_OFFICE_RATE	0.15
HOME_OFFICE_WHITELIST	対象ベンダー名をカンマ区切り（後から追加可）
ANOMALY_THRESHOLD_RATE	3.0
ANOMALY_MIN_AMOUNT	10000
LEARNING_RULE_EXPIRE_MONTHS	12
LEARNING_RULE_MAX	50
MF_WHITELIST_SHEET	MFホワイトリスト
BOOKING_DATE_BASIS	payment_date
一括設定関数
Copyfunction setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    'MAIN_MODEL':                  'gpt-4o',
    'FX_RATE_MODEL':               'gpt-4o',
    'FARE_MODEL':                  'gpt-4o',
    'HOME_OFFICE_ACCOUNTS':        '地代家賃,水道光熱費,通信費',
    'HOME_OFFICE_RATE':            '0.15',
    'ANOMALY_THRESHOLD_RATE':      '3.0',
    'ANOMALY_MIN_AMOUNT':          '10000',
    'LEARNING_RULE_EXPIRE_MONTHS': '12',
    'LEARNING_RULE_MAX':           '50',
    'MF_WHITELIST_SHEET':          'MFホワイトリスト',
    'BOOKING_DATE_BASIS':          'payment_date',
    'CREDIT_CORPORATE':            '短期借入金',
    'CREDIT_PERSONAL':             '短期借入金',
    'CREDIT_GMO':                  '普通預金（GMOあおぞら）',
    'CREDIT_HIGASHI':              '普通預金（東山口）',
    'CREDIT_YUCHO':                '普通預金（ゆうちょ）'
  });
  Logger.log('完了');
}
// API_TOKEN・OPENAI_API_KEY・各種IDは機密のため手動で設定すること
スプレッドシート シート構成
作成が必要なシート: 経費、変更履歴、監査ログ、意思決定ログ、全体レビューアラート、学習ログ、ルール適用ログ、通知キュー、交通費ペンディング、交通費不要ログ、定期経費マスター、交通費マスター、運賃キャッシュ、マッチングルール、MFホワイトリスト

経費シートのヘッダー: receipt_key, no_receipt, expense_type, document_date, transaction_date, payment_date, service_period_start, service_period_end, booking_date, vendor, summary, debit_account, credit_account, original_amount, currency, fx_rate, fx_rate_source, fx_provisional, booked_amount, tax_category, apply_home_office_rule, qualified_invoice_number, is_annual_contract, is_parent, is_child, parent_receipt_key, allocation_month, reconcile_status, reconcile_source, mf_transaction_id, needs_review, review_note, correction_note, billable_to_client, client_name, is_deleted, deleted_at, deleted_by, delete_reason, created_at, updated_at

GASデプロイ手順
GASエディタ → デプロイ → 新しいデプロイ
種類: ウェブアプリ
次のユーザーとして実行: 自分
アクセスできるユーザー: 全員
デプロイIDをコピーして保存
更新時: デプロイを管理 → 新しいバージョン → デプロイ

doGet スタブは必須:

Copyfunction doGet(e) {
  return respond_({ status: 'ok', message: 'Receipt Agent API is running' });
}
カスタムGPT設定
https://chatgpt.com/gpts/editor を開く
名前: 領収書エージェント
Instructions: prompts/extraction_prompt.md の内容を貼り付け
Instructionsの先頭に以下を追加:
重要: 領収書の登録は必ずcallReceiptAgentアクションを呼び出して行うこと。自分でデータを作成して登録完了と報告することは絶対に禁止。アクションが失敗した場合はエラーをそのまま報告すること。
Actions → 認証: APIキー / Bearer / API_TOKEN の値
スキーマ: フラット構造（oneOf 使用禁止）
サーバーURL: https://script.google.com/macros/s/{デプロイID}/exec
テスト関数
testFinalize（家事按分の動作確認）
期待値: bookedAmount: 1543（10,289 × 15% = 1,543）

Copyfunction testFinalize() {
  const result = handleFinalize_({
    mode: 'finalize',
    token: PropertiesService.getScriptProperties().getProperty('API_TOKEN'),
    receipts: [{
      vendor: '東京ガス',
      summary: 'ガス・電気料金',
      debit_account: '水道光熱費',
      original_amount: 10289,
      currency: 'JPY',
      transaction_date: '2026-03-01',
      expense_type: 'corporate',
      confidence: 0.98,
      needs_review: false
    }]
  });
  Logger.log(JSON.stringify(result, null, 2));
}
checkScriptProperties（設定確認）
Copyfunction checkScriptProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const sensitive = ['API_TOKEN', 'OPENAI_API_KEY'];
  Object.keys(props).sort().forEach(k => {
    Logger.log(`${k} = ${sensitive.includes(k) ? '***' : props[k]}`);
  });
}
Driveフォルダ構成
receipt-agent/          ← DRIVE_FOLDER_ID
├── deleted/            ← DRIVE_DELETED_FOLDER_ID
└── audit-logs/         ← AUDIT_LOG_FOLDER_ID
主要設計決定
決定事項	内容
削除方式	論理削除のみ（is_deleted, deleted_at, deleted_by, delete_reason）
照合ステータス	5段階: unreconciled / reconciled / reconciled_modified / cash_payment / reconcile_pending
貸方科目	照合前: 短期借入金 → 照合後: 口座別の普通預金
MF照合方式	ホワイトリスト + 照合済みID（二重照合防止）
家事按分	HOME_OFFICE_ACCOUNTS × HOME_OFFICE_WHITELIST のベンダーに15%適用
為替レート	77銀行URL動的生成（失敗時は needs_review: true）
stageハンドラ	サブフロー限定（将来用）。現時点では主処理に使わない
未解決・継続課題
項目	状況	Claudeへの注意
カスタムGPTからのAPI呼び出し	GAS内部エラーで調査中	エラー再現時はGASのログを必ず確認。doGetの有無・デプロイ設定・oneOf使用を最初にチェック
reconcileハンドラのテスト	未実施	testReconcileを作成してGASから直接実行すること
global_reviewのテスト	未実施	runGlobalReview_('full')をGASから直接呼び出してテスト
MFホワイトリストシートの設定	未実施	MFホワイトリストシートにベンダー名・口座名を登録してから照合テストを行うこと
タイムトリガー設定	未実施	setupTriggers関数をGASから一度だけ実行する
HOME_OFFICE_WHITELISTのベンダー登録	未実施	実際の家賃・光熱費・通信費のベンダー名を確認してから設定
多通貨での実運用テスト	未実施	USD・EUR等で testFinalize を実行し fx_rate が正しく取得されるか確認

## OpenAI カスタムGPT × GAS 接続バグ取り（2026-03-20）

### 問題の全体像

カスタムGPTのActionsからGASのWeb AppにPOSTしても、GASに届かずHTMLエラーページが返り続けた。

### 原因1: GASのdoPostがプラットフォームレベルで動かない

- 症状: POSTすると500エラーのHTMLが返る。doPostは実行数に一切出てこない
- 原因: GoogleのインフラがPOSTリクエストをGASランタイムに到達させる前に弾く既知のバグ（2025年11月報告、2026年3月現在も未解決）
- 参考: https://discuss.google.dev/t/apps-script-web-app-post-requests-fail-with-500-docs-error-and-dopost-never-runs/292239
- 対処: doGetでpayloadをクエリパラメータとして受け取る方式に変更

### 原因2: OpenAIからGASへの直接アクセスが401で弾かれる

- 症状: GETに切り替えても401エラー。ブラウザから同じURLにアクセスすると正常に動く
- 原因: GoogleがOpenAIのIPアドレス（Microsoftのクラウド）からのリクエストを弾いている
- 対処: Cloudflare Workersを中継サーバーとして挟む構成に変更

### 原因3: タイムアウト

- 症状: Cloudflare Worker経由でGASに届くようになったが、GPTがエラーと報告。GASの実行数には「完了」と出る
- 原因: GASの処理が4秒程度かかり、OpenAIの約3〜4秒タイムアウトに引っかかる
- 対処: Cloudflare WorkerをFire-and-forget方式に変更。GASへのリクエストをバックグラウンド（ctx.waitUntil）で送り、即座に200を返す

### 原因4: authenticate_がGET対応していなかった

- 症状: 401エラー（GAS側）
- 原因: authenticate_がe.postDataからtokenを読む実装になっており、GETではtokenが取れず認証失敗
- 対処: e.parameter.payloadからもtokenを読むよう修正

### 最終的な構成

Copy
カスタムGPT ↓ POST（JSON） Cloudflare Workers（即200を返す・GASへはバックグラウンド送信） ↓ GET（?payload=URLエンコードJSON） Google Apps Script（doGetで受け取り処理） ↓ スプレッドシート


### 教訓

- GASのWeb AppにPOSTで外部から直接叩くのは2026年現在動作しない。中継が必須
- OpenAIのIPはMicrosoftのクラウド（20.210.x.x）。GoogleがブロックするためCloudflare等の中継が必要
- タイムアウト対策としてFire-and-forgetパターンが有効。ただしエラー時にGPTにフィードバックできない点は注意
- デプロイIDは新バージョンを作っても変わらない。バージョン番号だけ上がる

---

## 💡 開発メモ（試行錯誤の感覚）

- **GitHubのWeb UIで長いMarkdownを貼るのは避ける**。Claudeの画面でMDが崩れて見えても、実際のファイルは正しい（表示の問題）
- **VSCodeで編集するのが一番楽**。`code .`でリポジトリを開いてCtrl+Sで保存、あとはgitコマンド一発
- **GAS直接POSTは2026年時点で動かない**。Cloudflare Workers経由が必須（詳細はreceipt-agent-lessons.md）
- **OpenAIのタイムアウトは3〜4秒**。GASの処理が間に合わないのでWorkerで即200を返してバックグラウンド送信
- **claspはCode.jsで保存するがGAS上はCode.gs**。これは正常、混乱しないこと
- **git pushが弾かれたらgit pullしてから再push**。複数箇所からコミットすると起きる