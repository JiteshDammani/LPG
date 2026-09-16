// ─────────────────────────────────────────────────────────────────────────
// dailyLedgerPdf.ts
//
// Builds the "Daily Record" PDF export, replacing the old "View Totals" /
// "Refresh" buttons on the Transaction screen. Mirrors the handwritten
// ledger sheet, 3 equal-width columns:
//   Col 1: CREDITS (TOTAL AHD rows first, then SHILLAK rows, then everything
//          else — no separate dedicated summary rows for those two anymore)
//   Col 2: COMMERCIAL PAYMENT, ONLINE PAYMENT, BANK DEPOSIT, CLOSING BALANCE
//   Col 3: DEBITS
//
// TABLE NAME / COLUMN NOTES (confirmed vs guessed):
//   - dashboard_dailyrecordsachin : confirmed (used throughout the app already)
//   - dashboard_dailyrecord ("JD") : confirmed identical column structure to
//     dashboard_dailyrecordsachin (per user) — same fields, same meaning,
//     just a separate table/ledger. Selectable via the `tableName` param
//     on buildDailyLedgerData / generateAndShareDailyLedgerPdf.
//   - dashboard_onlinepaymentdetails : confirmed name; the relevant column
//     is `no_of_cylinder` (per user: this column is effectively the
//     "amount" for that table — a naming leftover, not two different
//     values). Filtered by `date` + `type` ('PAYTM NEW' / 'ZERO BILL'),
//     fetched directly (no sum/count — one matching row expected).
//   - dashboard_commercialrecords / dashboard_debitbalancereport :
//     guessed snake_case, already used elsewhere in this codebase.
//
// All amounts/quantities are read-only here — this module never writes
// to the database, it only aggregates for the PDF.
// ─────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { format } from 'date-fns';

const TABLE = {
  sachin: 'dashboard_dailyrecordsachin',
  jd: 'dashboard_dailyrecord',
  onlinePaymentDetails: 'dashboard_onlinepaymentdetails',
};

type SachinRow = {
  id: number;
  date: string;
  transactions: 'CREDIT' | 'DEBIT';
  category: string;
  rate: number;
  quantity: number;
  amount: number;
  remarks: string;
};

// ── Small formatting helper used across several sections ───────────────
// "remarks(quantity) | amount" — quantity omitted entirely if it's 1.
function formatLine(remarks: string, quantity: number, amount: number) {
  const label = quantity === 1 ? (remarks || '—') : `${remarks || '—'}(${quantity})`;
  return { label, amount };
}

// ── Main aggregation: pulls every section's data for one date ──────────
// `tableName` lets callers point this at either dashboard_dailyrecordsachin
// (default) or dashboard_dailyrecord ("JD") — both tables share identical
// columns, so no other logic below needs to change based on which is used.

