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

const BPCL_BLUE            = '#017DC5';
const EMPTY_PENDING_MARKER = '1990-01-01';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ViewMode = 'monthly' | 'datewise';

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function dateKey(d: string) { return d.slice(0, 10); }

function fmtDate(d: string | null): string {
  if (!d) return '—';
  try { return format(parseISO(d), 'dd-MM-yyyy'); }
  catch { return d; }
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
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function CommercialEmptyReceivedScreen() {

  // ── State ──────────────────────────────────────────────────────────────────

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

  // ── Load consumer list ─────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoadingConsumers(true);
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
        setConsumers(names);
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Failed to load consumers.');
      } finally {
        setLoadingConsumers(false);
      }
    })();
  }, []);

  // ── Fetch data ─────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (
    consumer: string,
    mode: ViewMode,
    allFlag: boolean,
  ) => {
    setLoadingTable(true);
    setPendingRows([]);
    setAllEmptyRows([]);

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
      if (!records || records.length === 0) return;

      if (allFlag) {
        // Always datewise when showing all
        setAllEmptyRows(buildAllEmptyRows(records as RawRecord[]));
      } else if (mode === 'monthly') {
        setPendingRows(buildMonthlyRows(records as RawRecord[]));
      } else {
        setPendingRows(buildDatewiseRows(records as RawRecord[]));
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load data.');
    } finally {
      setLoadingTable(false);
    }
  }, []);

  useEffect(() => {
    if (selectedConsumer) fetchData(selectedConsumer, viewMode, showAll);
  }, [selectedConsumer, viewMode, showAll, fetchData]);

  // ── PDF ─────────────────────────────────────────────────────────────────────

  const handleDownloadPdf = async () => {
    if (!selectedConsumer) return;
    const hasData = showAll ? allEmptyRows.length > 0 : pendingRows.length > 0;
    if (!hasData) {
      Alert.alert('No Data', 'No records to generate PDF.');
      return;
    }
    try {
      setLoadingPdf(true);
      const html = showAll
        ? buildAllEmptyPdfHtml(selectedConsumer, allEmptyRows)
        : buildPendingPdfHtml(selectedConsumer, viewMode, pendingRows);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
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
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingPdf(false);
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const filteredConsumers = consumers.filter(c =>
    c.toUpperCase().includes(consumerSearch.toUpperCase()),
  );
  const pendingTotalCyls  = pendingRows.reduce((s, r) => s + r.cylinders, 0);
  const allTotalCyls      = allEmptyRows.reduce((s, r) => s + r.cylinders, 0);
  const hasData           = showAll ? allEmptyRows.length > 0 : pendingRows.length > 0;

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

        {/* Consumer Dropdown */}
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

        {/* Options — only shown after consumer selected */}
        {selectedConsumer && (
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
          </View>
        )}

        {/* Table */}
        {selectedConsumer && (
          <View style={styles.card}>

            {/* Top row */}
            <View style={styles.tableTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>
                  {showAll ? 'ALL RECORDS' : 'EMPTY PENDING'}
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

  // Empty state
  emptyBox:  { alignItems: 'center', paddingVertical: 36, gap: 10 },
  emptyText: { fontSize: 14, color: '#bbb', fontWeight: '500' },

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

  tCell: {
    width: 100, paddingVertical: 10, paddingHorizontal: 6,
    justifyContent: 'center', alignItems: 'center',
    borderRightWidth: 1, borderRightColor: '#eee',
  },
  tDateCell:  { width: 130 },
  tLabelCell: { width: 200, alignItems: 'flex-start', paddingLeft: 10 },

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
});