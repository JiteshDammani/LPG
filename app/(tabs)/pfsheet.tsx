import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, Alert, SafeAreaView, Platform,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import XLSXStyle from 'xlsx-js-style';
import { supabase } from '@/lib/supabase';
import { format, addDays, startOfMonth, endOfMonth } from 'date-fns';

const FS = require('expo-file-system/legacy');
const BPCL_BLUE = '#017DC5';

// ── FS Helper ─────────────────────────────────────────────────────────────────

function getFSHelpers() {
  const cacheDir: string =
    FS.cacheDirectory ?? FS.FileSystem?.cacheDirectory ?? 'file:///cache/';
  const base64Encoding: string =
    FS.EncodingType?.Base64 ?? FS.FileSystem?.EncodingType?.Base64 ?? 'base64';
  const writeAsync: Function =
    FS.writeAsStringAsync ?? FS.FileSystem?.writeAsStringAsync;
  const getInfo: Function =
    FS.getInfoAsync ?? FS.FileSystem?.getInfoAsync;
  if (!writeAsync) throw new Error('writeAsStringAsync not found.');
  if (!getInfo)    throw new Error('getInfoAsync not found.');
  return { cacheDir, base64Encoding, writeAsync, getInfo };
}

// ── Excel Write ───────────────────────────────────────────────────────────────

function writeWorkbookToBase64(wb: any): string {
  try {
    const r = XLSXStyle.write(wb, { type: 'base64', bookType: 'xlsx' });
    if (r && r.length > 0) return r;
  } catch (e) { console.warn('S1', e); }
  try {
    const b = XLSXStyle.write(wb, { type: 'binary', bookType: 'xlsx' });
    const bytes = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i) & 0xff;
    return Buffer.from(bytes).toString('base64');
  } catch (e) { console.warn('S2', e); }
  try {
    const ab = XLSXStyle.write(wb, { type: 'array', bookType: 'xlsx' });
    const u8 = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < u8.byteLength; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  } catch (e) { console.warn('S3', e); }
  throw new Error('All Excel write strategies failed.');
}

// ── Style Definitions ─────────────────────────────────────────────────────────

const thinBorder = {
  top:    { style: 'thin', color: { rgb: 'AAAAAA' } },
  bottom: { style: 'thin', color: { rgb: 'AAAAAA' } },
  left:   { style: 'thin', color: { rgb: 'AAAAAA' } },
  right:  { style: 'thin', color: { rgb: 'AAAAAA' } },
};

const mediumBorder = {
  top:    { style: 'medium', color: { rgb: '17375E' } },
  bottom: { style: 'medium', color: { rgb: '17375E' } },
  left:   { style: 'medium', color: { rgb: '17375E' } },
  right:  { style: 'medium', color: { rgb: '17375E' } },
};

// ── Helper: make a styled cell ────────────────────────────────────────────────

function makeCell(value: any, style: any): any {
  let t = 's';
  if (typeof value === 'number') t = 'n';
  else if (value === '' || value === null || value === undefined) {
    return { t: 's', v: '', s: style };
  }
  return { t, v: value, s: style };
}

// ── Helper: inject a styled AOA into a worksheet ──────────────────────────────

function buildStyledSheet(rows: { value: any; style: any }[][]): any {
  const ws: any = {};
  let maxCol = 0;
  rows.forEach((row, ri) => {
    maxCol = Math.max(maxCol, row.length - 1);
    row.forEach((cell, ci) => {
      const ref = XLSXStyle.utils.encode_cell({ r: ri, c: ci });
      ws[ref] = makeCell(cell.value, cell.style);
    });
  });
  ws['!ref'] = XLSXStyle.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rows.length - 1, c: maxCol },
  });
  return ws;
}

// ── Date Helpers ──────────────────────────────────────────────────────────────

/**
 * Get all Saturdays in a given month/year.
 */
function getSaturdaysOfMonth(year: number, month: number): Date[] {
  const out: Date[] = [];
  const first = startOfMonth(new Date(year, month, 1));
  const last  = endOfMonth(new Date(year, month, 1));
  let cur = new Date(first);
  while (cur.getDay() !== 6) cur = addDays(cur, 1);
  while (cur <= last) {
    out.push(new Date(cur));
    cur = addDays(cur, 7);
  }
  return out;
}

/**
 * For a given Saturday, the week covers the PREVIOUS Saturday (inclusive)
 * through the FRIDAY just before this Saturday (inclusive).
 *   e.g. Saturday 2 May → 26 Apr (Sat) to 1 May (Fri)
 */
function getWeekRange(saturday: Date): { wStart: string; wEnd: string } {
  const wStart = format(addDays(saturday, -7), 'yyyy-MM-dd'); // prev Saturday
  const wEnd   = format(addDays(saturday, -1), 'yyyy-MM-dd'); // this Friday
  return { wStart, wEnd };
}

function getMonthWithMostDays(saturdays: Date[]) {
  const counter: Record<string, number> = {};
  for (const sat of saturdays) {
    const key = `${sat.getFullYear()}-${sat.getMonth()}`;
    counter[key] = (counter[key] || 0) + 1;
  }
  const best = Object.entries(counter).sort((a, b) => b[1] - a[1])[0][0];
  const [year, month] = best.split('-').map(Number);
  return { year, month };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
  'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER',
];

const MONTH_NAMES_SHORT = [
  'Jan','Feb','Mar','Apr','May','Jun',
  'Jul','Aug','Sep','Oct','Nov','Dec',
];

