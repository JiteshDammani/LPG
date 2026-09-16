import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import { format, parseISO } from 'date-fns';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BPCL_BLUE = '#017DC5';
const DISCOUNT_CUTOFF = '2026-03-01'; // Dates >= this get zero discount

const MONTH_NAMES: Record<number, string> = {
  1: 'January', 2: 'February',  3: 'March',     4: 'April',
  5: 'May',     6: 'June',      7: 'July',       8: 'August',
  9: 'September', 10: 'October', 11: 'November', 12: 'December',
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ViewMode = 'monthly' | 'datewise';

interface RawRecord {
  id: number;
  customer_name: string;
  delivery_date: string;   // 'YYYY-MM-DD'
  payment_date: string | null;
}

interface RateRow {
  actual_rate: number;
  start_date: string;
  end_date: string;
}

interface CustomerRow {
  name: string;
  discount: number;
}

// Rows shown in the table and PDF
interface PendingRow {
  label: string;         // Month name OR date string
  cylinders: number;
  rate: number;
  discount: number;      // 0 if >= cutoff
  effectiveRate: number; // rate - discount
  pendingAmount: number; // effectiveRate * cylinders
  isSub?: boolean;       // March 2026 split sub-row
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns yyyy-MM-dd key for a date string */
function dateKey(d: string) {
  return d.slice(0, 10);
}

/** True if date string is before the discount cutoff */
function beforeCutoff(d: string): boolean {
  return dateKey(d) < DISCOUNT_CUTOFF;
}

/** e.g. "2024-05-15" → "May 2024" */
function monthLabel(d: string): string {
  const dt = parseISO(d);
  return `${MONTH_NAMES[dt.getMonth() + 1]} ${dt.getFullYear()}`;
}

/** "May 2024" → { month: 5, year: 2024 } */
function parseMonthLabel(label: string): { month: number; year: number } {
  const parts = label.split(' ');
  const month = Object.entries(MONTH_NAMES).find(([, v]) => v === parts[0])?.[0];
  return { month: Number(month), year: Number(parts[1]) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate fetcher — finds the applicable CommercialRate for a given date
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRateForDate(date: string, allRates: RateRow[]): Promise<number | null> {
  const d = dateKey(date);
  const rate = allRates.find(r => r.start_date <= d && r.end_date >= d);
  return rate ? rate.actual_rate : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build monthly rows — applies split logic for March 2026
// ─────────────────────────────────────────────────────────────────────────────

async function buildMonthlyRows(
  records: RawRecord[],
  discount: number,
  allRates: RateRow[],
): Promise<PendingRow[]> {
  // Group records by "Month Year" label
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
      // Single row
      const applyDiscount = allBefore;
      const sampleDate = recs[0].delivery_date;
      const rate = await fetchRateForDate(sampleDate, allRates);
      if (rate === null) continue;

      const disc        = applyDiscount ? discount : 0;
      const effRate     = rate - disc;
      const cylinders   = recs.length;
      rows.push({
        label,
        cylinders,
        rate,
        discount: disc,
        effectiveRate: effRate,
        pendingAmount: effRate * cylinders,
      });
    } else {
      // Split month (straddles cutoff — e.g. March 2026)
      const before = recs.filter(r => beforeCutoff(r.delivery_date));
      const after  = recs.filter(r => !beforeCutoff(r.delivery_date));

      if (before.length > 0) {
        const rate = await fetchRateForDate(before[0].delivery_date, allRates);
        if (rate !== null) {
          const effRate = rate - discount;
          rows.push({
            label: `${label} (before ${DISCOUNT_CUTOFF})`,
            cylinders: before.length,
            rate,
            discount,
            effectiveRate: effRate,
            pendingAmount: effRate * before.length,
            isSub: true,
          });
        }
      }

      if (after.length > 0) {
        const rate = await fetchRateForDate(after[0].delivery_date, allRates);
        if (rate !== null) {
          rows.push({
            label: `${label} (from ${DISCOUNT_CUTOFF})`,
            cylinders: after.length,
            rate,
            discount: 0,
            effectiveRate: rate,
            pendingAmount: rate * after.length,
            isSub: true,
          });
        }
      }
    }
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build date-wise rows
// ─────────────────────────────────────────────────────────────────────────────

async function buildDatewiseRows(
  records: RawRecord[],
  discount: number,
  allRates: RateRow[],
): Promise<PendingRow[]> {
  // Group by exact delivery_date
  const grouped: Record<string, RawRecord[]> = {};
  for (const r of records) {
    const key = dateKey(r.delivery_date);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  const rows: PendingRow[] = [];

  for (const [date, recs] of Object.entries(grouped).sort()) {
    const rate = await fetchRateForDate(date, allRates);
    if (rate === null) continue;

    const applyDiscount = beforeCutoff(date);
    const disc          = applyDiscount ? discount : 0;
    const effRate       = rate - disc;
    const cylinders     = recs.length;

    rows.push({
      label: format(parseISO(date), 'dd MMM yyyy'),
      cylinders,
      rate,
      discount: disc,
      effectiveRate: effRate,
      pendingAmount: effRate * cylinders,
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF HTML builder
// ─────────────────────────────────────────────────────────────────────────────

function buildPdfHtml(
  consumerName: string,
  viewMode: ViewMode,
  rows: PendingRow[],
): string {
  const colHeader = viewMode === 'monthly' ? 'Month' : 'Date';
  const grandTotal = rows.reduce((s, r) => s + r.pendingAmount, 0);

  const tableRows = rows.map(r => `
    <tr class="${r.isSub ? 'sub-row' : ''}">
      <td class="left">${r.label}</td>
      <td>${r.cylinders}</td>
      <td>₹${r.rate.toFixed(2)}</td>
      <td>₹${r.discount.toFixed(2)}</td>
      <td>₹${r.effectiveRate.toFixed(2)}</td>
      <td>₹${r.pendingAmount.toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 9.5pt; color: #000; }

  .header  { text-align: center; margin-bottom: 10px; }
  .header h1 { font-size: 14pt; font-weight: bold; }
  .header h2 { font-size: 10pt; font-weight: normal; margin-top: 3px; }
  .title   { font-size: 12pt; font-weight: bold; text-align: center;
              text-decoration: underline; margin: 8px 0 14px; }

  table    { width: 100%; border-collapse: collapse; }
  th, td   { border: 1px solid #555; padding: 6px 7px;
              text-align: center; font-size: 9pt; }
  th       { background: #d9e1f2; font-weight: bold; }
  td.left  { text-align: left; }
  .sub-row td { background: #f7f9ff; }

  .total-row td { font-weight: bold; background: #e8ecf0; }
  .footer  { margin-top: 16px; font-size: 9pt; text-align: right; color: #555; }
</style>
</head>
<body>

<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>Commercial Pending Statement</h2>
</div>

<div class="title">PENDING AMOUNT — ${consumerName.toUpperCase()}</div>

<table>
  <thead>
    <tr>
      <th>${colHeader}</th>
      <th>Cylinders</th>
      <th>Rate</th>
      <th>Discount</th>
      <th>Effective Rate</th>
      <th>Pending Amount</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
    <tr class="total-row">
      <td colspan="5" class="left">TOTAL PENDING AMOUNT</td>
      <td>₹${grandTotal.toFixed(2)}</td>
    </tr>
  </tbody>
</table>

<div class="footer">Generated on ${format(new Date(), 'dd MMM yyyy, hh:mm a')}</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function CommercialPendingScreen() {
  // ── State ────────────────────────────────────────────────────────────────

  const [consumers,        setConsumers]        = useState<string[]>([]);
  const [selectedConsumer, setSelectedConsumer]  = useState<string | null>(null);
  const [viewMode,         setViewMode]          = useState<ViewMode>('monthly');
  const [pendingRows,      setPendingRows]        = useState<PendingRow[]>([]);

  const [loadingConsumers, setLoadingConsumers]  = useState(false);
  const [loadingTable,     setLoadingTable]       = useState(false);
  const [loadingPdf,       setLoadingPdf]         = useState(false);

  // ── Fetch consumer list on mount ─────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoadingConsumers(true);
      try {
        const { data, error } = await supabase
          .from('dashboard_commercialrecords')
          .select('customer_name')
          .is('payment_date', null);

        if (error) throw error;

        // Distinct names
        const names = [...new Set((data || []).map((r: any) => r.customer_name as string))].sort();
        setConsumers(names);
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Failed to load consumers.');
      } finally {
        setLoadingConsumers(false);
      }
    })();
  }, []);

  // ── Fetch + build table whenever consumer or viewMode changes ────────────

  const fetchPendingData = useCallback(async (consumer: string, mode: ViewMode) => {
    setLoadingTable(true);
    setPendingRows([]);

    try {
      // 1. Fetch all pending records for this consumer
      const { data: records, error: recErr } = await supabase
        .from('dashboard_commercialrecords')
        .select('id, customer_name, delivery_date, payment_date')
        .eq('customer_name', consumer)
        .is('payment_date', null)
        .order('delivery_date', { ascending: true });

      if (recErr) throw recErr;
      if (!records || records.length === 0) {
        setPendingRows([]);
        return;
      }

      // 2. Fetch customer discount
      const { data: custData, error: custErr } = await supabase
        .from('dashboard_customername')
        .select('name, discount')
        .eq('name', consumer)
        .single();

      if (custErr) throw custErr;
      const discount: number = custData?.discount ?? 0;

      // 3. Fetch all rates (we'll match locally)
      const { data: ratesData, error: rateErr } = await supabase
        .from('dashboard_commercialrate')
        .select('actual_rate, start_date, end_date')
        .order('start_date', { ascending: true });

      if (rateErr) throw rateErr;
      const allRates: RateRow[] = ratesData || [];

      // 4. Build rows
      const rows =
        mode === 'monthly'
          ? await buildMonthlyRows(records as RawRecord[], discount, allRates)
          : await buildDatewiseRows(records as RawRecord[], discount, allRates);

      setPendingRows(rows);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load pending data.');
    } finally {
      setLoadingTable(false);
    }
  }, []);

  // Trigger re-fetch when consumer or mode changes
  useEffect(() => {
    if (selectedConsumer) {
      fetchPendingData(selectedConsumer, viewMode);
    }
  }, [selectedConsumer, viewMode, fetchPendingData]);

  // ── PDF download ──────────────────────────────────────────────────────────

  const handleDownloadPdf = async () => {
    if (!selectedConsumer || pendingRows.length === 0) {
      Alert.alert('No Data', 'Select a consumer first and ensure there are pending records.');
      return;
    }
    try {
      setLoadingPdf(true);
      const html = buildPdfHtml(selectedConsumer, viewMode, pendingRows);
      const { uri } = await Print.printToFileAsync({ html, base64: false });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: `Pending — ${selectedConsumer}`,
          UTI: 'com.adobe.pdf',
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

  // ── Grand total ───────────────────────────────────────────────────────────

  const grandTotal = pendingRows.reduce((s, r) => s + r.pendingAmount, 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <Ionicons name="receipt-outline" size={28} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Commercial Pending</Text>
            <Text style={styles.headerSub}>SHREEJEE GAS SERVICE</Text>
          </View>
        </View>

        {/* ── Consumer Dropdown Card ── */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>SELECT CONSUMER</Text>

          {loadingConsumers ? (
            <ActivityIndicator color={BPCL_BLUE} style={{ marginVertical: 16 }} />
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {consumers.map(name => {
                const active = selectedConsumer === name;
                return (
                  <TouchableOpacity
                    key={name}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => {
                      setSelectedConsumer(name);
                      setPendingRows([]);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>

        {/* ── Radio: Monthly / Date-wise ── */}
        {selectedConsumer && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>VIEW MODE</Text>
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
          </View>
        )}

        {/* ── Table ── */}
        {selectedConsumer && (
          <View style={styles.card}>
            <View style={styles.tableHeader}>
              <Text style={styles.sectionLabel}>
                {selectedConsumer} — {viewMode === 'monthly' ? 'MONTHLY' : 'DATE-WISE'} PENDING
              </Text>
              {/* Download PDF button */}
              <TouchableOpacity
                style={[styles.pdfBtn, (loadingPdf || loadingTable || pendingRows.length === 0) && styles.pdfBtnDisabled]}
                onPress={handleDownloadPdf}
                disabled={loadingPdf || loadingTable || pendingRows.length === 0}
                activeOpacity={0.8}
              >
                {loadingPdf
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <>
                      <Ionicons name="download-outline" size={15} color="#fff" />
                      <Text style={styles.pdfBtnText}>PDF</Text>
                    </>
                }
              </TouchableOpacity>
            </View>

            {loadingTable ? (
              <ActivityIndicator color={BPCL_BLUE} style={{ marginVertical: 24 }} />
            ) : pendingRows.length === 0 ? (
              <Text style={styles.emptyText}>No pending records found.</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View>
                  {/* Column headers */}
                  <View style={styles.tRow}>
                    {[
                      viewMode === 'monthly' ? 'Month' : 'Date',
                      'Cylinders',
                      'Rate',
                      'Discount',
                      'Eff. Rate',
                      'Pending ₹',
                    ].map((h, i) => (
                      <View
                        key={i}
                        style={[
                          styles.tCell,
                          styles.tHeaderCell,
                          i === 0 && styles.tLabelCell,
                        ]}
                      >
                        <Text style={styles.tHeaderTxt}>{h}</Text>
                      </View>
                    ))}
                  </View>

                  {/* Data rows */}
                  {pendingRows.map((row, i) => (
                    <View
                      key={i}
                      style={[styles.tRow, row.isSub && styles.tSubRow]}
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
                        <Text style={[styles.tTxt, row.discount === 0 && styles.tZero]}>
                          ₹{row.discount.toFixed(2)}
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

                  {/* Grand total row */}
                  <View style={[styles.tRow, styles.tTotalRow]}>
                    <View style={[styles.tCell, styles.tLabelCell]}>
                      <Text style={styles.tTotalTxt}>TOTAL</Text>
                    </View>
                    <View style={styles.tCell}>
                      <Text style={styles.tTotalTxt}>
                        {pendingRows.reduce((s, r) => s + r.cylinders, 0)}
                      </Text>
                    </View>
                    <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTotalTxt}>—</Text></View>
                    <View style={styles.tCell}>
                      <Text style={[styles.tTotalTxt, { color: BPCL_BLUE }]}>
                        ₹{grandTotal.toFixed(2)}
                      </Text>
                    </View>
                  </View>

                </View>
              </ScrollView>
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

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: BPCL_BLUE,
    borderRadius: 16,
    padding: 20,
    marginBottom: 14,
  },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  headerSub:   { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },

  // ── Card
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#eee',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#aaa',
    letterSpacing: 1.1,
    marginBottom: 10,
  },

  // ── Chips (consumer selector)
  chipRow: { flexDirection: 'row', gap: 8, paddingBottom: 4 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#ddd',
    backgroundColor: '#fafafa',
  },
  chipActive:     { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  chipText:       { fontSize: 13, color: '#555', fontWeight: '500' },
  chipTextActive: { color: '#fff', fontWeight: '700' },

  // ── Radio buttons
  radioRow: { flexDirection: 'row', gap: 20 },
  radioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#ddd',
    backgroundColor: '#fafafa',
  },
  radioBtnActive:   { borderColor: BPCL_BLUE, backgroundColor: '#eef6fd' },
  radioCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: BPCL_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner:       { width: 9, height: 9, borderRadius: 5, backgroundColor: BPCL_BLUE },
  radioLabel:       { fontSize: 14, color: '#555', fontWeight: '500' },
  radioLabelActive: { color: BPCL_BLUE, fontWeight: '700' },

  // ── Table header row (card top)
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },

  // ── PDF button
  pdfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: BPCL_BLUE,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    elevation: 2,
    shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  pdfBtnDisabled: { opacity: 0.5 },
  pdfBtnText:     { fontSize: 13, fontWeight: '700', color: '#fff' },

  emptyText: { textAlign: 'center', color: '#bbb', fontSize: 14, marginVertical: 24 },

  // ── Table cells
  tRow:        { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eee' },
  tHeaderCell: { backgroundColor: '#d9e1f2' },
  tSubRow:     { backgroundColor: '#f4f7ff' },
  tTotalRow:   { backgroundColor: '#e8ecf0' },

  tCell: {
    width: 88,
    paddingVertical: 9,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: '#eee',
  },
  tLabelCell:   { width: 160, alignItems: 'flex-start' },
  tHeaderTxt:   { fontSize: 10, fontWeight: '700', color: '#333', textAlign: 'center' },
  tTxt:         { fontSize: 11, color: '#444', textAlign: 'center' },
  tLabelTxt:    { fontSize: 11, color: '#333' },
  tZero:        { color: '#bbb' },
  tAmount:      { fontWeight: '700', color: '#222' },
  tTotalTxt:    { fontSize: 11, fontWeight: '800', color: '#111', textAlign: 'center' },
});