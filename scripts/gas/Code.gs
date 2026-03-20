/**
 * 領収書自動処理システム
 * Google Apps Script メインコード
 * version: 1.5.0
 * updated: 2026-03-20
 */

// ============================================================
// エントリーポイント
// ============================================================

function doPost(e) {
  try {
    authenticate_(e);
    const payload = JSON.parse(e.postData.contents);
    const mode = payload.mode;

    switch (mode) {
      case 'stage':         return respond_(handleStage_(payload));
      case 'finalize':      return respond_(handleFinalize_(payload));
      case 'reconcile':     return respond_(handleReconcile_(payload));
      case 'no_receipt':    return respond_(handleNoReceipt_(payload));
      case 'review':        return respond_(handleReview_(payload));
      case 'global_review': return respond_(handleGlobalReview_(payload));
      default:
        return respond_({ status: 'error', code: 'REQUEST_INVALID',
                          message: `Unknown mode: ${mode}` }, 400);
    }
  } catch (err) {
    const status = err.status || 500;
    return respond_({ status: 'error', code: err.code || 'UNKNOWN',
                      message: err.message }, status);
  }
}

// ============================================================
// 認証
// ============================================================

function authenticate_(e) {
  const props = PropertiesService.getScriptProperties();
  let token;
  if (e.postData) {
    try {
      token = JSON.parse(e.postData.contents).token;
    } catch (_) {}
  }
  if (token !== props.getProperty('API_TOKEN')) {
    throw { code: 'UNAUTHORIZED', status: 401,
            message: '認証失敗' };
  }
}

// ============================================================
// ① stage ハンドラ
// ============================================================

function handleStage_(payload) {
  const files = payload.files;
  if (!files || files.length === 0) {
    throw { code: 'REQUEST_INVALID', status: 400,
            message: 'files は必須です' };
  }
  const results = [];
  files.forEach(f => {
    try {
      const blob = f.fileId
        ? fetchFromOpenAI_(f.fileId)
        : fetchFromUrl_(f.url);
      const ext = detectExtension_(blob);
      const tmpName = `tmp_${Date.now()}_${generateRandId_(6)}.${ext}`;
      const folder = getDriveFolder_(
        PropertiesService.getScriptProperties()
          .getProperty('DRIVE_FOLDER_ID'));
      const file = folder.createFile(blob.setName(tmpName));
      results.push({ receiptKey: file.getId(),
                     originalName: f.fileId || f.url });
    } catch (err) {
      results.push({ error: 'STAGE_DOWNLOAD_FAILED',
                     originalName: f.fileId || f.url,
                     message: err.message });
    }
  });
  const hasError = results.some(r => r.error);
  const hasOk    = results.some(r => r.receiptKey);
  return {
    status: hasError && hasOk ? 'partial_ok' : hasError ? 'error' : 'ok',
    results
  };
}

// ============================================================
// ② finalize ハンドラ
// ============================================================

function handleFinalize_(payload) {
  const receipts = payload.receipts;
  if (!receipts || receipts.length === 0) {
    throw { code: 'REQUEST_INVALID', status: 400,
            message: 'receipts は必須です' };
  }
  const results = [];
  receipts.forEach(r => {
    try {
      // 重複チェック
      if (!r.refinalize && isAlreadyFinalized_(r.receiptKey)) {
        throw { code: 'ALREADY_FINALIZED', status: 409,
                message: `${r.receiptKey} は既にfinalizeされています` };
      }
      // 抽出
      const extracted = extractReceipt_(r.receiptKey);
      // 正規化
      const normalized = normalizeReceipt_(extracted, r);
      // AI再判断
      const reasoned = needsReason_(normalized)
        ? reasonReceipt_(normalized) : normalized;
      // 月割り処理
      const entries = allocatePrepaid_(reasoned);
      // シート登録
      entries.forEach(entry => {
        const built = buildEntry_(entry);
        appendRow_(getSheet_('経費'), built,
                   r.receiptKey, 'finalize');
      });
      // ファイルリネーム
      const newName = buildFileName_(reasoned);
      renameFile_(r.receiptKey, newName);
      // 監査ログ
      auditLog_('finalize', r.receiptKey, r, reasoned);
      // 軽量グローバルチェック（重複検知のみ）
      runGlobalReview_('light');

      results.push({
        receiptKey: r.receiptKey,
        fileName: newName,
        debitAccount: reasoned.debit_account,
        bookedAmount: reasoned.booked_amount,
        needsReview: reasoned.needs_review,
        reviewNote: reasoned.review_note
      });
    } catch (err) {
      results.push({
        error: err.code || 'EXTRACT_FAILED',
        receiptKey: r.receiptKey,
        message: err.message
      });
    }
  });
  const hasError = results.some(r => r.error);
  const hasOk    = results.some(r => r.receiptKey && !r.error);
  return {
    status: hasError && hasOk ? 'partial_ok' : hasError ? 'error' : 'ok',
    results
  };
}

