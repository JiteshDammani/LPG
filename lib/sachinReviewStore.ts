// ─────────────────────────────────────────────────────────────────────────
// sachinReviewStore.ts
// ─────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';

// ── Table names ─────────────────────────────────────────────────────────
const TABLES = {
  sachin: 'dashboard_dailyrecordsachin',
  dailyRecord: 'dashboard_dailyrecord',
  transactionsTable: 'dashboard_transactionstables',
  commercialRecords: 'dashboard_commercialrecords',
  debitBalanceReport: 'dashboard_debitbalancereport',
  deliveryRecords: 'dashboard_deliveryrecords',
  onlinePaymentDetails: 'dashboard_onlinepaymentdetails',
};

// ── Types ────────────────────────────────────────────────────────────────

export type SachinRecord = {
  id: number;
  date: string; // 'YYYY-MM-DD'
  transactions: 'CREDIT' | 'DEBIT';
  category: string;
  rate: number;
  quantity: number;
  amount: number;
  remarks: string;
  paytm_transaction: boolean;
  check_done: boolean;
};

export type PreviewData = {
  title: string;
  headers: string[];
  rows: string[][];
};

// ── Helper: get the Saturday on or before a given date ──────────────────
function getSaturdayBefore(dateStr: string): Date {
  const d = new Date(dateStr);
  const day = d.getDay(); // 0=Sun, 6=Sat
  const diff = day === 6 ? 0 : day + 1; // days to go back to reach Saturday
  d.setDate(d.getDate() - diff);
  return d;
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── 1. Fetch the next pending record + total pending count ─────────────

export async function fetchPendingSachinRecord(): Promise<{
  record: SachinRecord | null;
  totalPending: number;
}> {
  const { count, error: countError } = await supabase
    .from(TABLES.sachin)
    .select('id', { count: 'exact', head: true })
    .eq('check_done', false);

  if (countError) throw countError;

  const { data, error } = await supabase
    .from(TABLES.sachin)
    .select('*')
    .eq('check_done', false)
    .order('date', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  return {
    record: data as SachinRecord | null,
    totalPending: count ?? 0,
  };
}

// ── 2. Fetch distinct categories for the dropdown ───────────────────────

export async function fetchCategoryOptions(): Promise<string[]> {
  const { data, error } = await supabase
    .from(TABLES.transactionsTable)
    .select('category')
    .order('category', { ascending: true });

  if (error) throw error;

  const unique = Array.from(new Set((data ?? []).map((r: any) => r.category)));
  return unique;
}

// ── 3. Live preview ─────────────────────────────────────────────────────

export async function fetchPreviewData(
  category: string,
  remarks: string,
  date: string | null,
  quantity: number | null,
  transactions?: 'CREDIT' | 'DEBIT' | null,
  amount?: number | null
): Promise<PreviewData> {
  const cat = (category || '').toUpperCase().trim();
  const rem = (remarks || '').toUpperCase().trim();

  if (!cat) {
    return { title: 'Pick a category to see a preview', headers: [], rows: [] };
  }

  try {
    // ── COMMERCIAL PAYMENT ─────────────────────────────────────────────
    if (cat === 'COMMERCIAL PAYMENT') {
      const customerName = rem.split('(')[0]?.trim();
      const deliveryDateStr = rem.split('(')[1]?.replace(')', '').trim();

      if (!customerName || !deliveryDateStr) {
        return {
          title: 'Format remarks as "CUSTOMER NAME (DELIVERY DATE)" to preview',
          headers: [],
          rows: [],
        };
      }

      const { data: matchingRows, error: matchErr } = await supabase
        .from(TABLES.commercialRecords)
        .select('id, customer_name, delivery_date, payment_date, amount')
        .eq('customer_name', customerName)
        .eq('delivery_date', deliveryDateStr)
        .order('id', { ascending: true });

      if (matchErr) throw matchErr;

      const rows = matchingRows ?? [];
      const qty = quantity ?? 0;
      const rowCount = rows.length;
      const paidCount = rows.filter((r: any) => !!r.payment_date).length;
      const unpaidCount = rowCount - paidCount;

      const countMsg =
        rowCount === qty
          ? `✅ Row count matches: ${rowCount} row(s) found for "${customerName}" on ${deliveryDateStr} (quantity = ${qty})`
          : `⚠️ Row count mismatch: found ${rowCount} row(s) for "${customerName}" on ${deliveryDateStr}, but quantity is ${qty}`;

      let paidMsg: string;
      if (rowCount === 0) {
        paidMsg = 'No rows to check.';
      } else if (paidCount === rowCount) {
        paidMsg = `✅ All ${paidCount} row(s) already marked paid.`;
      } else if (paidCount === 0) {
        paidMsg = `⏳ None of these ${rowCount} row(s) are marked paid yet.`;
      } else {
        paidMsg = `⚠️ Mixed: ${paidCount} paid, ${unpaidCount} unpaid out of ${rowCount}.`;
      }

      return {
        title: `${countMsg} — ${paidMsg}`,
        headers: ['ID', 'Customer', 'Delivery Date', 'Payment Date', 'Amount'],
        rows: rows.map((r: any) => [
          String(r.id),
          r.customer_name,
          r.delivery_date,
          r.payment_date ? `✅ Paid (${r.payment_date})` : '⏳ Not paid',
          String(r.amount ?? ''),
        ]),
      };
    }

    // ── BALANCE ────────────────────────────────────────────────────────
    if (cat === 'BALANCE') {
      const nameOnly = (rem.includes('(') ? rem.split('(')[0] : rem).trim();

      if (!nameOnly || !date) {
        return { title: 'Enter remarks (name) to check', headers: [], rows: [] };
      }

      if (transactions === 'CREDIT') {
        const { data, error } = await supabase
          .from(TABLES.debitBalanceReport)
          .select('id, name, amount, amount_rec, date, date_received, status')
          .ilike('name', `%${nameOnly}%`)
          .ilike('date_received', `%${date}%`)
          .order('date', { ascending: false })
          .limit(20);

        if (error) throw error;

        const rows = data ?? [];
        const msg =
          rows.length > 0
            ? `✅ Entry found: ${rows.length} row(s) for "${nameOnly}" with date_received containing ${date}`
            : `⚠️ No entry found for "${nameOnly}" with date_received containing ${date}`;

        return {
          title: msg,
          headers: ['ID', 'Date', 'Name', 'Amount', 'Received', 'Date Received', 'Status'],
          rows: rows.map((r: any) => [
            String(r.id),
            r.date ?? '—',
            r.name,
            String(r.amount),
            String(r.amount_rec ?? 0),
            r.date_received ?? '—',
            r.status ? '✅ Closed' : '⏳ Open',
          ]),
        };
      }

      if (transactions === 'DEBIT') {
        let query = supabase
          .from(TABLES.debitBalanceReport)
          .select('id, name, amount, amount_rec, date, date_received, status')
          .ilike('name', `%${nameOnly}%`)
          .eq('date', date);

        if (amount != null) {
          query = query.eq('amount', amount);
        }

        const { data, error } = await query.order('date', { ascending: false }).limit(20);

        if (error) throw error;

        const rows = data ?? [];
        const msg =
          rows.length > 0
            ? `✅ Entry found: ${rows.length} row(s) for "${nameOnly}" — amount ${amount ?? '?'}, date = ${date}`
            : `⚠️ No entry found for "${nameOnly}" — amount ${amount ?? '?'}, date = ${date}`;

        return {
          title: msg,
          headers: ['ID', 'Name', 'Amount', 'Received', 'Date Received', 'Status'],
          rows: rows.map((r: any) => [
            String(r.id),
            r.name,
            String(r.amount),
            String(r.amount_rec ?? 0),
            r.date_received ?? '—',
            r.status ? '✅ Closed' : '⏳ Open',
          ]),
        };
      }

      return { title: 'Unknown transaction type', headers: [], rows: [] };
    }

    // ── WEEKLY SALARY ──────────────────────────────────────────────────
    if (cat === 'WEEKLY SALARY') {
      if (!date || !rem) {
        return {
          title: `Unpaid deliveries for ${rem || '(no name yet)'}`,
          headers: [],
          rows: [],
        };
      }

      // Week boundaries:
      //   Record date is a Saturday (pay day).
      //   Week 1 (current week):  the 7 days ending on Friday before record date
      //                           i.e. (recordDate - 7) to (recordDate - 1)
      //   Week 2 (previous week): the 7 days before that
      //                           i.e. (recordDate - 14) to (recordDate - 8)
      //
      // Example: record date = 2026-06-06 (Saturday)
      //   Week 1: 2026-05-30 → 2026-06-05
      //   Week 2: 2026-05-23 → 2026-05-29

      const recordDate = new Date(date);

      const week1End = new Date(recordDate);
      week1End.setDate(recordDate.getDate() - 1); // Friday before pay day

      const week1Start = new Date(week1End);
      week1Start.setDate(week1End.getDate() - 6); // Saturday 7 days earlier

      const week2End = new Date(week1Start);
      week2End.setDate(week1Start.getDate() - 1);

      const week2Start = new Date(week2End);
      week2Start.setDate(week2End.getDate() - 6);

      const w1s = toYMD(week1Start);
      const w1e = toYMD(week1End);
      const w2s = toYMD(week2Start);
      const w2e = toYMD(week2End);

      // Fetch both weeks in parallel
      const [res1, res2] = await Promise.all([
        supabase
          .from(TABLES.deliveryRecords)
          .select('id, name, date, number, commission_given')
          .eq('name', rem)
          .gte('date', w1s)
          .lte('date', w1e)
          .order('date', { ascending: true }),
        supabase
          .from(TABLES.deliveryRecords)
          .select('id, name, date, number, commission_given')
          .eq('name', rem)
          .gte('date', w2s)
          .lte('date', w2e)
          .order('date', { ascending: true }),
      ]);

      if (res1.error) throw res1.error;
      if (res2.error) throw res2.error;

      const week1Rows = res1.data ?? [];
      const week2Rows = res2.data ?? [];

      // Total cylinders (using `quantity` column — swap to `no_of_cylinder` if needed)
      const week1Total = week1Rows.reduce(
        (sum: number, r: any) => sum + Number(r.number || r.no_of_cylinder || 0),
        0
      );
      const week2Total = week2Rows.reduce(
        (sum: number, r: any) => sum + Number(r.number || r.no_of_cylinder || 0),
        0
      );

      // Commission status: true only if EVERY row in that week has commission_given=true
      const week1AllPaid =
        week1Rows.length > 0 && week1Rows.every((r: any) => r.commission_given === true);
      const week2AllPaid =
        week2Rows.length > 0 && week2Rows.every((r: any) => r.commission_given === true);
      const week1AnyPaid = week1Rows.some((r: any) => r.commission_given === true);
      const week2AnyPaid = week2Rows.some((r: any) => r.commission_given === true);

      const commissionLabel = (
        rows: any[],
        allPaid: boolean,
        anyPaid: boolean
      ): string => {
        if (rows.length === 0) return '— No records';
        if (allPaid) return '✅ All Commission Given';
        if (anyPaid) return '⚠️ Partially Given';
        return '⏳ Commission Pending';
      };

      const summaryRows: string[][] = [
        [
          `Week 1 (${w1s} → ${w1e})`,
          String(week1Total),
          String(week1Rows.length),
          commissionLabel(week1Rows, week1AllPaid, week1AnyPaid),
        ],
        [
          `Week 2 (${w2s} → ${w2e})`,
          String(week2Total),
          String(week2Rows.length),
          commissionLabel(week2Rows, week2AllPaid, week2AnyPaid),
        ],
      ];

      const grandTotal = week1Total + week2Total;

      return {
        title: `Delivery summary for ${rem} — Total cylinders: ${grandTotal} across 2 weeks`,
        headers: ['Period', 'Total Cylinders', 'Deliveries', 'Commission'],
        rows: summaryRows,
      };
    }

    // ── CLOSING BALANCE ────────────────────────────────────────────────
    if (cat === 'CLOSING BALANCE') {
      if (!date) {
        return { title: 'No date on this record to compare against', headers: [], rows: [] };
      }

      const cursor = new Date(date);
      let prevDateStr = '';
      let dayRows: any[] = [];

      for (let i = 1; i <= 7; i++) {
        cursor.setDate(cursor.getDate() - 1);
        const candidate = cursor.toISOString().slice(0, 10);

        const { data: candidateRows, error: candErr } = await supabase
          .from(TABLES.dailyRecord)
          .select('transactions, amount')
          .eq('date', candidate);

        if (candErr) throw candErr;

        if (candidateRows && candidateRows.length > 0) {
          prevDateStr = candidate;
          dayRows = candidateRows;
          break;
        }
      }

      if (!prevDateStr) {
        return {
          title: 'No prior day with entries found in the last 7 days',
          headers: [],
          rows: [],
        };
      }

      const debitTotal = dayRows
        .filter((r: any) => r.transactions === 'DEBIT')
        .reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0);
      const creditTotal = dayRows
        .filter((r: any) => r.transactions === 'CREDIT')
        .reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0);
      const balance = creditTotal - debitTotal;

      return {
        title: `Previous business day: ${prevDateStr}`,
        headers: ['Field', 'Value'],
        rows: [
          ['Date', prevDateStr],
          ['Total Debit', String(debitTotal)],
          ['Total Credit', String(creditTotal)],
          ['Closing Balance (Credit − Debit)', String(balance)],
        ],
      };
    }

    // ── ONLINE PAYMENT ─────────────────────────────────────────────────
    if (cat === 'ONLINE PAYMENT') {
      if (!date) {
        return { title: 'No date on this record to compare against', headers: [], rows: [] };
      }

      const { data, error } = await supabase
        .from(TABLES.onlinePaymentDetails)
        .select('*')
        .eq('date', date)
        .order('id', { ascending: true });

      if (error) throw error;

      const rows = data ?? [];
      const cylinderTotal = rows.reduce(
        (sum: number, r: any) => sum + Number(r.no_of_cylinder || 0),
        0
      );
      const recordAmount = amount ?? 0;
      const matches = cylinderTotal === recordAmount;

      const msg = matches
        ? `✅ Match: total cylinders (${cylinderTotal}) equals amount (${recordAmount}) for ${date}`
        : `⚠️ Mismatch: total cylinders (${cylinderTotal}) does not equal amount (${recordAmount}) for ${date}`;

      return {
        title: `${msg} — showing all ${rows.length} row(s) for ${date}`,
        headers: ['ID', 'No. of Cylinders', 'Amount', 'Date'],
        rows: rows.map((r: any) => [
          String(r.id),
          String(r.no_of_cylinder ?? ''),
          String(r.amount ?? ''),
          String(r.date ?? ''),
        ]),
      };
    }

    return {
      title: 'No side-table effects for this category',
      headers: [],
      rows: [],
    };
  } catch (e: any) {
    return {
      title: `Preview failed to load: ${e.message ?? 'unknown error'}`,
      headers: [],
      rows: [],
    };
  }
}

