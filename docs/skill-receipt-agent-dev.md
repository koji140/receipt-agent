---
name: receipt-agent-dev
description: 領収書自動処理システム（receipt-agent）の開発・セットアップ・デバッグを支援するスキル。GASのデプロイ、Script Propertiesの設定、カスタムGPTとの接続、スプレッドシートのセットアップ、claspによるGitHub同期など、このプロジェクト固有の作業が発生したときに使うこと。「領収書エージェント」「GASデプロイ」「clasp」「Script Properties」「経費シート」などのキーワードが出たら積極的に使用すること。
---

# 領収書エージェント開発スキル

## プロジェクト概要

個人事業主向けの領収書自動処理AIエージェントシステム。

- **リポジトリ**: https://github.com/koji140/receipt-agent
- **フロントエンド**: カスタムGPT（OpenAI）
- **バックエンド**: Google Apps Script (GAS)
- **ストレージ**: Google Drive / Google Sheets
- **ドキュメント**: docs/requirements.md (v1.6), docs/architecture.md (v1.6)

### 役割分担
| 担当 | 処理内容 |
|---|---|
| GPT | OCR・情報抽出・勘定科目判定・為替レート取得・ユーザー対話 |
| GAS | シート登録・Drive保存・銀行照合・ログ・タイムトリガー |

---

## 開発環境セットアップ

### claspインストール（初回のみ）

```bash
npm install -g @google/clasp
hash -r  # Macの場合。コマンドキャッシュリセット
clasp --version  # 2.4.2等が表示されればOK
clasp login  # ブラウザでGoogleアカウント認証
```

Windowsでパスが通らない場合:

```bash
# Apps Script APIを有効化してから実行
# https://script.google.com/home/usersettings
```

リポジトリをclone

```bash
# Mac
cd ~/Documents
git clone https://github.com/koji140/receipt-agent.git
cd receipt-agent

# Windows
cd C:\Users\{username}\github
git clone https://github.com/koji140/receipt-agent.git
cd receipt-agent
```

GASプロジェクトと紐付け
GASエディタ → ⚙️ プロジェクトの設定 → スクリプトIDをコピー

```bash
cd scripts/gas
clasp clone {スクリプトID}
clasp pull
```

日本語ファイル名の問題（Windowsで発生しやすい）:

```bash
del "コード.js"   # Code.gsが既存の場合
# または
ren コード.js Code.gs
```

gas-syncエイリアス（Mac）

```bash
echo 'alias gas-sync="cd ~/Documents/receipt-agent/scripts/gas && clasp pull && cd ~/Documents/receipt-agent && git add -A && git commit -m \"sync: GASから同期\" && git push"' >> ~/.zshrc
source ~/.zshrc
```

日常の開発フロー
GASエディタでコード修正・テスト
    ↓
clasp pull（GAS → ローカル）
    ↓
git add / commit / push（ローカル → GitHub）
Mac: gas-sync 一発でOK

Windows:

```bash
cd C:\Users\{username}\github\receipt-agent\scripts\gas
clasp pull
cd C:\Users\{username}\github\receipt-agent
git add -A
git commit -m "sync: GASから同期"
git push origin main
```

コミットメッセージ例
feat: reconcileハンドラを実装
fix: handleFinalize_のextractReceipt_を削除
add: appsscript.jsonを追加
sync: GASから同期

Script Properties設定
GASエディタ → ⚙️ プロジェクトの設定 → スクリプトのプロパティ

必須項目
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

一括設定関数（GASエディタで実行）

```javascript
function setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    'MAIN_MODEL':                  'gpt-4o',
    'FX_RATE_MODEL':               'gpt-4o',
    'FARE_MODEL':                  'gpt-4o',
    'HOME_OFFICE_ACCOUNTS':        '地代家賃,水道光熱費,通信費',
    'HOME_OFFICE_WHITELIST':       '東京ガス,東京都水道局,ソフトバンク,NTTファイナンス,事務所家賃',
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
```

API_TOKEN・OPENAI_API_KEY・各種IDは機密情報のため手動で設定すること。

設定確認関数

```javascript
function checkScriptProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const sensitive = ['API_TOKEN', 'OPENAI_API_KEY'];
  Object.keys(props).forEach(k => {
    Logger.log(`${k} = ${sensitive.includes(k) ? '***' : props[k]}`);
  });
}
```

スプレッドシートのセットアップ

シート一括作成（GASエディタで実行）

```javascript
function setupAllSheets() {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  const sheetNames = [
    '経費', '変更履歴', '監査ログ', '意思決定ログ',
    '全体レビューアラート', '学習ログ', 'ルール適用ログ',
    '通知キュー', '交通費ペンディング', '交通費不要ログ',
    '定期経費マスター', '交通費マスター', '運賃キャッシュ',
    'マッチングルール', 'MFホワイトリスト'
  ];
  sheetNames.forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  const expenseSheet = ss.getSheetByName('経費');
  if (expenseSheet.getLastRow() === 0) {
    const headers = [
      'receipt_key','no_receipt','expense_type','document_date',
      'transaction_date','payment_date','service_period_start',
      'service_period_end','booking_date','vendor','summary',
      'debit_account','credit_account','original_amount','currency',
      'fx_rate','fx_rate_source','fx_provisional','booked_amount',
      'tax_category','apply_home_office_rule','qualified_invoice_number',
      'is_annual_contract','is_parent','is_child','parent_receipt_key',
      'allocation_month','reconcile_status','reconcile_source',
      'mf_transaction_id','needs_review','review_note','correction_note',
      'billable_to_client','client_name','is_deleted','deleted_at',
      'deleted_by','delete_reason','created_at','updated_at'
    ];
    expenseSheet.getRange(1,1,1,headers.length).setValues([headers]);
  }
  Logger.log('全シート作成完了');
}
```