const EXCLUDED_NAMES = [
  'RAHUL','SAILESH','NARAYAN','NAMDEV - 19 KG','BANTE','HARI','VITTHAL',
];
const TOTAL_EXCL_NAMES = [
  'RAHUL','SAILESH','NARAYAN','SUNDAY','AGD',
  'RAMESH','NAMDEV - 19 KG','BANTE','HARI','VITTHAL',
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface PreviewRow {
  srNo: string | number;
  name: string;
  weekTotals: number[];
  total: number;
  isBold?: boolean;
}
interface PFRow {
  srNo: number;
  name: string;
  gross: number;
  pf: number;
  attendance: number | string;
}
interface BottomSection {
  label: string;
  value: string | number;
  isBold?: boolean;
}

// ── Year/Month Picker ─────────────────────────────────────────────────────────

interface MonthYearPickerProps {
  selectedMonth: number;
  selectedYear: number;
  onSelect: (month: number, year: number) => void;
}

function MonthYearPicker({ selectedMonth, selectedYear, onSelect }: MonthYearPickerProps) {
  const [visible, setVisible] = useState(false);
  const [tempYear, setTempYear] = useState(selectedYear);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  return (
    <>
      <TouchableOpacity style={styles.dateButton} onPress={() => { setTempYear(selectedYear); setVisible(true); }}>
        <Ionicons name="calendar-outline" size={18} color={BPCL_BLUE} />
        <Text style={styles.dateButtonText}>
          {MONTH_NAMES_SHORT[selectedMonth]} {selectedYear}
        </Text>
        <Ionicons name="chevron-down" size={16} color="#888" />
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.pickerCard}>
            {/* Year selector */}
            <View style={styles.yearRow}>
              <TouchableOpacity onPress={() => setTempYear(y => Math.max(y - 1, currentYear - 4))}>
                <Ionicons name="chevron-back" size={22} color={BPCL_BLUE} />
              </TouchableOpacity>
              <Text style={styles.yearText}>{tempYear}</Text>
              <TouchableOpacity onPress={() => setTempYear(y => Math.min(y + 1, currentYear + 2))}>
                <Ionicons name="chevron-forward" size={22} color={BPCL_BLUE} />
              </TouchableOpacity>
            </View>

            {/* Month grid */}
            <View style={styles.monthGrid}>
              {MONTH_NAMES_SHORT.map((m, i) => {
                const isSelected = i === selectedMonth && tempYear === selectedYear;
                return (
                  <TouchableOpacity
                    key={i}
                    style={[styles.monthCell, isSelected && styles.monthCellSelected]}
                    onPress={() => { onSelect(i, tempYear); setVisible(false); }}
                  >
                    <Text style={[styles.monthCellText, isSelected && styles.monthCellTextSelected]}>
                      {m}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function PFSheetScreen() {
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState<number>(now.getMonth());
  const [selectedYear,  setSelectedYear]  = useState<number>(now.getFullYear());

  const [trip1881,       setTrip1881]       = useState('');
  const [trip1116,       setTrip1116]       = useState('');
  const [loading,        setLoading]        = useState<'excel' | null>(null);
  const [saturdayLabels, setSaturdayLabels] = useState<string[]>([]);
  const [previewRows,    setPreviewRows]    = useState<PreviewRow[]>([]);
  const [pfPreviewRows,  setPfPreviewRows]  = useState<PFRow[]>([]);
  const [bottomSections, setBottomSections] = useState<BottomSection[]>([]);
  const [hasPreview,     setHasPreview]     = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // ── Fetch ───────────────────────────────────────────────────────────────────

  const fetchAllData = useCallback(async () => {
    // 1. Get all Saturdays of the selected month
    const saturdays = getSaturdaysOfMonth(selectedYear, selectedMonth);
    if (!saturdays.length) throw new Error('No Saturdays found for selected month.');

    // 2. Compute full DB range:
    //    - rangeStart = previous Saturday before the first Saturday of the month
    //    - rangeEnd   = Friday before the last Saturday of the month
    const firstWeek = getWeekRange(saturdays[0]);
    const lastWeek  = getWeekRange(saturdays[saturdays.length - 1]);
    const rangeStart = firstWeek.wStart; // e.g. 26 Apr for May
    const rangeEnd   = lastWeek.wEnd;    // e.g. 29 May for May

    // Labels shown in column headers: "02-05-2026" (the Saturday date)
    const satLabels = saturdays.map((s) => format(s, 'dd-MM-yyyy'));

    const [commData, pfData, deliveriesData, commercialData] = await Promise.all([
      supabase.from('dashboard_commisionrate').select('name').order('name'),
      supabase.from('dashboard_pfsheet')
        .select('name, full_name, designation, pf_amount')
        .order('sort_order', { ascending: true }),
      supabase.from('dashboard_deliveryrecords')
        .select('name, date, number')
        .gte('date', rangeStart).lte('date', rangeEnd),
      supabase.from('dashboard_commercialrecords')
        .select('id')
        .gte('delivery_date', rangeStart).lte('delivery_date', rangeEnd)
        .eq('delivery_boy', 'NAMDEV'),
    ]);

    if (commData.error)       throw commData.error;
    if (deliveriesData.error) throw deliveriesData.error;

    const staffList   = (commData.data || [])
      .map((r: any) => r.name)
      .filter((n: string) => !EXCLUDED_NAMES.includes(n));
    const pfRows      = pfData.data || [];
    const deliveries  = deliveriesData.data || [];
    const namdevCount = commercialData.data?.length || 0;

    // Build delivery map: name → date → qty
    const dMap: Record<string, Record<string, number>> = {};
    for (const row of deliveries) {
      if (!dMap[row.name]) dMap[row.name] = {};
      dMap[row.name][row.date] =
        (dMap[row.name][row.date] || 0) + Number(row.number || 0);
    }

    // Short name total (across full range, for PF gross calc)
    const shortNameTotalMap: Record<string, number> = {};
    for (const [sn, dm] of Object.entries(dMap))
      shortNameTotalMap[sn] = Object.values(dm).reduce((s, v) => s + v, 0);

    // Attendance = distinct dates per name
    const distinctDatesMap: Record<string, Set<string>> = {};
    for (const row of deliveries) {
      if (!distinctDatesMap[row.name]) distinctDatesMap[row.name] = new Set();
      distinctDatesMap[row.name].add(row.date);
    }
    const attendanceMap: Record<string, number> = {};
    for (const [n, ds] of Object.entries(distinctDatesMap))
      attendanceMap[n] = ds.size;

    const pfMap: Record<string, string> = {};
    for (const r of pfRows) pfMap[r.name] = r.full_name;

    // Build main preview rows — one per staff member
    const mainRows: PreviewRow[] = [];
    let srNo = 1;
    let totalCount = 0;

    for (const name of staffList) {
      const displayName = pfMap[name] || name;
      const weekTotals: number[] = [];
      let rowTotal = 0;

      for (const sat of saturdays) {
        // Week = prev Saturday to this Friday
        const { wStart, wEnd } = getWeekRange(sat);
        let wk = 0;
        for (const [date, qty] of Object.entries(dMap[name] || {}))
          if (date >= wStart && date <= wEnd) wk += qty;
        weekTotals.push(wk);
        rowTotal += wk;
      }

      mainRows.push({ srNo, name: displayName, weekTotals, total: rowTotal });
      srNo++;
    }

    // TOTAL row
    const totalWeeks: number[] = saturdays.map((sat) => {
      const { wStart, wEnd } = getWeekRange(sat);
      let wk = 0;
      for (const [dname, dateMap] of Object.entries(dMap)) {
        if (TOTAL_EXCL_NAMES.includes(dname) || dname.includes('DBA')) continue;
        for (const [date, qty] of Object.entries(dateMap))
          if (date >= wStart && date <= wEnd) wk += qty;
      }
      totalCount += wk;
      return wk;
    });

    mainRows.push({
      srNo: '', name: 'TOTAL',
      weekTotals: totalWeeks, total: totalCount, isBold: true,
    });

    const t1881 = parseInt(trip1881) || 0;
    const t1116 = parseInt(trip1116) || 0;

    const staticRows: PreviewRow[] = [
      { srNo,     name: 'KAILASH MOHAN AGRAWAL',
        weekTotals: [t1881, ...Array(saturdays.length - 1).fill(-1)], total: t1881 },
      { srNo: srNo + 1, name: 'RAJESH MANOHARRAO SHINDE',
        weekTotals: [t1116, ...Array(saturdays.length - 1).fill(-1)], total: t1116 },
      { srNo: srNo + 2, name: 'KISHOR MANOHAR GAYKI',
        weekTotals: [t1881 + t1116, ...Array(saturdays.length - 1).fill(-1)], total: t1881 + t1116 },
      { srNo: srNo + 3, name: 'VISHWANATH RAJARAM DHAD',
        weekTotals: [t1881 + t1116, ...Array(saturdays.length - 1).fill(-1)], total: t1881 + t1116 },
    ];

    const namdevRow: PreviewRow = {
      srNo: srNo + 4, name: 'NAMDEV URADE - 19KG',
      weekTotals: [namdevCount, ...Array(saturdays.length - 1).fill(-1)],
      total: namdevCount,
    };

    // Bottom verification section
    const fetchNameTotal = async (filterName: string, contains = false): Promise<number> => {
      let q = supabase.from('dashboard_deliveryrecords').select('number')
        .gte('date', rangeStart).lte('date', rangeEnd);
      if (contains) q = (q as any).ilike('name', `%${filterName}%`);
      else q = q.eq('name', filterName);
      const { data } = await q.limit(10000);
      return (data || []).reduce((s: number, r: any) => s + Number(r.number || 0), 0);
    };

    const [
      totalSaleAll, rahulTotal, saileshTotal, banteTotal,
      hariTotal, vitthalTotal, dbaTotal, agdRameshTotal,
    ] = await Promise.all([
      supabase.from('dashboard_deliveryrecords').select('number')
        .gte('date', rangeStart).lte('date', rangeEnd).neq('name', 'SUNDAY').limit(100000)
        .then(({ data }) => (data || []).reduce((s: number, r: any) => s + Number(r.number || 0), 0)),
      fetchNameTotal('RAHUL'), fetchNameTotal('SAILESH'), fetchNameTotal('BANTE'),
      fetchNameTotal('HARI'),  fetchNameTotal('VITTHAL'), fetchNameTotal('DBA', true),
      supabase.from('dashboard_deliveryrecords').select('number')
        .gte('date', rangeStart).lte('date', rangeEnd).in('name', ['AGD', 'RAMESH']).limit(10000)
        .then(({ data }) => (data || []).reduce((s: number, r: any) => s + Number(r.number || 0), 0)),
    ]);

    const verificationTotal =
      totalCount + rahulTotal + saileshTotal + banteTotal +
      hariTotal + vitthalTotal + dbaTotal + agdRameshTotal;

    const monthLabel = `${MONTH_NAMES[selectedMonth]} ${selectedYear}`;

    const bottomSecs: BottomSection[] = [
      { label: `TOTAL SALE — ${format(new Date(rangeStart), 'dd-MM-yyyy')} TO ${format(new Date(rangeEnd), 'dd-MM-yyyy')}`,
        value: totalSaleAll, isBold: true },
      { label: 'TOTAL 14.2 PF SHEET',        value: totalCount },
      { label: 'PRAMOD (RAHUL)',              value: rahulTotal },
      { label: 'SAILESH',                     value: saileshTotal },
      { label: 'BANTE',                       value: banteTotal },
      { label: 'HARI',                        value: hariTotal },
      { label: 'VITTHAL',                     value: vitthalTotal },
      { label: 'DBA',                         value: dbaTotal },
      { label: 'CASH N CARRY (AGD + RAMESH)', value: agdRameshTotal },
      { label: 'GRAND TOTAL (VERIFICATION)',  value: verificationTotal, isBold: true },
    ];

    // PF sheet rows
    const officeStaff   = pfRows.filter((r: any) => r.designation === 'OFFICE STAFF');
    const deliveryBoys  = pfRows.filter((r: any) =>
      r.designation === 'DELIVERY BOY' && r.full_name !== 'NAMDEV URHADE 19KG');
    const driversLabour = pfRows.filter((r: any) =>
      r.designation === 'DRIVER' || r.designation === 'LABOUR');

    const tripMap: Record<string, number> = {
      'KAILASH MOHAN AGRAWAL':    t1881,
      'RAJESH MANOHARRAO SHINDE': t1116,
      'KISHOR MANOHAR GAYKI':     t1881 + t1116,
      'VISHWANATH RAJARAM DHAD':  t1881 + t1116,
    };

    let pfSrCounter = 1;
    const pfRowsBuilt: PFRow[] = [];

    for (const r of officeStaff) {
      const amt = parseFloat(r.pf_amount);
      pfRowsBuilt.push({
        srNo: pfSrCounter++, name: r.name,
        gross: amt, pf: amt > 15000 ? 15000 : amt, attendance: '',
      });
    }
    for (const r of deliveryBoys) {
      const delivTotal = shortNameTotalMap[r.name] || 0;
      let gross = parseFloat(r.pf_amount) * delivTotal;
      if (r.name === 'NAMDEV URHADE') gross += namdevCount * 22;
      const pf  = gross > 15000 ? 15000 : gross;
      const att = attendanceMap[r.name] ?? 0;
      pfRowsBuilt.push({
        srNo: pfSrCounter++, name: r.full_name, gross, pf, attendance: att,
      });
    }
    for (const r of driversLabour) {
      const trips = tripMap[r.full_name] || 0;
      const gross = parseFloat((parseFloat(r.pf_amount) * trips).toFixed(2));
      const pf    = gross > 15000 ? 15000 : gross;
      pfRowsBuilt.push({
        srNo: pfSrCounter++, name: r.full_name, gross, pf,
        attendance: r.designation === 'DRIVER' ? trips * 2 : 23,
      });
    }

    return {
      satLabels, mainRows, staticRows, namdevRow,
      bottomSecs, pfRows: pfRowsBuilt, monthLabel, rangeStart, rangeEnd,
    };
  }, [selectedMonth, selectedYear, trip1881, trip1116]);

  // ── Preview ─────────────────────────────────────────────────────────────────

  const handlePreview = async () => {
    try {
      setLoadingPreview(true);
      const result = await fetchAllData();
      setSaturdayLabels(result.satLabels);
      setPreviewRows([...result.mainRows, ...result.staticRows, result.namdevRow]);
      setPfPreviewRows(result.pfRows);
      setBottomSections(result.bottomSecs);
      setHasPreview(true);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load preview.');
    } finally { setLoadingPreview(false); }
  };

  // ── Excel ───────────────────────────────────────────────────────────────────

  const handleGenerateExcel = async () => {
    if (!trip1881.trim() || !trip1116.trim()) {
      Alert.alert('Validation', 'Please enter trips for both trucks.');
      return;
    }
    try {
      setLoading('excel');
      const { cacheDir, base64Encoding, writeAsync, getInfo } = getFSHelpers();
      const result = await fetchAllData();
      const { satLabels, mainRows, staticRows, namdevRow, bottomSecs, pfRows, monthLabel } = result;

      const wb = XLSXStyle.utils.book_new();

      // ══════════════════════════════════════════════════════════════
      //  COMMON STYLES  (identical to original)
      // ══════════════════════════════════════════════════════════════

      const S = {
        company: {
          font:  { bold: true, sz: 16, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '17375E' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: mediumBorder,
        },
        subtitle: {
          font:  { bold: true, sz: 11, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '2E75B6' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: mediumBorder,
        },
        sheetTitle: {
          font:  { bold: true, sz: 13, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '17375E' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: mediumBorder,
        },
        colHeader: {
          font:  { bold: true, sz: 10, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '2E75B6' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: thinBorder,
        },
        dataCenter: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        dataLeft: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        altCenter: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        altLeft: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        totalCenter: {
          font:  { bold: true, sz: 11, color: { rgb: '17375E' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFD966' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        totalLeft: {
          font:  { bold: true, sz: 11, color: { rgb: '17375E' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFD966' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        sectionHeader: {
          font:  { bold: true, sz: 11, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '375623' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        sectionHeaderBlank: {
          font:  { sz: 10, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '375623' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        driverCenter: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'E2EFDA' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        driverLeft: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'E2EFDA' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        verifyBoldLeft: {
          font:  { bold: true, sz: 11, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '17375E' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        verifyBoldRight: {
          font:  { bold: true, sz: 11, color: { rgb: 'FFFFFF' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '17375E' } },
          alignment: { horizontal: 'right', vertical: 'center' },
          border: thinBorder,
        },
        verifyBoldBlank: {
          font:  { sz: 10, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: '17375E' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        verifyLeft: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '000000' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border: thinBorder,
        },
        verifyRight: {
          font:  { bold: true, sz: 10, name: 'Calibri', color: { rgb: '17375E' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } },
          alignment: { horizontal: 'right', vertical: 'center' },
          border: thinBorder,
        },
        verifyBlank: {
          font:  { sz: 10, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfGrossWhite: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '375623' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfGrossAlt: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '375623' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfPFWhite: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '833C00' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfPFAlt: {
          font:  { sz: 10, name: 'Calibri', color: { rgb: '833C00' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfAttWhite: {
          font:  { bold: true, sz: 10, name: 'Calibri', color: { rgb: '17375E' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfAttAlt: {
          font:  { bold: true, sz: 10, name: 'Calibri', color: { rgb: '17375E' } },
          fill:  { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfTotalGross: {
          font:  { bold: true, sz: 11, color: { rgb: '375623' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFD966' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        pfTotalPF: {
          font:  { bold: true, sz: 11, color: { rgb: '833C00' }, name: 'Calibri' },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFD966' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: thinBorder,
        },
        blank: {
          font:  { sz: 10 },
          fill:  { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          border: thinBorder,
        },
      };

      // ══════════════════════════════════════════════════════════════
      //  SHEET 1 — PRE-CHECKING SHEET
      // ══════════════════════════════════════════════════════════════

      const totalCols = 2 + satLabels.length + 1;
      const s1Rows: { value: any; style: any }[][] = [];

      const fullRow = (values: any[], defaultStyle: any, overrides: Record<number, any> = {}) =>
        values.map((v, i) => ({ value: v, style: overrides[i] ?? defaultStyle }));

      s1Rows.push(fullRow(['SHREEJEE GAS SERVICE', ...Array(totalCols - 1).fill('')], S.company));
      s1Rows.push(fullRow(
        [`${format(new Date(result.rangeStart), 'dd-MM-yyyy')} TO ${format(new Date(result.rangeEnd), 'dd-MM-yyyy')}`,
          ...Array(totalCols - 1).fill('')],
        S.subtitle
      ));
      s1Rows.push(fullRow(['PRE-CHECKING SHEET', ...Array(totalCols - 1).fill('')], S.sheetTitle));
      s1Rows.push(fullRow(Array(totalCols).fill(''), S.blank));
      s1Rows.push(fullRow(['SR NO', 'NAME', ...satLabels, 'TOTAL'], S.colHeader));

      let altToggle = false;
      for (const r of mainRows) {
        const isTotal = r.name === 'TOTAL';
        const base    = isTotal
          ? { center: S.totalCenter, left: S.totalLeft }
          : altToggle
            ? { center: S.altCenter, left: S.altLeft }
            : { center: S.dataCenter, left: S.dataLeft };

        s1Rows.push([
          { value: r.srNo,  style: base.center },
          { value: r.name,  style: base.left },
          ...r.weekTotals.map((v) => ({ value: v === -1 ? '' : v, style: base.center })),
          { value: r.total, style: base.center },
        ]);
        if (!isTotal) altToggle = !altToggle;
      }

      s1Rows.push(fullRow(Array(totalCols).fill(''), S.blank));
      s1Rows.push([
        { value: '',              style: S.sectionHeaderBlank },
        { value: 'TRUCK DRIVERS', style: S.sectionHeader },
        ...Array(totalCols - 2).fill({ value: '', style: S.sectionHeaderBlank }),
      ]);

      for (const r of staticRows) {
        s1Rows.push([
          { value: r.srNo, style: S.driverCenter },
          { value: r.name, style: S.driverLeft },
          ...r.weekTotals.map((v, i) => ({
            value: i === 0 ? v : v === -1 ? '' : v,
            style: S.driverCenter,
          })),
          { value: r.total, style: S.driverCenter },
        ]);
      }

      s1Rows.push(fullRow(Array(totalCols).fill(''), S.blank));
      s1Rows.push([
        { value: '',               style: S.sectionHeaderBlank },
        { value: '19 KG CYLINDER', style: S.sectionHeader },
        ...Array(totalCols - 2).fill({ value: '', style: S.sectionHeaderBlank }),
      ]);

      s1Rows.push([
        { value: namdevRow.srNo, style: S.driverCenter },
        { value: namdevRow.name, style: S.driverLeft },
        ...namdevRow.weekTotals.map((v, i) => ({
          value: i === 0 ? v : '',
          style: S.driverCenter,
        })),
        { value: namdevRow.total, style: S.driverCenter },
      ]);

      s1Rows.push(fullRow(Array(totalCols).fill(''), S.blank));
      for (const sec of bottomSecs) {
        const isBold = sec.isBold;
        s1Rows.push([
          { value: sec.label, style: isBold ? S.verifyBoldLeft  : S.verifyLeft },
          ...Array(totalCols - 2).fill({ value: '', style: isBold ? S.verifyBoldBlank : S.verifyBlank }),
          { value: sec.value, style: isBold ? S.verifyBoldRight : S.verifyRight },
        ]);
      }

      const ws1 = buildStyledSheet(s1Rows);
      ws1['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: totalCols - 1 } },
      ];
      ws1['!cols'] = [{ wch: 8 }, { wch: 32 }, ...satLabels.map(() => ({ wch: 14 })), { wch: 12 }];
      ws1['!rows'] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 26 }, { hpt: 6 }, { hpt: 38 }];
      XLSXStyle.utils.book_append_sheet(wb, ws1, 'Pre-Checking Sheet');

      // ══════════════════════════════════════════════════════════════
      //  SHEET 2 — FINAL PF SHEET
      // ══════════════════════════════════════════════════════════════

      const PF_COLS = 5;
      const s2Rows: { value: any; style: any }[][] = [];

      s2Rows.push(fullRow(['SHREEJEE GAS SERVICE', ...Array(PF_COLS - 1).fill('')], S.company));
      s2Rows.push(fullRow([`MONTH OF ${monthLabel}`, ...Array(PF_COLS - 1).fill('')], S.subtitle));
      s2Rows.push(fullRow(['FINAL PF SHEET', ...Array(PF_COLS - 1).fill('')], S.sheetTitle));
      s2Rows.push(fullRow(Array(PF_COLS).fill(''), S.blank));
      s2Rows.push([
        { value: 'SR NO',         style: S.colHeader },
        { value: 'NAME',          style: S.colHeader },
        { value: 'GROSS SALARY',  style: S.colHeader },
        { value: 'PF ON PAYMENT', style: S.colHeader },
        { value: 'ATTENDANCE',    style: S.colHeader },
      ]);

      let totalGross = 0; let totalPF = 0; let pfAlt = false;
      for (const r of pfRows) {
        const isAlt = pfAlt;
        s2Rows.push([
          { value: r.srNo,                            style: isAlt ? S.altCenter  : S.dataCenter },
          { value: r.name,                            style: isAlt ? S.altLeft    : S.dataLeft },
          { value: parseFloat(r.gross.toFixed(2)),    style: isAlt ? S.pfGrossAlt : S.pfGrossWhite },
          { value: parseFloat(r.pf.toFixed(2)),       style: isAlt ? S.pfPFAlt    : S.pfPFWhite },
          { value: r.attendance === '' ? '' : r.attendance, style: isAlt ? S.pfAttAlt : S.pfAttWhite },
        ]);
        totalGross += r.gross; totalPF += r.pf; pfAlt = !pfAlt;
      }
      s2Rows.push([
        { value: '',                                style: S.totalCenter },
        { value: 'TOTAL AMOUNT',                    style: S.totalLeft },
        { value: parseFloat(totalGross.toFixed(2)), style: S.pfTotalGross },
        { value: parseFloat(totalPF.toFixed(2)),    style: S.pfTotalPF },
        { value: '',                                style: S.totalCenter },
      ]);

      const ws2 = buildStyledSheet(s2Rows);
      ws2['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: PF_COLS - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: PF_COLS - 1 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: PF_COLS - 1 } },
      ];
      ws2['!cols'] = [{ wch: 8 }, { wch: 32 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
      ws2['!rows'] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 26 }, { hpt: 6 }, { hpt: 38 }];
      XLSXStyle.utils.book_append_sheet(wb, ws2, 'Final PF Sheet');

      // ── Write & Share ───────────────────────────────────────────

      const base64Data = writeWorkbookToBase64(wb);
      const fileName   = `PF_Sheet_${monthLabel.replace(' ', '_')}.xlsx`;
      const fileUri    = `${cacheDir}${fileName}`;

      await writeAsync(fileUri, base64Data, { encoding: base64Encoding });
      const fileInfo = await getInfo(fileUri);
      if (!fileInfo.exists || (fileInfo.size ?? 0) === 0)
        throw new Error('File was not written correctly.');

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType:    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: `PF Sheet — ${monthLabel}`,
          UTI:         'com.microsoft.excel.xlsx',
        });
      } else {
        Alert.alert('Saved', `Excel saved to:\n${fileUri}`);
      }
    } catch (err: any) {
      console.error('[PFSheet]', err);
      Alert.alert('Error', err.message || 'Failed to generate Excel.');
    } finally { setLoading(null); }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        <View style={styles.header}>
          <Ionicons name="document-text" size={28} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>PF Sheet</Text>
            <Text style={styles.headerSub}>SHREEJEE GAS SERVICE</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>SELECT MONTH</Text>
          <Text style={styles.fieldLabel}>Month & Year</Text>
          <MonthYearPicker
            selectedMonth={selectedMonth}
            selectedYear={selectedYear}
            onSelect={(m, y) => { setSelectedMonth(m); setSelectedYear(y); setHasPreview(false); }}
          />

          {/* Show computed range as info */}
          {(() => {
            const sats = getSaturdaysOfMonth(selectedYear, selectedMonth);
            if (!sats.length) return null;
            const { wStart } = getWeekRange(sats[0]);
            const { wEnd }   = getWeekRange(sats[sats.length - 1]);
            return (
              <View style={styles.rangeInfo}>
                <Ionicons name="information-circle-outline" size={14} color="#888" />
                <Text style={styles.rangeInfoText}>
                  Data range: {format(new Date(wStart), 'dd MMM')} → {format(new Date(wEnd), 'dd MMM yyyy')}
                  {'  ·  '}{sats.length} Saturdays
                </Text>
              </View>
            );
          })()}

          <Text style={[styles.sectionLabel, { marginTop: 20 }]}>TRUCK TRIPS</Text>
          <Text style={styles.fieldLabel}>Truck 1881 — Total Trips</Text>
          <TextInput style={styles.input} value={trip1881} onChangeText={setTrip1881}
            keyboardType="numeric" placeholder="e.g. 12" placeholderTextColor="#bbb" />
          <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Truck 1116 — Total Trips</Text>
          <TextInput style={styles.input} value={trip1116} onChangeText={setTrip1116}
            keyboardType="numeric" placeholder="e.g. 8" placeholderTextColor="#bbb" />
        </View>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.btn, styles.btnPreview, loadingPreview && styles.btnDisabled]}
            onPress={handlePreview} disabled={loadingPreview || loading !== null} activeOpacity={0.8}>
            {loadingPreview
              ? <ActivityIndicator color="#fff" size="small" />
              : <><Ionicons name="eye-outline" size={18} color="#fff" /><Text style={styles.btnText}>Preview</Text></>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnExcel, loading === 'excel' && styles.btnDisabled]}
            onPress={handleGenerateExcel} disabled={loadingPreview || loading !== null} activeOpacity={0.8}>
            {loading === 'excel'
              ? <ActivityIndicator color="#fff" size="small" />
              : <><Ionicons name="download-outline" size={18} color="#fff" /><Text style={styles.btnText}>Download Excel</Text></>}
          </TouchableOpacity>
        </View>

        {hasPreview && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>PREVIEW — PRE-CHECKING SHEET</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={styles.tRow}>
                  {['SR NO', 'NAME', ...saturdayLabels, 'TOTAL'].map((h, i) => (
                    <View key={i} style={[styles.tCell, styles.tHeader, i === 1 && styles.tNameCell]}>
                      <Text style={styles.tHeaderTxt}>{h}</Text>
                    </View>
                  ))}
                </View>
                {previewRows.map((row, ri) => {
                  const isTotal  = row.name === 'TOTAL';
                  const isTruck  = ['KAILASH MOHAN AGRAWAL','RAJESH MANOHARRAO SHINDE','KISHOR MANOHAR GAYKI','VISHWANATH RAJARAM DHAD'].includes(row.name);
                  const isNamdev = row.name === 'NAMDEV URADE - 19KG';
                  return (
                    <View key={ri} style={[
                      styles.tRow,
                      isTotal && styles.tTotalRow,
                      (isTruck || isNamdev) && styles.tSubRow,
                      ri % 2 === 1 && !isTotal && !isTruck && !isNamdev && styles.tAltRow,
                    ]}>
                      <View style={styles.tCell}><Text style={[styles.tTxt, isTotal && styles.tBold]}>{row.srNo}</Text></View>
                      <View style={[styles.tCell, styles.tNameCell]}><Text style={[styles.tTxt, isTotal && styles.tBold]}>{row.name}</Text></View>
                      {row.weekTotals.map((v, wi) => (
                        <View key={wi} style={styles.tCell}>
                          <Text style={[styles.tTxt, isTotal && styles.tBold]}>
                            {v === -1 ? (wi === 0 ? row.total.toString() : '') : v}
                          </Text>
                        </View>
                      ))}
                      <View style={styles.tCell}><Text style={[styles.tTxt, isTotal && styles.tBold]}>{row.total}</Text></View>
                    </View>
                  );
                })}
              </View>
            </ScrollView>

            <View style={styles.summaryBlock}>
              <Text style={[styles.sectionLabel, { marginTop: 16, marginBottom: 8 }]}>VERIFICATION SUMMARY</Text>
              {bottomSections.map((s, i) => (
                <View key={i} style={[styles.summaryRow, s.isBold && styles.summaryRowBold]}>
                  <Text style={[styles.summaryLabel, s.isBold && styles.summaryLabelBold]}>{s.label}</Text>
                  <Text style={[styles.summaryValue, s.isBold && styles.summaryLabelBold]}>{s.value}</Text>
                </View>
              ))}
            </View>

            <Text style={[styles.sectionLabel, { marginTop: 20, marginBottom: 8 }]}>PREVIEW — FINAL PF SHEET</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={styles.tRow}>
                  {['SR NO', 'NAME', 'GROSS SALARY', 'PF ON PAYMENT', 'ATTENDANCE', 'SIGNATURE'].map((h, i) => (
                    <View key={i} style={[
                      styles.tCell, styles.tHeader,
                      i === 1 && styles.tNameCell,
                      (i === 2 || i === 3) && styles.tAmtCell,
                      i === 4 && styles.tAttCell,
                      i === 5 && styles.tSigCell,
                    ]}>
                      <Text style={styles.tHeaderTxt}>{h}</Text>
                    </View>
                  ))}
                </View>
                {pfPreviewRows.map((row, ri) => (
                  <View key={ri} style={[styles.tRow, ri % 2 === 1 && styles.tAltRow]}>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{row.srNo}</Text></View>
                    <View style={[styles.tCell, styles.tNameCell]}><Text style={styles.tTxt}>{row.name}</Text></View>
                    <View style={[styles.tCell, styles.tAmtCell]}><Text style={[styles.tTxt, styles.tGreen]}>{row.gross.toFixed(2)}</Text></View>
                    <View style={[styles.tCell, styles.tAmtCell]}><Text style={[styles.tTxt, styles.tOrange]}>{row.pf.toFixed(2)}</Text></View>
                    <View style={[styles.tCell, styles.tAttCell]}><Text style={[styles.tTxt, styles.tBold]}>{row.attendance === '' ? '—' : row.attendance}</Text></View>
                    <View style={[styles.tCell, styles.tSigCell]}><Text style={styles.tTxt} /></View>
                  </View>
                ))}
                {pfPreviewRows.length > 0 && (() => {
                  const tG = pfPreviewRows.reduce((s, r) => s + r.gross, 0);
                  const tP = pfPreviewRows.reduce((s, r) => s + r.pf, 0);
                  return (
                    <View style={[styles.tRow, styles.tTotalRow]}>
                      <View style={styles.tCell}><Text style={styles.tBold} /></View>
                      <View style={[styles.tCell, styles.tNameCell]}><Text style={styles.tBold}>TOTAL AMOUNT</Text></View>
                      <View style={[styles.tCell, styles.tAmtCell]}><Text style={styles.tBold}>{tG.toFixed(2)}</Text></View>
                      <View style={[styles.tCell, styles.tAmtCell]}><Text style={styles.tBold}>{tP.toFixed(2)}</Text></View>
                      <View style={[styles.tCell, styles.tAttCell]}><Text style={styles.tBold} /></View>
                      <View style={[styles.tCell, styles.tSigCell]}><Text style={styles.tBold} /></View>
                    </View>
                  );
                })()}
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
  scroll:    { padding: 16, paddingBottom: 48 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: BPCL_BLUE, borderRadius: 16, padding: 20, marginBottom: 14,
  },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  headerSub:   { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
  card: {
    backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14,
    borderWidth: 1, borderColor: '#eee', elevation: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4,
  },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#aaa', letterSpacing: 1.1, marginBottom: 10 },
  fieldLabel:   { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 6 },
  dateButton: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, backgroundColor: '#fafafa',
  },
  dateButtonText: { fontSize: 15, color: '#333', fontWeight: '500', flex: 1 },
  rangeInfo: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 8, paddingHorizontal: 4,
  },
  rangeInfoText: { fontSize: 12, color: '#888' },
  input: {
    borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 15, color: '#333', backgroundColor: '#fafafa',
  },
  buttonRow:   { flexDirection: 'row', gap: 12, marginBottom: 14 },
  btn: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, borderRadius: 14, paddingVertical: 15,
    elevation: 3, shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25, shadowRadius: 6,
  },
  btnPreview:  { backgroundColor: '#27ae60', shadowColor: '#27ae60' },
  btnExcel:    { backgroundColor: '#1D6F42', shadowColor: '#1D6F42' },
  btnDisabled: { opacity: 0.55 },
  btnText:     { fontSize: 14, fontWeight: '700', color: '#fff' },
  // Modal picker
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center', alignItems: 'center',
  },
  pickerCard: {
    backgroundColor: '#fff', borderRadius: 20, padding: 20,
    width: 300, elevation: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 10,
  },
  yearRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 16, paddingHorizontal: 8,
  },
  yearText: { fontSize: 20, fontWeight: '800', color: '#17375E' },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  monthCell: {
    width: 70, paddingVertical: 10, borderRadius: 10,
    alignItems: 'center', backgroundColor: '#f5f7fa',
  },
  monthCellSelected: { backgroundColor: BPCL_BLUE },
  monthCellText:     { fontSize: 13, fontWeight: '600', color: '#444' },
  monthCellTextSelected: { color: '#fff' },
  // Table
  tRow:      { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e8e8e8' },
  tHeader:   { backgroundColor: '#2E75B6' },
  tTotalRow: { backgroundColor: '#FFD966' },
  tSubRow:   { backgroundColor: '#E2EFDA' },
  tAltRow:   { backgroundColor: '#DCE6F1' },
  tCell: {
    width: 76, paddingVertical: 7, paddingHorizontal: 5,
    justifyContent: 'center', alignItems: 'center',
    borderRightWidth: 1, borderRightColor: '#ddd',
  },
  tNameCell:  { width: 170, alignItems: 'flex-start' },
  tAmtCell:   { width: 100 },
  tAttCell:   { width: 90 },
  tSigCell:   { width: 110 },
  tHeaderTxt: { fontSize: 10, fontWeight: '700', color: '#fff', textAlign: 'center' },
  tTxt:       { fontSize: 10, color: '#444', textAlign: 'center' },
  tBold:      { fontWeight: '700', color: '#17375E', fontSize: 10 },
  tGreen:     { color: '#375623' },
  tOrange:    { color: '#833C00' },
  summaryBlock: { marginTop: 4 },
  summaryRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 7, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  summaryRowBold:   { backgroundColor: '#f0f4f8' },
  summaryLabel:     { fontSize: 13, color: '#555', flex: 1 },
  summaryLabelBold: { fontWeight: '700', color: '#111' },
  summaryValue:     { fontSize: 13, color: '#333', fontWeight: '600', minWidth: 50, textAlign: 'right' },
});