// ── 4a. Approve ─────────────────────────────────────────────────────────

export async function approveSachinRecord(
  record: SachinRecord,
  edits: {
    category: string;
    remarks: string;
    rate: number;
    quantity: number;
    amount: number;
  }
): Promise<void> {
  const category = (edits.category || record.category).toUpperCase().trim();
  const remarks = edits.remarks ?? record.remarks;
  const remarksUpper = remarks.toUpperCase().trim();
  const rate = edits.rate ?? record.rate;
  const quantity = edits.quantity ?? record.quantity;
  const amount = edits.amount ?? record.amount;
  const date = record.date;

  // 1. Copy to DailyRecord
  const { error: insertError } = await supabase.from(TABLES.dailyRecord).insert({
    date,
    transactions: record.transactions,
    category,
    rate,
    quantity,
    amount,
    remarks,
  });
  if (insertError) throw insertError;

  // 2. Category-specific side effects
  if (category === 'COMMERCIAL PAYMENT') {
    try {
      const customerName = remarksUpper.split('(')[0]?.trim();
      const deliveryDateStr = remarksUpper.split('(')[1]?.replace(')', '').trim();

      const { data: pendingRows, error: fetchErr } = await supabase
        .from(TABLES.commercialRecords)
        .select('id')
        .eq('customer_name', customerName)
        .eq('delivery_date', deliveryDateStr)
        .is('payment_date', null)
        .order('id', { ascending: true })
        .limit(quantity);

      if (fetchErr) throw fetchErr;

      const ids = (pendingRows ?? []).map((r: any) => r.id);
      if (ids.length) {
        const { error: updateErr } = await supabase
          .from(TABLES.commercialRecords)
          .update({ payment_date: date, amount: rate })
          .in('id', ids);
        if (updateErr) throw updateErr;
      }
    } catch (e: any) {
      console.error('Commercial payment side-effect failed:', e.message);
    }
  } else if (category === 'BALANCE') {
    const balanceName = (remarksUpper.includes('(')
      ? remarksUpper.split('(')[0]
      : remarksUpper
    ).trim();

    if (record.transactions === 'DEBIT') {
      const { error } = await supabase.from(TABLES.debitBalanceReport).insert({
        date,
        name: balanceName,
        amount,
        approve_status: true,
      });
      if (error) throw error;
    } else if (record.transactions === 'CREDIT') {
      const { data: balRow, error: fetchErr } = await supabase
        .from(TABLES.debitBalanceReport)
        .select('*')
        .eq('name', balanceName)
        .eq('status', false)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      if (!balRow) {
        console.warn(`No open DebitBalanceReport found for ${balanceName}`);
      } else {
        const newAmountRec = (balRow.amount_rec ?? 0) + amount;
        let dateReceived = balRow.date_received || String(date);
        if (!dateReceived.includes(String(date))) {
          dateReceived += `, ${date}`;
        }
        const { error: updateErr } = await supabase
          .from(TABLES.debitBalanceReport)
          .update({
            amount_rec: newAmountRec,
            date_received: dateReceived,
            status: balRow.amount === newAmountRec,
            approve_status: true,
          })
          .eq('id', balRow.id);
        if (updateErr) throw updateErr;
      }
    }
  } else if (category === 'WEEKLY SALARY') {
    const newDate = new Date(date);
    newDate.setDate(newDate.getDate() - 1);
    const newDateStr = newDate.toISOString().slice(0, 10);
    const deliveryBoy = remarksUpper;

    const { error } = await supabase
      .from(TABLES.deliveryRecords)
      .update({ commission_given: true })
      .eq('name', deliveryBoy)
      .eq('commission_given', false)
      .lte('date', newDateStr);
    if (error) throw error;

    if (deliveryBoy === 'NAMDEV - 19 KG') {
      const { error: comErr } = await supabase
        .from(TABLES.commercialRecords)
        .update({ commision_given: true })
        .lte('delivery_date', date);
      if (comErr) throw comErr;
    }
  }

  // 3. Mark done
  const { error: doneErr } = await supabase
    .from(TABLES.sachin)
    .update({ check_done: true, category, remarks, rate, quantity, amount })
    .eq('id', record.id);
  if (doneErr) throw doneErr;
}

// ── 4b. Reject ───────────────────────────────────────────────────────────

export async function rejectSachinRecord(recordId: number): Promise<void> {
  const { error } = await supabase
    .from(TABLES.sachin)
    .update({ check_done: true })
    .eq('id', recordId);
  if (error) throw error;
}
