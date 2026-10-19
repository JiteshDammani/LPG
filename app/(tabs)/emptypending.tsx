import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import { format, parseISO, startOfMonth, endOfMonth, subMonths } from 'date-fns';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BPCL_BLUE            = '#017DC5';
const EMPTY_PENDING_MARKER = '1990-01-01';
const GREEN                = '#1e8e3e';
const RED                  = '#c0392b';

// ─────────────────────────────────────────────────────────────────────────────
// Debug logging helpers
// ─────────────────────────────────────────────────────────────────────────────
// Every fetch / user action logs through here with a consistent prefix, so
// that if the screen ever appears to "hang" or crash, you can open the
// Metro / device logs, filter for "[EmptyReceived]" and see exactly which
// step was last reached (query started -> query finished -> state updated).

const DEBUG_PREFIX = '[EmptyReceived]';

function log(...args: any[]) {
  console.log(DEBUG_PREFIX, ...args);
}

function logError(...args: any[]) {
  console.error(DEBUG_PREFIX, ...args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ViewMode = 'monthly' | 'datewise';
type ReportMode = 'customer' | 'daterange' | 'monthlyReport';

interface RawRecord {
  id: number;
  customer_name: string;
  delivery_date: string;
  empty_received: string | null;
}

// Pending view row — grouped by month or date, just cylinders
interface PendingRow {
  label: string;      // "March 2026" or "03-03-2026"
  cylinders: number;
  isSub?: boolean;    // unused now but kept for safety
}

// All-records row — one row per delivery_date + empty_received combo
interface AllEmptyRow {
  deliveryDate: string;       // formatted dd-MM-yyyy
  emptyReceivedDate: string;  // formatted dd-MM-yyyy or 'Not Received'
  cylinders: number;
  isPending: boolean;
}

// One customer's pending rows within the "Date Wise (All Customers)" report
interface CustomerGroup {
  customerName: string;
  rows: PendingRow[];
  subtotalCyls: number;
}

// Monthly Report — a dashboard_commercialstock day row
interface StockDayRow {
  date: string;
  closing_full: number;
  closing_empty: number;
  remarks: string | null;
}

// Monthly Report — per-customer aggregate from remarks parsing
interface RemarkAgg {
  name: string;
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function dateKey(d: string) { return d.slice(0, 10); }

function fmtDate(d: string | null): string {
  if (!d) return '—';
  try { return format(parseISO(d), 'dd-MM-yyyy'); }
  catch { return d; }
}

// Same as fmtDate, but blanks out the "not received" marker instead of showing it.
function fmtDateOrBlank(d: string | null): string {
  if (!d || d === EMPTY_PENDING_MARKER) return '';
  try { return format(parseISO(d), 'dd-MM-yyyy'); }
  catch { return d; }
}

// Converts a JS Date to a "YYYY-MM-DD" key (local date, not UTC).
function toDateKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

// Filters raw records down to those whose delivery_date falls within
// [start, end] (inclusive). Either bound may be omitted.
function filterRecordsByRange(
  records: RawRecord[],
  start: string | null,
  end: string | null,
): RawRecord[] {
  if (!start && !end) return records;
  return records.filter(r => {
    const d = dateKey(r.delivery_date);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

const MONTH_NAMES: Record<number, string> = {
  1: 'January',   2: 'February', 3: 'March',    4: 'April',
  5: 'May',       6: 'June',     7: 'July',      8: 'August',
  9: 'September', 10: 'October', 11: 'November', 12: 'December',
};

function monthLabel(d: string): string {
  const dt = parseISO(d);
  return `${MONTH_NAMES[dt.getMonth() + 1]} ${dt.getFullYear()}`;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - 2022 + 2 }, (_, i) => 2022 + i);

function getMonthRange(year: number, month: number) {
  const base = new Date(year, month - 1, 1);
  return {
    start: format(startOfMonth(base), 'yyyy-MM-dd'),
    end:   format(endOfMonth(base), 'yyyy-MM-dd'),
  };
}

function getPrevMonthLastDay(year: number, month: number) {
  const base = new Date(year, month - 1, 1);
  return format(endOfMonth(subMonths(base, 1)), 'yyyy-MM-dd');
}

// Parses "NAME (FULL|EMPTY): ±qty;" entries out of a remarks string.
// The FULL/EMPTY tag is intentionally ignored — only name + signed qty matter.
function parseRemarks(remarks: string | null): { name: string; value: number }[] {
  if (!remarks) return [];
  const out: { name: string; value: number }[] = [];
  // Name group excludes ';' (and other stray punctuation) so that, after one
  // "NAME (FULL|EMPTY): qty;" entry is consumed, the leftover ";" separating
  // it from the next entry doesn't get swallowed into the next name — that
  // was producing names like "; MANGALAM" instead of "MANGALAM".
  const regex = /([^();]+)\(\s*(?:FULL|EMPTY)\s*\)\s*:\s*(-?\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(remarks)) !== null) {
    // Extra safety net: strip any other stray leading punctuation/whitespace
    // that might slip in from inconsistent remark formatting.
    const name = m[1].trim().toUpperCase().replace(/^[^A-Z0-9]+/, '');
    const value = parseInt(m[2], 10);
    if (name && !isNaN(value)) out.push({ name, value });
  }
  return out;
}

function aggregateRemarks(rows: StockDayRow[]): RemarkAgg[] {
  const map: Record<string, number> = {};
  for (const row of rows) {
    for (const e of parseRemarks(row.remarks)) {
      map[e.name] = (map[e.name] || 0) + e.value;
    }
  }
  return Object.entries(map)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Monthly Pending Rows
// ─────────────────────────────────────────────────────────────────────────────

function buildMonthlyRows(records: RawRecord[]): PendingRow[] {
  const grouped: Record<string, number> = {};
  for (const r of records) {
    const key = monthLabel(r.delivery_date);
    grouped[key] = (grouped[key] || 0) + 1;
  }
  return Object.entries(grouped).map(([label, cylinders]) => ({ label, cylinders }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Date-wise Pending Rows
// ─────────────────────────────────────────────────────────────────────────────

function buildDatewiseRows(records: RawRecord[]): PendingRow[] {
  const grouped: Record<string, number> = {};
  for (const r of records) {
    const key = dateKey(r.delivery_date);
    grouped[key] = (grouped[key] || 0) + 1;
  }
  return Object.entries(grouped)
    .sort()
    .map(([date, cylinders]) => ({ label: fmtDate(date), cylinders }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Build All Empty Rows (delivery_date + empty_received combos)
// ─────────────────────────────────────────────────────────────────────────────

function buildAllEmptyRows(records: RawRecord[]): AllEmptyRow[] {
  // Group by "deliveryDate|emptyReceivedKey"
  const grouped: Record<string, { count: number; emptyReceived: string | null }> = {};

  for (const r of records) {
    const erKey =
      r.empty_received === EMPTY_PENDING_MARKER || r.empty_received === null
        ? 'PENDING'
        : dateKey(r.empty_received);
    const key = `${dateKey(r.delivery_date)}|${erKey}`;

    if (!grouped[key]) {
      grouped[key] = { count: 0, emptyReceived: r.empty_received };
    }
    grouped[key].count += 1;
  }

  return Object.entries(grouped)
    .sort()
    .map(([key, val]) => {
      const [delivDate] = key.split('|');
      const isPending =
        val.emptyReceived === EMPTY_PENDING_MARKER || val.emptyReceived === null;
      return {
        deliveryDate:      fmtDate(delivDate),
        emptyReceivedDate: isPending ? 'Not Received' : fmtDate(val.emptyReceived),
        cylinders:         val.count,
        isPending,
      };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Customer Groups — "Date Wise (All Customers)" report
// ─────────────────────────────────────────────────────────────────────────────

function buildCustomerGroups(
  records: RawRecord[],
  mode: ViewMode,
): CustomerGroup[] {
  const grouped: Record<string, RawRecord[]> = {};
  for (const r of records) {
    if (!grouped[r.customer_name]) grouped[r.customer_name] = [];
    grouped[r.customer_name].push(r);
  }

  const groups: CustomerGroup[] = [];

  for (const customerName of Object.keys(grouped).sort()) {
    const custRecords = grouped[customerName];
    const rows = mode === 'monthly'
      ? buildMonthlyRows(custRecords)
      : buildDatewiseRows(custRecords);

    if (rows.length === 0) continue;

    const subtotalCyls = rows.reduce((s, r) => s + r.cylinders, 0);
    groups.push({ customerName, rows, subtotalCyls });
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — Pending view (monthly or datewise)
// ─────────────────────────────────────────────────────────────────────────────

function buildPendingPdfHtml(
  consumerName: string,
  viewMode: ViewMode,
  rows: PendingRow[],
): string {
  const totalCyls = rows.reduce((s, r) => s + r.cylinders, 0);
  const colHeader = viewMode === 'monthly' ? 'Month' : 'Date';

  const tableRows = rows
    .map(r => `
    <tr>
      <td class="left">${r.label}</td>
      <td>${r.cylinders}</td>
    </tr>`)
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #000; }
  .header { text-align:center; margin-bottom:12px; }
  .header h1 { font-size:15pt; font-weight:bold; }
  .header h2 { font-size:10pt; font-weight:normal; margin-top:3px; color:#444; }
  .title { font-size:12pt; font-weight:bold; text-align:center;
           text-decoration:underline; margin:8px 0 16px; }
  table { width:60%; margin: 0 auto; border-collapse:collapse; }
  th,td { border:1px solid #666; padding:8px 10px; text-align:center; font-size:10pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.left { text-align:left; }
  .total-row td { font-weight:bold; background:#e8ecf0; }
  .footer { margin-top:20px; font-size:8.5pt; text-align:right; color:#666; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Empty Cylinders — Pending Returns</h2>
</div>
<div class="title">EMPTY PENDING — ${consumerName.toUpperCase()}</div>
<table>
  <thead>
    <tr>
      <th style="text-align:left">${colHeader}</th>
      <th>Cylinders</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
    <tr class="total-row">
      <td class="left">TOTAL</td>
      <td>${totalCyls}</td>
    </tr>
  </tbody>
</table>
<div class="footer">Generated on ${format(new Date(), 'dd-MM-yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — All records view
// ─────────────────────────────────────────────────────────────────────────────

function buildAllEmptyPdfHtml(
  consumerName: string,
  rows: AllEmptyRow[],
): string {
  const totalCyls = rows.reduce((s, r) => s + r.cylinders, 0);

  const tableRows = rows
    .map(r => `
    <tr class="${r.isPending ? 'pending-row' : ''}">
      <td>${r.deliveryDate}</td>
      <td class="${r.isPending ? 'pending-tag' : ''}">${r.emptyReceivedDate}</td>
      <td>${r.cylinders}</td>
    </tr>`)
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #000; }
  .header { text-align:center; margin-bottom:12px; }
  .header h1 { font-size:15pt; font-weight:bold; }
  .header h2 { font-size:10pt; font-weight:normal; margin-top:3px; color:#444; }
  .title { font-size:12pt; font-weight:bold; text-align:center;
           text-decoration:underline; margin:8px 0 16px; }
  table { width:70%; margin: 0 auto; border-collapse:collapse; }
  th,td { border:1px solid #666; padding:8px 10px; text-align:center; font-size:10pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.pending-tag { color:#c0392b; font-weight:bold; }
  .pending-row td { background:#fff5f5; }
  .total-row td { font-weight:bold; background:#e8ecf0; }
  .footer { margin-top:20px; font-size:8.5pt; text-align:right; color:#666; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Empty Cylinders — Complete History</h2>
</div>
<div class="title">ALL EMPTY RECORDS — ${consumerName.toUpperCase()}</div>
<table>
  <thead>
    <tr>
      <th>Delivery Date</th>
      <th>Empty Received Date</th>
      <th>Cylinders</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
    <tr class="total-row">
      <td colspan="2">TOTAL</td>
      <td>${totalCyls}</td>
    </tr>
  </tbody>
</table>
<div class="footer">Generated on ${format(new Date(), 'dd-MM-yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — Date Wise (All Customers), grouped by customer → month/date → cylinders
// ─────────────────────────────────────────────────────────────────────────────

function buildAllCustomersPdfHtml(
  mode: ViewMode,
  groups: CustomerGroup[],
  rangeLabel: string | null,
): string {
  const colHeader  = mode === 'monthly' ? 'Month' : 'Date';
  const grandCyls  = groups.reduce((s, g) => s + g.subtotalCyls, 0);

  const groupsHtml = groups.map(g => `
    <tr class="customer-row"><td colspan="2" class="left">${g.customerName.toUpperCase()}</td></tr>
    ${g.rows.map(r => `
      <tr>
        <td class="left">${r.label}</td>
        <td>${r.cylinders}</td>
      </tr>`).join('')}
    <tr class="subtotal-row">
      <td class="left">Subtotal — ${g.customerName}</td>
      <td>${g.subtotalCyls}</td>
    </tr>
  `).join('');

  const rangeHtml = rangeLabel
    ? `<div class="range-note">Filtered range: ${rangeLabel}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #000; }
  .header { text-align:center; margin-bottom:12px; }
  .header h1 { font-size:15pt; font-weight:bold; }
  .header h2 { font-size:10pt; font-weight:normal; margin-top:3px; color:#444; }
  .title { font-size:12pt; font-weight:bold; text-align:center;
           text-decoration:underline; margin:8px 0 4px; }
  .range-note { text-align:center; font-size:9.5pt; color:#555; margin-bottom:14px; }
  table { width:70%; margin: 0 auto; border-collapse:collapse; }
  th,td { border:1px solid #666; padding:8px 10px; text-align:center; font-size:10pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.left { text-align:left; }
  .customer-row td { background:#017DC5; color:#fff; font-weight:bold; font-size:10.5pt; }
  .subtotal-row td { font-weight:bold; background:#eef3fb; }
  .grand-total-row td { font-weight:bold; background:#e8ecf0; font-size:11pt; }
  .footer { margin-top:20px; font-size:8.5pt; text-align:right; color:#666; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Empty Cylinders — Pending Returns, All Customers</h2>
</div>
<div class="title">DATE WISE EMPTY PENDING — ALL CUSTOMERS</div>
${rangeHtml}
<table>
  <thead>
    <tr>
      <th style="text-align:left">${colHeader}</th>
      <th>Cylinders</th>
    </tr>
  </thead>
  <tbody>
    ${groupsHtml}
    <tr class="grand-total-row">
      <td class="left">GRAND TOTAL — ALL CUSTOMERS</td>
      <td>${grandCyls}</td>
    </tr>
  </tbody>
</table>
<div class="footer">Generated on ${format(new Date(), 'dd-MM-yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — Monthly Report (reconciliation)
// ─────────────────────────────────────────────────────────────────────────────

interface MonthlyReportPdfData {
  year: number;
  month: number;
  prevMonthLastDay: string;
  monthLastDay: string;
  openingRow: StockDayRow | null;
  openingMissing: boolean;
  openingTotal: number | null;
  closingRow: StockDayRow | null;
  closingMissing: boolean;
  closingActualTotal: number | null;
  section1: RawRecord[];
  section2: RawRecord[];
  section4: RawRecord[];
  remarkAgg: RemarkAgg[];
  section3Total: number;
  expectedClosing: number | null;
  deliveredCount: number;
  emptyReceivedCount: number;
}

function recordsTableRows(records: RawRecord[]): string {
  if (records.length === 0) {
    return `<tr><td colspan="3" class="none-cell">No records.</td></tr>`;
  }
  return records.map(r => `
    <tr>
      <td class="left">${r.customer_name}</td>
      <td>${fmtDate(r.delivery_date)}</td>
      <td>${fmtDateOrBlank(r.empty_received) || '—'}</td>
    </tr>`).join('');
}

function buildMonthlyReportPdfHtml(d: MonthlyReportPdfData): string {
  const monthName   = `${MONTH_NAMES[d.month]} ${d.year}`;
  const diff         = (d.closingActualTotal !== null && d.expectedClosing !== null)
    ? d.closingActualTotal - d.expectedClosing
    : null;
  const canVerify    = d.expectedClosing !== null && d.closingActualTotal !== null;
  const isMatch      = canVerify && d.expectedClosing === d.closingActualTotal;

  const remarkRows = d.remarkAgg.length === 0
    ? `<tr><td colspan="2" class="none-cell">No remark adjustments this month.</td></tr>`
    : d.remarkAgg.map(r => `
      <tr>
        <td class="left">${r.name}</td>
        <td class="${r.total < 0 ? 'neg' : ''}">${r.total > 0 ? `+${r.total}` : r.total}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 9.5pt; color: #000; }
  .header { text-align:center; margin-bottom:12px; }
  .header h1 { font-size:15pt; font-weight:bold; }
  .header h2 { font-size:10pt; font-weight:normal; margin-top:3px; color:#444; }
  .title { font-size:12pt; font-weight:bold; text-align:center;
           text-decoration:underline; margin:8px 0 18px; }
  .section-title {
    font-size:10.5pt; font-weight:bold; background:#017DC5; color:#fff;
    padding:6px 10px; border-radius:4px; margin:16px 0 8px;
  }
  .section-title.first { margin-top: 0; }
  table { width:100%; border-collapse:collapse; margin-bottom:4px; }
  th,td { border:1px solid #666; padding:6px 8px; text-align:center; font-size:9pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.left { text-align:left; }
  td.neg { color:#c0392b; font-weight:bold; }
  td.none-cell { text-align:center; color:#999; font-style:italic; }
  .total-row td { font-weight:bold; background:#e8ecf0; }
  .stat-grid {
    display:flex; flex-wrap:wrap; gap:10px; margin-bottom:6px;
  }
  .stat-box {
    border:1px solid #ccc; border-radius:6px; padding:8px 12px;
    background:#fafbfc; min-width: 130px;
  }
  .stat-label { font-size:8pt; color:#888; text-transform:uppercase; letter-spacing:0.5px; }
  .stat-value { font-size:14pt; font-weight:800; color:#222; margin-top:2px; }
  .warn { color:#c0392b; font-weight:bold; font-size:9pt; }
  .formula { font-size:11pt; font-weight:700; text-align:center; margin: 10px 0; }
  .status-pill {
    display:inline-block; border-radius:14px; padding:6px 14px;
    font-weight:800; font-size:10pt; color:#fff; margin-top:6px;
  }
  .status-match    { background:#1e8e3e; }
  .status-mismatch { background:#c0392b; }
  .footer { margin-top:20px; font-size:8.5pt; text-align:right; color:#666; }
  .note { font-size:8pt; color:#888; margin-top:4px; font-style:italic; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Empty Cylinders — Monthly Reconciliation Report</h2>
</div>
<div class="title">MONTHLY REPORT — ${monthName.toUpperCase()}</div>

<div class="section-title first">OPENING STOCK (${fmtDate(d.prevMonthLastDay)})</div>
${d.openingMissing
  ? `<p class="warn">No stock row found for ${fmtDate(d.prevMonthLastDay)}.</p>`
  : `<div class="stat-grid">
      <div class="stat-box"><div class="stat-label">Opening Total</div><div class="stat-value">${d.openingTotal}</div></div>
      <div class="stat-box"><div class="stat-label">Full</div><div class="stat-value">${d.openingRow?.closing_full}</div></div>
      <div class="stat-box"><div class="stat-label">Empty</div><div class="stat-value">${d.openingRow?.closing_empty}</div></div>
    </div>`
}

<div class="section-title">SECTION 1 — DELIVERED THIS MONTH, EMPTY NOT RETURNED THIS MONTH (subtracted)</div>
<table>
  <thead><tr><th style="text-align:left">Customer</th><th>Delivery Date</th><th>Empty Received</th></tr></thead>
  <tbody>${recordsTableRows(d.section1)}</tbody>
</table>
<table><tbody><tr class="total-row"><td class="left">Total</td><td colspan="2">${d.section1.length}</td></tr></tbody></table>

<div class="section-title">SECTION 2 — RETURNED THIS MONTH, DELIVERED EARLIER (added)</div>
<table>
  <thead><tr><th style="text-align:left">Customer</th><th>Delivery Date</th><th>Empty Received</th></tr></thead>
  <tbody>${recordsTableRows(d.section2)}</tbody>
</table>
<table><tbody><tr class="total-row"><td class="left">Total</td><td colspan="2">${d.section2.length}</td></tr></tbody></table>

<div class="section-title">SECTION 3 — MANUAL STOCK ADJUSTMENTS (added/subtracted)</div>
<table>
  <thead><tr><th style="text-align:left">Customer</th><th>Net Qty</th></tr></thead>
  <tbody>${remarkRows}</tbody>
</table>
<table><tbody><tr class="total-row"><td class="left">Total</td><td class="${d.section3Total < 0 ? 'neg' : ''}">${d.section3Total > 0 ? `+${d.section3Total}` : d.section3Total}</td></tr></tbody></table>

<div class="section-title">SECTION 4 — DELIVERED &amp; RETURNED SAME MONTH (informative only)</div>
<table>
  <thead><tr><th style="text-align:left">Customer</th><th>Delivery Date</th><th>Empty Received</th></tr></thead>
  <tbody>${recordsTableRows(d.section4)}</tbody>
</table>
<p class="note">${d.section4.length} record(s) — not part of the reconciliation total.</p>

<div class="section-title">RECONCILIATION</div>
<p class="formula">
  ${d.openingTotal ?? '—'}  −  ${d.section1.length}  +  ${d.section2.length}  +  ${d.section3Total}
  &nbsp;=&nbsp; <strong>${d.expectedClosing ?? '—'}</strong>
</p>
<div class="stat-grid">
  <div class="stat-box"><div class="stat-label">Expected Closing</div><div class="stat-value">${d.expectedClosing ?? '—'}</div></div>
  <div class="stat-box">
    <div class="stat-label">Actual Closing (${fmtDate(d.monthLastDay)})</div>
    ${d.closingMissing
      ? `<div class="warn">No row for ${fmtDate(d.monthLastDay)}</div>`
      : `<div class="stat-value">${d.closingActualTotal}</div>`}
  </div>
</div>
${canVerify
  ? `<span class="status-pill ${isMatch ? 'status-match' : 'status-mismatch'}">
      ${isMatch ? 'MATCHED' : `MISMATCH (diff ${diff})`}
    </span>`
  : ''}

<div class="section-title">MONTH SUMMARY</div>
<table>
  <thead>
    <tr>
      <th>Prev Month Stock</th><th>Total Delivered</th><th>Total Empty Recvd</th><th>Total Extra</th><th>Month Closing</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>${d.openingTotal ?? '—'}</td>
      <td>${d.deliveredCount}</td>
      <td>${d.emptyReceivedCount}</td>
      <td>${d.section3Total}</td>
      <td>${d.closingActualTotal ?? '—'}</td>
    </tr>
  </tbody>
</table>

<div class="section-title">CYLINDERS DELIVERED &amp; EMPTY RECEIVED — ${monthName.toUpperCase()}</div>
<div class="stat-grid">
  <div class="stat-box"><div class="stat-label">Cylinders Delivered</div><div class="stat-value">${d.deliveredCount}</div></div>
  <div class="stat-box"><div class="stat-label">Empty Received</div><div class="stat-value">${d.emptyReceivedCount}</div></div>
</div>

<div class="footer">Generated on ${format(new Date(), 'dd-MM-yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function CommercialEmptyReceivedScreen() {

  // ── State ──────────────────────────────────────────────────────────────────

  // Top-level report type: a single consumer's own view, every consumer's
  // pending empty returns within a date range, or the monthly reconciliation report.
  const [reportMode, setReportMode] = useState<ReportMode>('customer');

  const [consumers,        setConsumers]        = useState<string[]>([]);
  const [selectedConsumer, setSelectedConsumer] = useState<string | null>(null);
  const [consumerSearch,   setConsumerSearch]   = useState('');
  const [dropdownOpen,     setDropdownOpen]     = useState(false);

  const [viewMode,         setViewMode]         = useState<ViewMode>('monthly');
  const [showAll,          setShowAll]          = useState(false);

  const [pendingRows,      setPendingRows]      = useState<PendingRow[]>([]);
  const [allEmptyRows,     setAllEmptyRows]     = useState<AllEmptyRow[]>([]);

  const [loadingConsumers, setLoadingConsumers] = useState(false);
  const [loadingTable,     setLoadingTable]     = useState(false);
  const [loadingPdf,       setLoadingPdf]       = useState(false);

  // Tracks the params ("consumer|viewMode|showAll") that were actually loaded
  // last time the Load/Refresh button was pressed. Data is NEVER fetched
  // automatically just because a filter changed — only this button does that.
  const [lastLoadedCustomerKey, setLastLoadedCustomerKey] = useState<string | null>(null);

  // ── "Date Wise (All Customers)" report state ────────────────────────────────

  const [allViewMode,        setAllViewMode]        = useState<ViewMode>('datewise');
  const [allRangeStart,      setAllRangeStart]      = useState<Date | null>(null);
  const [allRangeEnd,        setAllRangeEnd]        = useState<Date | null>(null);
  const [showAllStartPicker, setShowAllStartPicker] = useState(false);
  const [showAllEndPicker,   setShowAllEndPicker]   = useState(false);

  const [customerGroups,   setCustomerGroups]   = useState<CustomerGroup[]>([]);
  const [loadingAllTable,  setLoadingAllTable]  = useState(false);
  const [loadingAllPdf,    setLoadingAllPdf]    = useState(false);

  // Same idea as lastLoadedCustomerKey, for this report.
  const [lastLoadedAllKey, setLastLoadedAllKey] = useState<string | null>(null);

  const allRangeStartKey = allRangeStart ? toDateKey(allRangeStart) : null;
  const allRangeEndKey   = allRangeEnd ? toDateKey(allRangeEnd) : null;
  const allRangeActive   = allRangeStartKey !== null || allRangeEndKey !== null;
  const allRangeLabel    = allRangeActive
    ? `${allRangeStartKey ? fmtDate(allRangeStartKey) : 'Start'} to ${allRangeEndKey ? fmtDate(allRangeEndKey) : 'End'}`
    : null;

  const onChangeAllStartDate = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === 'android') setShowAllStartPicker(false);
    if (event.type === 'dismissed') return;
    if (picked) setAllRangeStart(picked);
  };

  const onChangeAllEndDate = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === 'android') setShowAllEndPicker(false);
    if (event.type === 'dismissed') return;
    if (picked) setAllRangeEnd(picked);
  };

  // ── "Monthly Report" (reconciliation) state ─────────────────────────────────

  const nowDate = new Date();
  const [monthlyYear,  setMonthlyYear]  = useState(nowDate.getFullYear());
  const [monthlyMonth, setMonthlyMonth] = useState(nowDate.getMonth() + 1); // 1-12

  const [monthlyMonthDropdownOpen, setMonthlyMonthDropdownOpen] = useState(false);
  const [monthlyYearDropdownOpen,  setMonthlyYearDropdownOpen]  = useState(false);

  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [loadingMonthlyPdf, setLoadingMonthlyPdf] = useState(false);

  const [openingRow,     setOpeningRow]     = useState<StockDayRow | null>(null);
  const [openingMissing, setOpeningMissing] = useState(false);

  const [closingRow,     setClosingRow]     = useState<StockDayRow | null>(null);
  const [closingMissing, setClosingMissing] = useState(false);

  const [monthlySection1, setMonthlySection1] = useState<RawRecord[]>([]);
  const [monthlySection2, setMonthlySection2] = useState<RawRecord[]>([]);
  const [monthlySection4, setMonthlySection4] = useState<RawRecord[]>([]);

  const [remarkAgg, setRemarkAgg] = useState<RemarkAgg[]>([]);

  const [monthlyDeliveredCount,     setMonthlyDeliveredCount]     = useState(0);
  const [monthlyEmptyReceivedCount, setMonthlyEmptyReceivedCount] = useState(0);

  // Same idea again, for the monthly reconciliation report.
  const [lastLoadedMonthlyKey, setLastLoadedMonthlyKey] = useState<string | null>(null);

  // ── Load consumer list (this one loads automatically — it's just the
  //    dropdown of names, not a data table, so it's cheap and safe) ──────────

  useEffect(() => {
    (async () => {
      setLoadingConsumers(true);
      log('Loading consumer list...');
      try {
        const { data, error } = await supabase
          .from('dashboard_commercialrecords')
          .select('customer_name')
          .gt('delivery_date', '2022-01-01')
          .eq('empty_received', EMPTY_PENDING_MARKER);
        if (error) throw error;
        const names = [
          ...new Set((data || []).map((r: any) => r.customer_name as string)),
        ].sort();
        log('Consumer list loaded:', names.length, 'names');
        setConsumers(names);
      } catch (err: any) {
        logError('Failed to load consumer list:', err);
        Alert.alert('Error', err.message || 'Failed to load consumers.');
      } finally {
        setLoadingConsumers(false);
      }
    })();
  }, []);

  // ── Fetch data (Customer Wise) ───────────────────────────────────────────────

  const fetchData = useCallback(async (
    consumer: string,
    mode: ViewMode,
    allFlag: boolean,
  ) => {
    setLoadingTable(true);
    setPendingRows([]);
    setAllEmptyRows([]);
    log('fetchData: start', { consumer, mode, allFlag });

    try {
      let query = supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, empty_received')
        .eq('customer_name', consumer)
        .gt('delivery_date', '2022-01-01')
        .order('delivery_date', { ascending: true });

      // Show all: fetch all records for this consumer
      // Pending only: filter to marker date
      if (!allFlag) {
        query = query.eq('empty_received', EMPTY_PENDING_MARKER);
      }

      const { data: records, error } = await query;
      if (error) throw error;
      log('fetchData: query returned', records?.length ?? 0, 'records');
      if (!records || records.length === 0) return;

      if (allFlag) {
        // Always datewise when showing all
        setAllEmptyRows(buildAllEmptyRows(records as RawRecord[]));
      } else if (mode === 'monthly') {
        setPendingRows(buildMonthlyRows(records as RawRecord[]));
      } else {
        setPendingRows(buildDatewiseRows(records as RawRecord[]));
      }
      log('fetchData: done, rows built');
    } catch (err: any) {
      logError('fetchData: failed', err);
      Alert.alert('Error', err.message || 'Failed to load data.');
    } finally {
      setLoadingTable(false);
    }
  }, []);

  // Params changed -> clear the stale table and require the Load/Refresh
  // button to be pressed again. We deliberately do NOT auto-fetch here.
  useEffect(() => {
    log('Customer report options changed', { selectedConsumer, viewMode, showAll });
    setPendingRows([]);
    setAllEmptyRows([]);
    setLastLoadedCustomerKey(null);
  }, [selectedConsumer, viewMode, showAll]);

  const handleLoadCustomerData = () => {
    if (!selectedConsumer) return;
    log('Load/Refresh pressed (customer report)', { selectedConsumer, viewMode, showAll });
    setLastLoadedCustomerKey(`${selectedConsumer}|${viewMode}|${showAll}`);
    fetchData(selectedConsumer, viewMode, showAll);
  };

  // ── Fetch data (Date Wise — All Customers) ──────────────────────────────────

  const fetchAllCustomersData = useCallback(async (
    mode: ViewMode,
    rStart: string | null,
    rEnd: string | null,
  ) => {
    setLoadingAllTable(true);
    setCustomerGroups([]);
    log('fetchAllCustomersData: start', { mode, rStart, rEnd });

    try {
      // Every customer's pending empty returns, across the board
      const { data: records, error } = await supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, empty_received')
        .eq('empty_received', EMPTY_PENDING_MARKER)
        .gt('delivery_date', '2022-01-01')
        .order('customer_name', { ascending: true })
        .order('delivery_date', { ascending: true });
      if (error) throw error;
      log('fetchAllCustomersData: query returned', records?.length ?? 0, 'records');
      if (!records || records.length === 0) return;

      // Apply the date-range filter
      const rangedRecords = filterRecordsByRange(records as RawRecord[], rStart, rEnd);
      log('fetchAllCustomersData: after range filter ->', rangedRecords.length, 'records');
      if (rangedRecords.length === 0) return;

      setCustomerGroups(buildCustomerGroups(rangedRecords, mode));
      log('fetchAllCustomersData: done, groups built');
    } catch (err: any) {
      logError('fetchAllCustomersData: failed', err);
      Alert.alert('Error', err.message || 'Failed to load data.');
    } finally {
      setLoadingAllTable(false);
    }
  }, []);

  // Params changed -> clear stale table, require Load/Refresh button again.
  useEffect(() => {
    log('Date-wise (all customers) filters changed', { allViewMode, allRangeStartKey, allRangeEndKey });
    setCustomerGroups([]);
    setLastLoadedAllKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allViewMode, allRangeStart, allRangeEnd]);

  const handleLoadAllCustomersData = () => {
    log('Load/Refresh pressed (date-wise all customers)', { allViewMode, allRangeStartKey, allRangeEndKey });
    setLastLoadedAllKey(`${allViewMode}|${allRangeStartKey ?? ''}|${allRangeEndKey ?? ''}`);
    fetchAllCustomersData(allViewMode, allRangeStartKey, allRangeEndKey);
  };

  // ── Fetch data (Monthly Report — reconciliation) ────────────────────────────

  const fetchMonthlyReport = useCallback(async (year: number, month: number) => {
    setMonthlyLoading(true);
    setOpeningRow(null);
    setClosingRow(null);
    setOpeningMissing(false);
    setClosingMissing(false);
    setMonthlySection1([]);
    setMonthlySection2([]);
    setMonthlySection4([]);
    setRemarkAgg([]);
    setMonthlyDeliveredCount(0);
    setMonthlyEmptyReceivedCount(0);
    log('fetchMonthlyReport: start', { year, month });

    try {
      const { start: monthStart, end: monthEnd } = getMonthRange(year, month);
      const prevMonthLastDay = getPrevMonthLastDay(year, month);
      log('fetchMonthlyReport: range', { monthStart, monthEnd, prevMonthLastDay });

      // Opening stock — closing_full + closing_empty of last day of previous month
      const openingPromise = supabase
        .from('dashboard_commercialstock')
        .select('date, closing_full, closing_empty, remarks')
        .eq('date', prevMonthLastDay)
        .maybeSingle();

      // Actual closing stock — same, for last day of selected month
      const closingPromise = supabase
        .from('dashboard_commercialstock')
        .select('date, closing_full, closing_empty, remarks')
        .eq('date', monthEnd)
        .maybeSingle();

      // Section 1 — delivered THIS month, but empty NOT received within this
      // month (still pending, or returned in some other month).
      // IMPORTANT: delivery_date must be within the selected month range —
      // previously this was missing, so it was scanning every historical
      // record whose empty_received fell outside the month, regardless of
      // when it was delivered. That was the bug.
      const section1Promise = supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, empty_received')
        .gte('delivery_date', monthStart)
        .lte('delivery_date', monthEnd)
        .or(`empty_received.lt.${monthStart},empty_received.gt.${monthEnd},empty_received.is.null`)
        .order('delivery_date', { ascending: true });

      // Section 2 — empty_received within selected month, delivery_date before month start
      const section2Promise = supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, empty_received')
        .gt('delivery_date', '2022-01-01')
        .gte('empty_received', monthStart)
        .lte('empty_received', monthEnd)
        .lt('delivery_date', monthStart)
        .order('delivery_date', { ascending: true });

      // Section 4 — both delivery_date and empty_received within selected month,
      // but only where they are DIFFERENT dates (informative). Records
      // delivered and returned on the exact same day are excluded — Postgrest
      // can't compare two columns to each other in a filter, so the
      // date != date part is done client-side just below, on the raw results.
      const section4Promise = supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, empty_received')
        .gte('delivery_date', monthStart)
        .lte('delivery_date', monthEnd)
        .gte('empty_received', monthStart)
        .lte('empty_received', monthEnd)
        .order('delivery_date', { ascending: true });

      // Summary — total delivered this month (count only)
      const deliveredCountPromise = supabase
        .from('dashboard_commercialrecords')
        .select('id', { count: 'exact', head: true })
        .gte('delivery_date', monthStart)
        .lte('delivery_date', monthEnd);

      // Summary — total empty received this month (count only)
      const emptyReceivedCountPromise = supabase
        .from('dashboard_commercialrecords')
        .select('id', { count: 'exact', head: true })
        .gte('empty_received', monthStart)
        .lte('empty_received', monthEnd);

      // Section 3 source rows — every commercialstock day-row in the month, for remarks
      const stockDaysPromise = supabase
        .from('dashboard_commercialstock')
        .select('date, closing_full, closing_empty, remarks')
        .gte('date', monthStart)
        .lte('date', monthEnd);

      const [
        openingRes, closingRes,
        s1Res, s2Res, s4Res,
        deliveredCountRes, emptyReceivedCountRes,
        stockDaysRes,
      ] = await Promise.all([
        openingPromise, closingPromise,
        section1Promise, section2Promise, section4Promise,
        deliveredCountPromise, emptyReceivedCountPromise,
        stockDaysPromise,
      ]);

      log('fetchMonthlyReport: all queries settled');

      if (openingRes.error) throw openingRes.error;
      if (closingRes.error) throw closingRes.error;
      if (s1Res.error) throw s1Res.error;
      if (s2Res.error) throw s2Res.error;
      if (s4Res.error) throw s4Res.error;
      if (deliveredCountRes.error) throw deliveredCountRes.error;
      if (emptyReceivedCountRes.error) throw emptyReceivedCountRes.error;
      if (stockDaysRes.error) throw stockDaysRes.error;

      setOpeningRow(openingRes.data as StockDayRow | null);
      setOpeningMissing(!openingRes.data);

      setClosingRow(closingRes.data as StockDayRow | null);
      setClosingMissing(!closingRes.data);

      setMonthlySection1((s1Res.data || []) as RawRecord[]);
      setMonthlySection2((s2Res.data || []) as RawRecord[]);

      // Drop rows where delivery_date and empty_received are the SAME day —
      // only the "different date" entries belong in Section 4.
      const section4Raw = (s4Res.data || []) as RawRecord[];
      const section4Filtered = section4Raw.filter(
        r => dateKey(r.delivery_date) !== dateKey(r.empty_received || ''),
      );
      setMonthlySection4(section4Filtered);

      setMonthlyDeliveredCount(deliveredCountRes.count || 0);
      setMonthlyEmptyReceivedCount(emptyReceivedCountRes.count || 0);

      setRemarkAgg(aggregateRemarks((stockDaysRes.data || []) as StockDayRow[]));

      log('fetchMonthlyReport: done', {
        section1: s1Res.data?.length ?? 0,
        section2: s2Res.data?.length ?? 0,
        section4Raw: section4Raw.length,
        section4Filtered: section4Filtered.length,
        delivered: deliveredCountRes.count,
        emptyReceived: emptyReceivedCountRes.count,
      });

    } catch (err: any) {
      logError('fetchMonthlyReport: failed', err);
      Alert.alert('Error', err.message || 'Failed to load reconciliation data.');
    } finally {
      setMonthlyLoading(false);
    }
  }, []);

  // Params changed -> clear stale report, require Load/Refresh button again.
  useEffect(() => {
    log('Monthly report month/year changed', { monthlyYear, monthlyMonth });
    setOpeningRow(null);
    setClosingRow(null);
    setOpeningMissing(false);
    setClosingMissing(false);
    setMonthlySection1([]);
    setMonthlySection2([]);
    setMonthlySection4([]);
    setRemarkAgg([]);
    setMonthlyDeliveredCount(0);
    setMonthlyEmptyReceivedCount(0);
    setLastLoadedMonthlyKey(null);
  }, [monthlyYear, monthlyMonth]);

  const handleLoadMonthlyReport = () => {
    log('Load/Refresh pressed (monthly report)', { monthlyYear, monthlyMonth });
    setLastLoadedMonthlyKey(`${monthlyYear}|${monthlyMonth}`);
    fetchMonthlyReport(monthlyYear, monthlyMonth);
  };

  // ── PDF (Customer Wise) ───────────────────────────────────────────────────────

  const handleDownloadPdf = async () => {
    if (!selectedConsumer) return;
    const hasData = showAll ? allEmptyRows.length > 0 : pendingRows.length > 0;
    if (!hasData) {
      Alert.alert('No Data', 'No records to generate PDF.');
      return;
    }
    try {
      setLoadingPdf(true);
      log('handleDownloadPdf (customer): generating', { selectedConsumer, showAll, viewMode });
      const html = showAll
        ? buildAllEmptyPdfHtml(selectedConsumer, allEmptyRows)
        : buildPendingPdfHtml(selectedConsumer, viewMode, pendingRows);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      log('handleDownloadPdf (customer): file created at', uri);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType:    'application/pdf',
          dialogTitle: `${selectedConsumer} — Empty Records`,
          UTI:         'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      logError('handleDownloadPdf (customer): failed', err);
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingPdf(false);
    }
  };

  // ── PDF (Date Wise — All Customers) ─────────────────────────────────────────

  const handleDownloadAllPdf = async () => {
    if (customerGroups.length === 0) {
      Alert.alert('No Data', 'No records to generate PDF.');
      return;
    }
    try {
      setLoadingAllPdf(true);
      log('handleDownloadAllPdf: generating', { allViewMode, allRangeLabel });
      const html = buildAllCustomersPdfHtml(allViewMode, customerGroups, allRangeLabel);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      log('handleDownloadAllPdf: file created at', uri);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType:    'application/pdf',
          dialogTitle: 'All Customers — Empty Pending',
          UTI:         'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      logError('handleDownloadAllPdf: failed', err);
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingAllPdf(false);
    }
  };

  // ── PDF (Monthly Report) ─────────────────────────────────────────────────────

  const handleDownloadMonthlyPdf = async () => {
    if (!isMonthlyLoaded) {
      Alert.alert('No Data', 'Load the report before generating a PDF.');
      return;
    }
    try {
      setLoadingMonthlyPdf(true);
      log('handleDownloadMonthlyPdf: generating', { monthlyYear, monthlyMonth });
      const html = buildMonthlyReportPdfHtml({
        year: monthlyYear,
        month: monthlyMonth,
        prevMonthLastDay: monthlyPrevMonthLastDay,
        monthLastDay: monthlyMonthLastDay,
        openingRow,
        openingMissing,
        openingTotal,
        closingRow,
        closingMissing,
        closingActualTotal,
        section1: monthlySection1,
        section2: monthlySection2,
        section4: monthlySection4,
        remarkAgg,
        section3Total,
        expectedClosing,
        deliveredCount: monthlyDeliveredCount,
        emptyReceivedCount: monthlyEmptyReceivedCount,
      });
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      log('handleDownloadMonthlyPdf: file created at', uri);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType:    'application/pdf',
          dialogTitle: `Monthly Report — ${MONTH_NAMES[monthlyMonth]} ${monthlyYear}`,
          UTI:         'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      logError('handleDownloadMonthlyPdf: failed', err);
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingMonthlyPdf(false);
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const filteredConsumers = consumers.filter(c =>
    c.toUpperCase().includes(consumerSearch.toUpperCase()),
  );
  const pendingTotalCyls  = pendingRows.reduce((s, r) => s + r.cylinders, 0);
  const allTotalCyls      = allEmptyRows.reduce((s, r) => s + r.cylinders, 0);
  const hasData           = showAll ? allEmptyRows.length > 0 : pendingRows.length > 0;

  // Customer report — has the current combination of filters been loaded yet?
  const customerParamsKey = selectedConsumer ? `${selectedConsumer}|${viewMode}|${showAll}` : null;
  const isCustomerLoaded  = lastLoadedCustomerKey !== null;
  const isCustomerDirty   = customerParamsKey !== null && customerParamsKey !== lastLoadedCustomerKey;

  const allCustomersGrandCyls = customerGroups.reduce((s, g) => s + g.subtotalCyls, 0);
  const hasAllCustomersData   = customerGroups.length > 0;

  // Date-wise (all customers) — has the current combination of filters been loaded yet?
  const allParamsKey = `${allViewMode}|${allRangeStartKey ?? ''}|${allRangeEndKey ?? ''}`;
  const isAllLoaded   = lastLoadedAllKey !== null;
  const isAllDirty     = allParamsKey !== lastLoadedAllKey;

  // Monthly Report derived totals
  const openingTotal       = openingRow ? openingRow.closing_full + openingRow.closing_empty : null;
  const closingActualTotal = closingRow ? closingRow.closing_full + closingRow.closing_empty : null;

  const section1Total = monthlySection1.length;
  const section2Total = monthlySection2.length;
  const section3Total = remarkAgg.reduce((s, r) => s + r.total, 0);

  const expectedClosing = openingTotal !== null
    ? openingTotal - section1Total + section2Total + section3Total
    : null;

  const canVerify = expectedClosing !== null && closingActualTotal !== null;
  const isMatch   = canVerify && expectedClosing === closingActualTotal;

  const monthlyMonthLastDay     = getMonthRange(monthlyYear, monthlyMonth).end;
  const monthlyPrevMonthLastDay = getPrevMonthLastDay(monthlyYear, monthlyMonth);

  // Monthly report — has the current month/year been loaded yet?
  const monthlyParamsKey = `${monthlyYear}|${monthlyMonth}`;
  const isMonthlyLoaded  = lastLoadedMonthlyKey !== null;
  const isMonthlyDirty   = monthlyParamsKey !== lastLoadedMonthlyKey;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >

        {/* Header */}
        <View style={styles.header}>
          <Ionicons name="cube-outline" size={28} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Empty Cylinders</Text>
            <Text style={styles.headerSub}>SHREEJEE GAS SERVICE</Text>
          </View>
        </View>

        {/* Report Type — stacked vertically */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>REPORT TYPE</Text>
          <View style={styles.radioColumn}>
            <TouchableOpacity
              style={[styles.radioBtn, reportMode === 'customer' && styles.radioBtnActive]}
              onPress={() => setReportMode('customer')}
              activeOpacity={0.8}
            >
              <View style={styles.radioCircle}>
                {reportMode === 'customer' && <View style={styles.radioInner} />}
              </View>
              <Text style={[styles.radioLabel, reportMode === 'customer' && styles.radioLabelActive]}>
                Customer Wise
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.radioBtn, reportMode === 'daterange' && styles.radioBtnActive]}
              onPress={() => setReportMode('daterange')}
              activeOpacity={0.8}
            >
              <View style={styles.radioCircle}>
                {reportMode === 'daterange' && <View style={styles.radioInner} />}
              </View>
              <Text style={[styles.radioLabel, reportMode === 'daterange' && styles.radioLabelActive]}>
                Date Wise (All Customers)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.radioBtn, reportMode === 'monthlyReport' && styles.radioBtnActive]}
              onPress={() => setReportMode('monthlyReport')}
              activeOpacity={0.8}
            >
              <View style={styles.radioCircle}>
                {reportMode === 'monthlyReport' && <View style={styles.radioInner} />}
              </View>
              <Text style={[styles.radioLabel, reportMode === 'monthlyReport' && styles.radioLabelActive]}>
                Monthly Report
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Consumer Dropdown */}
        {reportMode === 'customer' && (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>SELECT CONSUMER</Text>
          {loadingConsumers ? (
            <ActivityIndicator color={BPCL_BLUE} style={{ marginVertical: 16 }} />
          ) : (
            <>
              <TouchableOpacity
                style={styles.dropdownButton}
                onPress={() => { setDropdownOpen(p => !p); setConsumerSearch(''); }}
                activeOpacity={0.8}
              >
                <Text style={[
                  styles.dropdownButtonText,
                  !selectedConsumer && styles.dropdownPlaceholder,
                ]}>
                  {selectedConsumer || 'Select consumer...'}
                </Text>
                <Ionicons
                  name={dropdownOpen ? 'chevron-up' : 'chevron-down'}
                  size={20}
                  color={BPCL_BLUE}
                />
              </TouchableOpacity>

              {dropdownOpen && (
                <View style={styles.dropdownList}>
                  <TextInput
                    style={styles.dropdownSearch}
                    placeholder="Search consumer..."
                    value={consumerSearch}
                    onChangeText={t => setConsumerSearch(t.toUpperCase())}
                    autoCorrect={false}
                    autoCapitalize="characters"
                  />
                  <ScrollView
                    style={{ maxHeight: 220 }}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                  >
                    {filteredConsumers.length === 0 ? (
                      <Text style={styles.dropdownEmpty}>No consumers found.</Text>
                    ) : (
                      filteredConsumers.map(name => (
                        <TouchableOpacity
                          key={name}
                          style={[
                            styles.dropdownItem,
                            selectedConsumer === name && styles.dropdownItemSelected,
                          ]}
                          onPress={() => {
                            setSelectedConsumer(name);
                            setDropdownOpen(false);
                            setConsumerSearch('');
                          }}
                        >
                          <Text style={[
                            styles.dropdownItemText,
                            selectedConsumer === name && styles.dropdownItemTextSelected,
                          ]}>
                            {name}
                          </Text>
                          {selectedConsumer === name && (
                            <Ionicons name="checkmark" size={16} color="#fff" />
                          )}
                        </TouchableOpacity>
                      ))
                    )}
                  </ScrollView>
                </View>
              )}
            </>
          )}
        </View>
        )}

        {/* Options — only shown after consumer selected */}
        {reportMode === 'customer' && selectedConsumer && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>OPTIONS</Text>

            {/* Monthly / Date-wise — hidden when showAll is on */}
            {!showAll && (
              <>
                <Text style={styles.optionGroupLabel}>View Mode</Text>
                <View style={styles.radioRow}>
                  {(['monthly', 'datewise'] as ViewMode[]).map(mode => (
                    <TouchableOpacity
                      key={mode}
                      style={[styles.radioBtn, viewMode === mode && styles.radioBtnActive]}
                      onPress={() => setViewMode(mode)}
                      activeOpacity={0.8}
                    >
                      <View style={styles.radioCircle}>
                        {viewMode === mode && <View style={styles.radioInner} />}
                      </View>
                      <Text style={[styles.radioLabel, viewMode === mode && styles.radioLabelActive]}>
                        {mode === 'monthly' ? 'Monthly' : 'Date-wise'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.divider} />
              </>
            )}

            {/* Show All checkbox */}
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => setShowAll(p => !p)}
              activeOpacity={0.8}
            >
              <View style={[styles.checkbox, showAll && styles.checkboxChecked]}>
                {showAll && <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkboxLabel}>Show All Records</Text>
                <Text style={styles.checkboxHint}>
                  Shows every delivery with its empty received date (or not received)
                </Text>
              </View>
            </TouchableOpacity>

            {isCustomerDirty && (
              <Text style={styles.dirtyHint}>
                Filters changed — press "{!isCustomerLoaded ? 'Load' : 'Refresh'}" below to update the table.
              </Text>
            )}
          </View>
        )}

        {/* Table (Customer Wise) */}
        {reportMode === 'customer' && selectedConsumer && (
          <View style={styles.card}>

            {/* Top row */}
            <View style={styles.tableTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>
                  {showAll ? 'ALL RECORDS' : 'EMPTY PENDING'}
                </Text>
                <Text style={styles.consumerName}>{selectedConsumer}</Text>
              </View>

              <View style={styles.buttonGroup}>
                <TouchableOpacity
                  style={[
                    styles.loadBtn,
                    isCustomerDirty && styles.loadBtnDirty,
                    loadingTable && styles.pdfBtnDisabled,
                  ]}
                  onPress={handleLoadCustomerData}
                  disabled={loadingTable}
                  activeOpacity={0.8}
                >
                  {loadingTable ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="refresh-outline" size={16} color="#fff" />
                      <Text style={styles.pdfBtnText}>
                        {!isCustomerLoaded ? 'Load' : (isCustomerDirty ? 'Refresh' : 'Loaded')}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.pdfBtn,
                    (!hasData || loadingTable || loadingPdf) && styles.pdfBtnDisabled,
                  ]}
                  onPress={handleDownloadPdf}
                  disabled={!hasData || loadingTable || loadingPdf}
                  activeOpacity={0.8}
                >
                  {loadingPdf ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="download-outline" size={16} color="#fff" />
                      <Text style={styles.pdfBtnText}>PDF</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {loadingTable ? (
              <ActivityIndicator color={BPCL_BLUE} size="large" style={{ marginVertical: 32 }} />
            ) : !hasData ? (
              <View style={styles.emptyBox}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#c8d6e5" />
                <Text style={styles.emptyText}>
                  {!isCustomerLoaded ? 'Press "Load" above to fetch records.' : 'No records found.'}
                </Text>
              </View>

            ) : showAll ? (
              // ── All records table: Delivery Date | Empty Received Date | Cylinders
              <>
                <View style={[styles.tRow, styles.tHeaderRow]}>
                  <View style={[styles.tCell, styles.tDateCell]}>
                    <Text style={styles.tHeaderTxt}>Delivery Date</Text>
                  </View>
                  <View style={[styles.tCell, styles.tDateCell]}>
                    <Text style={styles.tHeaderTxt}>Empty Received</Text>
                  </View>
                  <View style={styles.tCell}>
                    <Text style={styles.tHeaderTxt}>Cylinders</Text>
                  </View>
                </View>

                <ScrollView style={{ maxHeight: 420 }} nestedScrollEnabled>
                  {allEmptyRows.map((row, i) => (
                    <View
                      key={i}
                      style={[
                        styles.tRow,
                        i % 2 === 0 ? styles.tRowEven : styles.tRowOdd,
                        row.isPending && styles.tPendingRow,
                      ]}
                    >
                      <View style={[styles.tCell, styles.tDateCell]}>
                        <Text style={styles.tTxt}>{row.deliveryDate}</Text>
                      </View>
                      <View style={[styles.tCell, styles.tDateCell]}>
                        <Text style={[styles.tTxt, row.isPending && styles.tPendingTag]}>
                          {row.emptyReceivedDate}
                        </Text>
                      </View>
                      <View style={styles.tCell}>
                        <Text style={styles.tTxt}>{row.cylinders}</Text>
                      </View>
                    </View>
                  ))}

                  {/* Total */}
                  <View style={[styles.tRow, styles.tTotalRow]}>
                    <View style={[styles.tCell, styles.tDateCell]}>
                      <Text style={styles.tTotalTxt}>TOTAL</Text>
                    </View>
                    <View style={[styles.tCell, styles.tDateCell]}>
                      <Text style={styles.tTotalTxt}>—</Text>
                    </View>
                    <View style={styles.tCell}>
                      <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                        {allTotalCyls}
                      </Text>
                    </View>
                  </View>
                </ScrollView>

                <View style={styles.summaryPill}>
                  <Text style={styles.summaryPillLabel}>Total Cylinders</Text>
                  <Text style={styles.summaryPillValue}>{allTotalCyls}</Text>
                </View>
              </>

            ) : (
              // ── Pending table: Month/Date | Cylinders
              <>
                <View style={[styles.tRow, styles.tHeaderRow]}>
                  <View style={[styles.tCell, styles.tLabelCell]}>
                    <Text style={styles.tHeaderTxt}>
                      {viewMode === 'monthly' ? 'Month' : 'Date'}
                    </Text>
                  </View>
                  <View style={styles.tCell}>
                    <Text style={styles.tHeaderTxt}>Cylinders</Text>
                  </View>
                </View>

                <ScrollView style={{ maxHeight: 420 }} nestedScrollEnabled>
                  {pendingRows.map((row, i) => (
                    <View
                      key={i}
                      style={[
                        styles.tRow,
                        i % 2 === 0 ? styles.tRowEven : styles.tRowOdd,
                      ]}
                    >
                      <View style={[styles.tCell, styles.tLabelCell]}>
                        <Text style={styles.tLabelTxt}>{row.label}</Text>
                      </View>
                      <View style={styles.tCell}>
                        <Text style={styles.tTxt}>{row.cylinders}</Text>
                      </View>
                    </View>
                  ))}

                  {/* Total */}
                  <View style={[styles.tRow, styles.tTotalRow]}>
                    <View style={[styles.tCell, styles.tLabelCell]}>
                      <Text style={styles.tTotalTxt}>TOTAL</Text>
                    </View>
                    <View style={styles.tCell}>
                      <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                        {pendingTotalCyls}
                      </Text>
                    </View>
                  </View>
                </ScrollView>

                <View style={styles.summaryPill}>
                  <Text style={styles.summaryPillLabel}>Total Cylinders Pending</Text>
                  <Text style={styles.summaryPillValue}>{pendingTotalCyls}</Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* Date Wise (All Customers) — Options */}
        {reportMode === 'daterange' && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>OPTIONS</Text>

            <Text style={styles.optionGroupLabel}>View Mode</Text>
            <View style={styles.radioRow}>
              {(['monthly', 'datewise'] as ViewMode[]).map(mode => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.radioBtn, allViewMode === mode && styles.radioBtnActive]}
                  onPress={() => setAllViewMode(mode)}
                  activeOpacity={0.8}
                >
                  <View style={styles.radioCircle}>
                    {allViewMode === mode && <View style={styles.radioInner} />}
                  </View>
                  <Text style={[styles.radioLabel, allViewMode === mode && styles.radioLabelActive]}>
                    {mode === 'monthly' ? 'Monthly' : 'Date-wise'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.divider} />
            <Text style={styles.optionGroupLabel}>Filter by Delivery Date Range</Text>
            <View style={styles.rangeRow}>
              <View style={styles.rangeField}>
                <Text style={styles.rangeFieldLabel}>Start Date</Text>
                <TouchableOpacity
                  style={styles.rangeDateBtn}
                  onPress={() => setShowAllStartPicker(true)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="calendar-outline" size={16} color={BPCL_BLUE} />
                  <Text style={[
                    styles.rangeDateBtnText,
                    !allRangeStart && styles.rangeDateBtnPlaceholder,
                  ]}>
                    {allRangeStart ? fmtDate(toDateKey(allRangeStart)) : 'Any'}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.rangeField}>
                <Text style={styles.rangeFieldLabel}>End Date</Text>
                <TouchableOpacity
                  style={styles.rangeDateBtn}
                  onPress={() => setShowAllEndPicker(true)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="calendar-outline" size={16} color={BPCL_BLUE} />
                  <Text style={[
                    styles.rangeDateBtnText,
                    !allRangeEnd && styles.rangeDateBtnPlaceholder,
                  ]}>
                    {allRangeEnd ? fmtDate(toDateKey(allRangeEnd)) : 'Any'}
                  </Text>
                </TouchableOpacity>
              </View>

              {(allRangeStart || allRangeEnd) && (
                <TouchableOpacity
                  style={styles.rangeClearBtn}
                  onPress={() => { setAllRangeStart(null); setAllRangeEnd(null); }}
                  activeOpacity={0.8}
                >
                  <Ionicons name="close-circle" size={22} color="#999" />
                </TouchableOpacity>
              )}
            </View>

            {showAllStartPicker && (
              <DateTimePicker
                value={allRangeStart || new Date()}
                mode="date"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                maximumDate={allRangeEnd || undefined}
                onChange={onChangeAllStartDate}
              />
            )}
            {Platform.OS === 'ios' && showAllStartPicker && (
              <TouchableOpacity
                style={styles.pickerDoneBtn}
                onPress={() => setShowAllStartPicker(false)}
              >
                <Text style={styles.pickerDoneBtnText}>Done</Text>
              </TouchableOpacity>
            )}

            {showAllEndPicker && (
              <DateTimePicker
                value={allRangeEnd || new Date()}
                mode="date"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                minimumDate={allRangeStart || undefined}
                onChange={onChangeAllEndDate}
              />
            )}
            {Platform.OS === 'ios' && showAllEndPicker && (
              <TouchableOpacity
                style={styles.pickerDoneBtn}
                onPress={() => setShowAllEndPicker(false)}
              >
                <Text style={styles.pickerDoneBtnText}>Done</Text>
              </TouchableOpacity>
            )}

            {allRangeActive && (
              <Text style={styles.rangeActiveText}>
                Showing pending empty returns from {allRangeStartKey ? fmtDate(allRangeStartKey) : 'the beginning'} to{' '}
                {allRangeEndKey ? fmtDate(allRangeEndKey) : 'the latest'}, across all customers.
              </Text>
            )}

            {isAllDirty && (
              <Text style={styles.dirtyHint}>
                Filters changed — press "{!isAllLoaded ? 'Load' : 'Refresh'}" below to update the table.
              </Text>
            )}
          </View>
        )}

        {/* Date Wise (All Customers) — Table */}
        {reportMode === 'daterange' && (
          <View style={styles.card}>

            <View style={styles.tableTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>EMPTY PENDING — ALL CUSTOMERS</Text>
                <Text style={styles.consumerName}>
                  {customerGroups.length} consumer{customerGroups.length === 1 ? '' : 's'} with pending returns
                </Text>
              </View>

              <View style={styles.buttonGroup}>
                <TouchableOpacity
                  style={[
                    styles.loadBtn,
                    isAllDirty && styles.loadBtnDirty,
                    loadingAllTable && styles.pdfBtnDisabled,
                  ]}
                  onPress={handleLoadAllCustomersData}
                  disabled={loadingAllTable}
                  activeOpacity={0.8}
                >
                  {loadingAllTable ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="refresh-outline" size={16} color="#fff" />
                      <Text style={styles.pdfBtnText}>
                        {!isAllLoaded ? 'Load' : (isAllDirty ? 'Refresh' : 'Loaded')}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.pdfBtn,
                    (!hasAllCustomersData || loadingAllTable || loadingAllPdf) && styles.pdfBtnDisabled,
                  ]}
                  onPress={handleDownloadAllPdf}
                  disabled={!hasAllCustomersData || loadingAllTable || loadingAllPdf}
                  activeOpacity={0.8}
                >
                  {loadingAllPdf ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="download-outline" size={16} color="#fff" />
                      <Text style={styles.pdfBtnText}>PDF</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {loadingAllTable ? (
              <ActivityIndicator color={BPCL_BLUE} size="large" style={{ marginVertical: 32 }} />
            ) : !hasAllCustomersData ? (
              <View style={styles.emptyBox}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#c8d6e5" />
                <Text style={styles.emptyText}>
                  {!isAllLoaded ? 'Press "Load" above to fetch records.' : 'No pending returns found for this range.'}
                </Text>
              </View>
            ) : (
              <>
                <View style={[styles.tRow, styles.tHeaderRow]}>
                  <View style={[styles.tCell, styles.tLabelCell]}>
                    <Text style={styles.tHeaderTxt}>
                      {allViewMode === 'monthly' ? 'Month' : 'Date'}
                    </Text>
                  </View>
                  <View style={styles.tCell}>
                    <Text style={styles.tHeaderTxt}>Cylinders</Text>
                  </View>
                </View>

                <ScrollView style={{ maxHeight: 480 }} nestedScrollEnabled>
                  {customerGroups.map(group => (
                    <View key={group.customerName}>
                      {/* Customer banner */}
                      <View style={styles.customerBanner}>
                        <Ionicons name="person-circle-outline" size={15} color="#fff" />
                        <Text style={styles.customerBannerText}>{group.customerName}</Text>
                      </View>

                      {group.rows.map((row, i) => (
                        <View
                          key={i}
                          style={[
                            styles.tRow,
                            i % 2 === 0 ? styles.tRowEven : styles.tRowOdd,
                          ]}
                        >
                          <View style={[styles.tCell, styles.tLabelCell]}>
                            <Text style={styles.tLabelTxt}>{row.label}</Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={styles.tTxt}>{row.cylinders}</Text>
                          </View>
                        </View>
                      ))}

                      {/* Per-customer subtotal */}
                      <View style={[styles.tRow, styles.tSubtotalRow]}>
                        <View style={[styles.tCell, styles.tLabelCell]}>
                          <Text style={styles.tSubtotalTxt}>Subtotal</Text>
                        </View>
                        <View style={styles.tCell}>
                          <Text style={[styles.tSubtotalTxt, { color: BPCL_BLUE }]}>
                            {group.subtotalCyls}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}

                  {/* Grand total across all customers */}
                  <View style={[styles.tRow, styles.tTotalRow]}>
                    <View style={[styles.tCell, styles.tLabelCell]}>
                      <Text style={styles.tTotalTxt}>GRAND TOTAL</Text>
                    </View>
                    <View style={styles.tCell}>
                      <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                        {allCustomersGrandCyls}
                      </Text>
                    </View>
                  </View>
                </ScrollView>

                <View style={styles.summaryPill}>
                  <Text style={styles.summaryPillLabel}>Grand Total — All Customers</Text>
                  <Text style={styles.summaryPillValue}>{allCustomersGrandCyls}</Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* Monthly Report — Month/Year selector */}
        {reportMode === 'monthlyReport' && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>SELECT MONTH</Text>
            <View style={styles.selectorRow}>
              <View style={{ flex: 1.4 }}>
                <TouchableOpacity
                  style={styles.dropdownButton}
                  onPress={() => { setMonthlyMonthDropdownOpen(p => !p); setMonthlyYearDropdownOpen(false); }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.dropdownButtonText}>{MONTH_NAMES[monthlyMonth]}</Text>
                  <Ionicons name={monthlyMonthDropdownOpen ? 'chevron-up' : 'chevron-down'} size={18} color={BPCL_BLUE} />
                </TouchableOpacity>
                {monthlyMonthDropdownOpen && (
                  <View style={styles.dropdownList}>
                    <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
                      {Object.entries(MONTH_NAMES).map(([num, name]) => (
                        <TouchableOpacity
                          key={num}
                          style={[styles.dropdownItem, monthlyMonth === Number(num) && styles.dropdownItemSelected]}
                          onPress={() => { setMonthlyMonth(Number(num)); setMonthlyMonthDropdownOpen(false); }}
                        >
                          <Text style={[styles.dropdownItemText, monthlyMonth === Number(num) && styles.dropdownItemTextSelected]}>
                            {name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </View>

              <View style={{ flex: 1 }}>
                <TouchableOpacity
                  style={styles.dropdownButton}
                  onPress={() => { setMonthlyYearDropdownOpen(p => !p); setMonthlyMonthDropdownOpen(false); }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.dropdownButtonText}>{monthlyYear}</Text>
                  <Ionicons name={monthlyYearDropdownOpen ? 'chevron-up' : 'chevron-down'} size={18} color={BPCL_BLUE} />
                </TouchableOpacity>
                {monthlyYearDropdownOpen && (
                  <View style={styles.dropdownList}>
                    <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
                      {YEAR_OPTIONS.map(y => (
                        <TouchableOpacity
                          key={y}
                          style={[styles.dropdownItem, monthlyYear === y && styles.dropdownItemSelected]}
                          onPress={() => { setMonthlyYear(y); setMonthlyYearDropdownOpen(false); }}
                        >
                          <Text style={[styles.dropdownItemText, monthlyYear === y && styles.dropdownItemTextSelected]}>
                            {y}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </View>
            </View>

            <View style={[styles.buttonGroup, { marginTop: 14 }]}>
              <TouchableOpacity
                style={[
                  styles.loadBtn,
                  isMonthlyDirty && styles.loadBtnDirty,
                  monthlyLoading && styles.pdfBtnDisabled,
                ]}
                onPress={handleLoadMonthlyReport}
                disabled={monthlyLoading}
                activeOpacity={0.8}
              >
                {monthlyLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="refresh-outline" size={16} color="#fff" />
                    <Text style={styles.pdfBtnText}>
                      {!isMonthlyLoaded ? 'Load Report' : (isMonthlyDirty ? 'Refresh' : 'Loaded')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.pdfBtn,
                  (!isMonthlyLoaded || monthlyLoading || loadingMonthlyPdf) && styles.pdfBtnDisabled,
                ]}
                onPress={handleDownloadMonthlyPdf}
                disabled={!isMonthlyLoaded || monthlyLoading || loadingMonthlyPdf}
                activeOpacity={0.8}
              >
                {loadingMonthlyPdf ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="download-outline" size={16} color="#fff" />
                    <Text style={styles.pdfBtnText}>PDF</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {isMonthlyDirty && isMonthlyLoaded && (
              <Text style={styles.dirtyHint}>Month/year changed — press "Refresh" to update the report.</Text>
            )}
          </View>
        )}

        {reportMode === 'monthlyReport' && (
          monthlyLoading ? (
            <ActivityIndicator color={BPCL_BLUE} size="large" style={{ marginVertical: 40 }} />
          ) : !isMonthlyLoaded ? (
            <View style={styles.card}>
              <View style={styles.emptyBox}>
                <Ionicons name="stats-chart-outline" size={40} color="#c8d6e5" />
                <Text style={styles.emptyText}>Select a month and press "Load Report" to view reconciliation.</Text>
              </View>
            </View>
          ) : (
            <>
              {/* Opening Stock */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>OPENING STOCK ({fmtDate(monthlyPrevMonthLastDay)})</Text>
                {openingMissing ? (
                  <Text style={styles.warningText}>No stock row found for {fmtDate(monthlyPrevMonthLastDay)}.</Text>
                ) : (
                  <>
                    <Text style={styles.bigNumber}>{openingTotal}</Text>
                    <Text style={styles.subText}>
                      Full: {openingRow?.closing_full}  •  Empty: {openingRow?.closing_empty}
                    </Text>
                  </>
                )}
              </View>

              {/* Section 1 */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>SECTION 1 — DELIVERED THIS MONTH, EMPTY NOT RETURNED THIS MONTH (subtracted)</Text>
                {monthlySection1.length === 0 ? (
                  <Text style={styles.emptyText}>No records.</Text>
                ) : (
                  <>
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tHeaderTxt}>Customer</Text></View>
                      <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tHeaderTxt}>Delivery Date</Text></View>
                      <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tHeaderTxt}>Empty Received</Text></View>
                    </View>
                    <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
                      {monthlySection1.map((row, i) => (
                        <View key={row.id} style={[styles.tRow, i % 2 === 0 ? styles.tRowEven : styles.tRowOdd]}>
                          <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tLabelTxt}>{row.customer_name}</Text></View>
                          <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tTxt}>{fmtDate(row.delivery_date)}</Text></View>
                          <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tTxt}>{fmtDateOrBlank(row.empty_received)}</Text></View>
                        </View>
                      ))}
                    </ScrollView>
                  </>
                )}
                <View style={[styles.tRow, styles.tTotalRow]}>
                  <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tTotalTxt}>Total</Text></View>
                  <View style={styles.tCell}><Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>{section1Total}</Text></View>
                </View>
              </View>

              {/* Section 2 */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>SECTION 2 — RETURNED THIS MONTH, DELIVERED EARLIER (added)</Text>
                {monthlySection2.length === 0 ? (
                  <Text style={styles.emptyText}>No records.</Text>
                ) : (
                  <>
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tHeaderTxt}>Customer</Text></View>
                      <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tHeaderTxt}>Delivery Date</Text></View>
                      <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tHeaderTxt}>Empty Received</Text></View>
                    </View>
                    <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
                      {monthlySection2.map((row, i) => (
                        <View key={row.id} style={[styles.tRow, i % 2 === 0 ? styles.tRowEven : styles.tRowOdd]}>
                          <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tLabelTxt}>{row.customer_name}</Text></View>
                          <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tTxt}>{fmtDate(row.delivery_date)}</Text></View>
                          <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tTxt}>{fmtDateOrBlank(row.empty_received)}</Text></View>
                        </View>
                      ))}
                    </ScrollView>
                  </>
                )}
                <View style={[styles.tRow, styles.tTotalRow]}>
                  <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tTotalTxt}>Total</Text></View>
                  <View style={styles.tCell}><Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>{section2Total}</Text></View>
                </View>
              </View>

              {/* Section 3 */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>SECTION 3 — MANUAL STOCK ADJUSTMENTS (added/subtracted)</Text>
                {remarkAgg.length === 0 ? (
                  <Text style={styles.emptyText}>No remark adjustments this month.</Text>
                ) : (
                  <>
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tHeaderTxt}>Customer</Text></View>
                      <View style={styles.tCell}><Text style={styles.tHeaderTxt}>Net Qty</Text></View>
                    </View>
                    {remarkAgg.map((r, i) => (
                      <View key={r.name} style={[styles.tRow, i % 2 === 0 ? styles.tRowEven : styles.tRowOdd]}>
                        <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tLabelTxt}>{r.name}</Text></View>
                        <View style={styles.tCell}>
                          <Text style={[styles.tTxt, r.total < 0 && { color: RED }]}>
                            {r.total > 0 ? `+${r.total}` : r.total}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </>
                )}
                <View style={[styles.tRow, styles.tTotalRow]}>
                  <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tTotalTxt}>Total</Text></View>
                  <View style={styles.tCell}>
                    <Text style={[styles.tTotalTxt, { color: section3Total < 0 ? RED : BPCL_BLUE }]}>
                      {section3Total > 0 ? `+${section3Total}` : section3Total}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Section 4 — informative */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>SECTION 4 — DELIVERED & RETURNED SAME MONTH (informative only)</Text>
                {monthlySection4.length === 0 ? (
                  <Text style={styles.emptyText}>No records.</Text>
                ) : (
                  <>
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tHeaderTxt}>Customer</Text></View>
                      <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tHeaderTxt}>Delivery Date</Text></View>
                      <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tHeaderTxt}>Empty Received</Text></View>
                    </View>
                    <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
                      {monthlySection4.map((row, i) => (
                        <View key={row.id} style={[styles.tRow, i % 2 === 0 ? styles.tRowEven : styles.tRowOdd]}>
                          <View style={[styles.tCell, styles.tLabelCell]}><Text style={styles.tLabelTxt}>{row.customer_name}</Text></View>
                          <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tTxt}>{fmtDate(row.delivery_date)}</Text></View>
                          <View style={[styles.tCell, styles.tDateCell]}><Text style={styles.tTxt}>{fmtDateOrBlank(row.empty_received)}</Text></View>
                        </View>
                      ))}
                    </ScrollView>
                  </>
                )}
                <Text style={styles.subText}>{monthlySection4.length} record(s) — not part of the reconciliation total.</Text>
              </View>

              {/* Reconciliation */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>RECONCILIATION</Text>
                <Text style={styles.formulaText}>
                  {openingTotal ?? '—'}  −  {section1Total}  +  {section2Total}  +  {section3Total}
                  {'  =  '}
                  <Text style={{ fontWeight: '800' }}>{expectedClosing ?? '—'}</Text>
                </Text>

                <View style={styles.divider} />

                <View style={styles.compareRow}>
                  <View>
                    <Text style={styles.subText}>Expected Closing</Text>
                    <Text style={styles.bigNumber}>{expectedClosing ?? '—'}</Text>
                  </View>
                  <View>
                    <Text style={styles.subText}>Actual Closing ({fmtDate(monthlyMonthLastDay)})</Text>
                    {closingMissing ? (
                      <Text style={styles.warningText}>No row for {fmtDate(monthlyMonthLastDay)}</Text>
                    ) : (
                      <Text style={styles.bigNumber}>{closingActualTotal}</Text>
                    )}
                  </View>
                </View>

                {canVerify && (
                  <View style={[styles.statusPill, { backgroundColor: isMatch ? GREEN : RED }]}>
                    <Ionicons name={isMatch ? 'checkmark-circle' : 'alert-circle'} size={16} color="#fff" />
                    <Text style={styles.statusPillText}>
                      {isMatch ? 'MATCHED' : `MISMATCH (diff ${(closingActualTotal! - expectedClosing!)})`}
                    </Text>
                  </View>
                )}
              </View>

              {/* Summary table */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>MONTH SUMMARY</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View>
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tHeaderTxt}>Prev Month Stock</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tHeaderTxt}>Total Delivered</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tHeaderTxt}>Total Empty Recvd</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tHeaderTxt}>Total Extra</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tHeaderTxt}>Month Closing</Text></View>
                    </View>
                    <View style={styles.tRow}>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tTotalTxt}>{openingTotal ?? '—'}</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tTotalTxt}>{monthlyDeliveredCount}</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tTotalTxt}>{monthlyEmptyReceivedCount}</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tTotalTxt}>{section3Total}</Text></View>
                      <View style={[styles.tCell, styles.summaryCell]}><Text style={styles.tTotalTxt}>{closingActualTotal ?? '—'}</Text></View>
                    </View>
                  </View>
                </ScrollView>
              </View>
              {/* Cylinders Delivered & Empty Received — last section */}
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>
                  CYLINDERS DELIVERED &amp; EMPTY RECEIVED — {MONTH_NAMES[monthlyMonth].toUpperCase()} {monthlyYear}
                </Text>
                <View style={styles.compareRow}>
                  <View>
                    <Text style={styles.subText}>Cylinders Delivered</Text>
                    <Text style={styles.bigNumber}>{monthlyDeliveredCount}</Text>
                  </View>
                  <View>
                    <Text style={styles.subText}>Empty Received</Text>
                    <Text style={styles.bigNumber}>{monthlyEmptyReceivedCount}</Text>
                  </View>
                </View>
              </View>
            </>
          )
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  scroll:    { padding: 16, paddingBottom: 60 },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: BPCL_BLUE, borderRadius: 16,
    padding: 20, marginBottom: 14,
  },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  headerSub:   { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },

  card: {
    backgroundColor: '#fff', borderRadius: 16, padding: 16,
    marginBottom: 14, borderWidth: 1, borderColor: '#eee',
    elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4,
  },
  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: '#aaa',
    letterSpacing: 1.1, marginBottom: 8,
  },

  // Dropdown
  dropdownButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 13, backgroundColor: '#fafafa',
  },
  dropdownButtonText:  { fontSize: 15, color: '#333', fontWeight: '500', flex: 1 },
  dropdownPlaceholder: { color: '#bbb' },
  dropdownList: {
    marginTop: 6, borderWidth: 1.5, borderColor: '#e0e0e0',
    borderRadius: 10, backgroundColor: '#fff', overflow: 'hidden',
    elevation: 4, shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 6,
  },
  dropdownSearch: {
    borderBottomWidth: 1, borderBottomColor: '#eee',
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14, color: '#333', backgroundColor: '#fafafa',
  },
  dropdownItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#f5f5f5',
  },
  dropdownItemSelected:     { backgroundColor: BPCL_BLUE },
  dropdownItemText:         { fontSize: 14, color: '#333' },
  dropdownItemTextSelected: { color: '#fff', fontWeight: '600' },
  dropdownEmpty: {
    textAlign: 'center', color: '#bbb', fontSize: 13, paddingVertical: 18,
  },

  // Radio
  optionGroupLabel: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 8 },
  radioRow:         { flexDirection: 'row', gap: 12 },
  radioRowWrap:     { flexWrap: 'wrap' },
  radioColumn:      { flexDirection: 'column', gap: 10 },
  radioBtn: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 16,
    borderRadius: 12, borderWidth: 1.5, borderColor: '#e0e0e0', backgroundColor: '#fafafa',
  },
  radioBtnActive:   { borderColor: BPCL_BLUE, backgroundColor: '#eef6fd' },
  radioCircle: {
    width: 20, height: 20, borderRadius: 10, flexShrink: 0,
    borderWidth: 2, borderColor: BPCL_BLUE,
    alignItems: 'center', justifyContent: 'center',
  },
  radioInner:       { width: 10, height: 10, borderRadius: 5, backgroundColor: BPCL_BLUE },
  radioLabel:       { flex: 1, flexShrink: 1, fontSize: 14, color: '#666', fontWeight: '500', flexWrap: 'wrap' },
  radioLabelActive: { color: BPCL_BLUE, fontWeight: '700' },

  divider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 14 },

  // Checkbox
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: BPCL_BLUE,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  checkboxChecked:  { backgroundColor: BPCL_BLUE },
  checkboxLabel:    { fontSize: 14, fontWeight: '600', color: '#333' },
  checkboxHint:     { fontSize: 11, color: '#999', marginTop: 2 },

  // Dirty / stale filter hint
  dirtyHint: {
    fontSize: 11.5, color: '#e08e0b', fontWeight: '700', marginTop: 10,
  },

  // Date range filter
  rangeRow:   { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  rangeField: { flex: 1 },
  rangeFieldLabel: { fontSize: 11, color: '#888', marginBottom: 4, fontWeight: '600' },
  rangeDateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 11, backgroundColor: '#fafafa',
  },
  rangeDateBtnText: { fontSize: 13, color: '#333', fontWeight: '600' },
  rangeDateBtnPlaceholder: { color: '#bbb', fontWeight: '500' },
  rangeClearBtn: { paddingBottom: 10, paddingHorizontal: 2 },
  rangeActiveText: { fontSize: 11.5, color: BPCL_BLUE, marginTop: 8, fontWeight: '600' },
  pickerDoneBtn: {
    alignSelf: 'flex-end', backgroundColor: BPCL_BLUE,
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4,
  },
  pickerDoneBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Table top
  tableTopRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10,
  },
  consumerName: { fontSize: 15, fontWeight: '700', color: '#222', marginTop: 1 },

  // Load/Refresh + PDF button group
  buttonGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loadBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#555', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 3,
  },
  loadBtnDirty: { backgroundColor: '#e08e0b' },

  // PDF button
  pdfBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: BPCL_BLUE, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    elevation: 3, shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 5,
  },
  pdfBtnDisabled: { opacity: 0.45 },
  pdfBtnText:     { fontSize: 13, fontWeight: '700', color: '#fff' },

  // Empty state
  emptyBox:  { alignItems: 'center', paddingVertical: 36, gap: 10 },
  emptyText: { fontSize: 14, color: '#bbb', fontWeight: '500', textAlign: 'center' },

  // Table
  tRow:        { flexDirection: 'row' },
  tHeaderRow:  { backgroundColor: '#d9e1f2', borderRadius: 6, marginBottom: 2 },
  tRowEven:    { backgroundColor: '#fff' },
  tRowOdd:     { backgroundColor: '#fafbfc' },
  tPendingRow: { backgroundColor: '#fff5f5' },
  tTotalRow: {
    backgroundColor: '#e8ecf0', borderTopWidth: 2,
    borderTopColor: '#ccd', marginTop: 2, borderRadius: 6,
  },

  // Customer banner (Date Wise — All Customers report)
  customerBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: BPCL_BLUE, paddingVertical: 8, paddingHorizontal: 10,
    marginTop: 10, borderRadius: 6,
  },
  customerBannerText: { fontSize: 12.5, fontWeight: '800', color: '#fff' },
  tSubtotalRow: {
    backgroundColor: '#eef6fd', borderTopWidth: 1, borderTopColor: '#d3e6f7',
  },
  tSubtotalTxt: { fontSize: 12, fontWeight: '700', color: '#333', textAlign: 'center' },

  tCell: {
    width: 100, paddingVertical: 10, paddingHorizontal: 6,
    justifyContent: 'center', alignItems: 'center',
    borderRightWidth: 1, borderRightColor: '#eee',
  },
  tDateCell:  { width: 130 },
  tLabelCell: { width: 200, alignItems: 'flex-start', paddingLeft: 10 },
  summaryCell:{ width: 130 },

  tHeaderTxt:  { fontSize: 11, fontWeight: '700', color: '#333', textAlign: 'center' },
  tTxt:        { fontSize: 12, color: '#444', textAlign: 'center' },
  tLabelTxt:   { fontSize: 12, color: '#333' },
  tPendingTag: { color: '#c0392b', fontWeight: '700' },
  tTotalTxt:   { fontSize: 12, fontWeight: '800', color: '#111', textAlign: 'center' },

  // Summary pill
  summaryPill: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 14, backgroundColor: '#eef6fd', borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1.5, borderColor: '#b8d9f5',
  },
  summaryPillLabel: { fontSize: 13, fontWeight: '600', color: '#555' },
  summaryPillValue: { fontSize: 16, fontWeight: '800', color: BPCL_BLUE },

  // Monthly Report — selector + reconciliation
  selectorRow: { flexDirection: 'row', gap: 10 },
  bigNumber:   { fontSize: 26, fontWeight: '800', color: '#222' },
  subText:     { fontSize: 12, color: '#888', marginTop: 4 },
  warningText: { fontSize: 13, color: RED, fontWeight: '600' },
  formulaText: { fontSize: 14, color: '#444', fontWeight: '600' },
  compareRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: 4, marginBottom: 4,
  },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start', marginTop: 14,
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
  },
  statusPillText: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
});