// ============================================================
// ③ reconcile ハンドラ
// ============================================================

function handleReconcile_(payload) {
  const { source, data } = payload;
  if (!source || !data) {
    throw { code: 'REQUEST_INVALID', status: 400,
            message: 'source と data は必須です' };
  }
  const sheet = getSheet_('経費');
  const expenseRows = getActiveRows_(sheet);
  const results = [];

  data.forEach(bankTx => {
    try {
      if (!isWhitelisted_(bankTx)) return;
      const match = matchTransaction_(bankTx, expenseRows);
      if (!match) {
        recordUnmatchedAlert_(bankTx, source);
        results.push({ status: 'unmatched', date: bankTx.date,
                       vendor: bankTx.vendor, amount: bankTx.amount });
        return;
      }
      if (match.status === 'multiple_candidates') {
        results.push({ status: 'multiple_candidates',
                       candidates: match.candidates });
        return;
      }
      applyReconcile_(match, bankTx, source);
      results.push({ status: 'reconciled',
                     receiptKey: match.receipt_key,
                     paymentDate: bankTx.date });
    } catch (err) {
      results.push({ status: 'error', message: err.message,
                     vendor: bankTx.vendor });
    }
  });
  return { status: 'ok', results };
}

// ============================================================
// ④ no_receipt ハンドラ
// ============================================================

function handleNoReceipt_(payload) {
  const entry = payload.entry;
  if (!entry) {
    throw { code: 'REQUEST_INVALID', status: 400,
            message: 'entry は必須です' };
  }
  const receiptKey = `no_receipt_${Date.now()}_${generateRandId_(6)}`;
  const built = buildEntry_({
    ...entry,
    receipt_key: receiptKey,
    no_receipt: true,
    reconcile_status: 'unreconciled',
    expense_type: entry.expense_type || 'corporate',
    credit_account: determineCreditAccount_(
      entry.expense_type || 'corporate')
  });
  appendRow_(getSheet_('経費'), built, receiptKey, 'no_receipt');
  auditLog_('no_receipt', receiptKey, entry, built);
  return { status: 'ok', receiptKey };
}

// ============================================================
// ⑤ review ハンドラ
// ============================================================

function handleReview_(payload) {
  const { action, receiptKey, updates, skipReason } = payload;

  switch (action || 'fetch') {
    case 'fetch': {
      const sheet = getSheet_('経費');
      const rows = getActiveRows_(sheet)
        .filter(r => r.needs_review === true);
      return { status: 'ok', items: rows };
    }
    case 'approve': {
      updateRow_(getSheet_('経費'),
        findRowIndexByReceiptKey_(receiptKey),
        'needs_review', false, receiptKey, 'review_approve');
      return { status: 'ok', receiptKey };
    }
    case 'update': {
      const sheet = getSheet_('経費');
      const rowIndex = findRowIndexByReceiptKey_(receiptKey);
      Object.entries(updates).forEach(([col, val]) => {
        updateRow_(sheet, rowIndex, col, val,
                   receiptKey, 'review_update');
      });
      updateRow_(sheet, rowIndex, 'needs_review', false,
                 receiptKey, 'review_update');
      return { status: 'ok', receiptKey };
    }
    case 'skip': {
      recordLearning_('review_skip', { receiptKey },
                      'unnecessary', skipReason || 'ユーザーがスキップ');
      return { status: 'ok', receiptKey };
    }
    default:
      throw { code: 'REQUEST_INVALID', status: 400,
              message: `Unknown action: ${action}` };
  }
}

// ============================================================
// ⑥ global_review ハンドラ
// ============================================================

function handleGlobalReview_(payload) {
  const mode = payload.reviewMode || 'full';
  const alerts = runGlobalReview_(mode);
  return { status: 'ok', alertCount: alerts.length, alerts };
}

function runGlobalReview_(mode) {
  const alerts = [];
  // Layer 1: ルールベースチェック
  alerts.push(...checkDuplicateEntries_());
  if (mode === 'full') {
    alerts.push(...checkMonthlyAnomaly_());
    alerts.push(...checkFxRateConsistency_());
    alerts.push(...checkHomeOfficeConsistency_());
    alerts.push(...checkPrepaidBalance_());
    alerts.push(...checkUnreconciledOld_());
  }
  // Layer 2: AI自由観察（フルのみ）
  if (mode === 'full') {
    alerts.push(...runAiObservation_());
  }
  // 学習済みルールでフィルタリング
  const filtered = applyLearnedRules_(alerts);
  // アラートシートに記録
  filtered.forEach(a => appendRow_(
    getSheet_('全体レビューアラート'), a, null, 'global_review'));
  return filtered;
}

