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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
// PDF — Pending (monthly or datewise) with Round-Off Payment Support
// ─────────────────────────────────────────────────────────────────────────────

function buildPendingPdfHtml(
  consumerName: string,
  viewMode: ViewMode,
  rows: PendingRow[],
  roundOffPayments: any[],
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
           text-decoration:underline; margin:8px 0 16px; }
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
           text-decoration:underline; margin:8px 0 16px; }
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
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function CommercialPendingScreen() {

  // ── State ──────────────────────────────────────────────────────────────────

  const [consumers,        setConsumers]        = useState<string[]>([]);
  const [selectedConsumer, setSelectedConsumer] = useState<string | null>(null);
  const [consumerSearch,   setConsumerSearch]   = useState('');
  const [dropdownOpen,     setDropdownOpen]     = useState(false);

  const [viewMode,         setViewMode]         = useState<ViewMode>('monthly');
  const [showAllPayments,  setShowAllPayments]  = useState(false);

  // Pending mode rows
  const [pendingRows,      setPendingRows]      = useState<PendingRow[]>([]);
  // All-payment mode rows
  const [allPaymentRows,   setAllPaymentRows]   = useState<AllPaymentRow[]>([]);
  // Round-off direct bank payments
  const [roundOffPayments, setRoundOffPayments] = useState<any[]>([]);

  const [loadingConsumers, setLoadingConsumers] = useState(false);
  const [loadingTable,     setLoadingTable]     = useState(false);
  const [loadingPdf,       setLoadingPdf]       = useState(false);

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
          buildAllPaymentRows(records as RawRecord[], discount, allRates),
        );
      } else if (mode === 'monthly') {
        setPendingRows(
          buildMonthlyRows(records as RawRecord[], discount, allRates),
        );
      } else {
        setPendingRows(
          buildDatewiseRows(records as RawRecord[], discount, allRates),
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
    if (selectedConsumer) fetchData(selectedConsumer, viewMode, showAllPayments);
  }, [selectedConsumer, viewMode, showAllPayments, fetchData]);

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
        ? buildAllPaymentPdfHtml(selectedConsumer, allPaymentRows)
        : buildPendingPdfHtml(selectedConsumer, viewMode, pendingRows, roundOffPayments);

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

        {/* ── Consumer Dropdown ── */}
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

        {/* ── View Mode + Show All Payments ── */}
        {selectedConsumer && (
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
                    if (mode === 'monthly') setShowAllPayments(false);
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

            {/* Show All Payments checkbox — only visible in datewise mode */}
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
              </>
            )}
          </View>
        )}

        {/* ── Table ── */}
        {selectedConsumer && (
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
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 16,
    borderRadius: 12, borderWidth: 1.5, borderColor: '#e0e0e0', backgroundColor: '#fafafa',
  },
  radioBtnActive:   { borderColor: BPCL_BLUE, backgroundColor: '#eef6fd' },
  radioCircle: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: BPCL_BLUE,
    alignItems: 'center', justifyContent: 'center',
  },
  radioInner:       { width: 10, height: 10, borderRadius: 5, backgroundColor: BPCL_BLUE },
  radioLabel:       { fontSize: 14, color: '#666', fontWeight: '500' },
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