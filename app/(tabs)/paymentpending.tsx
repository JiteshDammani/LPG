// app/(tabs)/commercial-pending.tsx

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
import { format, parseISO } from 'date-fns';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BPCL_BLUE      = '#017DC5';
const DISCOUNT_CUTOFF = '2026-03-01';

const MONTH_NAMES: Record<number, string> = {
  1: 'January',  2: 'February', 3: 'March',     4: 'April',
  5: 'May',      6: 'June',     7: 'July',       8: 'August',
  9: 'September',10: 'October', 11: 'November',  12: 'December',
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ViewMode = 'monthly' | 'datewise';

interface RawRecord {
  id: number;
  customer_name: string;
  delivery_date: string;
  payment_date: string | null;
}

interface RateRow {
  actual_rate: number;
  start_date: string;
  end_date: string;
}

// Pending rows (payment_date = null)
interface PendingRow {
  label: string;
  cylinders: number;
  rate: number;
  discount: number;
  effectiveRate: number;
  pendingAmount: number;
  isSub?: boolean;
}

// All-payment rows (datewise only, grouped by delivery_date + payment_date)
interface AllPaymentRow {
  deliveryDate: string;   // formatted display
  paymentDate: string;    // formatted display
  cylinders: number;
  rate: number;
  discount: number;
  effectiveRate: number;
  amount: number;
}

// One customer's pending rows within the "Date Wise (All Customers)" report
interface CustomerGroup {
  customerName: string;
  rows: PendingRow[];
  subtotalCyls: number;
  subtotalAmount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function dateKey(d: string) { return d.slice(0, 10); }

function beforeCutoff(d: string): boolean { return dateKey(d) < DISCOUNT_CUTOFF; }

function monthLabel(d: string): string {
  const dt = parseISO(d);
  return `${MONTH_NAMES[dt.getMonth() + 1]} ${dt.getFullYear()}`;
}

function fetchRateForDate(date: string, allRates: RateRow[]): number | null {
  const d    = dateKey(date);
  const rate = allRates.find(r => r.start_date <= d && r.end_date >= d);
  return rate ? rate.actual_rate : null;
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
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

// ─────────────────────────────────────────────────────────────────────────────
// Build Monthly Rows  (pending only)
// ─────────────────────────────────────────────────────────────────────────────

function buildMonthlyRows(
  records: RawRecord[],
  discount: number,
  allRates: RateRow[],
): PendingRow[] {
  const grouped: Record<string, RawRecord[]> = {};
  for (const r of records) {
    const key = monthLabel(r.delivery_date);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  const rows: PendingRow[] = [];

  for (const [label, recs] of Object.entries(grouped)) {
    const allBefore = recs.every(r => beforeCutoff(r.delivery_date));
    const allAfter  = recs.every(r => !beforeCutoff(r.delivery_date));

    if (allBefore || allAfter) {
      const rate = fetchRateForDate(recs[0].delivery_date, allRates);
      if (rate === null) continue;
      const disc    = allBefore ? discount : 0;
      const effRate = rate - disc;
      rows.push({
        label,
        cylinders:    recs.length,
        rate,
        discount:     disc,
        effectiveRate: effRate,
        pendingAmount: effRate * recs.length,
      });
    } else {
      // Split month straddles cutoff
      const before = recs.filter(r => beforeCutoff(r.delivery_date));
      const after  = recs.filter(r => !beforeCutoff(r.delivery_date));

      if (before.length > 0) {
        const rate = fetchRateForDate(before[0].delivery_date, allRates);
        if (rate !== null) {
          const effRate = rate - discount;
          rows.push({
            label:         `${label} (before ${DISCOUNT_CUTOFF})`,
            cylinders:     before.length,
            rate,
            discount,
            effectiveRate: effRate,
            pendingAmount: effRate * before.length,
            isSub:         true,
          });
        }
      }
      if (after.length > 0) {
        const rate = fetchRateForDate(after[0].delivery_date, allRates);
        if (rate !== null) {
          rows.push({
            label:         `${label} (from ${DISCOUNT_CUTOFF})`,
            cylinders:     after.length,
            rate,
            discount:      0,
            effectiveRate: rate,
            pendingAmount: rate * after.length,
            isSub:         true,
          });
        }
      }
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Date-wise Rows  (pending only)
// ─────────────────────────────────────────────────────────────────────────────

function buildDatewiseRows(
  records: RawRecord[],
  discount: number,
  allRates: RateRow[],
): PendingRow[] {
  const grouped: Record<string, RawRecord[]> = {};
  for (const r of records) {
    const key = dateKey(r.delivery_date);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  const rows: PendingRow[] = [];
  for (const [date, recs] of Object.entries(grouped).sort()) {
    const rate = fetchRateForDate(date, allRates);
    if (rate === null) continue;
    const disc    = beforeCutoff(date) ? discount : 0;
    const effRate = rate - disc;
    rows.push({
      label:         fmtDate(date),
      cylinders:     recs.length,
      rate,
      discount:      disc,
      effectiveRate: effRate,
      pendingAmount: effRate * recs.length,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build All-Payment Rows  (datewise, groups by delivery_date + payment_date)
// ─────────────────────────────────────────────────────────────────────────────

function buildAllPaymentRows(
  records: RawRecord[],
  discount: number,
  allRates: RateRow[],
): AllPaymentRow[] {
  // Group by "deliveryDate|paymentDate"
  const grouped: Record<string, RawRecord[]> = {};
  for (const r of records) {
    const key = `${dateKey(r.delivery_date)}|${r.payment_date ? dateKey(r.payment_date) : 'PENDING'}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  const rows: AllPaymentRow[] = [];

  for (const [key, recs] of Object.entries(grouped).sort()) {
    const [delivDate] = key.split('|');
    const rate = fetchRateForDate(delivDate, allRates);
    if (rate === null) continue;

    const disc    = beforeCutoff(delivDate) ? discount : 0;
    const effRate = rate - disc;
    const cyls    = recs.length;

    rows.push({
      deliveryDate: fmtDate(delivDate),
      paymentDate:  recs[0].payment_date ? fmtDate(recs[0].payment_date) : 'Pending',
      cylinders:    cyls,
      rate,
      discount:     disc,
      effectiveRate: effRate,
      amount:       effRate * cyls,
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Customer Groups — "Date Wise (All Customers)" report
// Groups pending records by customer, then builds monthly/datewise rows for
// each customer using the same builders as the single-customer flow.
// ─────────────────────────────────────────────────────────────────────────────

function buildCustomerGroups(
  records: RawRecord[],
  discountsByCustomer: Record<string, number>,
  allRates: RateRow[],
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
    const discount     = discountsByCustomer[customerName] ?? 0;
    const rows          = mode === 'monthly'
      ? buildMonthlyRows(custRecords, discount, allRates)
      : buildDatewiseRows(custRecords, discount, allRates);

    if (rows.length === 0) continue;

    const subtotalCyls   = rows.reduce((s, r) => s + r.cylinders, 0);
    const subtotalAmount = rows.reduce((s, r) => s + r.pendingAmount, 0);

    groups.push({ customerName, rows, subtotalCyls, subtotalAmount });
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — Pending (monthly or datewise) with Round-Off Payment Support
// ─────────────────────────────────────────────────────────────────────────────

function buildPendingPdfHtml(
  consumerName: string,
  viewMode: ViewMode,
  rows: PendingRow[],
  roundOffPayments: any[],
  rangeLabel: string | null,
): string {
  const colHeader  = viewMode === 'monthly' ? 'Month' : 'Date';
  const grandTotal = rows.reduce((s, r) => s + r.pendingAmount, 0);
  const totalCyls  = rows.reduce((s, r) => s + r.cylinders, 0);

  const tableRows = rows.map(r => `
    <tr class="${r.isSub ? 'sub-row' : ''}">
      <td class="left">${r.label}</td>
      <td>${r.cylinders}</td>
      <td>₹${r.rate.toFixed(2)}</td>
      <td>${r.discount === 0 ? '—' : '₹' + r.discount.toFixed(2)}</td>
      <td>₹${r.effectiveRate.toFixed(2)}</td>
      <td class="amount">₹${r.pendingAmount.toFixed(2)}</td>
    </tr>`).join('');

  // Add round-off lines
  const roundOffRowsHtml = roundOffPayments.map(p => `
    <tr class="round-off-row">
      <td class="left" style="font-style: italic;">Round-off Payment (${fmtDate(p.transaction_date)})</td>
      <td>—</td><td>—</td><td>—</td><td>—</td>
      <td class="amount" style="color: #c0392b;">-₹${p.amount.toFixed(2)}</td>
    </tr>
  `).join('');

  const finalPendingAmount = grandTotal - roundOffPayments.reduce((s, p) => s + p.amount, 0);

  const finalPendingHtml = roundOffPayments.length > 0 ? `
    <tr class="final-pending-row">
      <td class="left" style="font-weight: bold;">FINAL PENDING AMOUNT</td>
      <td style="font-weight: bold;">—</td>
      <td style="font-weight: bold;">—</td>
      <td style="font-weight: bold;">—</td>
      <td style="font-weight: bold;">—</td>
      <td class="amount" style="color: #27ae60; font-weight: bold;">₹${finalPendingAmount.toFixed(2)}</td>
    </tr>
  ` : '';

  const rangeHtml = rangeLabel
    ? `<div class="range-note">Filtered range: ${rangeLabel}</div>`
    : '';

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
           text-decoration:underline; margin:8px 0 4px; }
  .range-note { text-align:center; font-size:9.5pt; color:#555; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; }
  th,td { border:1px solid #666; padding:7px 8px; text-align:center; font-size:9pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.left { text-align:left; }
  td.amount { font-weight:bold; }
  .sub-row td { background:#f4f7ff; }
  .round-off-row td { background:#fff5f5; }
  .final-pending-row td { background:#e2f0d9; font-size:10pt; }
  .total-row td { font-weight:bold; background:#e8ecf0; font-size:10pt; }
  .footer { margin-top:18px; font-size:8.5pt; text-align:right; color:#666; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Commercial Pending Statement</h2>
</div>
<div class="title">PENDING AMOUNT — ${consumerName.toUpperCase()}</div>
${rangeHtml}
<table>
  <thead>
    <tr>
      <th style="text-align:left">${colHeader}</th>
      <th>Cylinders</th><th>Rate</th><th>Discount</th>
      <th>Effective Rate</th><th>Pending Amount</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
    <tr class="total-row">
      <td class="left">TOTAL PENDING</td>
      <td>${totalCyls}</td><td>—</td><td>—</td><td>—</td>
      <td>₹${grandTotal.toFixed(2)}</td>
    </tr>
    ${roundOffRowsHtml}
    ${finalPendingHtml}
  </tbody>
</table>
<div class="footer">Generated on ${format(new Date(), 'dd MMM yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — All Payments
// ─────────────────────────────────────────────────────────────────────────────

function buildAllPaymentPdfHtml(
  consumerName: string,
  rows: AllPaymentRow[],
  rangeLabel: string | null,
): string {
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);
  const totalCyls  = rows.reduce((s, r) => s + r.cylinders, 0);

  const tableRows = rows.map(r => `
    <tr class="${r.paymentDate === 'Pending' ? 'pending-row' : ''}">
      <td>${r.deliveryDate}</td>
      <td class="${r.paymentDate === 'Pending' ? 'pending-tag' : ''}">${r.paymentDate}</td>
      <td>${r.cylinders}</td>
      <td>₹${r.rate.toFixed(2)}</td>
      <td>${r.discount === 0 ? '—' : '₹' + r.discount.toFixed(2)}</td>
      <td>₹${r.effectiveRate.toFixed(2)}</td>
      <td class="amount">₹${r.amount.toFixed(2)}</td>
    </tr>`).join('');

  const rangeHtml = rangeLabel
    ? `<div class="range-note">Filtered range: ${rangeLabel}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 9.5pt; color: #000; }
  .header { text-align:center; margin-bottom:12px; }
  .header h1 { font-size:15pt; font-weight:bold; }
  .header h2 { font-size:10pt; font-weight:normal; margin-top:3px; color:#444; }
  .title { font-size:12pt; font-weight:bold; text-align:center;
           text-decoration:underline; margin:8px 0 4px; }
  .range-note { text-align:center; font-size:9.5pt; color:#555; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; }
  th,td { border:1px solid #666; padding:7px 8px; text-align:center; font-size:9pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.amount { font-weight:bold; }
  td.pending-tag { color:#c0392b; font-weight:bold; }
  .pending-row td { background:#fff5f5; }
  .total-row td { font-weight:bold; background:#e8ecf0; font-size:10pt; }
  .footer { margin-top:18px; font-size:8.5pt; text-align:right; color:#666; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Complete Payment History — Date-wise</h2>
</div>
<div class="title">ALL PAYMENTS — ${consumerName.toUpperCase()}</div>
${rangeHtml}
<table>
  <thead>
    <tr>
      <th>Delivery Date</th><th>Payment Date</th><th>Cylinders</th>
      <th>Rate</th><th>Discount</th><th>Effective Rate</th><th>Amount</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
    <tr class="total-row">
      <td colspan="2">TOTAL</td>
      <td>${totalCyls}</td><td>—</td><td>—</td><td>—</td>
      <td>₹${grandTotal.toFixed(2)}</td>
    </tr>
  </tbody>
</table>
<div class="footer">Generated on ${format(new Date(), 'dd MMM yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — Date Wise (All Customers), grouped by customer → month/date → amount
// ─────────────────────────────────────────────────────────────────────────────

function buildAllCustomersPdfHtml(
  mode: ViewMode,
  groups: CustomerGroup[],
  rangeLabel: string | null,
): string {
  const colHeader   = mode === 'monthly' ? 'Month' : 'Date';
  const grandTotal  = groups.reduce((s, g) => s + g.subtotalAmount, 0);
  const grandCyls   = groups.reduce((s, g) => s + g.subtotalCyls, 0);

  const groupsHtml = groups.map(g => `
    <tr class="customer-row"><td colspan="6" class="left">${g.customerName.toUpperCase()}</td></tr>
    ${g.rows.map(r => `
      <tr class="${r.isSub ? 'sub-row' : ''}">
        <td class="left">${r.label}</td>
        <td>${r.cylinders}</td>
        <td>₹${r.rate.toFixed(2)}</td>
        <td>${r.discount === 0 ? '—' : '₹' + r.discount.toFixed(2)}</td>
        <td>₹${r.effectiveRate.toFixed(2)}</td>
        <td class="amount">₹${r.pendingAmount.toFixed(2)}</td>
      </tr>`).join('')}
    <tr class="subtotal-row">
      <td class="left">Subtotal — ${g.customerName}</td>
      <td>${g.subtotalCyls}</td><td>—</td><td>—</td><td>—</td>
      <td>₹${g.subtotalAmount.toFixed(2)}</td>
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
  body { font-family: Arial, sans-serif; font-size: 9.5pt; color: #000; }
  .header { text-align:center; margin-bottom:12px; }
  .header h1 { font-size:15pt; font-weight:bold; }
  .header h2 { font-size:10pt; font-weight:normal; margin-top:3px; color:#444; }
  .title { font-size:12pt; font-weight:bold; text-align:center;
           text-decoration:underline; margin:8px 0 4px; }
  .range-note { text-align:center; font-size:9.5pt; color:#555; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; }
  th,td { border:1px solid #666; padding:7px 8px; text-align:center; font-size:9pt; }
  th { background:#d9e1f2; font-weight:bold; }
  td.left { text-align:left; }
  td.amount { font-weight:bold; }
  .customer-row td { background:#017DC5; color:#fff; font-weight:bold; font-size:10pt; }
  .sub-row td { background:#f4f7ff; }
  .subtotal-row td { font-weight:bold; background:#eef3fb; }
  .grand-total-row td { font-weight:bold; background:#e8ecf0; font-size:10.5pt; }
  .footer { margin-top:18px; font-size:8.5pt; text-align:right; color:#666; }
</style></head><body>
<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Pending Payments — All Customers</h2>
</div>
<div class="title">DATE WISE PENDING PAYMENT — ALL CUSTOMERS</div>
${rangeHtml}
<table>
  <thead>
    <tr>
      <th style="text-align:left">${colHeader}</th>
      <th>Cylinders</th><th>Rate</th><th>Discount</th>
      <th>Effective Rate</th><th>Pending Amount</th>
    </tr>
  </thead>
  <tbody>
    ${groupsHtml}
    <tr class="grand-total-row">
      <td class="left">GRAND TOTAL — ALL CUSTOMERS</td>
      <td>${grandCyls}</td><td>—</td><td>—</td><td>—</td>
      <td>₹${grandTotal.toFixed(2)}</td>
    </tr>
  </tbody>
</table>
<div class="footer">Generated on ${format(new Date(), 'dd MMM yyyy, hh:mm a')}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function CommercialPendingScreen() {

  // ── State ──────────────────────────────────────────────────────────────────

  // Top-level report type: a single consumer's own view, or every consumer's
  // pending payments within a date range, grouped by customer.
  type ReportMode = 'customer' | 'daterange';
  const [reportMode, setReportMode] = useState<ReportMode>('customer');

  const [consumers,        setConsumers]        = useState<string[]>([]);
  const [selectedConsumer, setSelectedConsumer] = useState<string | null>(null);
  const [consumerSearch,   setConsumerSearch]   = useState('');
  const [dropdownOpen,     setDropdownOpen]     = useState(false);

  const [viewMode,         setViewMode]         = useState<ViewMode>('monthly');
  const [showAllPayments,  setShowAllPayments]  = useState(false);

  // Date-wise range filter. null = no bound on that side.
  const [rangeStartDate,   setRangeStartDate]   = useState<Date | null>(null);
  const [rangeEndDate,     setRangeEndDate]     = useState<Date | null>(null);
  const [showStartPicker,  setShowStartPicker]  = useState(false);
  const [showEndPicker,    setShowEndPicker]    = useState(false);

  // Pending mode rows
  const [pendingRows,      setPendingRows]      = useState<PendingRow[]>([]);
  // All-payment mode rows
  const [allPaymentRows,   setAllPaymentRows]   = useState<AllPaymentRow[]>([]);
  // Round-off direct bank payments
  const [roundOffPayments, setRoundOffPayments] = useState<any[]>([]);

  const [loadingConsumers, setLoadingConsumers] = useState(false);
  const [loadingTable,     setLoadingTable]     = useState(false);
  const [loadingPdf,       setLoadingPdf]       = useState(false);

  // ── "Date Wise (All Customers)" report state ────────────────────────────────

  const [allViewMode,      setAllViewMode]      = useState<ViewMode>('datewise');
  const [allRangeStart,    setAllRangeStart]    = useState<Date | null>(null);
  const [allRangeEnd,      setAllRangeEnd]      = useState<Date | null>(null);
  const [showAllStartPicker, setShowAllStartPicker] = useState(false);
  const [showAllEndPicker,   setShowAllEndPicker]   = useState(false);

  const [customerGroups,   setCustomerGroups]   = useState<CustomerGroup[]>([]);
  const [loadingAllTable,  setLoadingAllTable]  = useState(false);
  const [loadingAllPdf,    setLoadingAllPdf]    = useState(false);

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

  // "YYYY-MM-DD" bounds derived from the picked dates.
  const rangeStart = rangeStartDate ? toDateKey(rangeStartDate) : null;
  const rangeEnd   = rangeEndDate ? toDateKey(rangeEndDate) : null;
  const rangeActive = viewMode === 'datewise' && (rangeStart !== null || rangeEnd !== null);
  const rangeLabel  = rangeActive
    ? `${rangeStart ? fmtDate(rangeStart) : 'Start'} to ${rangeEnd ? fmtDate(rangeEnd) : 'End'}`
    : null;

  // Handlers for the native date pickers. Android fires 'set'/'dismissed' and
  // closes itself; iOS keeps the inline picker open until the user taps Done.
  const onChangeStartDate = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === 'android') setShowStartPicker(false);
    if (event.type === 'dismissed') return;
    if (picked) setRangeStartDate(picked);
  };

  const onChangeEndDate = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === 'android') setShowEndPicker(false);
    if (event.type === 'dismissed') return;
    if (picked) setRangeEndDate(picked);
  };

  // ── Load consumers on mount ────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoadingConsumers(true);
      try {
        const { data, error } = await supabase
          .from('dashboard_commercialrecords')
          .select('customer_name')
          .gt('delivery_date', '2022-01-01')
          .is('payment_date', null);
        if (error) throw error;
        const names = [
          ...new Set((data || []).map((r: any) => r.customer_name as string)),
        ].sort();
        setConsumers(names);
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Failed to load consumers.');
      } finally {
        setLoadingConsumers(false);
      }
    })();
  }, []);

  // ── Core fetch ─────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (
    consumer: string,
    mode: ViewMode,
    allPayments: boolean,
    rStart: string | null,
    rEnd: string | null,
  ) => {
    setLoadingTable(true);
    setPendingRows([]);
    setAllPaymentRows([]);
    setRoundOffPayments([]);

    try {
      // ── Build query based on mode ──────────────────────────────────────
      let query = supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, payment_date')
        .eq('customer_name', consumer)
        .gt('delivery_date', '2022-01-01')
        .order('delivery_date', { ascending: true });

      if (!allPayments || mode === 'monthly') {
        query = query.is('payment_date', null);
      }

      const { data: records, error: recErr } = await query;
      if (recErr) throw recErr;
      if (!records || records.length === 0) return;

      // ── Apply start/end date range filter (date-wise only) ──────────────
      const rangedRecords: RawRecord[] = mode === 'datewise'
        ? filterRecordsByRange(records as RawRecord[], rStart, rEnd)
        : (records as RawRecord[]);

      if (rangedRecords.length === 0) return;

      // ── Customer discount ──────────────────────────────────────────────
      const { data: custData, error: custErr } = await supabase
        .from('dashboard_customername')
        .select('name, discount')
        .eq('name', consumer)
        .single();
      if (custErr) throw custErr;
      const discount: number = custData?.discount ?? 0;

      // ── All rates ──────────────────────────────────────────────────────
      const { data: ratesData, error: rateErr } = await supabase
        .from('dashboard_commercialrate')
        .select('actual_rate, start_date, end_date')
        .order('start_date', { ascending: true });
      if (rateErr) throw rateErr;
      const allRates: RateRow[] = ratesData || [];

      // ── Fetch Round-off Payments ───────────────────────────────────────
      const { data: roundOffData, error: roundOffErr } = await supabase
        .from('commercial_bank_payments')
        .select('id, transaction_date, amount')
        .eq('customer_name', consumer)
        .eq('round_off_value', true)
        .order('transaction_date', { ascending: true });
      if (roundOffErr) throw roundOffErr;

      setRoundOffPayments(roundOffData || []);

      // ── Build rows ─────────────────────────────────────────────────────
      if (allPayments && mode === 'datewise') {
        setAllPaymentRows(
          buildAllPaymentRows(rangedRecords, discount, allRates),
        );
      } else if (mode === 'monthly') {
        setPendingRows(
          buildMonthlyRows(rangedRecords, discount, allRates),
        );
      } else {
        setPendingRows(
          buildDatewiseRows(rangedRecords, discount, allRates),
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load data.');
    } finally {
      setLoadingTable(false);
    }
  }, []);

  // Re-fetch whenever any of these change
  useEffect(() => {
    if (selectedConsumer) {
      fetchData(selectedConsumer, viewMode, showAllPayments, rangeStart, rangeEnd);
    }
    // rangeStart / rangeEnd are derived from rangeStartDate / rangeEndDate,
    // so those are the actual dependencies that should re-trigger a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConsumer, viewMode, showAllPayments, rangeStartDate, rangeEndDate, fetchData]);

  // ── PDF handler ────────────────────────────────────────────────────────────

  const handleDownloadPdf = async () => {
    if (!selectedConsumer) return;

    const isAllPaymentView = showAllPayments && viewMode === 'datewise';
    const hasData = isAllPaymentView
      ? allPaymentRows.length > 0
      : pendingRows.length > 0;

    if (!hasData) {
      Alert.alert('No Data', 'No records to generate PDF.');
      return;
    }

    try {
      setLoadingPdf(true);
      const html = isAllPaymentView
        ? buildAllPaymentPdfHtml(selectedConsumer, allPaymentRows, rangeLabel)
        : buildPendingPdfHtml(selectedConsumer, viewMode, pendingRows, roundOffPayments, rangeLabel);

      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType:    'application/pdf',
          dialogTitle: `${selectedConsumer} — ${isAllPaymentView ? 'All Payments' : 'Pending'}`,
          UTI:         'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingPdf(false);
    }
  };

  // ── "Date Wise (All Customers)" fetch ───────────────────────────────────────

  const fetchAllCustomersData = useCallback(async (
    mode: ViewMode,
    rStart: string | null,
    rEnd: string | null,
  ) => {
    setLoadingAllTable(true);
    setCustomerGroups([]);

    try {
      // ── All pending records across every customer ───────────────────────
      const { data: records, error: recErr } = await supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, payment_date')
        .is('payment_date', null)
        .gt('delivery_date', '2022-01-01')
        .order('customer_name', { ascending: true })
        .order('delivery_date', { ascending: true });
      if (recErr) throw recErr;
      if (!records || records.length === 0) return;

      // ── Apply the date-range filter ──────────────────────────────────────
      const rangedRecords = filterRecordsByRange(records as RawRecord[], rStart, rEnd);
      if (rangedRecords.length === 0) return;

      const customerNames = [...new Set(rangedRecords.map(r => r.customer_name))];

      // ── Discounts for just the customers appearing in this range ────────
      const { data: custData, error: custErr } = await supabase
        .from('dashboard_customername')
        .select('name, discount')
        .in('name', customerNames);
      if (custErr) throw custErr;

      const discountsByCustomer: Record<string, number> = {};
      for (const c of custData || []) {
        discountsByCustomer[c.name] = c.discount ?? 0;
      }

      // ── All rates ─────────────────────────────────────────────────────
      const { data: ratesData, error: rateErr } = await supabase
        .from('dashboard_commercialrate')
        .select('actual_rate, start_date, end_date')
        .order('start_date', { ascending: true });
      if (rateErr) throw rateErr;
      const allRates: RateRow[] = ratesData || [];

      setCustomerGroups(
        buildCustomerGroups(rangedRecords, discountsByCustomer, allRates, mode),
      );
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load data.');
    } finally {
      setLoadingAllTable(false);
    }
  }, []);

  // Re-fetch the all-customers report whenever its filters change
  useEffect(() => {
    if (reportMode === 'daterange') {
      fetchAllCustomersData(allViewMode, allRangeStartKey, allRangeEndKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportMode, allViewMode, allRangeStart, allRangeEnd, fetchAllCustomersData]);

  // ── "Date Wise (All Customers)" PDF handler ─────────────────────────────────

  const handleDownloadAllPdf = async () => {
    if (customerGroups.length === 0) {
      Alert.alert('No Data', 'No records to generate PDF.');
      return;
    }

    try {
      setLoadingAllPdf(true);
      const html = buildAllCustomersPdfHtml(allViewMode, customerGroups, allRangeLabel);

      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType:    'application/pdf',
          dialogTitle: 'All Customers — Pending Payments',
          UTI:         'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingAllPdf(false);
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const isAllPaymentView   = showAllPayments && viewMode === 'datewise';
  const filteredConsumers  = consumers.filter(c =>
    c.toUpperCase().includes(consumerSearch.toUpperCase()),
  );

  const pendingGrandTotal  = pendingRows.reduce((s, r) => s + r.pendingAmount, 0);
  const pendingTotalCyls   = pendingRows.reduce((s, r) => s + r.cylinders, 0);
  const allPayGrandTotal   = allPaymentRows.reduce((s, r) => s + r.amount, 0);
  const allPayTotalCyls    = allPaymentRows.reduce((s, r) => s + r.cylinders, 0);

  // Total subtractable round-off payments
  const totalRoundOffAmount = roundOffPayments.reduce((s, p) => s + p.amount, 0);
  const finalPendingAmount  = pendingGrandTotal - totalRoundOffAmount;

  const hasData = isAllPaymentView
    ? allPaymentRows.length > 0
    : pendingRows.length > 0;

  // All-customers report totals
  const allCustomersGrandTotal = customerGroups.reduce((s, g) => s + g.subtotalAmount, 0);
  const allCustomersGrandCyls  = customerGroups.reduce((s, g) => s + g.subtotalCyls, 0);
  const hasAllCustomersData    = customerGroups.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >

        {/* ── Header ── */}
        <View style={styles.header}>
          <Ionicons name="receipt-outline" size={28} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Commercial Pending</Text>
            <Text style={styles.headerSub}>SHREEJEE GAS SERVICE</Text>
          </View>
        </View>

        {/* ── Report Type ── */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>REPORT TYPE</Text>
          <View style={styles.radioRow}>
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
          </View>
        </View>

        {/* ── Consumer Dropdown ── */}
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

        {/* ── View Mode + Show All Payments + Date Range ── */}
        {reportMode === 'customer' && selectedConsumer && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>OPTIONS</Text>

            {/* Monthly / Date-wise radio */}
            <Text style={styles.optionGroupLabel}>View Mode</Text>
            <View style={styles.radioRow}>
              {(['monthly', 'datewise'] as ViewMode[]).map(mode => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.radioBtn, viewMode === mode && styles.radioBtnActive]}
                  onPress={() => {
                    setViewMode(mode);
                    if (mode === 'monthly') {
                      setShowAllPayments(false);
                    } else {
                      // Date-wise defaults to showing everything.
                      setShowAllPayments(false);
                    }
                  }}
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

            {/* Show All Payments checkbox + Date Range — only visible in datewise mode */}
            {viewMode === 'datewise' && (
              <>
                <View style={styles.divider} />
                <TouchableOpacity
                  style={styles.checkboxRow}
                  onPress={() => setShowAllPayments(p => !p)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.checkbox, showAllPayments && styles.checkboxChecked]}>
                    {showAllPayments && (
                      <Ionicons name="checkmark" size={14} color="#fff" />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.checkboxLabel}>Show All Payments</Text>
                    <Text style={styles.checkboxHint}>
                      Includes paid deliveries — split by delivery date &amp; payment date
                    </Text>
                  </View>
                </TouchableOpacity>

                <View style={styles.divider} />
                <Text style={styles.optionGroupLabel}>Filter by Delivery Date Range</Text>
                <View style={styles.rangeRow}>
                  <View style={styles.rangeField}>
                    <Text style={styles.rangeFieldLabel}>Start Date</Text>
                    <TouchableOpacity
                      style={styles.rangeDateBtn}
                      onPress={() => setShowStartPicker(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="calendar-outline" size={16} color={BPCL_BLUE} />
                      <Text style={[
                        styles.rangeDateBtnText,
                        !rangeStartDate && styles.rangeDateBtnPlaceholder,
                      ]}>
                        {rangeStartDate ? fmtDate(toDateKey(rangeStartDate)) : 'Any'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.rangeField}>
                    <Text style={styles.rangeFieldLabel}>End Date</Text>
                    <TouchableOpacity
                      style={styles.rangeDateBtn}
                      onPress={() => setShowEndPicker(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="calendar-outline" size={16} color={BPCL_BLUE} />
                      <Text style={[
                        styles.rangeDateBtnText,
                        !rangeEndDate && styles.rangeDateBtnPlaceholder,
                      ]}>
                        {rangeEndDate ? fmtDate(toDateKey(rangeEndDate)) : 'Any'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {(rangeStartDate || rangeEndDate) && (
                    <TouchableOpacity
                      style={styles.rangeClearBtn}
                      onPress={() => { setRangeStartDate(null); setRangeEndDate(null); }}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="close-circle" size={22} color="#999" />
                    </TouchableOpacity>
                  )}
                </View>

                {showStartPicker && (
                  <DateTimePicker
                    value={rangeStartDate || new Date()}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'inline' : 'default'}
                    maximumDate={rangeEndDate || undefined}
                    onChange={onChangeStartDate}
                  />
                )}
                {Platform.OS === 'ios' && showStartPicker && (
                  <TouchableOpacity
                    style={styles.pickerDoneBtn}
                    onPress={() => setShowStartPicker(false)}
                  >
                    <Text style={styles.pickerDoneBtnText}>Done</Text>
                  </TouchableOpacity>
                )}

                {showEndPicker && (
                  <DateTimePicker
                    value={rangeEndDate || new Date()}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'inline' : 'default'}
                    minimumDate={rangeStartDate || undefined}
                    onChange={onChangeEndDate}
                  />
                )}
                {Platform.OS === 'ios' && showEndPicker && (
                  <TouchableOpacity
                    style={styles.pickerDoneBtn}
                    onPress={() => setShowEndPicker(false)}
                  >
                    <Text style={styles.pickerDoneBtnText}>Done</Text>
                  </TouchableOpacity>
                )}

                {rangeActive && (
                  <Text style={styles.rangeActiveText}>
                    Showing records from {rangeStart ? fmtDate(rangeStart) : 'the beginning'} to{' '}
                    {rangeEnd ? fmtDate(rangeEnd) : 'the latest'}.
                  </Text>
                )}
              </>
            )}
          </View>
        )}

        {/* ── Table ── */}
        {reportMode === 'customer' && selectedConsumer && (
          <View style={styles.card}>

            {/* Card top row */}
            <View style={styles.tableTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>
                  {isAllPaymentView ? 'ALL PAYMENTS' : 'PENDING RECORDS'}
                </Text>
                <Text style={styles.consumerName}>{selectedConsumer}</Text>
              </View>

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
                    <Text style={styles.pdfBtnText}>Download PDF</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {loadingTable ? (
              <ActivityIndicator color={BPCL_BLUE} size="large" style={{ marginVertical: 32 }} />
            ) : !hasData ? (
              <View style={styles.emptyBox}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#c8d6e5" />
                <Text style={styles.emptyText}>No records found.</Text>
              </View>

            ) : isAllPaymentView ? (
              /* ══════════════════════════════════════════════════════════════
                 ALL-PAYMENT TABLE
                 ══════════════════════════════════════════════════════════════ */
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View>
                    {/* Header */}
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      {[
                        'Delivery Date','Payment Date','Cylinders',
                        'Rate','Discount','Eff. Rate','Amount ₹',
                      ].map((h, i) => (
                        <View
                          key={i}
                          style={[styles.tCell, i < 2 && styles.tDateCell]}
                        >
                          <Text style={styles.tHeaderTxt}>{h}</Text>
                        </View>
                      ))}
                    </View>

                    {/* Rows */}
                    {allPaymentRows.map((row, i) => {
                      const isPending = row.paymentDate === 'Pending';
                      return (
                        <View
                          key={i}
                          style={[
                            styles.tRow,
                            i % 2 === 0 ? styles.tRowEven : styles.tRowOdd,
                            isPending && styles.tPendingRow,
                          ]}
                        >
                          <View style={[styles.tCell, styles.tDateCell]}>
                            <Text style={styles.tTxt}>{row.deliveryDate}</Text>
                          </View>
                          <View style={[styles.tCell, styles.tDateCell]}>
                            <Text style={[styles.tTxt, isPending && styles.tPendingTag]}>
                              {row.paymentDate}
                            </Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={styles.tTxt}>{row.cylinders}</Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={styles.tTxt}>₹{row.rate.toFixed(2)}</Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={[styles.tTxt, row.discount === 0 && styles.tMuted]}>
                              {row.discount === 0 ? '—' : `₹${row.discount.toFixed(2)}`}
                            </Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={styles.tTxt}>₹{row.effectiveRate.toFixed(2)}</Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={[styles.tTxt, styles.tAmount]}>
                              ₹{row.amount.toFixed(2)}
                            </Text>
                          </View>
                        </View>
                      );
                    })}

                    {/* Total */}
                    <View style={[styles.tRow, styles.tTotalRow]}>
                      <View style={[styles.tCell, styles.tDateCell]}>
                        <Text style={styles.tTotalTxt}>TOTAL</Text>
                      </View>
                      <View style={[styles.tCell, styles.tDateCell]}>
                        <Text style={styles.tTotalTxt}>—</Text>
                      </View>
                      <View style={styles.tCell}>
                        <Text style={styles.tTotalTxt}>{allPayTotalCyls}</Text>
                      </View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}>
                        <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                          ₹{allPayGrandTotal.toFixed(2)}
                        </Text>
                      </View>
                    </View>
                  </View>
                </ScrollView>

                {/* Summary pill */}
                <View style={styles.summaryPill}>
                  <Text style={styles.summaryPillLabel}>Grand Total</Text>
                  <Text style={styles.summaryPillValue}>₹{allPayGrandTotal.toFixed(2)}</Text>
                </View>
              </>

            ) : (
              /* ══════════════════════════════════════════════════════════════
                 PENDING TABLE  (monthly or datewise) with Round-Off Support
                 ══════════════════════════════════════════════════════════════ */
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View>
                    {/* Header */}
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      {[
                        viewMode === 'monthly' ? 'Month' : 'Date',
                        'Cylinders','Rate','Discount','Eff. Rate','Pending ₹',
                      ].map((h, i) => (
                        <View key={i} style={[styles.tCell, i === 0 && styles.tLabelCell]}>
                          <Text style={styles.tHeaderTxt}>{h}</Text>
                        </View>
                      ))}
                    </View>

                    {/* Rows */}
                    {pendingRows.map((row, i) => (
                      <View
                        key={i}
                        style={[
                          styles.tRow,
                          i % 2 === 0 ? styles.tRowEven : styles.tRowOdd,
                          row.isSub && styles.tSubRow,
                        ]}
                      >
                        <View style={[styles.tCell, styles.tLabelCell]}>
                          <Text style={styles.tLabelTxt}>{row.label}</Text>
                        </View>
                        <View style={styles.tCell}>
                          <Text style={styles.tTxt}>{row.cylinders}</Text>
                        </View>
                        <View style={styles.tCell}>
                          <Text style={styles.tTxt}>₹{row.rate.toFixed(2)}</Text>
                        </View>
                        <View style={styles.tCell}>
                          <Text style={[styles.tTxt, row.discount === 0 && styles.tMuted]}>
                            {row.discount === 0 ? '—' : `₹${row.discount.toFixed(2)}`}
                          </Text>
                        </View>
                        <View style={styles.tCell}>
                          <Text style={styles.tTxt}>₹{row.effectiveRate.toFixed(2)}</Text>
                        </View>
                        <View style={styles.tCell}>
                          <Text style={[styles.tTxt, styles.tAmount]}>
                            ₹{row.pendingAmount.toFixed(2)}
                          </Text>
                        </View>
                      </View>
                    ))}

                    {/* Total Row */}
                    <View style={[styles.tRow, styles.tTotalRow]}>
                      <View style={[styles.tCell, styles.tLabelCell]}>
                        <Text style={styles.tTotalTxt}>TOTAL PENDING</Text>
                      </View>
                      <View style={styles.tCell}>
                        <Text style={styles.tTotalTxt}>{pendingTotalCyls}</Text>
                      </View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}>
                        <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                          ₹{pendingGrandTotal.toFixed(2)}
                        </Text>
                      </View>
                    </View>

                    {/* Round-off Payment Rows */}
                    {roundOffPayments.map((p, i) => (
                      <View key={`ro-${i}`} style={[styles.tRow, styles.tRoundOffRow]}>
                        <View style={[styles.tCell, styles.tLabelCell]}>
                          <Text style={[styles.tLabelTxt, { fontStyle: 'italic', color: '#c0392b', fontWeight: '600' }]}>
                            Round-off Payment ({fmtDate(p.transaction_date)})
                          </Text>
                        </View>
                        <View style={styles.tCell}><Text style={styles.tTxt}>—</Text></View>
                        <View style={styles.tCell}><Text style={styles.tTxt}>—</Text></View>
                        <View style={styles.tCell}><Text style={styles.tTxt}>—</Text></View>
                        <View style={styles.tCell}><Text style={styles.tTxt}>—</Text></View>
                        <View style={styles.tCell}>
                          <Text style={[styles.tTxt, styles.tAmount, { color: '#c0392b' }]}>
                            -₹{p.amount.toFixed(2)}
                          </Text>
                        </View>
                      </View>
                    ))}

                    {/* Final Pending Amount Row */}
                    {roundOffPayments.length > 0 && (
                      <View style={[styles.tRow, styles.tFinalPendingRow]}>
                        <View style={[styles.tCell, styles.tLabelCell]}>
                          <Text style={[styles.tLabelTxt, { fontWeight: '800', color: '#2e7d32' }]}>
                            FINAL PENDING AMOUNT
                          </Text>
                        </View>
                        <View style={styles.tCell}><Text style={[styles.tTxt, { fontWeight: '800', color: '#2e7d32' }]}>—</Text></View>
                        <View style={styles.tCell}><Text style={[styles.tTxt, { fontWeight: '800', color: '#2e7d32' }]}>—</Text></View>
                        <View style={styles.tCell}><Text style={[styles.tTxt, { fontWeight: '800', color: '#2e7d32' }]}>—</Text></View>
                        <View style={styles.tCell}><Text style={[styles.tTxt, { fontWeight: '800', color: '#2e7d32' }]}>—</Text></View>
                        <View style={styles.tCell}>
                          <Text style={[styles.tTxt, styles.tAmount, { color: '#2e7d32', fontWeight: '800' }]}>
                            ₹{finalPendingAmount.toFixed(2)}
                          </Text>
                        </View>
                      </View>
                    )}
                  </View>
                </ScrollView>

                {/* Summary pill */}
                <View style={styles.summaryPill}>
                  <Text style={styles.summaryPillLabel}>
                    {roundOffPayments.length > 0 ? 'Final Pending Amount' : 'Total Pending'}
                  </Text>
                  <Text style={styles.summaryPillValue}>
                    ₹{(roundOffPayments.length > 0 ? finalPendingAmount : pendingGrandTotal).toFixed(2)}
                  </Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* ── Date Wise (All Customers) — Options ── */}
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
                Showing pending payments from {allRangeStartKey ? fmtDate(allRangeStartKey) : 'the beginning'} to{' '}
                {allRangeEndKey ? fmtDate(allRangeEndKey) : 'the latest'}, across all customers.
              </Text>
            )}
          </View>
        )}

        {/* ── Date Wise (All Customers) — Table ── */}
        {reportMode === 'daterange' && (
          <View style={styles.card}>

            <View style={styles.tableTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>PENDING RECORDS — ALL CUSTOMERS</Text>
                <Text style={styles.consumerName}>
                  {customerGroups.length} consumer{customerGroups.length === 1 ? '' : 's'} with pending payments
                </Text>
              </View>

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
                    <Text style={styles.pdfBtnText}>Download PDF</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {loadingAllTable ? (
              <ActivityIndicator color={BPCL_BLUE} size="large" style={{ marginVertical: 32 }} />
            ) : !hasAllCustomersData ? (
              <View style={styles.emptyBox}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#c8d6e5" />
                <Text style={styles.emptyText}>No pending payments found for this range.</Text>
              </View>
            ) : (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View>
                    {/* Header */}
                    <View style={[styles.tRow, styles.tHeaderRow]}>
                      {[
                        allViewMode === 'monthly' ? 'Month' : 'Date',
                        'Cylinders','Rate','Discount','Eff. Rate','Pending ₹',
                      ].map((h, i) => (
                        <View key={i} style={[styles.tCell, i === 0 && styles.tLabelCell]}>
                          <Text style={styles.tHeaderTxt}>{h}</Text>
                        </View>
                      ))}
                    </View>

                    {/* Customer groups */}
                    {customerGroups.map((group, gi) => (
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
                              row.isSub && styles.tSubRow,
                            ]}
                          >
                            <View style={[styles.tCell, styles.tLabelCell]}>
                              <Text style={styles.tLabelTxt}>{row.label}</Text>
                            </View>
                            <View style={styles.tCell}>
                              <Text style={styles.tTxt}>{row.cylinders}</Text>
                            </View>
                            <View style={styles.tCell}>
                              <Text style={styles.tTxt}>₹{row.rate.toFixed(2)}</Text>
                            </View>
                            <View style={styles.tCell}>
                              <Text style={[styles.tTxt, row.discount === 0 && styles.tMuted]}>
                                {row.discount === 0 ? '—' : `₹${row.discount.toFixed(2)}`}
                              </Text>
                            </View>
                            <View style={styles.tCell}>
                              <Text style={styles.tTxt}>₹{row.effectiveRate.toFixed(2)}</Text>
                            </View>
                            <View style={styles.tCell}>
                              <Text style={[styles.tTxt, styles.tAmount]}>
                                ₹{row.pendingAmount.toFixed(2)}
                              </Text>
                            </View>
                          </View>
                        ))}

                        {/* Per-customer subtotal */}
                        <View style={[styles.tRow, styles.tSubtotalRow]}>
                          <View style={[styles.tCell, styles.tLabelCell]}>
                            <Text style={styles.tSubtotalTxt}>Subtotal</Text>
                          </View>
                          <View style={styles.tCell}>
                            <Text style={styles.tSubtotalTxt}>{group.subtotalCyls}</Text>
                          </View>
                          <View style={styles.tCell}><Text style={styles.tSubtotalTxt}>—</Text></View>
                          <View style={styles.tCell}><Text style={styles.tSubtotalTxt}>—</Text></View>
                          <View style={styles.tCell}><Text style={styles.tSubtotalTxt}>—</Text></View>
                          <View style={styles.tCell}>
                            <Text style={[styles.tSubtotalTxt, { color: BPCL_BLUE }]}>
                              ₹{group.subtotalAmount.toFixed(2)}
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
                        <Text style={styles.tTotalTxt}>{allCustomersGrandCyls}</Text>
                      </View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                      <View style={styles.tCell}>
                        <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                          ₹{allCustomersGrandTotal.toFixed(2)}
                        </Text>
                      </View>
                    </View>
                  </View>
                </ScrollView>

                {/* Summary pill */}
                <View style={styles.summaryPill}>
                  <Text style={styles.summaryPillLabel}>Grand Total — All Customers</Text>
                  <Text style={styles.summaryPillValue}>₹{allCustomersGrandTotal.toFixed(2)}</Text>
                </View>
              </>
            )}
          </View>
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
  dropdownButtonText: { fontSize: 15, color: '#333', fontWeight: '500', flex: 1 },
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

  // Divider
  divider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 14 },

  // Checkbox
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: BPCL_BLUE,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked:  { backgroundColor: BPCL_BLUE },
  checkboxLabel:    { fontSize: 14, fontWeight: '600', color: '#333' },
  checkboxHint:     { fontSize: 11, color: '#999', marginTop: 2 },

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

  // Empty
  emptyBox:  { alignItems: 'center', paddingVertical: 36, gap: 10 },
  emptyText: { fontSize: 14, color: '#bbb', fontWeight: '500' },

  // Table rows
  tRow:       { flexDirection: 'row' },
  tHeaderRow: { backgroundColor: '#d9e1f2', borderRadius: 6, marginBottom: 2 },
  tRowEven:   { backgroundColor: '#fff' },
  tRowOdd:    { backgroundColor: '#fafbfc' },
  tSubRow:    { backgroundColor: '#f0f4ff' },
  tPendingRow:{ backgroundColor: '#fff5f5' },
  tTotalRow:  {
    backgroundColor: '#e8ecf0', borderTopWidth: 2,
    borderTopColor: '#ccd', marginTop: 2, borderRadius: 6,
  },
  tRoundOffRow: {
    backgroundColor: '#fff5f5',
    borderTopWidth: 1,
    borderTopColor: '#ffe3e3',
  },
  tFinalPendingRow: {
    backgroundColor: '#e8f5e9',
    borderTopWidth: 2,
    borderTopColor: '#a5d6a7',
    borderRadius: 6,
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
  tSubtotalTxt: { fontSize: 11, fontWeight: '700', color: '#333', textAlign: 'center' },

  // Table cells
  tCell: {
    width: 90, paddingVertical: 9, paddingHorizontal: 6,
    justifyContent: 'center', alignItems: 'center',
    borderRightWidth: 1, borderRightColor: '#eee',
  },
  tDateCell:  { width: 110 },
  tLabelCell: { width: 170, alignItems: 'flex-start', paddingLeft: 10 },

  tHeaderTxt: { fontSize: 10, fontWeight: '700', color: '#333', textAlign: 'center' },
  tTxt:       { fontSize: 11, color: '#444', textAlign: 'center' },
  tLabelTxt:  { fontSize: 11, color: '#333' },
  tMuted:     { color: '#ccc' },
  tAmount:    { fontWeight: '700', color: '#111' },
  tPendingTag:{ color: '#c0392b', fontWeight: '700' },
  tTotalTxt:  { fontSize: 11, fontWeight: '800', color: '#111', textAlign: 'center' },

  // Summary pill
  summaryPill: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 14, backgroundColor: '#eef6fd', borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1.5, borderColor: '#b8d9f5',
  },
  summaryPillLabel: { fontSize: 13, fontWeight: '600', color: '#555' },
  summaryPillValue: { fontSize: 16, fontWeight: '800', color: BPCL_BLUE },
});
