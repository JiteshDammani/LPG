import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDataStore } from '../../store/dataStore';
import { format, subDays } from 'date-fns';
import { supabase } from '@/lib/supabase';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRole } from '../../hooks/useRole';

// Import SDK 54 legacy filesystem bridges to bypass deprecation errors
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';

// Import Excel sheet parser
import * as XLSX from 'xlsx';

const BPCL_BLUE = '#017DC5';

// ── Pure JS CSV Parser (Handles Quoted Columns & Line breaks safely) ────────
function parseCSV(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let inQuotes = false;
  let entry = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        entry += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(entry.trim());
      entry = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      row.push(entry.trim());
      lines.push(row);
      row = [];
      entry = '';
    } else {
      entry += char;
    }
  }
  if (entry || row.length > 0) {
    row.push(entry.trim());
    lines.push(row);
  }
  return lines.filter(r => r.length > 0 && r.some(c => c !== ''));
}

// ── Quote Stripper to Clean Surrounding Quotes from CSV/Excel Cells ────────
function cleanVal(val: any): string {
  if (val === null || val === undefined) return '';
  let str = val.toString().trim();

  // Clean outer double quotes
  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.substring(1, str.length - 1).trim();
  }
  // Clean inner single quotes
  if (str.startsWith("'") && str.endsWith("'")) {
    str = str.substring(1, str.length - 1).trim();
  }
  return str;
}

// ── Date Normalizer to return standard YYYY-MM-DD ──────────────────────────
function formatExcelDate(dateStr: string): string | null {
  if (!dateStr || dateStr.startsWith('#') || dateStr.toLowerCase().includes('date')) return null;
  const cleaned = dateStr.trim();

  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
      return cleaned;
    }

    // Handle raw Excel serial date numbers (e.g. "46269.53958333333")
    if (/^\d+(\.\d+)?$/.test(cleaned)) {
      const serial = parseFloat(cleaned);
      // Excel epoch is 1899-12-30 (accounts for Excel's leap-year bug)
      const utcMillis = Math.round((serial - 25569) * 86400 * 1000);
      const d = new Date(utcMillis);
      if (isNaN(d.getTime())) return null;
      const year = d.getUTCFullYear();
      const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
      const day = d.getUTCDate().toString().padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

        const parts = cleaned.split(/[-/]/);
    if (parts.length === 3) {
      let day = parseInt(parts[0], 10);
      let month = parseInt(parts[1], 10);
      let year = parseInt(parts[2], 10);

      if (isNaN(day) || isNaN(month) || isNaN(year)) {
        const monthMap: { [key: string]: number } = {
          jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
          jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
        };
        const monStr = parts[1].toLowerCase().substring(0, 3);
        if (monthMap[monStr]) {
          month = monthMap[monStr];
        } else {
          return null; // unparseable — bail rather than let NaN through
        }
      }

      // Defensive: if what we assumed was "month" is out of range (>12) but
      // what we assumed was "day" is a valid month, the source was actually MM/DD/YYYY — swap.
      if (month > 12 && day >= 1 && day <= 12) {
        [day, month] = [month, day];
      }

      if (month < 1 || month > 12 || day < 1 || day > 31) return null; // still invalid — bail instead of inserting garbage

      if (year < 100) {
        year = 2000 + year;
      }

      const dStr = day.toString().padStart(2, '0');
      const mStr = month.toString().padStart(2, '0');
      return `${year}-${mStr}-${dStr}`;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ── Sunday to Monday Date Adjuster ──────────────────────────────────────────
function getEffectiveReportingDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    if (isNaN(date.getTime())) return dateStr;
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday

    if (dayOfWeek === 0) { // If Sunday, shift to next Monday
      const monday = new Date(date.getTime() + 24 * 60 * 60 * 1000);
      return format(monday, 'yyyy-MM-dd');
    }
  } catch (e) {
    // Return original if parsing fails
  }
  return dateStr;
}