export async function buildDailyLedgerData(
  date: string,
  tableName: string = TABLE.sachin
) {
  // All of today's records — most sections filter this same list rather
  // than re-querying, except where a different table is genuinely needed
  // (online payments, commercial records).
  const { data: rows, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('date', date)
    .order('category', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw error;
  const all = (rows ?? []) as SachinRow[];

  // ── CREDITS (all CREDIT transactions except Commercial Payment) ────
  // Print order within this single list:
  //   1. category = 'TOTAL AHD' rows first
  //   2. remarks = 'SHILLAK' rows second (previous day's lookback balance)
  //   3. everything else after that
  // No separate dedicated "TOTAL AHD" / "OPENING BAL" rows anymore —
  // these values now live only once, inside this list, in this order.
  const creditRowsAll = all.filter(
    (r) => r.transactions === 'CREDIT' && r.category !== 'COMMERCIAL PAYMENT'
  );
  const creditAhdRows = creditRowsAll.filter((r) => r.category === 'TOTAL AHD');
  const creditShillakRows = creditRowsAll.filter(
    (r) => r.category !== 'TOTAL AHD' && (r.remarks || '').toUpperCase().trim() === 'SHILLAK'
  );
  const creditOtherRows = creditRowsAll.filter(
    (r) =>
      r.category !== 'TOTAL AHD' &&
      (r.remarks || '').toUpperCase().trim() !== 'SHILLAK'
  );
  const orderedCreditRows = [...creditAhdRows, ...creditShillakRows, ...creditOtherRows];
  const credits = orderedCreditRows.map((r) => formatLine(r.remarks, r.quantity, r.amount));
  const creditsTotal = orderedCreditRows.reduce((s, r) => s + Number(r.amount || 0), 0);

  // ── COMMERCIAL PAYMENT block ────────────────────────────────────────
  // Format: NAME(QTY)(AMOUNT)(DATE/MONTH) — remarks already store
  // "NAME(DELIVERY_DATE)"; quantity/amount come from the daily-record row itself.
  const commercialRows = all.filter((r) => r.category === 'COMMERCIAL PAYMENT');
  const commercial = commercialRows.map((r) => {
    const nameMatch = r.remarks?.split('(')[0]?.trim() || r.remarks;
    const dateMatch = r.remarks?.includes('(')
      ? r.remarks.split('(')[1]?.replace(')', '').trim()
      : '';
    let dayMonth = '';
    if (dateMatch) {
      const d = new Date(dateMatch);
      if (!isNaN(d.getTime())) {
        dayMonth = `${d.getDate()}/${d.getMonth() + 1}`;
      }
    }
    return {
      label: `${nameMatch}(${r.quantity})(${r.amount})(${dayMonth})`,
      quantity: r.quantity,
      amount: r.amount,
    };
  });
  const commercialCount = commercialRows.reduce((s, r) => s + Number(r.quantity || 0), 0);
  const commercialTotal = commercialRows.reduce((s, r) => s + Number(r.amount || 0), 0);

  // ── ONLINE PAYMENT block ────────────────────────────────────────────
  // PAYTM <- type='PAYTM NEW', ONLINE <- type='ZERO BILL'. Column actually
  // read is no_of_cylinder (per user, this table's "amount" lives there).
  // Single matching row expected per date+type, not summed.
  // NOTE: this section always reads from dashboard_onlinepaymentdetails,
  // regardless of which daily-record table (`tableName`) was selected —
  // online payment data is not duplicated per-ledger.
  let paytmAmount = 0;
  let onlineAmount = 0;
  {
    const { data: opRows, error: opErr } = await supabase
      .from(TABLE.onlinePaymentDetails)
      .select('type, no_of_cylinder')
      .eq('date', date)
      .in('type', ['PAYTM NEW', 'ZERO BILL']);

    if (opErr) throw opErr;

    for (const r of opRows ?? []) {
      if (r.type === 'PAYTM NEW') paytmAmount = Number(r.no_of_cylinder || 0);
      if (r.type === 'ZERO BILL') onlineAmount = Number(r.no_of_cylinder || 0);
    }
  }
  const onlinePaymentTotal = paytmAmount + onlineAmount;

  // ── BANK DEPOSIT block (AUB / ARVIND) ───────────────────────────────
  const bankRows = all.filter((r) => r.category === 'BANK DEPOSIT');
  const aubAmount = bankRows
    .filter((r) => (r.remarks || '').toUpperCase().includes('AUB'))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const arvindAmount = bankRows
    .filter((r) => (r.remarks || '').toUpperCase().includes('ARVIND'))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const bankDepositTotal = aubAmount + arvindAmount;

  // ── CLOSING BALANCE (today's totals) ────────────────────────────────
  const todayCredit = all
    .filter((r) => r.transactions === 'CREDIT')
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const todayDebit = all
    .filter((r) => r.transactions === 'DEBIT')
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const closingBalance = todayCredit - todayDebit;

  // ── DEBITS column ────────────────────────────────────────────────────
  // Group 1: category = 'BALANCE' debits first.
  // Group 2: every other debit EXCEPT 'ONLINE PAYMENT' and 'BANK DEPOSIT',
  // ordered by category then id (already the base sort order of `all`).
  const debitRowsBalance = all.filter(
    (r) => r.transactions === 'DEBIT' && r.category === 'BALANCE'
  );
  const debitRowsOther = all.filter(
    (r) =>
      r.transactions === 'DEBIT' &&
      r.category !== 'BALANCE' &&
      r.category !== 'ONLINE PAYMENT' &&
      r.category !== 'BANK DEPOSIT'
  );
  const debitLines = [...debitRowsBalance, ...debitRowsOther].map((r) =>
    formatLine(r.remarks, r.quantity, r.amount)
  );
  const debitsTotal = [...debitRowsBalance, ...debitRowsOther].reduce(
    (s, r) => s + Number(r.amount || 0),
    0
  );

  return {
    date,
    credits,
    creditsTotal,
    commercial,
    commercialCount,
    commercialTotal,
    paytmAmount,
    onlineAmount,
    onlinePaymentTotal,
    aubAmount,
    arvindAmount,
    bankDepositTotal,
    closingCredit: todayCredit,
    closingDebit: todayDebit,
    closingBalance,
    debitLines,
    debitsTotal,
  };
}

// ── HTML template ────────────────────────────────────────────────────────

function escapeHtml(s: string) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c];
  });
}

