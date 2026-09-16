import React, { useState, useCallback } from 'react';
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
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import { format, addDays, subDays } from 'date-fns';

const BPCL_BLUE   = '#017DC5';
const GREEN_DARK  = '#1a6b2a';
const GREEN_BTN   = '#27ae60';

// ── Constants ─────────────────────────────────────────────────────────────────

const EXCLUDED_FROM_MAIN = [
  'SUNDAY', 'RAMESH', 'AGD', 'SAILESH', 'RAHUL',
  'VITTHAL', 'BANTE', 'NAMDEV', 'HARI',
];
const OTHER_NAMES = ['SAILESH', 'RAHUL', 'BANTE', 'VITTHAL', 'HARI'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSaturdays(start: Date, end: Date): Date[] {
  const saturdays: Date[] = [];
  let cur = new Date(start);
  // advance to first Saturday
  while (cur.getDay() !== 6) cur = addDays(cur, 1);
  while (cur <= end) {
    saturdays.push(new Date(cur));
    cur = addDays(cur, 7);
  }
  return saturdays;
}

function fmt(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function fmtDisplay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return format(date, 'dd-MM-yyyy');
}

function subtractDays(dateStr: string, days: number): string {
  return fmt(subDays(new Date(dateStr), days));
}

// Equivalent of Django's commission_fetch — get cumulative earnings
// for a person in the current monthly cycle up to end_date
async function commissionFetch(
  name: string,
  commisionRate: number,
  endDateStr: string,
  startDateStr: string,
): Promise<number> {
  // Find the Monday of the week containing startDateStr (cycle boundary is monthly)
  // The Django logic sums all deliveries from the true monthly cycle start to end_date
  // and computes total earnings to check against ₹15,000 cap

  // We replicate: get all delivery records for this person from the start of their
  // monthly cycle (first Saturday of the month) to end_date_str
  const endDate = new Date(endDateStr);
  const year    = endDate.getFullYear();
  const month   = endDate.getMonth();

  // Find first day of month, then backtrack to the last Saturday of previous month
  const firstDayOfMonth = new Date(year, month, 1);
  const dayOfWeek = firstDayOfMonth.getDay(); // 0=Sun, 6=Sat
  const daysToSub = ((dayOfWeek - 6) + 7) % 7 || 7;
  const cycleStart = fmt(subDays(firstDayOfMonth, daysToSub));

  const { data } = await supabase
    .from('dashboard_deliveryrecords')
    .select('number')
    .eq('name', name)
    .gte('date', cycleStart)
    .lte('date', endDateStr)
    .limit(10000);

  const total = (data || []).reduce((s: number, r: any) => s + Number(r.number || 0), 0);
  return total * commisionRate;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MainRow {
  srNo: number;
  fullName: string;
  cylinders: number;
  commisionRate: number | string;
  total: number;
  pfOnAmount: number;
  pfContribution: number;
  esic: number;
  netAmount: number;
}

interface OtherRow {
  srNo: number;
  name: string;
  cylinders: number;
  commisionRate: number;
  total: number;
}

interface WeekData {
  saturday: Date;
  startDateStr: string;
  endDateStr: string;
  paymentDate: string;
  mainRows: MainRow[];
  mainTotals: {
    cylinder: number;
    commision: number;
    pfOnAmount: number;
    pfDeduction: number;
    esic: number;
    net: number;
  };
  otherRows: OtherRow[];
  otherTotals: { cylinder: number; total: number };
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function WeeklySalaryScreen() {
  const [startDate, setStartDate] = useState<Date>(new Date());
  const [endDate,   setEndDate]   = useState<Date>(new Date());
  const [showStart, setShowStart] = useState(false);
  const [showEnd,   setShowEnd]   = useState(false);

  const [hasPreview,     setHasPreview]     = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingMain,    setLoadingMain]    = useState(false);
  const [loadingOther,   setLoadingOther]   = useState(false);

  // Preview data
  const [previewWeeks, setPreviewWeeks] = useState<WeekData[]>([]);

  // ── Core: build all week data ─────────────────────────────────────────────

  const buildAllWeeks = useCallback(async (): Promise<WeekData[]> => {
    const saturdays = getSaturdays(startDate, endDate);
    if (!saturdays.length) throw new Error('No Saturdays found in the selected date range.');

    const rangeStart = subtractDays(fmt(saturdays[0]), 6);
    const rangeEnd   = fmt(saturdays[saturdays.length - 1]);

    // ── Bulk fetch all data we need ────────────────────────────────────────

    const [pfRes, commRes, delivRes, otherCommRes] = await Promise.all([
      // PF sheet: name, full_name, pf_amount
      supabase
        .from('dashboard_pfsheet')
        .select('name, full_name, pf_amount')
        .limit(1000),

      // Delivery boy names (main list — not DBA, not excluded)
      supabase
        .from('dashboard_deliveryboyname')
        .select('name')
        .not('name', 'ilike', '%DBA%')
        .not('name', 'in', `(${EXCLUDED_FROM_MAIN.join(',')})`)
        .order('name')
        .limit(500),

      // All delivery records in range
      supabase
        .from('dashboard_deliveryrecords')
        .select('name, date, number')
        .gte('date', rangeStart)
        .lte('date', rangeEnd)
        .limit(100000),

      // Commission rates for "other" employees
      supabase
        .from('dashboard_commisionrate')
        .select('name, commission')
        .in('name', OTHER_NAMES)
        .limit(100),
    ]);

    if (pfRes.error)    throw pfRes.error;
    if (commRes.error)  throw commRes.error;
    if (delivRes.error) throw delivRes.error;

    const pfMap: Record<string, { fullName: string; pfAmount: number }> = {};
    for (const r of (pfRes.data || [])) {
      pfMap[r.name] = { fullName: r.full_name, pfAmount: parseFloat(r.pf_amount) };
    }

    const mainDeliveryNames: string[] = (commRes.data || []).map((r: any) => r.name);

    // Delivery lookup: name -> date -> qty
    const dMap: Record<string, Record<string, number>> = {};
    for (const row of (delivRes.data || [])) {
      if (!dMap[row.name]) dMap[row.name] = {};
      dMap[row.name][row.date] = (dMap[row.name][row.date] || 0) + Number(row.number || 0);
    }

    const otherCommMap: Record<string, number> = {};
    for (const r of (otherCommRes.data || [])) {
      otherCommMap[r.name] = parseFloat(r.commission);
    }

    // ── NAMDEV commercial records (19KG) for entire range ─────────────────
    const namdevCommRes = await supabase
      .from('dashboard_commercialrecords')
      .select('id, delivery_date')
      .eq('delivery_boy', 'NAMDEV')
      .gte('delivery_date', rangeStart)
      .lte('delivery_date', rangeEnd)
      .limit(10000);

    const namdevCommercial = namdevCommRes.data || [];

    // ── Build per-week data ───────────────────────────────────────────────
    const weeks: WeekData[] = [];

    for (const saturday of saturdays) {
      const endDateStr   = fmt(saturday);
      const startDateStr = subtractDays(endDateStr, 6);
      const paymentDate  = fmtDisplay(addDays(saturday, 1));

      // ── MAIN salary rows ──────────────────────────────────────────────

      let totalCylinder    = 0;
      let totalCommision   = 0;
      let totalPfOnAmount  = 0;
      let pfDeduction      = 0;
      let totalAfterPf     = 0;
      let totalEsic        = 0;

      const mainRows: MainRow[] = [];
      let srNo = 1;

      for (const name of mainDeliveryNames) {
        const pf = pfMap[name];
        const fullName = pf?.fullName || name;
        const commisionRate = pf?.pfAmount || 0;

        // Sum cylinders for this week
        let temp = 0;
        for (const [date, qty] of Object.entries(dMap[name] || {})) {
          if (date >= startDateStr && date <= endDateStr) temp += qty;
        }

        totalCylinder += temp;
        const total    = temp * commisionRate;
        const esic     = Math.round(total * 0.0075);
        totalEsic     += esic;

        // Check cumulative earnings vs ₹15,000 PF cap
        const cumulativeEarnings = await commissionFetch(name, commisionRate, endDateStr, startDateStr);

        let pfOnAmount: number;
        let pfContribution: number;
        let netAmount: number;

        if (cumulativeEarnings >= 15000) {
          const howMuchGreater = cumulativeEarnings - 15000;
          pfOnAmount = total - howMuchGreater;
          if (pfOnAmount > 0) {
            pfContribution = pfOnAmount * 0.12;
            netAmount      = Math.round(total - pfContribution) - esic;
          } else {
            pfOnAmount     = 0;
            pfContribution = 0;
            netAmount      = total - esic;
          }
        } else {
          pfOnAmount     = total;
          pfContribution = total * 0.12;
          netAmount      = Math.round(total - pfContribution) - esic;
        }

        totalCommision   += total;
        totalPfOnAmount  += pfOnAmount;
        pfDeduction      += pfContribution;
        totalAfterPf     += netAmount;

        mainRows.push({
          srNo, fullName, cylinders: temp, commisionRate,
          total, pfOnAmount, pfContribution, esic, netAmount,
        });
        srNo++;
      }

      // ── NAMDEV (14KG + 19KG) ─────────────────────────────────────────

      // 14KG deliveries this week
      let cylinder14 = 0;
      for (const [date, qty] of Object.entries(dMap['NAMDEV'] || {})) {
        if (date >= startDateStr && date <= endDateStr) cylinder14 += qty;
      }
      const weeklyComm14 = cylinder14 * 18.5;

      // 19KG commercial records this week
      const cylinder19 = namdevCommercial.filter(r =>
        r.delivery_date >= startDateStr && r.delivery_date <= endDateStr
      ).length;
      const weeklyComm19 = cylinder19 * 22;

      // NAMDEV monthly cap logic (same as Django view)
      const weekDate       = new Date(startDateStr);
      const cyMonth        = weekDate.getMonth();
      const cyYear         = weekDate.getFullYear();
      const firstOfMonth   = new Date(cyYear, cyMonth, 1);
      const dToSub         = ((firstOfMonth.getDay() - 6) + 7) % 7 || 7;
      const trueCycleStart = fmt(subDays(firstOfMonth, dToSub));
      const dayBefore      = fmt(subDays(new Date(startDateStr), 1));

      let historicalEarnings = 0;
      if (dayBefore >= trueCycleStart) {
        const [past14Res, past19Res] = await Promise.all([
          supabase
            .from('dashboard_deliveryrecords')
            .select('number')
            .eq('name', 'NAMDEV')
            .gte('date', trueCycleStart)
            .lte('date', dayBefore)
            .limit(10000),
          supabase
            .from('dashboard_commercialrecords')
            .select('id')
            .eq('delivery_boy', 'NAMDEV')
            .gte('delivery_date', trueCycleStart)
            .lte('delivery_date', dayBefore)
            .limit(10000),
        ]);
        const past14 = (past14Res.data || []).reduce((s: number, r: any) => s + Number(r.number || 0), 0);
        const past19 = past19Res.data?.length || 0;
        historicalEarnings = past14 * 18.5 + past19 * 22;
      }

      let pfOnAmount14: number;
      let pfOnAmount19: number;

      if (historicalEarnings >= 15000) {
        pfOnAmount14 = 0;
        pfOnAmount19 = 0;
      } else {
        let remaining = 15000 - historicalEarnings;
        pfOnAmount14  = Math.min(weeklyComm14, remaining);
        remaining    -= pfOnAmount14;
        pfOnAmount19  = Math.min(weeklyComm19, remaining);
      }

      const pf14    = pfOnAmount14 * 0.12;
      const pf19    = pfOnAmount19 * 0.12;
      const esic14  = Math.round(weeklyComm14 * 0.0075);
      const esic19  = Math.round(weeklyComm19 * 0.0075);
      const net14   = Math.round(weeklyComm14 - pf14) - esic14;
      const net19   = Math.round(weeklyComm19 - pf19) - esic19;

      totalEsic      += esic14 + esic19;
      totalCommision += weeklyComm14 + weeklyComm19;
      totalCylinder  += cylinder14 + cylinder19;
      totalPfOnAmount += pfOnAmount14 + pfOnAmount19;
      pfDeduction    += pf14 + pf19;
      totalAfterPf   += net14 + net19;

      mainRows.push({
        srNo:            srNo,
        fullName:        'NAMDEV URHADE - 14KG',
        cylinders:       cylinder14,
        commisionRate:   '18.5',
        total:           weeklyComm14,
        pfOnAmount:      pfOnAmount14,
        pfContribution:  pf14,
        esic:            esic14,
        netAmount:       net14,
      });
      srNo++;
      mainRows.push({
        srNo:            srNo,
        fullName:        'NAMDEV URHADE - 19KG',
        cylinders:       cylinder19,
        commisionRate:   '22',
        total:           weeklyComm19,
        pfOnAmount:      pfOnAmount19,
        pfContribution:  pf19,
        esic:            esic19,
        netAmount:       net19,
      });

      const mainTotals = {
        cylinder:   totalCylinder,
        commision:  Math.round(totalCommision),
        pfOnAmount: Math.round(totalPfOnAmount),
        pfDeduction: Math.round(pfDeduction),
        esic:       totalEsic,
        net:        Math.round(totalAfterPf),
      };

      // ── OTHER salary rows ────────────────────────────────────────────

      const otherRows: OtherRow[] = [];
      let srOther     = 1;
      let totalCylOther   = 0;
      let fullTotalOther  = 0;

      for (const name of OTHER_NAMES) {
        let temp = 0;
        for (const [date, qty] of Object.entries(dMap[name] || {})) {
          if (date >= startDateStr && date <= endDateStr) temp += qty;
        }
        const rate  = otherCommMap[name] || 0;
        const total = Math.round(temp * rate);
        totalCylOther  += temp;
        fullTotalOther += total;

        otherRows.push({
          srNo:         srOther,
          name:         name === 'RAHUL' ? 'PRAMOD' : name,
          cylinders:    temp,
          commisionRate: rate,
          total,
        });
        srOther++;
      }

      weeks.push({
        saturday,
        startDateStr,
        endDateStr,
        paymentDate,
        mainRows,
        mainTotals,
        otherRows,
        otherTotals: { cylinder: totalCylOther, total: fullTotalOther },
      });
    }

    return weeks;
  }, [startDate, endDate]);

  // ── Preview ───────────────────────────────────────────────────────────────

  const handlePreview = async () => {
    try {
      setLoadingPreview(true);
      const weeks = await buildAllWeeks();
      setPreviewWeeks(weeks);
      setHasPreview(true);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load preview.');
    } finally {
      setLoadingPreview(false);
    }
  };

  // ── PDF Builders ──────────────────────────────────────────────────────────

  function buildMainSalaryHtml(weeks: WeekData[]): string {
    // Split each week's rows into two roughly equal halves so every week prints
    // across 2 physical pages with taller rows and real room to sign.
    function renderTable(rows: MainRow[], totals: WeekData['mainTotals'] | null): string {
      const dataRows = rows.map((r, i) => `
        <tr style="background:${i % 2 === 0 ? '#f5f9ff' : '#fff'}">
          <td>${r.srNo}</td>
          <td class="name-col">${r.fullName}</td>
          <td>${r.cylinders}</td>
          <td>${r.commisionRate}</td>
          <td>${Math.round(r.total)}</td>
          <td>${Math.round(r.pfOnAmount)}</td>
          <td>${r.pfContribution.toFixed(2)}</td>
          <td>${r.esic}</td>
          <td>${r.netAmount}</td>
          <td class="sig-col"></td>
        </tr>`).join('');

      const totalsRow = totals ? `
              <tr class="totals-row">
                <td></td>
                <td class="name-col"><b>TOTAL</b></td>
                <td><b>${totals.cylinder}</b></td>
                <td></td>
                <td><b>${totals.commision}</b></td>
                <td><b>${totals.pfOnAmount}</b></td>
                <td><b>${totals.pfDeduction}</b></td>
                <td><b>${totals.esic}</b></td>
                <td><b>${totals.net}</b></td>
                <td></td>
              </tr>` : '';

      return `
          <table>
            <thead>
              <tr>
                <th style="width:36px">SR NO</th>
                <th class="name-col">NAME</th>
                <th>CYLINDER QTY</th>
                <th>PER CYL COMMISSION</th>
                <th>TOTAL</th>
                <th>PF ON AMOUNT</th>
                <th>PF CONTRIBUTION</th>
                <th>ESIC CONTRIBUTION</th>
                <th>NET AMOUNT</th>
                <th class="sig-col">SIGNATURE</th>
              </tr>
            </thead>
            <tbody>
              ${dataRows}${totalsRow}
            </tbody>
          </table>`;
    }

    function renderPageHeader(week: WeekData, pageLabel: string): string {
      return `
          <div class="company-header">SHREEJEE GAS SERVICE</div>
          <div class="date-header">
            <span>FROM ${fmtDisplay(week.startDateStr)} TO ${fmtDisplay(week.endDateStr)}</span>
            <span>DATE OF PAYMENT: ${week.paymentDate}</span>
            <span>${pageLabel}</span>
          </div>`;
    }

    const weekSections = weeks.map(week => {
      const rows = week.mainRows;
      const mid = Math.ceil(rows.length / 2);
      const page1Rows = rows.slice(0, mid);
      const page2Rows = rows.slice(mid);

      const page1 = `
        <div class="week-block">
          ${renderPageHeader(week, 'PAGE 1 OF 2')}
          ${renderTable(page1Rows, null)}
        </div>`;

      const page2 = `
        <div class="week-block">
          ${renderPageHeader(week, 'PAGE 2 OF 2')}
          ${renderTable(page2Rows, week.mainTotals)}
        </div>`;

      return page1 + '<div class="page-break"></div>' + page2;
    }).join('<div class="page-break"></div>');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4 landscape; margin: 10mm 8mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #000; }

  .company-header {
    background: #1a3c5e;
    color: #fff;
    text-align: center;
    font-size: 14pt;
    font-weight: bold;
    padding: 10px;
    letter-spacing: 0.5px;
  }
  .date-header {
    background: #2e6da4;
    color: #fff;
    display: flex;
    justify-content: space-between;
    padding: 6px 14px;
    font-size: 10pt;
    font-weight: bold;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    page-break-inside: auto;
  }
  thead { display: table-header-group; }
  tr    { page-break-inside: avoid; }

  th, td {
    border: 1px solid #aac4e0;
    padding: 14px 6px;
    text-align: center;
    vertical-align: middle;
    font-size: 9.5pt;
  }
  th {
    background: #d0e4f7;
    font-weight: bold;
    color: #1a3c5e;
    font-size: 9pt;
    padding: 8px 6px;
  }
  td.name-col   { text-align: left; min-width: 160px; }
  td.sig-col    { min-width: 110px; height: 55px; }

  .totals-row td {
    background: #e8f4e8;
    font-weight: bold;
    border-top: 2px solid #1a3c5e;
  }

  .page-break  { page-break-before: always; }
  .week-block  { }
</style>
</head>
<body>
${weekSections}
</body>
</html>`;
  }

  function buildOtherSalaryHtml(weeks: WeekData[]): string {
    const weekSections = weeks.map(week => {
      const dataRows = week.otherRows.map((r, i) => `
        <tr style="background:${i % 2 === 0 ? '#f5f9ff' : '#fff'}">
          <td>${r.srNo}</td>
          <td class="name-col">${r.name}</td>
          <td>${r.cylinders}</td>
          <td>${r.commisionRate}</td>
          <td>${r.total}</td>
        </tr>`).join('');

      const t = week.otherTotals;
      return `
        <div class="week-block">
          <div class="company-header">SHREEJEE GAS SERVICE</div>
          <div class="date-header">
            <span>FROM ${fmtDisplay(week.startDateStr)} TO ${fmtDisplay(week.endDateStr)}</span>
            <span>DATE OF PAYMENT: ${week.paymentDate}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width:50px">SR NO</th>
                <th class="name-col">NAME</th>
                <th>CYLINDER QTY</th>
                <th>COMMISSION RATE</th>
                <th>TOTAL</th>
              </tr>
            </thead>
            <tbody>
              ${dataRows}
              <tr class="totals-row">
                <td></td>
                <td class="name-col"><b>TOTAL</b></td>
                <td><b>${t.cylinder}</b></td>
                <td></td>
                <td><b>${t.total}</b></td>
              </tr>
            </tbody>
          </table>
        </div>`;
    }).join('<div class="page-break"></div>');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 12mm 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 9pt; color: #000; }

  .company-header {
    background: #1a4a1a;
    color: #fff;
    text-align: center;
    font-size: 13pt;
    font-weight: bold;
    padding: 8px;
    letter-spacing: 0.5px;
  }
  .date-header {
    background: #2e7d32;
    color: #fff;
    display: flex;
    justify-content: space-between;
    padding: 5px 12px;
    font-size: 9pt;
    font-weight: bold;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }
  thead { display: table-header-group; }
  tr    { page-break-inside: avoid; }

  th, td {
    border: 1px solid #a5d6a7;
    padding: 6px 5px;
    text-align: center;
    vertical-align: middle;
  }
  th {
    background: #c8e6c9;
    font-weight: bold;
    color: #1a4a1a;
  }
  td.name-col { text-align: left; min-width: 130px; }

  .totals-row td {
    background: #e8f5e9;
    font-weight: bold;
    border-top: 2px solid #1a4a1a;
  }
  .page-break { page-break-before: always; }
</style>
</head>
<body>
${weekSections}
</body>
</html>`;
  }

  // ── Download Handlers ─────────────────────────────────────────────────────

  const handleDownloadMain = async () => {
    try {
      setLoadingMain(true);
      const weeks = await buildAllWeeks();
      const html  = buildMainSalaryHtml(weeks);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Weekly Salary Sheet',
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingMain(false);
    }
  };

  const handleDownloadOther = async () => {
    try {
      setLoadingOther(true);
      const weeks = await buildAllWeeks();
      const html  = buildOtherSalaryHtml(weeks);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Weekly Salary Other',
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', `PDF saved to:\n${uri}`);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate PDF.');
    } finally {
      setLoadingOther(false);
    }
  };

  const isAnyLoading = loadingPreview || loadingMain || loadingOther;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Ionicons name="cash-outline" size={28} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Weekly Salary</Text>
            <Text style={styles.headerSub}>SHREEJEE GAS SERVICE</Text>
          </View>
        </View>

        {/* Date Input Card */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>DATE RANGE</Text>

          <Text style={styles.fieldLabel}>Start Date</Text>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={() => setShowStart(true)}
            disabled={isAnyLoading}
          >
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

          <Text style={[styles.fieldLabel, { marginTop: 14 }]}>End Date</Text>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={() => setShowEnd(true)}
            disabled={isAnyLoading}
          >
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
        </View>

        {/* Info badges */}
        <View style={styles.infoRow}>
          <View style={styles.infoBadge}>
            <Ionicons name="people-outline" size={13} color={BPCL_BLUE} />
            <Text style={styles.infoBadgeText}>PF + ESIC Calculated</Text>
          </View>
          <View style={styles.infoBadge}>
            <Ionicons name="shield-checkmark-outline" size={13} color={BPCL_BLUE} />
            <Text style={styles.infoBadgeText}>₹15,000 PF Cap</Text>
          </View>
          <View style={styles.infoBadge}>
            <Ionicons name="repeat-outline" size={13} color={BPCL_BLUE} />
            <Text style={styles.infoBadgeText}>Namdev 14KG + 19KG Split</Text>
          </View>
        </View>

        {/* Preview Button */}
        <TouchableOpacity
          style={[styles.btnPreview, isAnyLoading && styles.btnDisabled]}
          onPress={handlePreview}
          disabled={isAnyLoading}
          activeOpacity={0.8}
        >
          {loadingPreview
            ? <ActivityIndicator color="#fff" size="small" />
            : <><Ionicons name="eye-outline" size={18} color="#fff" /><Text style={styles.btnText}>Preview Data</Text></>
          }
        </TouchableOpacity>

        {/* PDF Download Buttons */}
        <View style={styles.buttonRow}>
          {/* Main Salary PDF */}
          <TouchableOpacity
            style={[styles.btnMain, isAnyLoading && styles.btnDisabled]}
            onPress={handleDownloadMain}
            disabled={isAnyLoading}
            activeOpacity={0.8}
          >
            {loadingMain
              ? <ActivityIndicator color="#fff" size="small" />
              : <>
                  <Ionicons name="document-outline" size={18} color="#fff" />
                  <View>
                    <Text style={styles.btnText}>Weekly Salary PDF</Text>
                    <Text style={styles.btnSubText}>PF Employees · Landscape</Text>
                  </View>
                </>
            }
          </TouchableOpacity>

          {/* Other Salary PDF */}
          <TouchableOpacity
            style={[styles.btnOther, isAnyLoading && styles.btnDisabled]}
            onPress={handleDownloadOther}
            disabled={isAnyLoading}
            activeOpacity={0.8}
          >
            {loadingOther
              ? <ActivityIndicator color="#fff" size="small" />
              : <>
                  <Ionicons name="document-outline" size={18} color="#fff" />
                  <View>
                    <Text style={styles.btnText}>Other Salary PDF</Text>
                    <Text style={styles.btnSubText}>Sailesh, Bante &amp; others</Text>
                  </View>
                </>
            }
          </TouchableOpacity>
        </View>

        {/* ── Preview Section ───────────────────────────────────────────────── */}
        {hasPreview && previewWeeks.map((week, wi) => (
          <View key={wi} style={styles.card}>
            {/* Week header */}
            <View style={styles.weekHeader}>
              <Text style={styles.weekHeaderText}>
                {fmtDisplay(week.startDateStr)} → {fmtDisplay(week.endDateStr)}
              </Text>
              <Text style={styles.weekPayText}>Payment: {week.paymentDate}</Text>
            </View>

            <Text style={[styles.sectionLabel, { marginTop: 12 }]}>MAIN SALARY</Text>

            {/* Horizontally scrollable table */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                {/* Table header */}
                <View style={styles.tRow}>
                  {['SR', 'NAME', 'CYL', 'RATE', 'TOTAL', 'PF BASE', 'PF', 'ESIC', 'NET'].map((h, i) => (
                    <View key={i} style={[styles.tCell, styles.tHeader, i === 1 && styles.tNameCell]}>
                      <Text style={styles.tHeaderTxt}>{h}</Text>
                    </View>
                  ))}
                </View>

                {/* Data rows */}
                {week.mainRows.map((r, ri) => (
                  <View key={ri} style={[styles.tRow, ri % 2 === 0 && styles.tAltRow]}>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{r.srNo}</Text></View>
                    <View style={[styles.tCell, styles.tNameCell]}><Text style={styles.tTxt}>{r.fullName}</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{r.cylinders}</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{r.commisionRate}</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{Math.round(r.total)}</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{Math.round(r.pfOnAmount)}</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{r.pfContribution.toFixed(1)}</Text></View>
                    <View style={styles.tCell}><Text style={styles.tTxt}>{r.esic}</Text></View>
                    <View style={styles.tCell}><Text style={[styles.tTxt, styles.tBold]}>{r.netAmount}</Text></View>
                  </View>
                ))}

                {/* Totals */}
                <View style={[styles.tRow, styles.tTotalRow]}>
                  <View style={styles.tCell}><Text style={styles.tBold}></Text></View>
                  <View style={[styles.tCell, styles.tNameCell]}><Text style={styles.tBold}>TOTAL</Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}>{week.mainTotals.cylinder}</Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}></Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}>{week.mainTotals.commision}</Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}>{week.mainTotals.pfOnAmount}</Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}>{week.mainTotals.pfDeduction}</Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}>{week.mainTotals.esic}</Text></View>
                  <View style={styles.tCell}><Text style={styles.tBold}>{week.mainTotals.net}</Text></View>
                </View>
              </View>
            </ScrollView>

            {/* Other salary mini table */}
            <Text style={[styles.sectionLabel, { marginTop: 16 }]}>OTHER SALARY</Text>
            {week.otherRows.map((r, ri) => (
              <View key={ri} style={styles.otherRow}>
                <Text style={styles.otherName}>{r.name}</Text>
                <Text style={styles.otherDetail}>{r.cylinders} cyl × {r.commisionRate}</Text>
                <Text style={styles.otherTotal}>₹{r.total}</Text>
              </View>
            ))}
            <View style={styles.otherTotalRow}>
              <Text style={styles.otherTotalLabel}>TOTAL</Text>
              <Text style={styles.otherTotalValue}>₹{week.otherTotals.total}</Text>
            </View>
          </View>
        ))}

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  scroll:    { padding: 16, paddingBottom: 48 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: BPCL_BLUE,
    borderRadius: 16,
    padding: 20,
    marginBottom: 14,
    elevation: 4,
    shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  headerSub:   { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },

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
    fontSize: 11, fontWeight: '700', color: '#aaa',
    letterSpacing: 1.1, marginBottom: 10,
  },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 6 },

  dateButton: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, backgroundColor: '#fafafa',
  },
  dateButtonText: { fontSize: 15, color: '#333', fontWeight: '500' },

  // Info badges
  infoRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  infoBadge:    {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#e3f2fd', borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  infoBadgeText: { fontSize: 11, color: BPCL_BLUE, fontWeight: '600' },

  // Buttons
  btnPreview: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: 14, paddingVertical: 14, marginBottom: 12,
    backgroundColor: '#27ae60',
    elevation: 3, shadowColor: '#27ae60',
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6,
  },
  buttonRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  btnMain: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: 14, paddingVertical: 14,
    backgroundColor: BPCL_BLUE,
    elevation: 3, shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6,
  },
  btnOther: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: 14, paddingVertical: 14,
    backgroundColor: GREEN_DARK,
    elevation: 3, shadowColor: GREEN_DARK,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6,
  },
  btnDisabled: { opacity: 0.55 },
  btnText:     { fontSize: 13, fontWeight: '700', color: '#fff' },
  btnSubText:  { fontSize: 10, color: 'rgba(255,255,255,0.75)', marginTop: 1 },

  // Week header
  weekHeader: {
    backgroundColor: '#1a3c5e',
    borderRadius: 10,
    padding: 12,
    marginBottom: 4,
  },
  weekHeaderText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  weekPayText:    { fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 3 },

  // Preview table
  tRow:       { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e8e8e8' },
  tHeader:    { backgroundColor: '#d0e4f7' },
  tTotalRow:  { backgroundColor: '#e8f4e8', borderTopWidth: 2, borderTopColor: '#1a3c5e' },
  tAltRow:    { backgroundColor: '#f5f9ff' },
  tCell: {
    width: 68, paddingVertical: 7, paddingHorizontal: 4,
    justifyContent: 'center', alignItems: 'center',
    borderRightWidth: 1, borderRightColor: '#eee',
  },
  tNameCell:  { width: 160, alignItems: 'flex-start' },
  tHeaderTxt: { fontSize: 9, fontWeight: '700', color: '#1a3c5e', textAlign: 'center' },
  tTxt:       { fontSize: 9.5, color: '#444', textAlign: 'center' },
  tBold:      { fontWeight: '700', color: '#111' },

  // Other salary preview
  otherRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  otherName:   { flex: 1, fontSize: 13, color: '#333', fontWeight: '600' },
  otherDetail: { fontSize: 12, color: '#888', marginRight: 12 },
  otherTotal:  { fontSize: 13, fontWeight: '700', color: '#1a6b2a', minWidth: 60, textAlign: 'right' },
  otherTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 2,
    borderTopWidth: 2, borderTopColor: '#1a6b2a',
    marginTop: 2, backgroundColor: '#e8f5e9', borderRadius: 6,
  },
  otherTotalLabel: { fontSize: 13, fontWeight: '800', color: '#1a4a1a' },
  otherTotalValue: { fontSize: 14, fontWeight: '800', color: '#1a4a1a' },
});