export default function OnlinePaymentScreen() {
  const { cylinderPrice, currentUser } = useDataStore() as any;
  const isAdmin = currentUser?.username?.toLowerCase() === 'jitesh';

  // Date state
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);

  // ── Base data from DB ──
  const [baseOnlineQty, setBaseOnlineQty] = useState(0);
  const [basePaytmQty, setBasePaytmQty] = useState(0);
  const [baseAdditionalPaytm, setBaseAdditionalPaytm] = useState(0);
  const [basePaytmCreditAmount, setBasePaytmCreditAmount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [csvProcessing, setCsvProcessing] = useState(false);

  // ── Extra manual entries ──
  const [extraOnlineEntries, setExtraOnlineEntries] = useState<{ name: string; qty: number }[]>([]);
  const [extraPaytmEntries, setExtraPaytmEntries] = useState<{ name: string; amount: number }[]>([]);

  // ── Audit entries ──
  const [missingEntries, setMissingEntries] = useState<{ date: string; missingTypes: string[] }[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // ── Online popup ──
  const [showOnlinePopup, setShowOnlinePopup] = useState(false);
  const [onlineName, setOnlineName] = useState('');
  const [onlineQty, setOnlineQty] = useState('');

  // ── Paytm popup ──
  const [showPaytmPopup, setShowPaytmPopup] = useState(false);
  const [paytmName, setPaytmName] = useState('');
  const [paytmAmount, setPaytmAmount] = useState('');

  useEffect(() => {
    loadData();
  }, [selectedDate]);

  const loadData = async () => {
    setLoading(true);
    setAuditLoading(true);
    try {
      // Fetch delivery records
      const { data: deliveryData } = await supabase
        .from('dashboard_deliveryrecords')
        .select('online_payment, paytm, additional_paytm')
        .eq('date', selectedDate);

      if (deliveryData) {
        const onlineQty = deliveryData.reduce((s: number, r: any) => s + (r.online_payment || 0), 0);
        const paytmQty = deliveryData.reduce((s: number, r: any) => s + (r.paytm || 0), 0);
        const additionalPaytm = deliveryData.reduce((s: number, r: any) => s + (r.additional_paytm || 0), 0);
        setBaseOnlineQty(onlineQty);
        setBasePaytmQty(paytmQty);
        setBaseAdditionalPaytm(additionalPaytm);
      }

      // Fetch paytm credit entries from daily table
      const { data: paytmCredits } = await supabase
        .from('dashboard_dailyrecordsachin')
        .select('amount')
        .eq('date', selectedDate)
        .eq('transactions', 'CREDIT')
        .eq('paytm_transaction', true);

      if (paytmCredits) {
        const total = paytmCredits.reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
        setBasePaytmCreditAmount(total);
      }

      // Run missing entries audit
      await runMissingEntriesAudit();
    } finally {
      setLoading(false);
      setAuditLoading(false);
    }
  };

  // ── Missing Entries Audit (Last 15 Days) ──────────────────────────────────
  const runMissingEntriesAudit = async () => {
    try {
      const today = new Date();
      const existingMap: { [date: string]: { hasPaytm: boolean; hasZeroBill: boolean } } = {};

      // Generate list of past 15 days (excluding Sundays)
      for (let i = 1; i <= 150; i++) {
        const d = subDays(today, i);
        if (d.getDay() !== 0) { // 0 is Sunday
          const dateStr = format(d, 'yyyy-MM-dd');
          existingMap[dateStr] = { hasPaytm: false, hasZeroBill: false };
        }
      }

      const dates = Object.keys(existingMap);
      if (dates.length === 0) return;

      const startDateStr = dates[dates.length - 1];
      const endDateStr = dates[0];

      // Fetch entries from DB
      const { data, error } = await supabase
        .from('dashboard_onlinepaymentdetails')
        .select('date, type')
        .gte('date', startDateStr)
        .lte('date', endDateStr);

      if (!error && data) {
        data.forEach((item: any) => {
          const dateStr = item.date;
          const type = cleanVal(item.type);
          if (existingMap[dateStr]) {
            if (type === 'PAYTM NEW') existingMap[dateStr].hasPaytm = true;
            if (type === 'ZERO BILL') existingMap[dateStr].hasZeroBill = true;
          }
        });
      }

      const missing: { date: string; missingTypes: string[] }[] = [];
      Object.keys(existingMap).sort().reverse().forEach(dateStr => {
        const record = existingMap[dateStr];
        const missingTypes: string[] = [];
        if (!record.hasPaytm) missingTypes.push('PAYTM NEW');
        if (!record.hasZeroBill) missingTypes.push('ZERO BILL');
        if (missingTypes.length > 0) {
          missing.push({ date: dateStr, missingTypes });
        }
      });

      setMissingEntries(missing);
    } catch (err) {
      console.error('Audit failed:', err);
    }
  };

  // ── Document Picking & SDK 54 Legacy bridge File Parser ────────────────────

  const pickAndParseFile = async (): Promise<string[][] | null> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return null;
      }

      setCsvProcessing(true);
      const fileUri = result.assets[0].uri;
      const fileName = result.assets[0].name || '';
      const isXlsx = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');

      if (isXlsx) {
        const base64Content = await FileSystem.readAsStringAsync(fileUri, {encoding: FileSystem.EncodingType.Base64});
        const workbook = XLSX.read(base64Content, {type: 'base64', cellDates: true}); // real Date objects, no string formatting
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rawRows = XLSX.utils.sheet_to_json<any[]>(worksheet, {header: 1}); // raw: true (default) — keeps Date objects as Date objects

        // Normalize any real Date cells into unambiguous ISO strings ourselves —
        // don't rely on xlsx's dateNF formatting, which can silently flip to MM/DD/YYYY.
        return rawRows.map(row =>
            row.map(cell => {
              if (cell instanceof Date && !isNaN(cell.getTime())) {
                const y = cell.getFullYear();
                const m = (cell.getMonth() + 1).toString().padStart(2, '0');
                const d = cell.getDate().toString().padStart(2, '0');
                return `${y}-${m}-${d}`;
              }
              return cell;
            })
        );
      } else {
        // Read file content as string using SDK 54 legacy bridge
        const fileContent = await FileSystem.readAsStringAsync(fileUri);
        return parseCSV(fileContent);
      }
    } catch (err: any) {
      Alert.alert('Error Reading File', err?.message || 'Failed to open file.');
      return null;
    } finally {
      setCsvProcessing(false);
    }
  };

  // ── Helper to present a clean, sequential prompt for Paytm conflicts ─────
  const confirmOverwritePrompt = (dateStr: string, oldAmount: number, newAmount: number): Promise<boolean> => {
    return new Promise((resolve) => {
      Alert.alert(
        'Duplicate Value Found',
        `A Paytm transaction for ${dateStr} already exists.\n\nOld Value: ₹${oldAmount}\nNew Value: ₹${newAmount}\n\nDo you want to overwrite with the new value?`,
        [
          { text: 'Decline (Keep Old)', onPress: () => resolve(false) },
          { text: 'Approve (Overwrite)', onPress: () => resolve(true) }
        ],
        { cancelable: false }
      );
    });
  };

  // ── Handle Paytm Payment Upload ──────────────────────────────────────────
  const handlePaytmCSVUpload = async () => {
    const rows = await pickAndParseFile();
    if (!rows || rows.length === 0) return;

    setCsvProcessing(true);
    try {
      let dateIdx = -1, statusIdx = -1, amtIdx = -1;

      // Identify transaction headers row using cleanVal
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const hasDate = row.some(c => c && cleanVal(c).toLowerCase().includes('transaction_date'));
        const hasStatus = row.some(c => c && cleanVal(c).toLowerCase().includes('status'));
        const hasAmt = row.some(c => c && cleanVal(c).toLowerCase().includes('amount'));

        if (hasDate && hasStatus && hasAmt) {
          dateIdx = row.findIndex(c => c && cleanVal(c).toLowerCase().includes('transaction_date'));
          statusIdx = row.findIndex(c => c && cleanVal(c).toLowerCase().includes('status'));
          amtIdx = row.findIndex(c => c && cleanVal(c).toLowerCase().includes('amount'));
          rows.splice(0, i + 1); // delete preceding config rows
          break;
        }
      }

      if (dateIdx === -1 || statusIdx === -1 || amtIdx === -1) {
        Alert.alert('Error', 'Invalid Paytm statement format. Columns (Transaction_Date, Status, Amount) are required.');
        return;
      }

      const paytmAggregates: { [date: string]: number } = {};

      for (const row of rows) {
        const rawDate = cleanVal(row[dateIdx]);
        const status = cleanVal(row[statusIdx]).toUpperCase();
        const rawAmt = cleanVal(row[amtIdx]);

        if (rawDate && (status.includes('SUCCESS') || status.includes('SUCESS')) && rawAmt) {
          const dateOnly = rawDate.trim().substring(0, 10);
          const amt = parseFloat(rawAmt.replace(/[^0-9.]/g, '')) || 0;
          const normalizedDate = formatExcelDate(dateOnly);

          if (normalizedDate) {
            // Sunday Shift Check: if Sunday, shift to next Monday
            const effectiveDate = getEffectiveReportingDate(normalizedDate);
            paytmAggregates[effectiveDate] = (paytmAggregates[effectiveDate] || 0) + amt;
          }
        }
      }

      const uploadDates = Object.keys(paytmAggregates);
      if (uploadDates.length === 0) {
        Alert.alert('Info', 'No successful Paytm records found in this file.');
        return;
      }

      // Check conflicts sequentially on dashboard_onlinepaymentdetails
      for (const targetDate of uploadDates) {
        // Round to nearest whole integer to prevent type errors (e.g. 80357.5 becomes 80358)
        const newAmount = Math.round(paytmAggregates[targetDate]);

        // Fetch existing daily Paytm records in dashboard_onlinepaymentdetails
        const { data: existingData } = await supabase
          .from('dashboard_onlinepaymentdetails')
          .select('id, no_of_cylinder')
          .eq('date', targetDate)
          .eq('type', 'PAYTM NEW');

        if (existingData && existingData.length > 0) {
          const oldRecord = existingData[0];
          const shouldOverwrite = await confirmOverwritePrompt(targetDate, oldRecord.no_of_cylinder, newAmount);

          if (shouldOverwrite) {
            const { error: updErr } = await supabase
              .from('dashboard_onlinepaymentdetails')
              .update({ no_of_cylinder: newAmount })
              .eq('id', oldRecord.id);
            if (updErr) throw updErr;
          }
        } else {
          // If date doesn't exist, insert a new record with type 'PAYTM NEW'
          const { error: insErr } = await supabase
            .from('dashboard_onlinepaymentdetails')
            .insert({
              date: targetDate,
              no_of_cylinder: newAmount,
              type: 'PAYTM NEW',
            });
          if (insErr) throw insErr;
        }
      }

      Alert.alert('Success', 'Paytm statements parsed and uploaded successfully.');
      await loadData();
    } catch (err: any) {
      Alert.alert('Upload Error', err?.message || 'Failed to complete Paytm upload.');
    } finally {
      setCsvProcessing(false);
    }
  };

  // ── Handle Advance Payment (Zero Bills / Multi-Table Sheet) Upload ────────
  // ── Handle Advance Payment (Zero Bills / Multi-Table Sheet) Upload ────────