// ============================================================
// 正規化処理
// ============================================================

function normalizeReceipt_(extracted, options) {
  const props = PropertiesService.getScriptProperties();
  const entry = { ...extracted };

  // 適格番号正規化
  const invoiceResult = normalizeInvoiceNumber_(
    entry.qualified_invoice_number);
  entry.qualified_invoice_number = invoiceResult.value;
  if (invoiceResult.needsReview) {
    entry.needs_review = true;
    entry.review_note = appendNote_(entry.review_note,
                                    invoiceResult.reviewNote);
  }

  // 外貨処理
  if (entry.currency && entry.currency !== 'JPY') {
    const fxResult = extractFxRate_(
      entry.transaction_date || entry.document_date,
      entry.currency);
    if (fxResult.needsReview) {
      entry.needs_review = true;
      entry.review_note = appendNote_(entry.review_note,
                                      fxResult.reviewNote);
    } else {
      entry.fx_rate = fxResult.rate;
      entry.fx_rate_source = fxResult.fxRateSource;
      entry.fx_provisional = true;
      entry.booked_amount = Math.round(
        entry.original_amount * fxResult.rate);
    }
  }

  // 家事按分15%
  const homeOfficeResult = applyHomeOfficeRule_(entry);
  entry.apply_home_office_rule = homeOfficeResult.apply;
  entry.booked_amount = homeOfficeResult.booked_amount;
  if (homeOfficeResult.correction_note) {
    entry.correction_note = homeOfficeResult.correction_note;
  }

  // expenseType・貸方科目
  entry.expense_type = options.expenseType || 'corporate';
  entry.credit_account = determineCreditAccount_(entry.expense_type);

  // 計上日
  entry.booking_date = resolveBookingDate_(entry);

  // reconcileStatus初期値
  entry.reconcile_status = 'unreconciled';

  return entry;
}

function normalizeInvoiceNumber_(raw) {
  if (!raw) return { value: null, needsReview: false };
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

function buildFxRateUrl_(currency, date) {
  const year = new Date(date).getFullYear();
  const code = currency.toLowerCase();
  return `https://www.77bank.co.jp/kawase/${code}${year}.html`;
}

function extractFxRate_(date, currency) {
  const url = buildFxRateUrl_(currency, date);
  const prompt =
    `以下のURLから${date}の${currency}/JPY仲値レートを取得してください。\n` +
    `URL: ${url}\n` +
    `休日の場合は直前の営業日のレートを使用してください。\n` +
    `必ずJSON形式で返してください:\n` +
    `{"date":"YYYY-MM-DD","currency":"${currency}","rate":158.28,` +
    `"source":"77bank_TTM","is_business_day":true}\n` +
    `取得できない場合: {"error":"RATE_NOT_FOUND"}`;
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

function applyHomeOfficeRule_(entry) {
  const props = PropertiesService.getScriptProperties();
  const targets = props.getProperty('HOME_OFFICE_ACCOUNTS').split(',');
  const whitelist = props.getProperty('HOME_OFFICE_WHITELIST').split(',');
  const accountMatch = targets.some(t =>
    t.trim() === entry.debit_account);
  const vendorMatch = whitelist.some(w =>
    entry.vendor && entry.vendor.includes(w.trim()));
  if (accountMatch && vendorMatch) {
    return {
      apply: true,
      booked_amount: Math.round(entry.original_amount * 0.15),
      correction_note:
        `家事按分15%適用。元金額¥${entry.original_amount}`
    };
  }
  return { apply: false,
           booked_amount: entry.booked_amount || entry.original_amount };
}

function determineCreditAccount_(expenseType) {
  const props = PropertiesService.getScriptProperties();
  return expenseType === 'personal'
    ? props.getProperty('CREDIT_PERSONAL')
    : props.getProperty('CREDIT_CORPORATE');
}

function resolveBookingDate_(entry) {
  return entry.payment_date
    || entry.transaction_date
    || entry.document_date;
}

// ============================================================
// 月割り処理
// ============================================================

function allocatePrepaid_(entry) {
  if (!entry.is_annual_contract) return [entry];
  const months = calcContractMonths_(
    entry.service_period_start, entry.service_period_end);
  const monthlyAmount = Math.round(entry.original_amount / months);
  const lastMonthAmount = entry.original_amount
    - monthlyAmount * (months - 1);
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
      booked_amount: i === months - 1 ? lastMonthAmount : monthlyAmount,
      is_child: true,
      allocation_month: addMonths_(entry.service_period_start, i),
      expense_type: entry.expense_type,
      credit_account: entry.credit_account,
      vendor: entry.vendor,
      reconcile_status: 'unreconciled'
    });
  }
  return rows;
}

