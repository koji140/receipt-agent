# 領収書自動処理システム 技術仕様書

## ドキュメント管理

| 項目 | 内容 |
|:--|:--|
| ドキュメント名 | 領収書自動処理システム 技術仕様書 |
| バージョン | v1.5 |
| 作成日 | 2026-03-20 |
| 作成者 | 石丸浩司 |
| ステータス | 確定 |

## 改訂履歴

| バージョン | 日付 | 主な変更内容 |
|:--|:--|:--|
| v1.0 | 2026-03-01 | 初版作成 |
| v1.1 | 2026-03-05 | needsReview判定表・ファイル命名仕様 |
| v1.2 | 2026-03-10 | 銀行照合・日付3種分離 |
| v1.3 | 2026-03-19 | 為替レート・貸方科目・15%ホワイトリスト |
| v1.4 | 2026-03-19 | 月割りP0・領収書なし・AIレビュー |
| v1.5 | 2026-03-20 | 論理削除・照合5段階・MFホワイトリスト・学習ルール・URL動的生成・シート書き込み一元化・考慮漏れ全件対応 |

---

## システム構成

    [カスタムGPT]
        ↓ HTTP POST (JSON)
    [GAS Web アプリ (doPost)]
        ↓
    [各ハンドラ]
        ├── stage        : Drive一時保存
        ├── finalize     : 抽出・正規化・登録
        ├── reconcile    : 銀行照合
        ├── no_receipt   : 領収書なし登録
        ├── review       : AIレビュー
        └── global_review: 横断的異常検知
        ↓
    [Google Drive] [Google Sheets]

---

## 共通仕様

全エンドポイントはHTTP POSTでJSON形式のリクエストを受け付ける。認証はBearerトークン方式とし、全リクエストに `Authorization: Bearer {API_TOKEN}` ヘッダーを必須とする。レスポンスは全てJSON形式とする。

```javascript
// 認証チェック（全ハンドラ共通）
function authenticate_(e) {
  const token = e.parameter.token
    || (e.postData && JSON.parse(e.postData.contents).token);
  if (token !== PropertiesService
      .getScriptProperties().getProperty('API_TOKEN')) {
    throw { code: 'UNAUTHORIZED', status: 401 };
  }
}
```

---

## エラーコード一覧

| コード | HTTPステータス | 説明 |
|:--|:--|:--|
| `UNAUTHORIZED` | 401 | 認証失敗 |
| `REQUEST_INVALID` | 400 | リクエスト形式不正 |
| `STAGE_DOWNLOAD_FAILED` | 500 | Drive保存失敗 |
| `DRIVE_SAVE_FAILED` | 500 | ファイル保存失敗 |
| `EXTRACT_FAILED` | 500 | OCR抽出失敗 |
| `REASON_FAILED` | 500 | AI再判断失敗 |
| `FX_RATE_FAILED` | 500 | 為替レート取得失敗 |
| `FARE_FETCH_FAILED` | 500 | 運賃取得失敗 |
| `SHEET_APPEND_FAILED` | 500 | シート書き込み失敗 |
| `LOCK_TIMEOUT` | 500 | LockService待機タイムアウト |
| `RECONCILE_FAILED` | 500 | 銀行照合失敗 |
| `ALREADY_FINALIZED` | 409 | 同一receiptKeyの重複finalize |

---

## ① stage ハンドラ

OpenAIのfileIdまたは署名付きURLを受け取り、Google Driveに一時保存してreceiptKeyを返す。一時ファイル名は `tmp_{timestamp}_{rand6}.{ext}` とする。

```javascript
// リクエスト
{
  "mode": "stage",
  "token": "...",
  "files": [
    { "fileId": "openai_file_id_xxx" },
    { "url": "https://..." }
  ]
}

// レスポンス（成功）
{
  "status": "ok",
  "results": [
    { "receiptKey": "drive_file_id_xxx", "originalName": "receipt.pdf" }
  ]
}

// レスポンス（一部失敗）
{
  "status": "partial_ok",
  "results": [
    { "receiptKey": "drive_file_id_xxx", "originalName": "receipt.pdf" },
    { "error": "STAGE_DOWNLOAD_FAILED", "originalName": "receipt2.pdf" }
  ]
}
```

