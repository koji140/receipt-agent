# 005 家事按分15%ルールの設計

## 決定日
2026-03-20

## 決定内容
自宅兼事務所の経費について15%を事業按分として計上するルールを実装する。
対象科目と対象取引先はホワイトリストで管理する。

## 対象科目
- 地代家賃
- 水道光熱費
- 通信費

## 対象取引先ホワイトリスト（HOME_OFFICE_WHITELIST）
- ソフトバンク
- NTTファイナンス
- 東京ガス
- 東京都水道局

SaaS系（OpenAI・Genspark・Notta・DeepL等）は対象外とする。

## 計算式

$$bookedAmount = round(originalAmount \times 0.15)$$

## 銀行照合キー
家事按分適用後の `bookedAmount` ではなく、元金額（`originalAmount`）を照合キーとして使用する。
理由：銀行口座からは元金額で引き落とされるため。

## 実装

```javascript
function applyHomeOfficeRule_(entry) {
  const targets = HOME_OFFICE_ACCOUNTS.split(',');
  const whitelist = HOME_OFFICE_WHITELIST.split(',');
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

## 管理方法
Script Propertiesで設定を管理し、カスタムGPT上で「このキーワードを追加して」と指示することで更新できる。

## 税務上の注意
按分割合・対象範囲については顧問税理士に確認すること。継続適用が原則。