// ============================================================
// 論理削除
// ============================================================

function deleteEntry_(receiptKey, reason, deletedBy) {
  const sheet = getSheet_('経費');
  const rowIndex = findRowIndexByReceiptKey_(receiptKey);
  const childRows = findChildRows_(sheet, receiptKey);
  const futureRows = childRows.filter(r => !r.payment_date);
  const pastRows   = childRows.filter(r =>  r.payment_date);

  if (childRows.length > 0) {
    return {
      status: 'confirmation_required',
      message: buildDeleteConfirmMessage_(pastRows, futureRows, receiptKey)
    };
  }
  updateRow_(sheet, rowIndex, 'is_deleted',    true,
             receiptKey, 'logical_delete');
  updateRow_(sheet, rowIndex, 'deleted_at',
             new Date().toISOString(), receiptKey, 'logical_delete');
  updateRow_(sheet, rowIndex, 'deleted_by',    deletedBy,
             receiptKey, 'logical_delete');
  updateRow_(sheet, rowIndex, 'delete_reason', reason,
             receiptKey, 'logical_delete');
  moveToDeletedFolder_(receiptKey);
  return { status: 'ok', receiptKey };
}

// ============================================================
// シート書き込み一元化
// ============================================================

/**
 * ✅ 全シート書き込みはこの関数を経由すること
 * ❌ sheet.getRange().setValue() の直接呼び出し禁止
 */
function appendRow_(sheet, rowData, receiptKey, changeType) {
  sheet.appendRow(Array.isArray(rowData)
    ? rowData : Object.values(rowData));
  logChange_(receiptKey, 'append', null, rowData, changeType);
}

function updateRow_(sheet, rowIndex, colName, newValue,
                    receiptKey, changeType) {
  const col = getColIndex_(sheet, colName);
  const oldValue = sheet.getRange(rowIndex, col).getValue();
  sheet.getRange(rowIndex, col).setValue(newValue);
  logChange_(receiptKey, 'update', oldValue, newValue, changeType);
  // updated_at を自動更新
  const updatedAtCol = getColIndex_(sheet, 'updated_at');
  if (updatedAtCol) {
    sheet.getRange(rowIndex, updatedAtCol)
         .setValue(new Date().toISOString());
  }
}

function logChange_(receiptKey, action, oldValue, newValue, changeType) {
  const sheet = getSheet_('変更履歴');
  sheet.appendRow([
    new Date().toISOString(),
    receiptKey || '',
    action,
    changeType || '',
    JSON.stringify(oldValue),
    JSON.stringify(newValue)
  ]);
}

// ============================================================
// 照合処理
// ============================================================

function matchTransaction_(bankTx, expenseRows) {
  const candidates = expenseRows.filter(row =>
    !row.is_deleted &&
    row.reconcile_status !== 'cash_payment' &&
    Math.abs(row.original_amount) === Math.abs(bankTx.amount) &&
    vendorMatch_(row.vendor, bankTx.vendor) &&
    dateDiff_(row.transaction_date, bankTx.date) <= 1
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return { status: 'multiple_candidates', candidates };
  }
  return null;
}

function applyReconcile_(row, bankTx, source) {
  const sheet = getSheet_('経費');
  const creditAccount = resolveCreditAccount_(source);
  updateRow_(sheet, row.rowIndex, 'payment_date',
             bankTx.date, row.receipt_key, 'reconcile');
  updateRow_(sheet, row.rowIndex, 'credit_account',
             creditAccount, row.receipt_key, 'reconcile');
  updateRow_(sheet, row.rowIndex, 'reconcile_status',
             'reconciled', row.receipt_key, 'reconcile');
  updateRow_(sheet, row.rowIndex, 'reconcile_source',
             source, row.receipt_key, 'reconcile');
  if (bankTx.mfTransactionId) {
    updateRow_(sheet, row.rowIndex, 'mf_transaction_id',
               bankTx.mfTransactionId, row.receipt_key, 'reconcile');
  }
}

function resolveCreditAccount_(source) {
  const props = PropertiesService.getScriptProperties();
  const map = {
    'gmo_aozora':       props.getProperty('CREDIT_GMO'),
    'higashi_yamaguchi': props.getProperty('CREDIT_HIGASHI'),
    'yucho_passbook':   props.getProperty('CREDIT_YUCHO'),
    'moneyforward':     props.getProperty('CREDIT_CORPORATE')
  };
  return map[source] || props.getProperty('CREDIT_CORPORATE');
}