---

## ② finalize ハンドラ

receiptKeyを受け取り、抽出・正規化・月割り処理・シート登録・ファイルリネームを行う。同一receiptKeyへの2回目の呼び出しは `ALREADY_FINALIZED` を返す。`refinalize: true` を付与した場合のみ再処理を許可する。

```javascript
// リクエスト
{
  "mode": "finalize",
  "token": "...",
  "receipts": [
    {
      "receiptKey": "drive_file_id_xxx",
      "expenseType": "corporate",
      "memo": "〇〇社との打ち合わせ、参加者3名",
      "refinalize": false
    }
  ]
}
```

処理フローは以下の順で実行する。

    ① 重複チェック（ALREADY_FINALIZED制御）
    ② OpenAI Visionで抽出（extractReceipt_）
    ③ 正規化（normalizeReceipt_）
    ④ AI再判断が必要な場合（reasonReceipt_）
    ⑤ 月割り処理（allocatePrepaid_）
    ⑥ エントリ生成（buildEntry_）
    ⑦ ファイルリネーム（renameFile_）
    ⑧ シート追記（appendRow_）※LockService使用
    ⑨ 監査ログ記録（auditLog_）
    ⑩ 軽量グローバルチェック（重複検知のみ）

---

## 抽出スキーマ（extractReceipt_ の返却値）

```javascript
{
  document_date: "2026-02-28",
  transaction_date: "2025-12-01",
  service_period_start: "2025-12-01",
  service_period_end: "2025-12-31",
  vendor: "ソフトバンク株式会社",
  summary: "光回線利用料",
  debit_account: "通信費",
  original_amount: 4180,
  currency: "JPY",
  tax_category: "10%",
  qualified_invoice_number: "T9010401052465",
  confidence: 0.95,
  needs_review: false,
  review_note: "",
  has_japanese_yen_amount: true
}
```

`has_japanese_yen_amount` は合計金額に円金額が含まれる場合のみ `true` とする。税額のみの円表記は `false` とする。

---

## 正規化処理（normalizeReceipt_）

正規化は全て純粋関数として実装し、副作用を持たない。

### 適格請求書番号の正規化

```javascript
function normalizeInvoiceNumber_(raw) {
  if (!raw) return { value: null, needsReview: true };
  const normalized = raw
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/-/g, '')
    .toUpperCase();
  const valid = /^T[0-9]{13}$/.test(normalized);
  return {
    value: normalized,
    needsReview: !valid,
    reviewNote: valid ? '' : '適格番号フォーマット不正'
  };
}
```

### 為替レートURL動的生成