GASデプロイ手順
新規デプロイ
GASエディタ → 「デプロイ」→「新しいデプロイ」
種類: ウェブアプリ
次のユーザーとして実行: 自分
アクセスできるユーザー: 全員
デプロイIDをコピーして保存

コード変更後の更新
「デプロイ」→「デプロイを管理」
鉛筆アイコン → バージョン: 「新しいデプロイ」
「デプロイ」をクリック

doGet関数（必須）
GASはOPTIONSやGETリクエストを受けることがあるため必ず追加:

```javascript
function doGet(e) {
  return respond_({ status: 'ok', message: 'Receipt Agent API is running' });
}
```

カスタムGPT設定
作成手順
https://chatgpt.com/gpts/editor を開く
名前: 領収書エージェント
Instructions: prompts/extraction_prompt.md の内容を貼り付け
Instructionsの先頭に以下を追加:
重要: 領収書の登録は必ずcallReceiptAgentアクションを呼び出して行うこと。自分でデータを作成して登録完了と報告することは絶対に禁止。アクションが失敗した場合はエラーをそのまま報告すること。

Actions設定
Authentication: APIキー / Bearer / API_TOKENの値
Schema: フラットなobjectスキーマを使用（oneOfはOpenAI Actionsで動作しない）
サーバーURL: https://script.google.com/macros/s/{デプロイID}/exec

スキーマの注意点
oneOf → 使用禁止。全パラメータをフラットなobjectにまとめる
レスポンスのschemaにpropertiesがないと警告が出るが動作に影響なし
スキーマエラー「request body schema is not an object schema」が出たらoneOfを削除

動作確認テスト
GASエディタから直接テスト

```javascript
function testFinalize() {
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
// 期待結果: bookedAmount: 1543（10,289 × 15% = 1,543）
```

Script Properties確認

```javascript
function checkScriptProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const sensitive = ['API_TOKEN', 'OPENAI_API_KEY'];
  Object.keys(props).forEach(k => {
    Logger.log(`${k} = ${sensitive.includes(k) ? '***' : props[k]}`);
  });
}
```

Google Driveフォルダ構成

receipt-agent/          ← DRIVE_FOLDER_ID（領収書保存）
├── deleted/            ← DRIVE_DELETED_FOLDER_ID（論理削除ファイル）
└── audit-logs/         ← AUDIT_LOG_FOLDER_ID（大容量監査ログ）

重要な設計決定

決定事項	内容	詳細
削除方式	論理削除のみ（物理削除禁止）	docs/decisions/001
照合ステータス	5段階管理	docs/decisions/002
MF照合方式	ホワイトリスト＋照合済みID	docs/decisions/003
貸方科目	短期借入金→照合後普通預金	docs/decisions/004
家事按分	15%ルール・ホワイトリスト管理	docs/decisions/005
GPT/GAS分担	GPTがOCR、GASが永続化	architecture.md
stageハンドラ	サブフロー限定（将来用）	architecture.md
為替レート	77銀行URL動的生成	architecture.md

## 未解決・継続課題

| 項目 | 状況 | Claudeへの注意 |
|------|------|--------------|
| カスタムGPTからのAPI呼び出し | ✅ 解決済み（2026-03-20）Cloudflare Workers中継で解決 | 詳細はdocs/receipt-agent-lessons.mdを参照 |
| reconcileハンドラのテスト | 未実施 | testReconcileを作成してGASから直接実行すること |
| global_reviewのテスト | 未実施 | runGlobalReview_('full')をGASから直接呼び出してテスト |
| MFホワイトリストシートの設定 | 未実施 | MFホワイトリストシートにベンダー名・口座名を登録してから照合テストを行うこと |
| タイムトリガー設定 | 未実施 | setupTriggers関数をGASから一度だけ実行する |
| HOME_OFFICE_WHITELISTのベンダー登録 | 未実施 | 実際の家賃・光熱費・通信費のベンダー名を確認してから設定 |
| 多通貨での実運用テスト | 未実施 | USD・EUR等でtestFinalizeを実行しfx_rateが正しく取得されるか確認 |
| 毎回出る確認ダイアログ | 調査中 | OpenAIの仕様。プライバシーポリシーURL設定で改善する可能性あり |

## Claudeの表示とファイルの実態について

- ClaudeはMarkdownをレンダリングして表示するため、コードブロック内の---や```が崩れて見える
- これはClaudeの表示の問題であり、GitHubに保存されたファイル自体は正しい
- ファイルの実態を確認するときは必ずRaw URLで確認すること
  https://raw.githubusercontent.com/koji140/receipt-agent/main/docs/skill-receipt-agent-dev.md

## Gitの注意事項

- git pushが「rejected」になったら必ずgit pull origin mainを先に実行してからpushする
- これは複数の場所からコミットしたときに毎回起きる。焦らずpull→pushの順で解決する
- clasp pullでConflictが出たらclasp pull --forceで解決する
- clasp pullはCode.jsで取得される。GitHubにはCode.gsとして管理するのが正式だが、claspの仕様でCode.jsになる点に注意