// ============================================================
// ファイル命名
// ============================================================

function buildFileName_(entry) {
  const date = (entry.document_date
    || entry.transaction_date
    || entry.payment_date
    || formatDate_(new Date()))
    .replace(/-/g, '');
  const account = (entry.debit_account || '未分類')
    .replace(/[\/\\:*?"<>|\s]/g, '_');
  const vendor  = (entry.vendor || '未抽出')
    .replace(/[\/\\:*?"<>|\s]/g, '_')
    .substring(0, 20);
  const amount  = String(entry.original_amount || '0');
  const id      = generateRandId_(6);
  const ext     = entry.extension || 'pdf';
  const raw     = `${date}_${account}_${vendor}_${amount}_${id}`;
  const sanitized = raw.replace(/_+/g, '_');
  const name = sanitized.length > 94
    ? sanitized.substring(0, 94) : sanitized;
  return `${name}.${ext}`;
}

// ============================================================
// 監査ログ
// ============================================================

function auditLog_(action, receiptKey, payload, result) {
  const entry = {
    timestamp:   new Date().toISOString(),
    action,
    receipt_key: receiptKey,
    payload:     JSON.stringify(payload),
    result:      JSON.stringify(result)
  };
  const sheet = getSheet_('監査ログ');
  if (JSON.stringify(entry).length > 50000) {
    const props = PropertiesService.getScriptProperties();
    const fileUrl = saveToDrive_(
      JSON.stringify(entry),
      `audit_${Date.now()}.json`,
      props.getProperty('AUDIT_LOG_FOLDER_ID')
    );
    sheet.appendRow([entry.timestamp, action, receiptKey,
                     fileUrl, fileUrl]);
  } else {
    sheet.appendRow([entry.timestamp, action, receiptKey,
                     entry.payload, entry.result]);
  }
}

// ============================================================
// 定期経費自動入力（月末トリガー）
// ============================================================

function processRecurringExpenses_() {
  const today = new Date();
  const master = getSheet_('定期経費マスター');
  const rows = master.getDataRange().getValues();
  const header = rows[0];
  rows.slice(1).forEach(row => {
    const rec = Object.fromEntries(
      header.map((h, i) => [h, row[i]]));
    const validFrom = new Date(rec.valid_from);
    const validTo   = new Date(rec.valid_to);
    if (validFrom <= today && today <= validTo) {
      const receiptKey =
        `recurring_${Date.now()}_${generateRandId_(6)}`;
      const entry = buildEntry_({
        receipt_key:      receiptKey,
        no_receipt:       true,
        expense_type:     'corporate',
        transaction_date: formatDate_(today),
        vendor:           rec.vendor,
        debit_account:    rec.debit_account,
        original_amount:  rec.original_amount,
        booked_amount:    rec.apply_home_office_rule
          ? Math.round(rec.original_amount * 0.15)
          : rec.original_amount,
        apply_home_office_rule: rec.apply_home_office_rule,
        credit_account:   determineCreditAccount_('corporate'),
        reconcile_status: 'unreconciled'
      });
      const result = appendRow_(
        getSheet_('経費'), entry, receiptKey, 'recurring_auto');
      if (!result) {
        appendRow_(getSheet_('全体レビューアラート'), {
          timestamp:   new Date().toISOString(),
          alert_type:  'recurring_entry_failed',
          severity:    'high',
          description: `定期経費自動入力失敗: ${rec.vendor}`,
          status:      'open'
        }, null, 'alert');
      }
    }
  });
}

// ============================================================
// フィードバック学習
// ============================================================

function recordLearning_(alertType, pattern, feedback, learnedRule) {
  appendRow_(getSheet_('学習ログ'), {
    timestamp:    new Date().toISOString(),
    alert_type:   alertType,
    pattern:      JSON.stringify(pattern),
    user_feedback: feedback,
    learned_rule: learnedRule,
    applied_from: new Date().toISOString(),
    status:       'active',
    applied_count: 0,
    last_applied_at: ''
  }, null, 'learning');
}

function applyLearnedRules_(alerts) {
  const rules = getActiveRules_();
  return alerts.filter(alert => {
    const matched = rules.find(r => matchesRule_(alert, r));
    if (matched) {
      appendRow_(getSheet_('ルール適用ログ'), {
        timestamp:           new Date().toISOString(),
        rule_id:             matched.id,
        alert_type:          alert.type,
        action:              'skipped',
        related_receipt_keys: JSON.stringify(alert.receiptKeys || [])
      }, null, 'rule_apply');
      return false;
    }
    return true;
  });
}

// ============================================================
// 運賃キャッシュ
// ============================================================

function getFare_(routeId, date) {
  const cache = getSheet_('運賃キャッシュ');
  const records = getCacheRecords_(cache, routeId);
  if (records.length < 2) {
    return fetchFareFromAI_(routeId, date);
  }
  const latest = records[0];
  const prev   = records[1];
  if (latest.fare === prev.fare) {
    return { fare: latest.fare, source: 'cache' };
  }
  const txDate     = new Date(date);
  const latestStart = new Date(latest.valid_from);
  return txDate >= latestStart
    ? { fare: latest.fare, source: 'cache' }
    : { fare: prev.fare,   source: 'cache' };
}

// ============================================================
// ユーティリティ
// ============================================================

function respond_(data, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties()
      .getProperty('SPREADSHEET_ID'));
  return ss.getSheetByName(name);
}

function getDriveFolder_(folderId) {
  return DriveApp.getFolderById(folderId);
}

function generateRandId_(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function formatDate_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function dateDiff_(d1, d2) {
  if (!d1 || !d2) return 999;
  const diff = Math.abs(new Date(d1) - new Date(d2));
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function vendorMatch_(v1, v2) {
  if (!v1 || !v2) return false;
  return v1.includes(v2) || v2.includes(v1);
}

function appendNote_(existing, note) {
  if (!note) return existing || '';
  return existing ? `${existing}\n${note}` : note;
}

function isAlreadyFinalized_(receiptKey) {
  const sheet = getSheet_('経費');
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const keyCol = header.indexOf('receipt_key');
  return data.slice(1).some(row => row[keyCol] === receiptKey);
}

function getColIndex_(sheet, colName) {
  const header = sheet.getRange(1, 1, 1,
    sheet.getLastColumn()).getValues()[0];
  const idx = header.indexOf(colName);
  return idx >= 0 ? idx + 1 : null;
}

function getActiveRows_(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0];
  return data.slice(1)
    .map((row, i) => {
      const obj = Object.fromEntries(header.map((h, j) => [h, row[j]]));
      obj.rowIndex = i + 2;
      return obj;
    })
    .filter(r => !r.is_deleted);
}

function findRowIndexByReceiptKey_(receiptKey) {
  const sheet = getSheet_('経費');
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const keyCol = header.indexOf('receipt_key');
  for (let i = 1; i < data.length; i++) {
    if (data[i][keyCol] === receiptKey) return i + 1;
  }
  return null;
}

function buildEntry_(entry) {
  return {
    receipt_key:             entry.receipt_key || '',
    no_receipt:              entry.no_receipt || false,
    expense_type:            entry.expense_type || 'corporate',
    document_date:           entry.document_date || '',
    transaction_date:        entry.transaction_date || '',
    payment_date:            entry.payment_date || '',
    service_period_start:    entry.service_period_start || '',
    service_period_end:      entry.service_period_end || '',
    booking_date:            entry.booking_date || '',
    vendor:                  entry.vendor || '',
    summary:                 entry.summary || '',
    debit_account:           entry.debit_account || '',
    credit_account:          entry.credit_account || '',
    original_amount:         entry.original_amount || 0,
    currency:                entry.currency || 'JPY',
    fx_rate:                 entry.fx_rate || '',
    fx_rate_source:          entry.fx_rate_source || '',
    fx_provisional:          entry.fx_provisional || false,
    booked_amount:           entry.booked_amount || 0,
    tax_category:            entry.tax_category || '',
    apply_home_office_rule:  entry.apply_home_office_rule || false,
    qualified_invoice_number: entry.qualified_invoice_number || '',
    is_annual_contract:      entry.is_annual_contract || false,
    is_parent:               entry.is_parent || false,
    is_child:                entry.is_child || false,
    parent_receipt_key:      entry.parent_receipt_key || '',
    allocation_month:        entry.allocation_month || '',
    reconcile_status:        entry.reconcile_status || 'unreconciled',
    reconcile_source:        entry.reconcile_source || '',
    mf_transaction_id:       entry.mf_transaction_id || '',
    needs_review:            entry.needs_review || false,
    review_note:             entry.review_note || '',
    correction_note:         entry.correction_note || '',
    billable_to_client:      entry.billable_to_client || false,
    client_name:             entry.client_name || '',
    is_deleted:              false,
    deleted_at:              '',
    deleted_by:              '',
    delete_reason:           '',
    created_at:              new Date().toISOString(),
    updated_at:              new Date().toISOString()
  };
}

function callOpenAI_(prompt, model) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('OPENAI_API_KEY');
  const payload = {
    model: model || props.getProperty('MAIN_MODEL') || 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(
    'https://api.openai.com/v1/chat/completions', options);
  const json = JSON.parse(res.getContentText());
  if (json.error) throw new Error(json.error.message);
  return JSON.parse(json.choices[0].message.content);
}

function saveToDrive_(content, filename, folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(filename, content,
    MimeType.PLAIN_TEXT);
  return file.getUrl();
}

function isWhitelisted_(bankTx) {
  const sheet = getSheet_('MFホワイトリスト');
  if (!sheet) return true;
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const keywordCol  = header.indexOf('keyword');
  const matchCol    = header.indexOf('match_target');
  return data.slice(1).some(row => {
    const keyword = row[keywordCol];
    const target  = row[matchCol];
    if (!keyword) return false;
    if (target === '大カテゴリ') {
      return bankTx.category === keyword;
    }
    return (bankTx.vendor || '').includes(keyword)
        || (bankTx.description || '').includes(keyword);
  });
}

function recordUnmatchedAlert_(bankTx, source) {
  appendRow_(getSheet_('全体レビューアラート'), {
    timestamp:   new Date().toISOString(),
    alert_type:  'unmatched_bank_transaction',
    severity:    'medium',
    description: `[${source}] ${bankTx.date} ${bankTx.vendor} ¥${Math.abs(bankTx.amount)} が経費シートに見つかりません`,
    status:      'open'
  }, null, 'alert');
}

function moveToDeletedFolder_(receiptKey) {
  const props = PropertiesService.getScriptProperties();
  const deletedFolderId =
    props.getProperty('DRIVE_DELETED_FOLDER_ID');
  if (!deletedFolderId) return;
  try {
    const file = DriveApp.getFileById(receiptKey);
    const deletedFolder = DriveApp.getFolderById(deletedFolderId);
    file.moveTo(deletedFolder);
  } catch (e) {
    Logger.log(`moveToDeletedFolder_ error: ${e.message}`);
  }
}

function addMonths_(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return formatDate_(d);
}

function calcContractMonths_(start, end) {
  if (!start || !end) return 12;
  const s = new Date(start);
  const e = new Date(end);
  return (e.getFullYear() - s.getFullYear()) * 12
    + (e.getMonth() - s.getMonth()) + 1;
}

function getActiveRules_() {
  const sheet = getSheet_('学習ログ');
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0];
  return data.slice(1)
    .map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])))
    .filter(r => r.status === 'active');
}