```javascript
function buildFxRateUrl_(currency, date) {
  const year = new Date(date).getFullYear();
  const code = currency.toLowerCase();
  return `https://www.77bank.co.jp/kawase/${code}${year}.html`;
}
```

77銀行がページを提供していない通貨の場合はURLアクセスに失敗するため、`needsReview=true` でフォールバックする。

### 為替レート取得（OpenAI経由）

```javascript
function extractFxRate_(date, currency) {
  const url = buildFxRateUrl_(currency, date);
  const prompt = `
    以下のURLから${date}の${currency}/JPY仲値レートを取得してください。
    URL: ${url}
    休日の場合は直前の営業日のレートを使用してください。
    必ずJSON形式で返してください:
    {"date":"YYYY-MM-DD","currency":"USD","rate":158.28,
     "source":"77bank_TTM","is_business_day":true}
    取得できない場合: {"error":"RATE_NOT_FOUND"}
  `;
  const result = callOpenAI_(prompt,
    PropertiesService.getScriptProperties()
      .getProperty('FX_RATE_MODEL'));
  if (result.error) {
    return { rate: null, needsReview: true,
             reviewNote: 'FXレート取得失敗。手動入力してください' };
  }
  return { rate: result.rate, needsReview: false,
           fxRateSource: '77bank_TTM' };
}
```

### 家事按分15%ルール

```javascript
function applyHomeOfficeRule_(entry) {
  const targets = PropertiesService.getScriptProperties()
    .getProperty('HOME_OFFICE_ACCOUNTS').split(',');
  const whitelist = PropertiesService.getScriptProperties()
    .getProperty('HOME_OFFICE_WHITELIST').split(',');
  const accountMatch = targets.includes(entry.debit_account);
  const vendorMatch = whitelist.some(w =>
    entry.vendor.includes(w.trim()));
  if (accountMatch && vendorMatch) {
    return {
      apply: true,
      booked_amount: Math.round(entry.original_amount * 0.15),
      correction_note: `家事按分15%適用。元金額¥${entry.original_amount}`
    };
  }
  return { apply: false, booked_amount: entry.original_amount };
}
```

### 貸方科目決定

```javascript
function determineCreditAccount_(expenseType) {
  const props = PropertiesService.getScriptProperties();
  if (expenseType === 'personal') {
    return props.getProperty('CREDIT_PERSONAL');
  }
  return props.getProperty('CREDIT_CORPORATE');
}
```

銀行照合後に法人口座が確認された場合のみ普通預金に更新する。

### 計上日決定

```javascript
function resolveBookingDate_(entry) {
  return entry.payment_date
    || entry.transaction_date
    || entry.document_date;
}
```

---

## 月割り処理（allocatePrepaid_）

```javascript
function allocatePrepaid_(entry) {
  if (!entry.is_annual_contract) return [entry];
  const months = calcContractMonths_(
    entry.service_period_start,
    entry.service_period_end
  );
  const monthlyAmount = Math.round(entry.original_amount / months);
  const lastMonthAmount = entry.original_amount
    - (monthlyAmount * (months - 1));
  const rows = [];
  rows.push({ ...entry,
    debit_account: '前払費用',
    booked_amount: entry.original_amount,
    is_parent: true
  });
  for (let i = 0; i < months; i++) {
    rows.push({
      parent_receipt_key: entry.receipt_key,
      debit_account: entry.debit_account,
      booked_amount: i === months - 1
        ? lastMonthAmount : monthlyAmount,
      is_child: true,
      allocation_month: addMonths_(
        entry.service_period_start, i)
    });
  }
  return rows;
}
```

解約時は残額を一括費用計上する。月割り子行の論理削除は計上済み行（`payment_date` 確定済み）は残し、未来月行のみ削除することをAIが確認してから実行する。

---

## 論理削除処理（deleteEntry_）

```javascript
function deleteEntry_(receiptKey, reason, deletedBy) {
  const sheet = getSheet_('経費');
  const row = findRowByReceiptKey_(sheet, receiptKey);
  const childRows = findChildRows_(sheet, receiptKey);
  const futureRows = childRows.filter(r => !r.payment_date);
  const pastRows = childRows.filter(r => r.payment_date);
  if (childRows.length > 0) {
    return {
      status: 'confirmation_required',
      message: buildDeleteConfirmMessage_(
        pastRows, futureRows, receiptKey)
    };
  }
  updateRow_(sheet, row, 'isDeleted', true,
    receiptKey, 'logical_delete');
  updateRow_(sheet, row, 'deletedAt',
    new Date().toISOString(), receiptKey, 'logical_delete');
  updateRow_(sheet, row, 'deletedBy',
    deletedBy, receiptKey, 'logical_delete');
  updateRow_(sheet, row, 'deleteReason',
    reason, receiptKey, 'logical_delete');
  moveToDeletdFolder_(receiptKey);
}
```

---

## シート書き込み一元化

全てのシート書き込みは以下の専用関数を経由する。`sheet.getRange().setValue()` の直接呼び出しを禁止する。

```javascript
// ✅ 正しい書き方
function appendRow_(sheet, rowData, receiptKey, changeType) {
  sheet.appendRow(rowData);
  logChange_(receiptKey, 'append', null, rowData, changeType);
}

