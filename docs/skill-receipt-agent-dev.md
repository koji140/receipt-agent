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
hash -r  # Macの場合
clasp --version
clasp login
```

#### Apps Script APIを有効化
https://script.google.com/home/usersettings

---

### リポジトリをclone

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

---

### GASプロジェクトと紐付け

GASエディタ → ⚙️ → スクリプトIDをコピー

```bash
cd scripts/gas
clasp clone {スクリプトID}
clasp pull
```

---

### 日本語ファイル名の問題（Windows）

```bash
del "コード.js"
# または
ren コード.js Code.gs
```

---

### gas-syncエイリアス（Mac）

```bash
echo 'alias gas-sync="cd ~/Documents/receipt-agent/scripts/gas && clasp pull && cd ~/Documents/receipt-agent && git add -A && git commit -m \"sync: GASから同期\" && git push"' >> ~/.zshrc
source ~/.zshrc
```

---

### 日常の開発フロー

```
GASで修正
↓
clasp pull
↓
git add / commit / push
```

#### Windows

```bash
cd C:\Users\{username}\github\receipt-agent\scripts\gas
clasp pull
cd C:\Users\{username}\github\receipt-agent
git add -A
git commit -m "sync: GASから同期"
git push origin main
```

---

### コミットメッセージ例

- feat: reconcileハンドラを実装
- fix: handleFinalize_のextractReceipt_を削除
- add: appsscript.jsonを追加
- sync: GASから同期

---

## Script Properties設定

GASエディタ → ⚙️ → スクリプトのプロパティ

### 必須項目

| キー | 内容 |
|---|---|
| API_TOKEN | 任意 |
| OPENAI_API_KEY | https://platform.openai.com/api-keys |
| SPREADSHEET_ID | URLから取得 |
| DRIVE_FOLDER_ID | URLから取得 |

---

### 一括設定関数

```javascript
function setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    MAIN_MODEL: 'gpt-4o',
    FX_RATE_MODEL: 'gpt-4o',
    FARE_MODEL: 'gpt-4o',
    HOME_OFFICE_RATE: '0.15'
  });
}
```

---

### 設定確認

```javascript
function checkScriptProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(k => Logger.log(k));
}
```

---

## スプレッドシートセットアップ

```javascript
function setupAllSheets() {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
  );

  const sheetNames = ['経費','変更履歴','監査ログ'];

  sheetNames.forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
}
```

---

## GASデプロイ

### 新規

- ウェブアプリ
- 実行: 自分
- アクセス: 全員

---

### doGet（必須）

```javascript
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({status: 'ok'}))
    .setMimeType(ContentService.MimeType.JSON);
}
```

---

## カスタムGPT設定

- URL: https://script.google.com/macros/s/{ID}/exec
- 認証: Bearer

---

## Google Drive構成

```
receipt-agent/
├── deleted/
└── audit-logs/
```

---

## 重要な設計決定

| 項目 | 内容 |
|---|---|
| 削除方式 | 論理削除 |
| 家事按分 | 15% |
| GPT/GAS分担 | GPT=解析 / GAS=保存 |

---

## 未解決タスク

| 項目 | 状況 |
|---|---|
| reconcileテスト | 未実施 |
| global_review | 未実施 |
| タイムトリガー | 未設定 |
