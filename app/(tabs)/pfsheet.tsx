import React, { useState, useCallback } from 'react';
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
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import { format, addDays, eachWeekOfInterval, nextSaturday, isSaturday } from 'date-fns';

const BPCL_BLUE = '#017DC5';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSaturdays(start: Date, end: Date): Date[] {
  const saturdays: Date[] = [];
  let current = new Date(start);
  // Move to first Saturday >= start
  while (current.getDay() !== 6) current = addDays(current, 1);
  while (current <= end) {
    saturdays.push(new Date(current));
    current = addDays(current, 7);
  }
  return saturdays;
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  return format(d, 'yyyy-MM-dd');
}

function getMonthWithMostDays(start: Date, end: Date): { month: number; year: number } {
  const counter: Record<string, number> = {};
  let cur = new Date(start);
  while (cur <= end) {
    const key = `${cur.getFullYear()}-${cur.getMonth()}`;
    counter[key] = (counter[key] || 0) + 1;
    cur = addDays(cur, 1);
  }
  const best = Object.entries(counter).sort((a, b) => b[1] - a[1])[0][0];
  const [year, month] = best.split('-').map(Number);
  return { year, month };
}

const MONTH_NAMES = [
  'JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
  'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER',
];

// Excluded names for PF pre-check sheet (mirrors Django excludes)
const EXCLUDED_NAMES = ['RAHUL','SAILESH','NARAYAN','NAMDEV - 19 KG','BANTE','HARI','VITTHAL'];
const TOTAL_EXCLUDED  = ['RAHUL','SAILESH','NARAYAN','SUNDAY','AGD','RAMESH','NAMDEV - 19 KG','BANTE','HARI','VITTHAL'];

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function PFSheetScreen() {
  const [startDate, setStartDate]   = useState<Date>(new Date());
  const [endDate, setEndDate]       = useState<Date>(new Date());
  const [trip1881, setTrip1881]     = useState('');
  const [trip1116, setTrip1116]     = useState('');
  const [showStart, setShowStart]   = useState(false);
  const [showEnd, setShowEnd]       = useState(false);
  const [loading, setLoading]       = useState<'preview' | 'final' | null>(null);

  // preview table state
  const [previewRows, setPreviewRows]     = useState<any[]>([]);
  const [previewColumns, setPreviewColumns] = useState<string[]>([]);
  const [hasPreview, setHasPreview]       = useState(false);

  // ── Data Fetching Helpers ─────────────────────────────────────────────────

  const fetchPreviewData = useCallback(async () => {
    const saturdays = getSaturdays(startDate, endDate);
    if (saturdays.length === 0) {
      Alert.alert('No Saturdays', 'No Saturdays found in the selected date range.');
      return null;
    }

    // Fetch staff list (excluding certain names)
    const { data: staffData, error: staffErr } = await supabase
      .from('dashboard_commisionrate')
      .select('name')
      .order('name');
    if (staffErr) throw staffErr;

    const staffList = (staffData || [])
      .map((r: any) => r.name)
      .filter((n: string) => !EXCLUDED_NAMES.includes(n));

    // Fetch PF sheet for full names
    const { data: pfData } = await supabase
      .from('dashboard_pfsheet')
      .select('name, full_name');
    const pfMap: Record<string, string> = {};
    (pfData || []).forEach((r: any) => { pfMap[r.name] = r.full_name; });

    // Build columns
    const cols = ['SR NO', 'NAME'];
    for (const sat of saturdays) {
      cols.push(format(sat, 'dd-MM-yyyy'));
    }
    cols.push('TOTAL');

    // Fetch all delivery records for date range at once
    const rangeStart = subtractDays(format(saturdays[0], 'yyyy-MM-dd'), 6);
    const rangeEnd   = format(saturdays[saturdays.length - 1], 'yyyy-MM-dd');

    const { data: deliveries, error: delErr } = await supabase
      .from('dashboard_deliveryrecords')
      .select('name, date, number')
      .gte('date', rangeStart)
      .lte('date', rangeEnd);
    if (delErr) throw delErr;

    // Build lookup: name -> date -> number
    const deliveryMap: Record<string, Record<string, number>> = {};
    for (const row of deliveries || []) {
      if (!deliveryMap[row.name]) deliveryMap[row.name] = {};
      deliveryMap[row.name][row.date] = (deliveryMap[row.name][row.date] || 0) + Number(row.number || 0);
    }

    const rows: any[] = [];
    let srNo = 1;

    for (const name of staffList) {
      const displayName = pfMap[name] || name;
      const row: any = { srNo, name: displayName };
      let total = 0;
      for (const sat of saturdays) {
        const wStart = subtractDays(format(sat, 'yyyy-MM-dd'), 6);
        const wEnd   = format(sat, 'yyyy-MM-dd');
        let weekTotal = 0;
        for (const [date, qty] of Object.entries(deliveryMap[name] || {})) {
          if (date >= wStart && date <= wEnd) weekTotal += qty;
        }
        row[format(sat, 'dd-MM-yyyy')] = weekTotal;
        total += weekTotal;
      }
      row['TOTAL'] = total;
      rows.push(row);
      srNo++;
    }

    // Total row (excluding certain names)
    const totalRow: any = { srNo: '', name: 'TOTAL' };
    let grandTotal = 0;
    for (const sat of saturdays) {
      const wStart = subtractDays(format(sat, 'yyyy-MM-dd'), 6);
      const wEnd   = format(sat, 'yyyy-MM-dd');
      let weekTotal = 0;
      for (const [dname, dateMap] of Object.entries(deliveryMap)) {
        if (TOTAL_EXCLUDED.includes(dname) || dname.includes('DBA')) continue;
        for (const [date, qty] of Object.entries(dateMap)) {
          if (date >= wStart && date <= wEnd) weekTotal += qty;
        }
      }
      totalRow[format(sat, 'dd-MM-yyyy')] = weekTotal;
      grandTotal += weekTotal;
    }
    totalRow['TOTAL'] = grandTotal;
    rows.push(totalRow);

    return { cols, rows, saturdays };
  }, [startDate, endDate]);

  // ── Preview Button ────────────────────────────────────────────────────────

  const handlePreview = async () => {
    try {
      setLoading('preview');
      const result = await fetchPreviewData();
      if (!result) return;
      setPreviewColumns(result.cols);
      setPreviewRows(result.rows);
      setHasPreview(true);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load preview data.');
    } finally {
      setLoading(null);
    }
  };

  // ── Final PF PDF ──────────────────────────────────────────────────────────

  const handleFinalPDF = async () => {
    if (!trip1881.trim() || !trip1116.trim()) {
      Alert.alert('Validation', 'Please enter trips for both trucks.');
      return;
    }
    const t1881 = parseInt(trip1881);
    const t1116 = parseInt(trip1116);

    try {
      setLoading('final');

      // 1. Get preview data for delivery totals
      const previewResult = await fetchPreviewData();
      if (!previewResult) return;
      const { rows: previewRowsData } = previewResult;

      // Build name->total map from preview rows
      const totalMap: Record<string, number> = {};
      for (const row of previewRowsData) {
        totalMap[row.name] = row['TOTAL'] || 0;
      }

      // 2. Fetch PF sheet
      const { data: pfRows, error: pfErr } = await supabase
        .from('dashboard_pfsheet')
        .select('name, full_name, designation, pf_amount')
        .order('designation');
      if (pfErr) throw pfErr;

      // 3. Fetch NAMDEV commercial count
      const rangeStart = format(startDate, 'yyyy-MM-dd');
      const rangeEnd   = format(endDate, 'yyyy-MM-dd');
      const { data: namdevData } = await supabase
        .from('dashboard_commercialrecords')
        .select('id')
        .gte('delivery_date', rangeStart)
        .lte('delivery_date', rangeEnd)
        .eq('delivery_boy', 'NAMDEV');
      const namdevCount = namdevData?.length || 0;

      // 4. Determine month label
      const { year, month } = getMonthWithMostDays(startDate, endDate);
      const monthLabel = `${MONTH_NAMES[month]} ${year}`;

      // 5. Build table rows for PDF
      const tableRows: { srNo: number; name: string; gross: string; pf: string }[] = [];
      let srNo = 1;
      let pfTotalAmount  = 0;
      let grossTotal     = 0;

      const officeStaff  = (pfRows || []).filter((r: any) => r.designation === 'OFFICE STAFF');
      const deliveryBoys = (pfRows || []).filter((r: any) => r.designation === 'DELIVERY BOY' && r.full_name !== 'NAMDEV URHADE 19KG');
      const drivers      = (pfRows || []).filter((r: any) => r.designation === 'DRIVER' || r.designation === 'LABOUR');

      // Office staff
      for (const row of officeStaff) {
        const amt = parseFloat(row.pf_amount);
        tableRows.push({ srNo: srNo++, name: row.name, gross: amt.toFixed(2), pf: amt.toFixed(2) });
        pfTotalAmount += amt;
        grossTotal    += amt;
      }

      // Delivery boys
      for (const row of deliveryBoys) {
        const deliveryTotal = totalMap[row.full_name] || 0;
        let pfAmt = row.pf_amount * deliveryTotal;
        if (row.full_name === 'NAMDEV URHADE') {
          pfAmt = (row.pf_amount * deliveryTotal) + (namdevCount * 22);
        }
        const pfStr = pfAmt.toFixed(2);
        const pfOnPayment = pfAmt > 15000 ? '15000.00' : pfStr;
        tableRows.push({ srNo: srNo++, name: row.full_name, gross: pfStr, pf: pfOnPayment });
        pfTotalAmount += pfAmt;
        grossTotal    += pfAmt > 15000 ? 15000 : pfAmt;
      }

      // Drivers & Labour
      const tripMap: Record<string, number> = {
        'KAILASH MOHAN AGRAWAL':   t1881,
        'RAJESH MANOHARRAO SHINDE': t1116,
        'KISHOR MANOHAR GAYKI':    t1881 + t1116,
        'VISHWANATH RAJARAM DHAD': t1881 + t1116,
      };
      for (const row of drivers) {
        const trips = tripMap[row.name] || 0;
        const amt   = parseFloat((row.pf_amount * trips).toFixed(2));
        tableRows.push({ srNo: srNo++, name: row.name, gross: amt.toFixed(2), pf: amt.toFixed(2) });
        pfTotalAmount += amt;
        grossTotal    += amt;
      }

      // 6. Generate HTML for PDF
      const tableBodyHtml = tableRows.map(r => `
        <tr>
          <td>${r.srNo}</td>
          <td class="name-col">${r.name}</td>
          <td>${r.gross}</td>
          <td>${r.pf}</td>
          <td class="sig-col"></td>
        </tr>
      `).join('');

      const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4 landscape; margin: 14mm 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #000; }

  .header { text-align: center; margin-bottom: 6px; }
  .header h1 { font-size: 14pt; font-weight: bold; letter-spacing: 1px; }
  .header h2 { font-size: 11pt; font-weight: bold; margin-top: 2px; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
    page-break-inside: auto;
  }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; page-break-after: auto; }

  th, td {
    border: 1.5px solid #000;
    padding: 5px 6px;
    text-align: center;
    vertical-align: middle;
  }
  th {
    background-color: #d9e1f2;
    font-weight: bold;
    font-size: 9.5pt;
  }
  td.name-col { text-align: left; min-width: 180px; }
  td.sig-col  { min-width: 90px; height: 28px; }

  .total-row td {
    font-weight: bold;
    background-color: #f2f2f2;
  }
  .footer-note {
    margin-top: 10px;
    font-size: 8.5pt;
    color: #555;
  }
</style>
</head>
<body>

<div class="header">
  <h1>SHREEJEE GAS SERVICE</h1>
  <h2>MONTH OF ${monthLabel}</h2>
</div>

<table>
  <thead>
    <tr>
      <th>SR NO</th>
      <th>NAME</th>
      <th>GROSS SALARY</th>
      <th>PF ON PAYMENT</th>
      <th>SIGNATURE</th>
    </tr>
  </thead>
  <tbody>
    ${tableBodyHtml}
    <tr class="total-row">
      <td colspan="2">TOTAL AMOUNT</td>
      <td>${pfTotalAmount.toFixed(2)}</td>
      <td>${grossTotal.toFixed(2)}</td>
      <td></td>
    </tr>
  </tbody>
</table>

</body>
</html>`;

      const { uri } = await Print.printToFileAsync({ html, base64: false });

      // Rename with meaningful name
      const fileName = `PF_Final_Sheet_${monthLabel.replace(' ', '_')}.pdf`;
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: `PF Final Sheet — ${monthLabel}`,
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to: ${uri}`);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoading(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>PF Sheet</Text>
          <Text style={styles.headerSub}>Provident Fund — SHREEJEE GAS SERVICE</Text>
        </View>

        {/* Input Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>DATE RANGE</Text>

          {/* Start Date */}
          <Text style={styles.fieldLabel}>Start Date</Text>
          <TouchableOpacity style={styles.dateButton} onPress={() => setShowStart(true)}>
            <Ionicons name="calendar-outline" size={18} color={BPCL_BLUE} />
            <Text style={styles.dateButtonText}>{format(startDate, 'dd MMM yyyy')}</Text>
          </TouchableOpacity>
          {showStart && (
            <DateTimePicker
              value={startDate}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_, d) => { setShowStart(false); if (d) setStartDate(d); }}
            />
          )}

          {/* End Date */}
          <Text style={[styles.fieldLabel, { marginTop: 12 }]}>End Date</Text>
          <TouchableOpacity style={styles.dateButton} onPress={() => setShowEnd(true)}>
            <Ionicons name="calendar-outline" size={18} color={BPCL_BLUE} />
            <Text style={styles.dateButtonText}>{format(endDate, 'dd MMM yyyy')}</Text>
          </TouchableOpacity>
          {showEnd && (
            <DateTimePicker
              value={endDate}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_, d) => { setShowEnd(false); if (d) setEndDate(d); }}
            />
          )}

          {/* Truck Trips */}
          <Text style={[styles.cardTitle, { marginTop: 20 }]}>TRUCK TRIPS</Text>
          <Text style={styles.fieldLabel}>Total Trips — Truck 1881</Text>
          <TextInput
            style={styles.input}
            value={trip1881}
            onChangeText={setTrip1881}
            keyboardType="numeric"
            placeholder="Enter number of trips"
            placeholderTextColor="#bbb"
          />
          <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Total Trips — Truck 1116</Text>
          <TextInput
            style={styles.input}
            value={trip1116}
            onChangeText={setTrip1116}
            keyboardType="numeric"
            placeholder="Enter number of trips"
            placeholderTextColor="#bbb"
          />
        </View>

        {/* Action Buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.actionButton, styles.previewButton, loading === 'preview' && styles.buttonDisabled]}
            onPress={handlePreview}
            disabled={loading !== null}
            activeOpacity={0.8}
          >
            {loading === 'preview'
              ? <ActivityIndicator color="#fff" size="small" />
              : <>
                  <Ionicons name="eye-outline" size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>Preview Sheet</Text>
                </>
            }
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.downloadButton, loading === 'final' && styles.buttonDisabled]}
            onPress={handleFinalPDF}
            disabled={loading !== null}
            activeOpacity={0.8}
          >
            {loading === 'final'
              ? <ActivityIndicator color="#fff" size="small" />
              : <>
                  <Ionicons name="download-outline" size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>Final PF PDF</Text>
                </>
            }
          </TouchableOpacity>
        </View>

        {/* Preview Table */}
        {hasPreview && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>PF TABLE — PREVIEW</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                {/* Table Header */}
                <View style={styles.tableRow}>
                  {previewColumns.map((col, i) => (
                    <View key={i} style={[styles.tableCell, styles.tableHeaderCell, i === 1 && styles.nameCell]}>
                      <Text style={styles.tableHeaderText}>{col}</Text>
                    </View>
                  ))}
                </View>
                {/* Table Body */}
                {previewRows.map((row, ri) => {
                  const isTotal = row.name === 'TOTAL';
                  return (
                    <View key={ri} style={[styles.tableRow, isTotal && styles.totalRow]}>
                      {previewColumns.map((col, ci) => {
                        const key = col === 'SR NO' ? 'srNo' : col === 'NAME' ? 'name' : col;
                        return (
                          <View key={ci} style={[styles.tableCell, ci === 1 && styles.nameCell]}>
                            <Text style={[styles.tableCellText, isTotal && styles.totalCellText]}>
                              {row[key] ?? ''}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  scroll: { padding: 16, paddingBottom: 40 },

  header: {
    backgroundColor: BPCL_BLUE,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  headerSub:   { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 4 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#efefef',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#aaa',
    letterSpacing: 1.2,
    marginBottom: 12,
  },

  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 6 },

  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: '#fafafa',
  },
  dateButtonText: { fontSize: 15, color: '#333', fontWeight: '500' },

  input: {
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#333',
    backgroundColor: '#fafafa',
  },

  buttonRow: { flexDirection: 'row', gap: 12, marginBottom: 14 },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 15,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  previewButton:  { backgroundColor: '#27ae60', shadowColor: '#27ae60' },
  downloadButton: { backgroundColor: BPCL_BLUE,  shadowColor: BPCL_BLUE  },
  buttonDisabled: { opacity: 0.6 },
  actionButtonText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  // Table
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eee' },
  tableHeaderCell: { backgroundColor: '#d9e1f2' },
  tableCell: {
    width: 90,
    paddingVertical: 8,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: '#eee',
  },
  nameCell:        { width: 160, alignItems: 'flex-start' },
  tableHeaderText: { fontSize: 11, fontWeight: '700', color: '#333', textAlign: 'center' },
  tableCellText:   { fontSize: 11, color: '#444', textAlign: 'center' },
  totalRow:        { backgroundColor: '#f2f2f2' },
  totalCellText:   { fontWeight: '700', color: '#111' },
});