function updateRow_(sheet, rowIndex, colName,
                    newValue, receiptKey, changeType) {
  const col = getColIndex_(sheet, colName);
  const oldValue = sheet.getRange(rowIndex, col).getValue();
  sheet.getRange(rowIndex, col).setValue(newValue);
  logChange_(receiptKey, 'update', oldValue, newValue, changeType);
}

// ❌ 禁止: sheet.getRange(row, col).setValue(value)
```

---

## ③ reconcile ハンドラ

```javascript
// リクエスト
{
  "mode": "reconcile",
  "token": "...",
  "source": "gmo_aozora",
  "data": [
    {
      "date": "2026-02-28",
      "amount": -4180,
      "vendor": "ソフトバンク",
      "mfTransactionId": "IGKOD0dSmEkddYVUNGucftphjE7..."
    }
  ]
}
```

### 照合ロジック

```javascript
function matchTransaction_(bankTx, expenseRows) {
  if (!isWhitelisted_(bankTx)) return null;
  const candidates = expenseRows.filter(row =>
    !row.isDeleted &&
    row.reconcile_status !== 'cash_payment' &&
    Math.abs(row.original_amount) === Math.abs(bankTx.amount) &&
    vendorMatch_(row.vendor, bankTx.vendor) &&
    dateDiff_(row.transaction_date, bankTx.date) <= 1
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return { status: 'multiple_candidates', candidates };
  }
  recordUnmatchedAlert_(bankTx);
  return null;
}
```

### 照合成功時の更新

```javascript
function applyReconcile_(row, bankTx, source) {
  const creditAccount = resolveCreditAccount_(source);
  updateRow_(sheet, row.index, 'payment_date',
    bankTx.date, row.receipt_key, 'reconcile');
  updateRow_(sheet, row.index, 'credit_account',
    creditAccount, row.receipt_key, 'reconcile');
  updateRow_(sheet, row.index, 'reconcile_status',
    'reconciled', row.receipt_key, 'reconcile');
  updateRow_(sheet, row.index, 'reconcile_source',
    source, row.receipt_key, 'reconcile');
  updateRow_(sheet, row.index, 'mf_transaction_id',
    bankTx.mfTransactionId, row.receipt_key, 'reconcile');
}
```

### reconcileStatus管理

| ステータス | 遷移条件 | 貸方科目 |
|:--|:--|:--|
| `unreconciled` | 登録時デフォルト | 短期借入金 |
| `reconciled` | 照合成功 | 普通預金（照合口座）or 短期借入金 |
| `reconciled_modified` | 照合後に手動修正 | 同上 |
| `cash_payment` | ユーザーが現金払いと確定 | 短期借入金 |
| `reconcile_pending` | 通帳待ち等 | 短期借入金 |

`unreconciled` が30日以上経過した行は月末レビュー時にAIが「現金払いでしたか？」と確認する。

---

## ④ global_review ハンドラ

```javascript
function runGlobalReview_(mode) {
  const alerts = [];
  alerts.push(...checkDuplicateEntries_());
  if (mode === 'full') {
    alerts.push(...checkMonthlyAnomaly_());
    alerts.push(...checkFxRateConsistency_());
    alerts.push(...checkHomeOfficeConsistency_());
    alerts.push(...checkPrepaidBalance_());
    alerts.push(...checkUnreconciledOld_());
  }
  if (mode === 'full') {
    alerts.push(...runAiObservation_());
  }
  const filtered = applyLearnedRules_(alerts);
  filtered.forEach(a => appendRow_(
    getSheet_('全体レビューアラート'), a,
    null, 'global_review'));
  return filtered;
}
```

### 月次異常検知の閾値

```javascript
function checkMonthlyAnomaly_() {
  const threshold = parseFloat(
    PropertiesService.getScriptProperties()
      .getProperty('ANOMALY_THRESHOLD_RATE'));
  const minAmount = parseInt(
    PropertiesService.getScriptProperties()
      .getProperty('ANOMALY_MIN_AMOUNT'));
  // 科目別に前月比を計算し閾値超過を検知
}
```

---

## ⑤ フィードバック学習システム

```javascript
function recordLearning_(alertType, pattern,
                          feedback, learnedRule) {
  appendRow_(getSheet_('学習ログ'), {
    timestamp: new Date().toISOString(),
    alert_type: alertType,
    pattern: JSON.stringify(pattern),
    user_feedback: feedback,
    learned_rule: learnedRule,
    applied_from: new Date().toISOString(),
    status: 'active',
    applied_count: 0,
    last_applied_at: null
  }, null, 'learning');
}