function rowsHtml(lines: { label: string; amount: number }[], emptyRowCount = 0) {
  let html = lines
    .map(
      (l) => `
      <tr>
        <td class="cell-label">${escapeHtml(l.label)}</td>
        <td class="cell-amount">${l.amount}</td>
      </tr>`
    )
    .join('');
  for (let i = 0; i < emptyRowCount; i++) {
    html += `<tr><td class="cell-label">&nbsp;</td><td class="cell-amount">&nbsp;</td></tr>`;
  }
  return html;
}

// `reportLabel` drives the on-page <h1> title (defaults to "DAILY RECORD")
// so the JD PDF is visually distinguishable from the Sachin one even
// though the layout/columns are otherwise identical.
export function buildDailyLedgerHtml(
  d: Awaited<ReturnType<typeof buildDailyLedgerData>>,
  reportLabel: string = 'DAILY RECORD'
) {
  const formattedDate = format(new Date(d.date + 'T00:00:00'), 'dd/MM/yyyy');

  return `
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      body { font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #000; margin: 0; padding: 16px; }
      .firm-name { text-align: center; font-size: 18px; font-weight: bold; letter-spacing: 0.5px; color: #1a1a8c; margin: 0; }
      .firm-location { text-align: center; font-size: 12px; color: #444; margin: 2px 0 8px; }
      .firm-divider { border: none; border-top: 2px solid #1a1a8c; margin: 0 0 10px; }
      h1 { text-align: center; font-size: 14px; margin: 0 0 4px; letter-spacing: 1px; }
      .date-line { text-align: center; font-size: 12px; margin-bottom: 12px; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; }
      td, th { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
      .section-title { background: #eef0fb; font-weight: bold; text-align: center; color: #1a1a8c; }
      .cell-label { width: 70%; }
      .cell-amount { width: 30%; text-align: right; }
      .layout-table > tbody > tr > td { border: none; padding: 0; vertical-align: top; }
      .col1, .col2, .col3 { width: 33.33%; padding: 0 4px; }
      .total-row td { font-weight: bold; background: #f5f5f5; }
    </style>
  </head>
  <body>
    <p class="firm-name">SHREEJEE GAS SERVICE</p>
    <p class="firm-location">AMRAVATI</p>
    <hr class="firm-divider" />
    <h1>${escapeHtml(reportLabel.toUpperCase())}</h1>
    <div class="date-line">Date: ${formattedDate}</div>

    <table class="layout-table">
      <tr>
        <!-- ── COLUMN 1: CREDITS (TOTAL AHD rows first, then SHILLAK, then rest) ── -->
        <td class="col1">
          <table>
            <tr><td colspan="2" class="section-title">CREDITS</td></tr>
            ${rowsHtml(d.credits)}
            <tr class="total-row">
              <td class="cell-label">TOTAL</td>
              <td class="cell-amount">${d.creditsTotal}</td>
            </tr>
          </table>
        </td>

        <!-- ── COLUMN 2: COMMERCIAL PAYMENT, ONLINE PAYMENT, BANK DEPOSIT, CLOSING BALANCE ── -->
        <td class="col2">
          <table>
            <tr><td colspan="2" class="section-title">COMMERCIAL PAYMENT</td></tr>
            ${rowsHtml(d.commercial.map((c) => ({ label: c.label, amount: c.amount })))}
            <tr class="total-row">
              <td class="cell-label">TOTAL (Count: ${d.commercialCount})</td>
              <td class="cell-amount">${d.commercialTotal}</td>
            </tr>

            <tr><td colspan="2" class="section-title">ONLINE PAYMENT</td></tr>
            <tr>
              <td class="cell-label">PAYTM</td>
              <td class="cell-amount">${d.paytmAmount}</td>
            </tr>
            <tr>
              <td class="cell-label">ONLINE</td>
              <td class="cell-amount">${d.onlineAmount}</td>
            </tr>
            <tr class="total-row">
              <td class="cell-label">TOTAL</td>
              <td class="cell-amount">${d.onlinePaymentTotal}</td>
            </tr>

            <tr><td colspan="2" class="section-title">BANK DEPOSIT</td></tr>
            <tr>
              <td class="cell-label">AUB</td>
              <td class="cell-amount">${d.aubAmount}</td>
            </tr>
            <tr>
              <td class="cell-label">ARVIND</td>
              <td class="cell-amount">${d.arvindAmount}</td>
            </tr>
            <tr class="total-row">
              <td class="cell-label">TOTAL</td>
              <td class="cell-amount">${d.bankDepositTotal}</td>
            </tr>

            <tr><td colspan="2" class="section-title">CLOSING BALANCE</td></tr>
            <tr>
              <td class="cell-label">CREDIT</td>
              <td class="cell-amount">${d.closingCredit}</td>
            </tr>
            <tr>
              <td class="cell-label">DEBIT</td>
              <td class="cell-amount">${d.closingDebit}</td>
            </tr>
            <tr class="total-row">
              <td class="cell-label">BALANCE</td>
              <td class="cell-amount">${d.closingBalance}</td>
            </tr>
          </table>
        </td>

        <!-- ── COLUMN 3: DEBITS ── -->
        <td class="col3">
          <table>
            <tr><td colspan="2" class="section-title">DEBITS</td></tr>
            ${rowsHtml(d.debitLines)}
            <tr class="total-row">
              <td class="cell-label">TOTAL</td>
              <td class="cell-amount">${d.debitsTotal}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

// ── Public entry point: generate + share/save the PDF ───────────────────
// `tableName` picks which daily-record table to read from:
//   TABLE.sachin (default) -> dashboard_dailyrecordsachin
//   TABLE.jd               -> dashboard_dailyrecord
// `reportLabel` controls the title printed on the PDF and the share-sheet
// dialog title, so the two exports are easy to tell apart.

export async function generateAndShareDailyLedgerPdf(
  date: string,
  tableName: string = TABLE.sachin,
  reportLabel: string = 'Daily Record'
) {
  const data = await buildDailyLedgerData(date, tableName);
  const html = buildDailyLedgerHtml(data, reportLabel);

  const { uri } = await Print.printToFileAsync({ html, base64: false });

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      dialogTitle: `${reportLabel} - ${date}`,
    });
  }

  return uri;
}

// Convenience export naming the two tables, in case other files want to
// reference them without hardcoding the raw strings.
export const DAILY_RECORD_TABLES = TABLE;