function matchesRule_(alert, rule) {
  try {
    const pattern = JSON.parse(rule.pattern);
    return alert.type === rule.alert_type
      && Object.entries(pattern).every(([k, v]) => alert[k] === v);
  } catch (_) {
    return false;
  }
}

function getCacheRecords_(sheet, routeId) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0];
  return data.slice(1)
    .map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])))
    .filter(r => r.route_id === routeId)
    .sort((a, b) => new Date(b.valid_from) - new Date(a.valid_from));
}

function findChildRows_(sheet, parentReceiptKey) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0];
  return data.slice(1)
    .map((row, i) => {
      const obj = Object.fromEntries(header.map((h, j) => [h, row[j]]));
      obj.rowIndex = i + 2;
      return obj;
    })
    .filter(r => r.parent_receipt_key === parentReceiptKey);
}

function buildDeleteConfirmMessage_(pastRows, futureRows, receiptKey) {
  const lines = [
    `この年額契約には${pastRows.length + futureRows.length}件の月割り行があります。`
  ];
  if (pastRows.length > 0) {
    lines.push(`・計上済み ${pastRows.length}件 → 残すことを推奨`);
  }
  if (futureRows.length > 0) {
    lines.push(`・未来月 ${futureRows.length}件 → 削除を推奨`);
  }
  lines.push('どのように処理しますか？');
  return lines.join('\n');
}