function applyLearnedRules_(alerts) {
  const rules = getActiveRules_();
  return alerts.filter(alert => {
    const matchedRule = rules.find(r =>
      matchesRule_(alert, r));
    if (matchedRule) {
      appendRow_(getSheet_('ルール適用ログ'), {
        timestamp: new Date().toISOString(),
        rule_id: matchedRule.id,
        alert_type: alert.type,
        action: 'skipped',
        related_receipt_keys: alert.receiptKeys
      }, null, 'rule_apply');
      return false;
    }
    return true;
  });
}
```

ルール優先順位はユーザー承認済みルール＞AI自動学習ルール＞Script Properties閾値＞AIデフォルト判断とする。競合時はより具体的なルールを優先する。`LEARNING_RULE_EXPIRE_MONTHS = 12` ヶ月未使用で自動失効し、`LEARNING_RULE_MAX = 50` 件を上限とする。

---

## ⑥ 運賃キャッシュ管理

```javascript
function getFare_(routeId, date) {
  const cache = getSheet_('運賃キャッシュ');
  const records = getCacheRecords_(cache, routeId);
  if (records.length < 2) {
    return fetchFareFromAI_(routeId, date);
  }
  const latest = records[0];
  const prev = records[1];
  if (latest.fare === prev.fare) {
    return { fare: latest.fare, source: 'cache' };
  }
  const txDate = new Date(date);
  const latestStart = new Date(latest.valid_from);
  if (txDate >= latestStart) {
    return { fare: latest.fare, source: 'cache' };
  }
  return { fare: prev.fare, source: 'cache' };
}
```

新レコード追加時は前レコードの `valid_to` を新有効開始日の前日に自動更新する。取得失敗時は `needsReview=true` とする。

---

## ⑦ 定期経費マスター処理

月末23:00のタイムトリガーで実行する。実行日時点で有効なレコード（`valid_from <= today <= valid_to`）のみを処理する。

```javascript
function processRecurringExpenses_() {
  const today = new Date();
  const master = getSheet_('定期経費マスター');
  const activeEntries = master.getDataRange()
    .getValues()
    .filter(row =>
      new Date(row.valid_from) <= today &&
      new Date(row.valid_to) >= today
    );
  activeEntries.forEach(entry => {
    const result = appendRow_(
      getSheet_('経費'),
      buildRecurringEntry_(entry),
      null,
      'recurring_auto'
    );
    if (!result.success) {
      appendRow_(getSheet_('全体レビューアラート'), {
        alert_type: 'recurring_entry_failed',
        severity: 'high',
        description: `定期経費自動入力失敗: ${entry.name}`,
        timestamp: new Date().toISOString()
      }, null, 'alert');
    }
  });
}
```

---

## ⑧ タイムトリガー一覧

| トリガー名 | 実行タイミング | 処理内容 |
|:--|:--|:--|
| `processRecurringExpenses_` | 毎月末 23:00 | 定期経費自動入力 |
| `runMonthEndReview_` | 毎月末 23:30 | 月末フルレビュー・漏れ検知 |
| `checkBillingReminder_` | 毎月20日 09:00 | クライアント請求リマインド（将来用） |
| `expireLearningRules_` | 毎月1日 00:00 | 学習ルール失効チェック |

---

## ⑨ ファイル命名処理（renameFile_）

```javascript
function buildFileName_(entry) {
  const date = (entry.document_date
    || entry.transaction_date
    || entry.payment_date
    || formatDate_(new Date()))
    .replace(/-/g, '');
  const account = entry.debit_account || '未分類';
  const vendor = (entry.vendor || '未抽出')
    .substring(0, 20);
  const amount = entry.original_amount || '0';
  const id = generateRandId_(6);
  const ext = entry.extension || 'pdf';
  const raw = `${date}_${account}_${vendor}_${amount}_${id}`;
  const sanitized = raw
    .replace(/[\/\\:*?"<>|\s]/g, '_')
    .replace(/_+/g, '_');
  const name = sanitized.length > 94
    ? sanitized.substring(0, 94)
    : sanitized;
  return `${name}.${ext}`;
}
```

---

## ⑩ 監査ログ処理（auditLog_）

```javascript
function auditLog_(action, receiptKey, payload, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    receipt_key: receiptKey,
    payload: JSON.stringify(payload),
    result: JSON.stringify(result)
  };
  const sheet = getSheet_('監査ログ');
  if (JSON.stringify(entry).length > 50000) {
    const fileUrl = saveToDrive_(
      JSON.stringify(entry),
      `audit_${new Date().toISOString()}.json`,
      PropertiesService.getScriptProperties()
        .getProperty('AUDIT_LOG_FOLDER_ID')
    );
    appendRow_(sheet,
      { ...entry, payload: fileUrl, result: fileUrl },
      receiptKey, 'audit');
  } else {
    appendRow_(sheet, entry, receiptKey, 'audit');
  }
}
```

---

## ⑪ 経費シート列定義

| 列名 | 型 | 説明 |
|:--|:--|:--|
| `receipt_key` | string | Drive fileId（主キー） |
| `no_receipt` | boolean | 領収書なしフラグ |
| `expense_type` | enum | corporate / personal |
| `document_date` | date | 発行日 |
| `transaction_date` | date | 取引日 |
| `payment_date` | date | 支払日（照合後確定） |
| `service_period_start` | date | サービス期間開始 |
| `service_period_end` | date | サービス期間終了 |
| `booking_date` | date | 計上日（自動算出） |
| `vendor` | string | 取引先 |
| `summary` | string | 摘要 |
| `debit_account` | string | 借方科目 |
| `credit_account` | string | 貸方科目 |
| `original_amount` | integer | 元金額 |
| `currency` | string | 通貨コード |
| `fx_rate` | float | 為替レート |
| `fx_rate_source` | string | レートソース |
| `fx_provisional` | boolean | 仮換算フラグ |
| `booked_amount` | integer | 計上金額（円） |
| `tax_category` | string | 税区分 |
| `apply_home_office_rule` | boolean | 家事按分適用フラグ |
| `qualified_invoice_number` | string | 適格請求書番号 |
| `is_annual_contract` | boolean | 年額契約フラグ |
| `is_parent` | boolean | 月割り親行フラグ |
| `is_child` | boolean | 月割り子行フラグ |
| `parent_receipt_key` | string | 親行のreceiptKey |
| `allocation_month` | string | 月割り対象月 |
| `reconcile_status` | enum | 照合ステータス5段階 |
| `reconcile_source` | string | 照合ソース |
| `mf_transaction_id` | string | MF取引ID |
| `needs_review` | boolean | 要確認フラグ |
| `review_note` | string | 確認事項メモ |
| `correction_note` | string | 補正メモ |
| `billable_to_client` | boolean | クライアント請求フラグ |
| `client_name` | string | 請求先クライアント名 |
| `is_deleted` | boolean | 論理削除フラグ |
| `deleted_at` | datetime | 削除日時 |
| `deleted_by` | string | 削除者 |
| `delete_reason` | string | 削除理由 |
| `created_at` | datetime | 登録日時 |
| `updated_at` | datetime | 最終更新日時 |

---

## ⑫ Script Properties一覧

| キー | デフォルト値 | 説明 |
|:--|:--|:--|
| `API_TOKEN` | （必須設定） | Bearer認証トークン |
| `OPENAI_API_KEY` | （必須設定） | OpenAI APIキー |
| `MAIN_MODEL` | `gpt-4o` | メイン処理モデル |
| `FX_RATE_MODEL` | `gpt-4o` | 為替レート取得モデル |
| `FARE_MODEL` | `gpt-4o` | 運賃取得モデル |
| `SPREADSHEET_ID` | （必須設定） | スプレッドシートID |
| `DRIVE_FOLDER_ID` | （必須設定） | 領収書保存フォルダID |
| `DRIVE_DELETED_FOLDER_ID` | （必須設定） | 論理削除ファイル移動先 |
| `AUDIT_LOG_FOLDER_ID` | （必須設定） | 監査ログ保存フォルダID |
| `BOOKING_DATE_BASIS` | `payment_date` | 計上日基準 |
| `HOME_OFFICE_ACCOUNTS` | `地代家賃,水道光熱費,通信費` | 家事按分対象科目 |
| `HOME_OFFICE_WHITELIST` | `ソフトバンク,NTTファイナンス,東京ガス,東京都水道局` | 家事按分対象取引先 |
| `ANOMALY_THRESHOLD_RATE` | `3.0` | 月次異常検知閾値（倍率） |
| `ANOMALY_MIN_AMOUNT` | `10000` | 月次異常検知最小金額 |
| `REVIEW_TRIGGER` | `month_end` | レビュー通知タイミング |
| `TRANSPORT_TIMING` | `month_end` | 交通費確認タイミング |
| `LEARNING_RULE_EXPIRE_MONTHS` | `12` | 学習ルール失効月数 |
| `LEARNING_RULE_MAX` | `50` | 学習ルール最大件数 |
| `TRANSPORT_REMINDER_MAX` | `1` | 交通費リマインド上限回数 |
| `BILLING_CHECK_DAY` | `20` | クライアント請求確認日 |
| `CREDIT_CORPORATE` | `短期借入金` | 法人経費貸方科目 |
| `CREDIT_PERSONAL` | `短期借入金` | 個人経費貸方科目 |
| `CREDIT_GMO` | `普通預金（GMOあおぞらネット銀行）` | GMO照合後貸方 |
| `CREDIT_HIGASHI` | `普通預金（東山口信用金庫）` | 東山口照合後貸方 |
| `CREDIT_YUCHO` | `普通預金（ゆうちょ銀行）` | ゆうちょ照合後貸方 |

---

## ⑬ シート一覧（最終版）

| シート名 | 用途 | append-only |
|:--|:--|:--|
| 経費 | メイン経費データ | No |
| 変更履歴 | 全変更記録 | Yes |
| 監査ログ | API操作全般 | Yes |
| 意思決定ログ | 経理判断確定 | Yes |
| 全体レビューアラート | 横断的異常検知結果 | Yes |
| 学習ログ | フィードバック学習ルール | No |
| ルール適用ログ | ルール適用・スキップ記録 | Yes |
| 通知キュー | 月末通知未読フラグ | No |
| 交通費ペンディング | 後入力交通費管理 | No |
| 交通費不要ログ | 不要判定記録 | Yes |
| 定期経費マスター | 有効期間付き定期経費 | No |
| 交通費マスター | 経路情報（運賃なし） | No |
| 運賃キャッシュ | 有効期間付き運賃記録 | No |
| マッチングルール | 銀行照合パターン | No |
| MFホワイトリスト | MF取引フィルタリング | No |