// ── Handle Advance Payment (Zero Bills / Multi-Table Sheet) Upload ────────
const handleAdvanceCSVUpload = async () => {
  const rows = await pickAndParseFile();
  if (!rows || rows.length === 0) return;

  setCsvProcessing(true);
  try {
    let currentMode: 'TABLE_1' | 'TABLE_2' | null = null;
    let t1AmtIdx = -1, t1DateIdx = -1;
    let t2AmtIdx = -1, t2DateIdx = -1;

    let sawTable1Marker = false;
    let sawTable2Marker = false;
    let sawUnresolvedColumns = false;

    // Diagnostics
    let rowsSeen = 0;
    let blankAmt = 0;
    let blankDate = 0;
    let dateParseFailed = 0;
    let sampleSkipped: string[] = [];

    const aggregates: { [date: string]: number } = {};

    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const cleanedRow = row.map(c => cleanVal(c));
      const normalizedCells = cleanedRow.map(c => c.toUpperCase());

      if (normalizedCells.includes('SRNO')) {
        sawTable1Marker = true;
        t1AmtIdx = cleanedRow.findIndex(c => c.toLowerCase().includes('advtotala'));
        t1DateIdx = cleanedRow.findIndex(c => c.toLowerCase().includes('deliveryda'));
        currentMode = (t1AmtIdx === -1 || t1DateIdx === -1) ? (sawUnresolvedColumns = true, null) : 'TABLE_1';
        continue;
      }

      if (normalizedCells.includes('SRNO2')) {
        sawTable2Marker = true;
        t2AmtIdx = cleanedRow.findIndex(c => c && (c.toLowerCase().includes('advtotalia') || c.toLowerCase().includes('advtotala')));
        t2DateIdx = cleanedRow.findIndex(c => c.toLowerCase().includes('deliveryda'));
        currentMode = (t2AmtIdx === -1 || t2DateIdx === -1) ? (sawUnresolvedColumns = true, null) : 'TABLE_2';
        continue;
      }

      const amtIdx = currentMode === 'TABLE_1' ? t1AmtIdx : currentMode === 'TABLE_2' ? t2AmtIdx : -1;
      const dateIdx = currentMode === 'TABLE_1' ? t1DateIdx : currentMode === 'TABLE_2' ? t2DateIdx : -1;

      if (currentMode && amtIdx !== -1 && dateIdx !== -1) {
        rowsSeen++;
        const amtStr = cleanedRow[amtIdx];
        const dateStr = cleanedRow[dateIdx];

        if (!amtStr) { blankAmt++; if (sampleSkipped.length < 3) sampleSkipped.push(`row amt blank | date="${dateStr}"`); continue; }
        if (!dateStr || dateStr.toLowerCase().includes('date')) { blankDate++; if (sampleSkipped.length < 3) sampleSkipped.push(`row date blank/header-like | amt="${amtStr}"`); continue; }

        const amt = parseFloat(amtStr.replace(/[^0-9.]/g, '')) || 0;
        const normalizedDate = formatExcelDate(dateStr);
        if (!normalizedDate) {
          dateParseFailed++;
          if (sampleSkipped.length < 3) sampleSkipped.push(`date parse failed | raw="${dateStr}"`);
          continue;
        }

        const effectiveDate = getEffectiveReportingDate(normalizedDate);
        aggregates[effectiveDate] = (aggregates[effectiveDate] || 0) + amt;
      }
    }

        const parsedDates = Object.keys(aggregates);
    if (parsedDates.length === 0) {
      if (!sawTable1Marker && !sawTable2Marker) {
        Alert.alert('Error', 'Could not find the SrNo / SrNo2 table markers in this file.');
      } else if (sawUnresolvedColumns) {
        Alert.alert('Error', 'Found headers, but could not identify the AdvTotalAmount / DeliveryDate columns.');
      } else {
        Alert.alert(
          'Debug: No Rows Parsed',
          `Rows evaluated: ${rowsSeen}\nBlank amount: ${blankAmt}\nBlank/header-like date: ${blankDate}\nDate parse failed: ${dateParseFailed}\n\nSamples:\n${sampleSkipped.join('\n')}`
        );
      }
      return;
    }

    // Check conflicts sequentially, same as the Paytm upload
    for (const targetDate of parsedDates) {
      const sumCylinder = Math.round(aggregates[targetDate]);

      const { data: existingData } = await supabase
        .from('dashboard_onlinepaymentdetails')
        .select('id, no_of_cylinder')
        .eq('date', targetDate)
        .eq('type', 'ZERO BILL');

      if (existingData && existingData.length > 0) {
        const oldRecord = existingData[0];

        // Skip the prompt entirely if the new total matches what's already there
        if (Math.round(oldRecord.no_of_cylinder) === sumCylinder) {
          continue;
        }

        const shouldOverwrite = await confirmOverwritePrompt(targetDate, oldRecord.no_of_cylinder, sumCylinder);
        if (!shouldOverwrite) {
          continue; // leave the existing value untouched
        }

        const { error: updErr } = await supabase
          .from('dashboard_onlinepaymentdetails')
          .update({ no_of_cylinder: sumCylinder })
          .eq('id', oldRecord.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase
          .from('dashboard_onlinepaymentdetails')
          .insert({
            date: targetDate,
            no_of_cylinder: sumCylinder,
            type: 'ZERO BILL',
          });
        if (insErr) throw insErr;
      }
    }

    Alert.alert('Success', 'Advance Payment tables merged and updated successfully.');
    await loadData();
  } catch (err: any) {
    Alert.alert('Upload Error', err?.message || 'Failed to parse Advance Payment tables.');
  } finally {
    setCsvProcessing(false);
  }
};

  // ── Calculations ──
  const extraOnlineQty = extraOnlineEntries.reduce((s, e) => s + e.qty, 0);
  const totalOnlineQty = baseOnlineQty + extraOnlineQty;
  const totalOnlineAmount = Math.ceil(totalOnlineQty * (cylinderPrice || 0));

  const extraPaytmAmount = extraPaytmEntries.reduce((s, e) => s + e.amount, 0);
  const basePaytmAmount = Math.ceil(basePaytmQty * (cylinderPrice || 0));
  const totalPaytmAmount = basePaytmAmount + baseAdditionalPaytm + basePaytmCreditAmount + extraPaytmAmount;

  const grandTotal = totalOnlineAmount + totalPaytmAmount;

  // ── Remarks builder ──
  const buildRemarks = () => {
    let parts = [];
    parts.push(`ONLINE(${totalOnlineQty})`);
    parts.push(`PAYTM(${basePaytmQty})`);
    if (baseAdditionalPaytm > 0) parts.push(`ADD.PAYTM(₹${baseAdditionalPaytm})`);
    if (basePaytmCreditAmount > 0) parts.push(`PAYTM.CREDIT(₹${basePaytmCreditAmount})`);
    if (extraOnlineEntries.length > 0) {
      const extras = extraOnlineEntries.map(e => `${e.name}(${e.qty})`).join(' ');
      parts.push(`EXTRA.ONLINE: ${extras}`);
    }
    if (extraPaytmEntries.length > 0) {
      const extras = extraPaytmEntries.map(e => `${e.name}(₹${e.amount})`).join(' ');
      parts.push(`EXTRA.PAYTM: ${extras}`);
    }
    return parts.join(' | ');
  };

  // ── Submit ──
  const handleSubmit = async () => {
    if (grandTotal <= 0) return Alert.alert('Error', 'Total amount is 0');

    Alert.alert(
      'Confirm Submit',
      `Submit DEBIT entry of ₹${grandTotal}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          onPress: async () => {
            setSubmitting(true);
            try {
              const { error } = await supabase
                .from('dashboard_dailyrecordsachin')
                .insert({
                  date: selectedDate,
                  transactions: 'DEBIT',
                  category: 'ONLINE PAYMENT',
                  rate: grandTotal,
                  quantity: 1,
                  amount: grandTotal,
                  remarks: buildRemarks(),
                  paytm_transaction: false,
                  check_done: false,
                  debit_balance_report_id: 0,
                });

              if (error) throw error;

              Alert.alert('Success', 'Online Payment entry saved');
              setExtraOnlineEntries([]);
              setExtraPaytmEntries([]);
              await loadData();
            } catch (err: any) {
                console.log('Save error:', JSON.stringify(err));
                Alert.alert('Save Error', err?.message || 'Failed to save transaction');
              } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>

      {/* HEADER */}
      <View style={styles.header}>
        <View>
        <Text style={styles.headerTitle}>Online Payment</Text>
          <TouchableOpacity
            onPress={() => setShowDatePicker(true)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}
          >
            <Ionicons name="calendar-outline" size={14} color="rgba(255,255,255,0.9)" />
            <Text style={styles.headerDate}>
              {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
            </Text>
            <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.9)" />
          </TouchableOpacity>

          {showDatePicker && (
            <DateTimePicker
              value={new Date(selectedDate + 'T00:00:00')}
              mode="date"
              display="default"
              onChange={(event, date) => {
                setShowDatePicker(false);
                if (event.type === 'set' && date) {
                  setSelectedDate(format(date, 'yyyy-MM-dd'));
                }
              }}
            />
          )}
        </View>
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={loadData}
          disabled={loading}
        >
          <Ionicons
            name="refresh"
            size={20}
            color="#fff"
            style={loading ? { opacity: 0.4 } : {}}
          />
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={BPCL_BLUE} />
        </View>
      ) : (
        <ScrollView style={styles.scroll}>

          {/* ── JITESH ADMIN CSV/XLSX OPERATION CARD ── */}
          {isAdmin && (
            <View style={[styles.card, styles.adminCard]}>
              <View style={styles.adminHeader}>
                <Ionicons name="shield-checkmark" size={18} color="#9a3412" />
                <Text style={styles.adminTitle}>Admin Import Center</Text>
              </View>
              <Text style={styles.subtext}>Upload daily transaction statements directly from CSV or Excel (.xlsx) files</Text>

              <View style={styles.csvRow}>
                {/* Paytm CSV Button */}
                <TouchableOpacity
                  style={[styles.csvButton, { backgroundColor: '#002E6E' }]}
                  onPress={handlePaytmCSVUpload}
                  disabled={csvProcessing}
                >
                  <Ionicons name="logo-paypal" size={16} color="#fff" />
                  <Text style={styles.csvButtonText}>Paytm Payment</Text>
                </TouchableOpacity>

                {/* Advance CSV Button */}
                <TouchableOpacity
                  style={[styles.csvButton, { backgroundColor: '#15803d' }]}
                  onPress={handleAdvanceCSVUpload}
                  disabled={csvProcessing}
                >
                  <Ionicons name="document-text-outline" size={16} color="#fff" />
                  <Text style={styles.csvButtonText}>Advance Payment</Text>
                </TouchableOpacity>
              </View>

              {csvProcessing && (
                <View style={styles.csvLoader}>
                  <ActivityIndicator color={BPCL_BLUE} size="small" />
                  <Text style={styles.csvLoaderText}>Processing statement file...</Text>
                </View>
              )}
            </View>
          )}

          {/* ── ONLINE SECTION ── */}
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Online Payment</Text>
              <TouchableOpacity
                style={styles.addButton}
                onPress={() => {
                  setOnlineName('');
                  setOnlineQty('');
                  setShowOnlinePopup(true);
                }}
              >
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.addButtonText}>Add</Text>
              </TouchableOpacity>
            </View>

            {/* Base row */}
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>From Delivery Records</Text>
              <Text style={styles.infoValue}>{baseOnlineQty} cyl × ₹{cylinderPrice}</Text>
            </View>

            {/* Extra entries */}
            {extraOnlineEntries.map((entry, index) => (
              <View key={index} style={styles.extraRow}>
                <Text style={styles.extraText}>{entry.name} ({entry.qty} cyl)</Text>
                <TouchableOpacity onPress={() => {
                  setExtraOnlineEntries(prev => prev.filter((_, i) => i !== index));
                }}>
                  <Ionicons name="close-circle" size={20} color="#FF3B30" />
                </TouchableOpacity>
              </View>
            ))}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total Online</Text>
              <Text style={styles.totalValue}>₹{totalOnlineAmount} ({totalOnlineQty} cyl)</Text>
            </View>
          </View>

          {/* ── PAYTM SECTION ── */}
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Paytm Payment</Text>
              <TouchableOpacity
                style={styles.addButton}
                onPress={() => {
                  setPaytmName('');
                  setPaytmAmount('');
                  setShowPaytmPopup(true);
                }}
              >
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.addButtonText}>Add</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Paytm from Delivery</Text>
              <Text style={styles.infoValue}>{basePaytmQty} cyl × ₹{cylinderPrice} = ₹{basePaytmAmount}</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Additional Paytm</Text>
              <Text style={styles.infoValue}>₹{baseAdditionalPaytm}</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Paytm Credits (Daily)</Text>
              <Text style={styles.infoValue}>₹{basePaytmCreditAmount}</Text>
            </View>

            {/* Extra paytm entries */}
            {extraPaytmEntries.map((entry, index) => (
              <View key={index} style={styles.extraRow}>
                <Text style={styles.extraText}>{entry.name} (₹{entry.amount})</Text>
                <TouchableOpacity onPress={() => {
                  setExtraPaytmEntries(prev => prev.filter((_, i) => i !== index));
                }}>
                  <Ionicons name="close-circle" size={20} color="#FF3B30" />
                </TouchableOpacity>
              </View>
            ))}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total Paytm</Text>
              <Text style={styles.totalValue}>₹{totalPaytmAmount}</Text>
            </View>
          </View>

          {/* ── GRAND TOTAL ── */}
          <View style={styles.grandTotalCard}>
            <Text style={styles.grandTotalLabel}>Grand Total</Text>
            <Text style={styles.grandTotalValue}>₹{grandTotal}</Text>
          </View>

          {/* ── MISSING ENTRIES AUDIT SECTION ── */}
          {isAdmin && (
            <View style={[styles.card, styles.auditCard]}>
              <View style={styles.auditHeader}>
                <Ionicons name="alert-circle-outline" size={20} color="#dc2626" />
                <Text style={styles.auditTitle}>Missing Records Audit (Past 150 Days)</Text>
              </View>
              <Text style={styles.auditSubtext}>
                Days (excluding Sundays) where Paytm or Advance Payment imports are missing:
              </Text>

              {auditLoading ? (
                <ActivityIndicator color={BPCL_BLUE} style={{ padding: 10 }} />
              ) : missingEntries.length === 0 ? (
                <View style={styles.auditSuccessBox}>
                  <Ionicons name="checkmark-circle" size={18} color="#15803d" />
                  <Text style={styles.auditSuccessText}>All entries complete for the last 15 days!</Text>
                </View>
              ) : (
                <View style={styles.auditList}>
                  {missingEntries.map((item, index) => (
                    <View key={index} style={styles.auditRow}>
                      <Text style={styles.auditRowDate}>
                        {format(new Date(item.date + 'T00:00:00'), 'dd MMM yyyy')}
                      </Text>
                      <View style={styles.auditPillsRow}>
                        {item.missingTypes.map((type, tIdx) => (
                          <View
                            key={tIdx}
                            style={[
                              styles.auditPill,
                              type === 'PAYTM NEW' ? styles.paytmPill : styles.zeroPill
                            ]}
                          >
                            <Text style={styles.auditPillText}>{type} MISSING</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* ── SUBMIT ── */}
          <TouchableOpacity
            style={styles.submitButton}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>SAVE DEBIT ENTRY</Text>
            }
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── ONLINE POPUP ── */}
      {showOnlinePopup && (
        <View style={styles.overlay}>
          <View style={styles.popup}>
            <View style={styles.popupHeader}>
              <Text style={styles.popupTitle}>Add Online Entry</Text>
              <TouchableOpacity onPress={() => setShowOnlinePopup(false)}>
                <Text style={styles.closeX}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter name"
              value={onlineName}
              onChangeText={(t) => setOnlineName(t.toUpperCase())}
              autoCorrect={false}
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Quantity *</Text>
            <TextInput
              style={styles.input}
              placeholder="No of cylinders"
              keyboardType="numeric"
              value={onlineQty}
              onChangeText={setOnlineQty}
            />

            <TouchableOpacity
              style={[styles.submitButton, { marginTop: 20 }]}
              onPress={() => {
                const qty = parseInt(onlineQty);
                if (!onlineName.trim()) return Alert.alert('Error', 'Enter name');
                if (!qty || qty <= 0) return Alert.alert('Error', 'Enter valid quantity');
                setExtraOnlineEntries(prev => [...prev, { name: onlineName.trim(), qty }]);
                setShowOnlinePopup(false);
              }}
            >
              <Text style={styles.submitText}>ADD</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── PAYTM POPUP ── */}
      {showPaytmPopup && (
        <View style={styles.overlay}>
          <View style={styles.popup}>
            <View style={styles.popupHeader}>
              <Text style={styles.popupTitle}>Add Paytm Entry</Text>
              <TouchableOpacity onPress={() => setShowPaytmPopup(false)}>
                <Text style={styles.closeX}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Name *</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter name"
              value={paytmName}
              onChangeText={(t) => setPaytmName(t.toUpperCase())}
              autoCorrect={false}
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Amount *</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter amount"
              keyboardType="numeric"
              value={paytmAmount}
              onChangeText={setPaytmAmount}
            />

            <TouchableOpacity
              style={[styles.submitButton, { marginTop: 20 }]}
              onPress={() => {
                const amt = parseFloat(paytmAmount);
                if (!paytmName.trim()) return Alert.alert('Error', 'Enter name');
                if (!amt || amt <= 0) return Alert.alert('Error', 'Enter valid amount');
                setExtraPaytmEntries(prev => [...prev, { name: paytmName.trim(), amount: amt }]);
                setShowPaytmPopup(false);
              }}
            >
              <Text style={styles.submitText}>ADD</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    backgroundColor: BPCL_BLUE,
    padding: 20,
    paddingTop: 60,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerDate: { fontSize: 14, color: 'rgba(255,255,255,0.9)' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { flex: 1 },
  card: {
    backgroundColor: '#fff',
    margin: 12,
    padding: 16,
    borderRadius: 12,
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: BPCL_BLUE },
  addButton: {
    backgroundColor: BPCL_BLUE,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  infoLabel: { fontSize: 13, color: '#666' },
  infoValue: { fontSize: 13, fontWeight: '600', color: '#333' },
  extraRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#e8f4f8',
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  extraText: { fontSize: 13, color: BPCL_BLUE, fontWeight: '500' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#ddd',
  },
  totalLabel: { fontSize: 14, fontWeight: 'bold', color: '#333' },
  totalValue: { fontSize: 14, fontWeight: 'bold', color: BPCL_BLUE },
  grandTotalCard: {
    backgroundColor: BPCL_BLUE,
    margin: 12,
    padding: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  grandTotalLabel: { fontSize: 14, color: 'rgba(255,255,255,0.8)', marginBottom: 4 },
  grandTotalValue: { fontSize: 32, fontWeight: 'bold', color: '#fff' },
  submitButton: {
    backgroundColor: BPCL_BLUE,
    margin: 12,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  popup: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    elevation: 10,
  },
  popupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  popupTitle: { fontSize: 17, fontWeight: 'bold', color: BPCL_BLUE },
  closeX: { fontSize: 22, color: '#666', fontWeight: 'bold' },
  label: { fontSize: 14, fontWeight: '600', color: '#444', marginBottom: 6 },
  input: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  refreshText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Admin Styling
  adminCard: {
    backgroundColor: '#fffaf0',
    borderColor: '#fed7aa',
    borderWidth: 1,
  },
  adminHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  adminTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#9a3412',
  },
  subtext: {
    fontSize: 12,
    color: '#7c2d12',
    marginBottom: 14,
  },
  csvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  csvButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 6,
    elevation: 1,
  },
  csvButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  csvLoader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    gap: 8,
  },
  csvLoaderText: {
    fontSize: 12,
    color: '#c2410c',
    fontWeight: '600',
  },
  // Audit Styling
  auditCard: {
    borderColor: '#fca5a5',
    borderWidth: 1,
    backgroundColor: '#fffbeb',
  },
  auditHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  auditTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#b91c1c',
  },
  auditSubtext: {
    fontSize: 12,
    color: '#7c2d12',
    marginBottom: 10,
  },
  auditSuccessBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f0fdf4',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  auditSuccessText: {
    fontSize: 13,
    color: '#166534',
    fontWeight: '600',
  },
  auditList: {
    marginTop: 6,
  },
  auditRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#fee2e2',
  },
  auditRowDate: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  auditPillsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  auditPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  paytmPill: {
    backgroundColor: '#fee2e2',
  },
  zeroPill: {
    backgroundColor: '#fef3c7',
  },
  auditPillText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#991b1b',
  },
});