// ============================================================
// タイムトリガー登録（初回のみ手動実行）
// ============================================================

function setupTriggers() {
  // 既存トリガーを全削除
  ScriptApp.getProjectTriggers().forEach(t =>
    ScriptApp.deleteTrigger(t));

  // 毎月末 23:00 定期経費自動入力
  ScriptApp.newTrigger('processRecurringExpenses_')
    .timeBased().onMonthDay(28).atHour(23).create();

  // 毎月末 23:30 月末フルレビュー
  ScriptApp.newTrigger('runMonthEndReview_')
    .timeBased().onMonthDay(28).atHour(23).nearMinute(30).create();

  // 毎月20日 09:00 クライアント請求リマインド（将来用）
  ScriptApp.newTrigger('checkBillingReminder_')
    .timeBased().onMonthDay(20).atHour(9).create();

  // 毎月1日 00:00 学習ルール失効チェック
  ScriptApp.newTrigger('expireLearningRules_')
    .timeBased().onMonthDay(1).atHour(0).create();

  Logger.log('トリガー設定完了');
}

function runMonthEndReview_() {
  runGlobalReview_('full');
  Logger.log('月末フルレビュー完了');
}

function checkBillingReminder_() {
  // 将来実装：クライアント請求リマインド
  Logger.log('クライアント請求リマインド（未実装）');
}

function expireLearningRules_() {
  const props = PropertiesService.getScriptProperties();
  const expireMonths = parseInt(
    props.getProperty('LEARNING_RULE_EXPIRE_MONTHS') || '12');
  const sheet = getSheet_('学習ログ');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const statusCol       = header.indexOf('status') + 1;
  const lastAppliedCol  = header.indexOf('last_applied_at') + 1;
  const expireDate = new Date();
  expireDate.setMonth(expireDate.getMonth() - expireMonths);
  data.slice(1).forEach((row, i) => {
    const lastApplied = row[lastAppliedCol - 1];
    const status      = row[statusCol - 1];
    if (status === 'active' && lastApplied
        && new Date(lastApplied) < expireDate) {
      sheet.getRange(i + 2, statusCol).setValue('expired');
    }
  });
  Logger.log('学習ルール失効チェック完了');
}

// ============================================================
// グローバルレビュー チェック関数（スタブ）
// ============================================================

function checkDuplicateEntries_() {
  const rows = getActiveRows_(getSheet_('経費'));
  const seen = {};
  const alerts = [];
  rows.forEach(row => {
    const key = `${row.transaction_date}_${row.vendor}_${row.original_amount}`;
    if (seen[key]) {
      alerts.push({
        type:        'duplicate_entry',
        severity:    'high',
        description: `重複の可能性: ${row.vendor} ¥${row.original_amount} (${row.transaction_date})`,
        receiptKeys: [seen[key], row.receipt_key],
        timestamp:   new Date().toISOString(),
        status:      'open'
      });
    } else {
      seen[key] = row.receipt_key;
    }
  });
  return alerts;
}

function checkMonthlyAnomaly_() {
  // TODO: 科目別月次集計と前月比較を実装
  return [];
}

function checkFxRateConsistency_() {
  // TODO: 同日同通貨の為替レート整合性チェックを実装
  return [];
}

function checkHomeOfficeConsistency_() {
  // TODO: 家事按分適用漏れチェックを実装
  return [];
}

function checkPrepaidBalance_() {
  // TODO: 前払費用残高整合性チェックを実装
  return [];
}

function checkUnreconciledOld_() {
  const rows = getActiveRows_(getSheet_('経費'));
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return rows
    .filter(r =>
      r.reconcile_status === 'unreconciled' &&
      r.created_at &&
      new Date(r.created_at) < thirtyDaysAgo)
    .map(r => ({
      type:        'unreconciled_old',
      severity:    'medium',
      description: `30日以上未照合: ${r.vendor} ¥${r.original_amount} (${r.transaction_date})`,
      receiptKeys: [r.receipt_key],
      timestamp:   new Date().toISOString(),
      status:      'open'
    }));
}

function runAiObservation_() {
  // TODO: OpenAI経由の自由観察を実装
  return [];
}

function fetchFareFromAI_(routeId, date) {
  // TODO: OpenAI経由でIC運賃を取得し、キャッシュシートに保存
  return { fare: null, source: 'ai', needsReview: true };
}

function extractReceipt_(receiptKey) {
  // TODO: OpenAI Vision経由でOCR抽出を実装
  return {
    needs_review: true,
    review_note: '自動抽出未実装。手動入力してください'
  };
}

function needsReason_(entry) {
  return entry.needs_review === true
    || (entry.confidence && entry.confidence < 0.8);
}

function reasonReceipt_(entry) {
  // TODO: OpenAI経由のAI再判断を実装
  return entry;
}

function renameFile_(receiptKey, newName) {
  try {
    DriveApp.getFileById(receiptKey).setName(newName);
  } catch (e) {
    Logger.log(`renameFile_ error: ${e.message}`);
  }
}

function fetchFromOpenAI_(fileId) {
  // TODO: OpenAI Files APIからBlobを取得
  throw new Error('fetchFromOpenAI_ 未実装');
}

function fetchFromUrl_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(`URL取得失敗: ${url}`);
  }
  return res.getBlob();
}

function detectExtension_(blob) {
  const type = blob.getContentType() || '';
  if (type.includes('pdf'))  return 'pdf';
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('png'))  return 'png';
  return 'pdf';
}
