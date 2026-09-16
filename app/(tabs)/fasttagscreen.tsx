import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { cacheDirectory, readAsStringAsync, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx-js-style';

const BPCL_BLUE = '#017DC5';

interface FastagTransaction {
  time: string;
  parsedDate: Date;
  nature: string;
  amount: number;
  closingBalance: string;
  description: string;
  truckNo: string;
  transactionId: string;
  tripDirection: string;
  invoiceNo: string;
  invoiceDate: string;
}

interface SapInvoice {
  vehicleNo: string;
  invoiceNo: string;
  invoiceDateStr: string;
  parsedDateTime: Date;
}

type FastagProvider = 'blackbuck' | 'airtel';

const FASTAG_PROVIDER_OPTIONS: { value: FastagProvider; label: string }[] = [
  { value: 'blackbuck', label: 'Blackbuck Fastag' },
  { value: 'airtel', label: 'Airtel Fastag' },
];

// Column-name aliases per provider. Header detection and column mapping in
// handleFastagUpload use these lists (as lowercase substrings) instead of
// hard-coded labels, so the two very differently-labelled statement formats
// can share the same parsing pipeline.
//   Blackbuck: Date | Time | Nature (C/D)      | Amount              | Description | Truck No       | Transaction ID
//   Airtel:    Travel Date Time (combined)     | Activity            | Amount (INR)(DR) | Plaza Name | Vehicle Number | Unique Transaction Number
const PROVIDER_CONFIG: Record<FastagProvider, {
  natureAliases: string[];      // column indicating debit/credit nature
  amountAliases: string[];      // debit amount column
  descAliases: string[];        // toll plaza / description column
  truckAliases: string[];       // vehicle / truck number column
  dateAliases: string[];        // date (or combined date+time) column
  timeAliases: string[];        // separate time column, if any
  closingBalAliases: string[];  // closing balance column
  txIdAliases: string[];        // transaction id column
  combinedDateTime: boolean;    // true when date+time live in a single column
}> = {
  blackbuck: {
    natureAliases: ['nature', 'c/d'],
    amountAliases: ['amount'],
    descAliases: ['description'],
    truckAliases: ['truck', 'vehicle'],
    dateAliases: ['date'],
    timeAliases: ['time'],
    closingBalAliases: ['closing', 'balance'],
    txIdAliases: ['transaction id', 'tx id'],
    combinedDateTime: false,
  },
  airtel: {
    natureAliases: ['activity'],
    amountAliases: ['amount (inr)(dr)', 'amount(inr)(dr)', 'amount inr dr', 'amount (dr)'],
    descAliases: ['plaza name', 'plaza'],
    truckAliases: ['vehicle number', 'vehicle'],
    dateAliases: ['travel date time', 'travel date'],
    timeAliases: [],
    closingBalAliases: ['tag closing balance', 'closing balance', 'closing'],
    txIdAliases: ['unique transaction number', 'transaction number'],
    combinedDateTime: true,
  },
};

export default function FastagReimbursementScreen() {
  const [loading, setLoading] = useState(false);
  const [fastagUploaded, setFastagUploaded] = useState(false);
  const [sapUploaded, setSapUploaded] = useState(false);
  const [fastagProvider, setFastagProvider] = useState<FastagProvider>('blackbuck');
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);

  const [transactions, setTransactions] = useState<FastagTransaction[]>([]);
  const [sapInvoices, setSapInvoices] = useState<SapInvoice[]>([]);
  const [truckGroups, setTruckGroups] = useState<{ [key: string]: FastagTransaction[] }>({});

  const cleanVal = (val: any): string => {
    if (val === null || val === undefined) return '';
    return val.toString().trim();
  };

  const normalizeVehicleNo = (val: string): string => {
    return cleanVal(val).toUpperCase().replace(/[^A-Z0-9]/g, '');
  };

  // Converts a rupee amount to words in the Indian numbering system
  // (thousand / lakh / crore), e.g. 45125 -> "FORTY FIVE THOUSAND ONE
  // HUNDRED TWENTY FIVE RUPEES ONLY" — matching the wording style used on
  // the bill template.
  const numberToWordsIndian = (num: number): string => {
    const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
      'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
    const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

    const twoDigits = (n: number): string => {
      if (n < 20) return ones[n];
      return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    };

    const threeDigits = (n: number): string => {
      if (n < 100) return twoDigits(n);
      return ones[Math.floor(n / 100)] + ' HUNDRED' + (n % 100 ? ' ' + twoDigits(n % 100) : '');
    };

    const rupees = Math.floor(num);
    const paise = Math.round((num - rupees) * 100);

    if (rupees === 0 && paise === 0) return 'ZERO RUPEES ONLY';

    let n = rupees;
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    const hundred = n;

    const parts: string[] = [];
    if (crore) parts.push(threeDigits(crore) + ' CRORE');
    if (lakh) parts.push(threeDigits(lakh) + ' LAKH');
    if (thousand) parts.push(threeDigits(thousand) + ' THOUSAND');
    if (hundred) parts.push(threeDigits(hundred));

    let words = (parts.length > 0 ? parts.join(' ') : 'ZERO') + ' RUPEES';
    if (paise > 0) {
      words += ' AND ' + twoDigits(paise) + ' PAISE';
    }
    words += ' ONLY';
    return words;
  };

  const formatDDMMYYYY = (d: Date): string => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}-${mm}-${d.getFullYear()}`;
  };

  // Strips HTML tags/entities down to plain text for a single cell's contents.
  const stripTags = (s: string): string =>
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();

  // Some exports (notably SAP web-portal downloads) are saved with a ".xls"
  // extension but are actually raw HTML tables — and some of those are
  // malformed HTML where every data row is missing its opening <tr> tag
  // (only the header row and the closing </tr> of each row are present).
  // XLSX.read() cannot parse that correctly: it silently collapses the
  // whole table into a single row, which means zero data rows are ever
  // read. This parser works directly off the HTML text and only relies on
  // matching <td>/<th> ... </td>/<th> pairs, so it recovers every row
  // correctly even when the opening <tr> tags are missing.
  const parseHtmlTableToRows = (htmlText: string): string[][] => {
    const tableMatch = htmlText.match(/<table[\s\S]*?>([\s\S]*)<\/table>/i);
    const tableBody = tableMatch ? tableMatch[1] : htmlText;

    // Splitting on </tr> reconstructs row boundaries correctly even when
    // the matching opening <tr> tag for that row is missing.
    const rowChunks = tableBody.split(/<\/tr>/i);

    const rows: string[][] = [];
    rowChunks.forEach((chunk) => {
      const cellMatches = chunk.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
      if (!cellMatches || cellMatches.length === 0) return;

      const cells = cellMatches.map((cellHtml) => {
        const inner = cellHtml.replace(/^<t[dh][^>]*>/i, '').replace(/<\/t[dh]>$/i, '');
        return stripTags(inner);
      });

      rows.push(cells);
    });

    return rows;
  };

  // Reads a picked file and returns:
  //  - rows: display-formatted cell text (existing behavior — used for
  //    header detection and every non-date column).
  //  - rawRows: the same shape, but with cellDates enabled and raw values
  //    (so genuine Excel date/time cells come back as real JS Date objects
  //    instead of text). This matters because SheetJS's raw:false path
  //    renders dates using its own built-in default format ("m/d/yy", a
  //    US-style layout) whenever the source file doesn't carry an explicit
  //    custom number format — regardless of the workbook's actual locale.
  //    That silently turns e.g. 28-02-26 into "2/28/26" in the formatted
  //    text. Using rawRows for date columns sidesteps that entirely.
  // For HTML-table exports there's no SheetJS type conversion involved at
  // all (everything is scraped as plain text), so rawRows === rows there.
  const readSpreadsheetRows = async (
    fileUri: string,
    label: string
  ): Promise<{ rows: string[][]; rawRows: any[][] }> => {
    const rawText = await readAsStringAsync(fileUri, { encoding: EncodingType.UTF8 });
    const peek = rawText.slice(0, 3000);
    const looksLikeHtml = /<table[\s>]/i.test(peek) || /<html[\s>]/i.test(peek);

    if (looksLikeHtml) {
      const rows = parseHtmlTableToRows(rawText);
      console.log(`[${label}] Detected HTML-formatted file (not a real binary spreadsheet). Recovered ${rows.length} row(s) via HTML parser.`);
      if (rows.length > 0) {
        console.log(`[${label}] Header row: ${JSON.stringify(rows[0])}`);
      }
      return { rows, rawRows: rows };
    }

    const base64Content = await readAsStringAsync(fileUri, { encoding: EncodingType.Base64 });
    const workbook = XLSX.read(base64Content, { type: 'base64', cellDates: true });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false }) as string[][];
    const rawRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: true }) as any[][];
    console.log(`[${label}] Detected binary spreadsheet (${workbook.SheetNames[0]}). Read ${rows.length} row(s) via XLSX parser.`);
    return { rows, rawRows };
  };

  // Formats a Date as "DD/MM/YY HH:MM" (24-hour clock) — the unambiguous
  // display format used for Fastag transaction timestamps in the exported
  // sheets, independent of whatever format the source file's date column
  // happened to use.
  const formatDDMMYYTime = (d: Date): string => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yy} ${HH}:${MM}`;
  };

  // Parses space-separated/hyphenated dates and normalizes spaced AM/PM (e.g. 'P M' -> 'PM')
  const parseDateTime = (dateInput: any, timeInput?: any): Date => {
    try {
      if (dateInput instanceof Date) return dateInput;
      let dateStr = cleanVal(dateInput);
      let timeStr = timeInput ? cleanVal(timeInput) : '';

      // Normalize spaces and convert spaced AM/PM (e.g., "P M" / "A M" to "PM" / "AM")
      dateStr = dateStr.replace(/\s+/g, ' ').replace(/([apAP])\s+([mM])/g, '$1$2').trim();
      timeStr = timeStr.replace(/\s+/g, ' ').replace(/([apAP])\s+([mM])/g, '$1$2').trim();

      // Handle space-separated date formats (e.g., '09 Jul 26 06:11 PM')
      const spaceParts = dateStr.split(/\s+/);
      if (spaceParts.length >= 3 && isNaN(Number(dateStr))) {
        let day = parseInt(spaceParts[0], 10);
        let monthStr = spaceParts[1].toLowerCase().slice(0, 3);
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        let month = months.indexOf(monthStr);
        if (month === -1) month = 0;

        let year = parseInt(spaceParts[2], 10);
        if (year < 100) year += 2000;

        let d = new Date(year, month, day);

        if (!timeStr && spaceParts.length >= 4) {
          timeStr = spaceParts.slice(3).join(' ');
        }

        if (timeStr) {
          const ampmMatch = timeStr.match(/(am|pm)/i);
          const isPM = ampmMatch && ampmMatch[0].toLowerCase() === 'pm';
          const cleanTime = timeStr.replace(/(am|pm)/i, '').trim();
          const timeParts = cleanTime.split(':');

          if (timeParts.length >= 2) {
            let hours = parseInt(timeParts[0], 10);
            const minutes = parseInt(timeParts[1], 10);
            const seconds = timeParts[2] ? parseInt(timeParts[2], 10) : 0;

            if (isPM && hours < 12) hours += 12;
            if (!isPM && hours === 12) hours = 0;

            d.setHours(hours, minutes, seconds, 0);
          }
        }
        return d;
      }

      // Fallback for hyphenated format (e.g., '03-Jul-26')
      let d = new Date(dateStr);
      if (isNaN(d.getTime())) {
        const parts = dateStr.split(/[-/.]/);
        if (parts.length === 3) {
          let day = parseInt(parts[0], 10);
          let monthStr = parts[1].toLowerCase().slice(0, 3);

          const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
          let month = months.indexOf(monthStr);
          if (month === -1) {
            month = parseInt(parts[1], 10) - 1;
          }

          let year = parseInt(parts[2], 10);
          if (year < 100) year += 2000;
          d = new Date(year, month, day);
        }
      }

      if (timeStr) {
        const ampmMatch = timeStr.match(/(am|pm)/i);
        const isPM = ampmMatch && ampmMatch[0].toLowerCase() === 'pm';
        const cleanTime = timeStr.replace(/(am|pm)/i, '').trim();
        const timeParts = cleanTime.split(':');

        if (timeParts.length >= 2) {
          let hours = parseInt(timeParts[0], 10);
          const minutes = parseInt(timeParts[1], 10);
          const seconds = timeParts[2] ? parseInt(timeParts[2], 10) : 0;

          if (isPM && hours < 12) hours += 12;
          if (!isPM && hours === 12) hours = 0;

          d.setHours(hours, minutes, seconds, 0);
        }
      }
      return d;
    } catch {
      return new Date();
    }
  };

  // Finds the index of the first cell in a (lowercased) header row whose text
  // contains any of the given alias substrings, checked in order — so more
  // specific aliases can be listed first.
  const findColByAliases = (headerRowLower: string[], aliases: string[]): number => {
    for (const alias of aliases) {
      const idx = headerRowLower.findIndex((c) => c.includes(alias));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  // Airtel's "Travel Date Time" column packs the date and time into one
  // string, e.g. "28-02-26 9:49". Splits it into separate date/time parts
  // so the existing parseDateTime(dateInput, timeInput) logic can be reused
  // unchanged.
  const splitCombinedDateTime = (raw: string): { datePart: string; timePart: string } => {
    const trimmed = cleanVal(raw);
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return { datePart: trimmed, timePart: '' };
    return { datePart: trimmed.slice(0, spaceIdx), timePart: trimmed.slice(spaceIdx + 1) };
  };

  // 1. FASTAG STATEMENT PARSING
  const handleFastagUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv'
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      setLoading(true);
      const fileUri = result.assets[0].uri;

      // Handles both genuine binary .xlsx/.xls files and HTML tables saved
      // with a spreadsheet extension (a common export quirk). rawRows
      // carries real Date objects for genuine date-typed cells so we don't
      // have to trust SheetJS's (locale-ambiguous) formatted text for dates.
      const { rows, rawRows } = await readSpreadsheetRows(fileUri, 'FASTAG');

      if (rows.length === 0) {
        Alert.alert('Error', 'Fastag statement appears to be empty.');
        setLoading(false);
        return;
      }

      const config = PROVIDER_CONFIG[fastagProvider];

      let headerRowIdx = -1;
      let natureIdx = -1, amtIdx = -1, descIdx = -1, truckIdx = -1, dateIdx = -1, timeIdx = -1, closeBalIdx = -1, txIdIdx = -1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i].map((c: any) => cleanVal(c).toLowerCase());

        const hasAmount = findColByAliases(row, config.amountAliases) !== -1;
        const hasAnchor =
          findColByAliases(row, config.truckAliases) !== -1 ||
          findColByAliases(row, config.natureAliases) !== -1 ||
          findColByAliases(row, config.descAliases) !== -1;

        if (hasAmount && hasAnchor) {
          headerRowIdx = i;
          natureIdx = findColByAliases(row, config.natureAliases);
          amtIdx = findColByAliases(row, config.amountAliases);
          descIdx = findColByAliases(row, config.descAliases);
          truckIdx = findColByAliases(row, config.truckAliases);

          // Identify Date & Time columns. For combined date+time providers
          // (e.g. Airtel's "Travel Date Time") there is no separate time
          // column — the single date column carries both.
          dateIdx = findColByAliases(row, config.dateAliases);
          timeIdx = config.combinedDateTime ? -1 : findColByAliases(row, config.timeAliases);

          if (dateIdx === -1 && timeIdx !== -1) {
            dateIdx = timeIdx;
          }

          // "closing" is checked first and exclusively before falling back
          // to a generic "balance" alias, so e.g. "Opening Balance" never
          // gets matched ahead of "Closing Balance" / "Tag Closing Balance".
          closeBalIdx = findColByAliases(row, config.closingBalAliases);

          txIdIdx = findColByAliases(row, config.txIdAliases);

          console.log(`[FASTAG:${fastagProvider}] Header row ${i} -> nature:${natureIdx} amount:${amtIdx} desc:${descIdx} truck:${truckIdx} date:${dateIdx} time:${timeIdx} closingBal:${closeBalIdx} txId:${txIdIdx}`);
          break;
        }
      }

      if (headerRowIdx === -1) {
        if (fastagProvider === 'airtel') {
          // Fixed fallback matching the sample Airtel column order: Vehicle
          // Number, Tag ID, Travel Date Time, Processed Date Time, Category,
          // Activity, Toll Transaction Mode, Lane, Plaza ID, Plaza Name,
          // Unique Transaction Number, Amount(CR), Amount(DR), Tag Closing Balance.
          truckIdx = 0; dateIdx = 2; timeIdx = -1; natureIdx = 5; descIdx = 9;
          txIdIdx = 10; amtIdx = 12; closeBalIdx = 13;
        } else {
          natureIdx = 1; amtIdx = 2; closeBalIdx = 3; descIdx = 4; truckIdx = 5; txIdIdx = 6; dateIdx = 0; timeIdx = -1;
        }
        headerRowIdx = 5;
      }

      const parsed: FastagTransaction[] = [];
      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 3) continue;

        const nature = cleanVal(row[natureIdx]).toUpperCase();
        const description = cleanVal(row[descIdx]);
        const truckNo = normalizeVehicleNo(row[truckIdx]);
        const rawAmount = cleanVal(row[amtIdx]);

        // Both providers' debit-indicating text contains "DEBIT" —
        // Blackbuck uses "DEBIT"/"D", Airtel uses "Toll Debit" (Activity
        // column). Airtel's credit rows ("Credit to tag from...") and
        // Recharge rows naturally fail this check and are excluded, and
        // their DR amount column is blank anyway.
        const isDebit = nature.includes('DEBIT') || nature === 'D';
        const isNashirabad = description.toLowerCase().includes('nashirabad');

        if (isDebit && !isNashirabad && rawAmount && truckNo) {
          const amount = parseFloat(rawAmount.replace(/[^0-9.]/g, '')) || 0;

          // Prefer the raw cell value (rawRows) when it's an actual Date
          // object — that only happens for genuine Excel date-typed cells,
          // and sidesteps SheetJS's locale-ambiguous formatted text (its
          // raw:false default date format is "m/d/yy", US-style, regardless
          // of the source file's actual day/month order).
          const rawCellVal = rawRows[i] ? rawRows[i][dateIdx] : undefined;

          let parsedDate: Date;
          let displayTime: string;

          if (rawCellVal instanceof Date) {
            parsedDate = rawCellVal;
            displayTime = config.combinedDateTime
              ? formatDDMMYYTime(parsedDate)
              : cleanVal(row[dateIdx]) + ((timeIdx !== -1 && timeIdx !== dateIdx) ? ' ' + cleanVal(row[timeIdx]) : '');
          } else if (config.combinedDateTime) {
            // e.g. Airtel's "Travel Date Time" text = "28-02-26 9:49" —
            // split into date/time parts so parseDateTime can reuse its
            // existing hyphenated-date + HH:MM logic unchanged.
            const { datePart, timePart } = splitCombinedDateTime(row[dateIdx]);
            parsedDate = parseDateTime(datePart, timePart);
            displayTime = formatDDMMYYTime(parsedDate);
          } else {
            const rawTimeVal = (timeIdx !== -1 && timeIdx !== dateIdx) ? row[timeIdx] : undefined;
            parsedDate = parseDateTime(row[dateIdx], rawTimeVal);
            displayTime = cleanVal(row[dateIdx]) + (rawTimeVal ? ' ' + cleanVal(rawTimeVal) : '');
          }

          parsed.push({
            time: displayTime,
            parsedDate,
            nature: 'Debit',
            amount,
            closingBalance: cleanVal(row[closeBalIdx]),
            description,
            truckNo,
            transactionId: cleanVal(row[txIdIdx]),
            tripDirection: '-',
            invoiceNo: '-',
            invoiceDate: '-'
          });
        }
      }

      if (parsed.length === 0) {
        Alert.alert('No Records Found', 'No valid Debit entries identified.');
      } else {
        setTransactions(parsed);
        setFastagUploaded(true);

        // Diagnostic: surface the truck numbers found, so a mismatch against
        // the SAP file's vehicle numbers is easy to spot early.
        const uniqueTrucks = Array.from(new Set(parsed.map(p => p.truckNo)));
        console.log(`Fastag: parsed ${parsed.length} debit rows for trucks: ${uniqueTrucks.join(', ')}`);

        processReconciliation(parsed, sapInvoices);
      }
    } catch (error: any) {
      Alert.alert('Fastag Parsing Error', error?.message || 'Could not process Fastag file.');
    } finally {
      setLoading(false);
    }
  };

  // 2. SAP INVOICES PARSING
  const handleSapUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv'
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      setLoading(true);
      const fileUri = result.assets[0].uri;

      // Handles both genuine binary .xlsx/.xls files and HTML tables saved
      // with a spreadsheet extension — SAP web-portal exports are commonly
      // saved this way, and some are malformed HTML where each data row is
      // missing its opening <tr> tag, which silently breaks XLSX.read().
      const { rows } = await readSpreadsheetRows(fileUri, 'SAP');

      let headerIdx = -1;
      let vIdx = -1, invIdx = -1, dateIdx = -1, timeIdx = -1, prodIdx = -1;

      // Broadened keyword match so abbreviated SAP column names (e.g. "Inv No",
      // "Bill.Doc", "Doc No") are still recognised as the invoice-number column.
      // Previously only the literal words "invoice" / "billing document" matched,
      // which caused invIdx to silently stay at -1 for many real-world exports.
      const isInvoiceHeader = (c: string) =>
        c.includes('invoice') ||
        c.includes('billing document') ||
        c.includes('bill no') ||
        c.includes('bill.no') ||
        c.includes('bill doc') ||
        c.includes('doc no') ||
        c.includes('doc.no') ||
        c.includes('inv no') ||
        c.includes('inv.no') ||
        (c.includes('inv') && c.includes('no'));

      for (let i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        const row = rows[i].map((c: any) => cleanVal(c).toLowerCase());

        const hasVehicle = row.some((c: string) => c.includes('vehicle'));
        const hasInvoice = row.some(isInvoiceHeader);

        // IMPORTANT FIX: previously this was `hasVehicle && (hasInvoice || hasDate)`,
        // so a row with a "Date" column but NO invoice-labelled column could still be
        // accepted as the header. That left invIdx stuck at -1 forever, meaning every
        // parsed invoiceNo was an empty string and NO invoice ever made it into the
        // matched list - which is exactly the "invoice no/date missing on every truck
        // sheet" symptom. Now both a vehicle AND an invoice column are required.
        if (hasVehicle && hasInvoice) {
          headerIdx = i;
          vIdx = row.findIndex((c: string) => c.includes('vehicle'));
          invIdx = row.findIndex(isInvoiceHeader);
          dateIdx = row.findIndex((c: string) => c.includes('date'));
          timeIdx = row.findIndex((c: string) => c.includes('time'));
          prodIdx = row.findIndex((c: string) => c.includes('product'));
          console.log(`[SAP] Header row ${i} -> vehicle:${vIdx} invoice:${invIdx} date:${dateIdx} time:${timeIdx} product:${prodIdx}`);
          break;
        }
      }

      if (headerIdx === -1) {
        vIdx = 9; invIdx = 4; dateIdx = 2; timeIdx = 3; prodIdx = 6;
        headerIdx = 0;
        console.warn('[SAP] Header row not auto-detected — falling back to fixed column positions (Vehicle=9, Invoice=4, Date=2, Time=3, Product=6). If these are wrong for your file, invoice numbers will be blank.');
      }

      console.log(`[SAP] Scanning data rows ${headerIdx + 1}..${rows.length - 1} (${rows.length - headerIdx - 1} candidate rows)`);

      const tempInvoices: { vehicleNo: string; invoiceNo: string; invoiceDateStr: string; parsedDateTime: Date; isTargetProduct: boolean }[] = [];
      const seenInvoices = new Set<string>();
      const invoices: SapInvoice[] = [];
      let skippedRows = 0;

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) { skippedRows++; continue; }

        const vehicleNo = normalizeVehicleNo(row[vIdx]);
        const invoiceNo = cleanVal(row[invIdx]);
        const product = prodIdx !== -1 ? cleanVal(row[prodIdx]).toLowerCase() : '';

        if (vehicleNo && invoiceNo) {
          // Identify matching billing row for 'LPG 14.2 kg Non-Subsidized Cyl.'
          const isTargetProduct = product.includes('14.2 kg') && product.includes('non-subsidized');

          tempInvoices.push({
            vehicleNo,
            invoiceNo,
            invoiceDateStr: cleanVal(row[dateIdx]),
            parsedDateTime: parseDateTime(row[dateIdx], row[timeIdx]),
            isTargetProduct
          });
        } else {
          skippedRows++;
        }
      }

      console.log(`[SAP] Parsed ${tempInvoices.length} candidate invoice row(s), skipped ${skippedRows} row(s) missing vehicle/invoice values.`);

      // Prioritize primary cylinders matching the exact user specification
      tempInvoices.sort((a, b) => {
        if (a.isTargetProduct && !b.isTargetProduct) return -1;
        if (!a.isTargetProduct && b.isTargetProduct) return 1;
        return 0;
      });

      tempInvoices.forEach((item) => {
        const uniqueKey = `${item.vehicleNo}_${item.invoiceNo}`;
        if (!seenInvoices.has(uniqueKey)) {
          seenInvoices.add(uniqueKey);
          invoices.push({
            vehicleNo: item.vehicleNo,
            invoiceNo: item.invoiceNo,
            invoiceDateStr: item.invoiceDateStr,
            parsedDateTime: item.parsedDateTime
          });
        }
      });

      setSapInvoices(invoices);
      setSapUploaded(true);
      processReconciliation(transactions, invoices);

      // Diagnostic: show exactly what was detected so a mismatch is obvious
      // immediately instead of silently showing "-" in the exported sheet.
      if (invoices.length === 0) {
        Alert.alert(
          'No Invoices Parsed',
          `Header row detected at spreadsheet row ${headerIdx + 1} (Vehicle col: ${vIdx}, Invoice col: ${invIdx}, Date col: ${dateIdx}).\n\nNo rows produced a valid vehicle + invoice pair. Please check that your SAP sheet clearly labels the vehicle and invoice-number columns (e.g. "Vehicle No", "Invoice No").`
        );
      } else {
        const uniqueTrucks = Array.from(new Set(invoices.map(i => i.vehicleNo)));
        Alert.alert(
          'SAP Invoices Loaded',
          `${invoices.length} invoice record(s) parsed for ${uniqueTrucks.length} truck(s): ${uniqueTrucks.join(', ')}.\n\nSample: ${invoices[0].vehicleNo} → ${invoices[0].invoiceNo} (${invoices[0].invoiceDateStr})`
        );
      }
    } catch (error: any) {
      Alert.alert('SAP Parsing Error', error?.message || 'Could not process SAP invoices file.');
    } finally {
      setLoading(false);
    }
  };

  // 3. RECONCILIATION MATCHING (Chronological matching bounded by Dasarkhed crossings)
  const processReconciliation = (fastagList: FastagTransaction[], sapList: SapInvoice[]) => {
    if (fastagList.length === 0) return;

    const fastagClone = fastagList.map(tx => ({ ...tx }));
    const grouped: { [key: string]: FastagTransaction[] } = {};

    fastagClone.forEach((tx) => {
      if (!grouped[tx.truckNo]) grouped[tx.truckNo] = [];
      grouped[tx.truckNo].push(tx);
    });

    // Diagnostic: collect trucks that have Fastag records but zero matching
    // SAP invoices — almost always a vehicle-number formatting mismatch
    // between the two files (extra characters, state code, spacing, etc.)
    const trucksWithNoInvoices: string[] = [];

    Object.keys(grouped).forEach((truckNo) => {
      const list = grouped[truckNo].sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime());
      const truckInvoices = sapList
        .filter(inv => inv.vehicleNo === truckNo)
        .sort((a, b) => a.parsedDateTime.getTime() - b.parsedDateTime.getTime());

      if (sapList.length > 0 && truckInvoices.length === 0) {
        trucksWithNoInvoices.push(truckNo);
      }

      // Route layout: Godown <-> Kurankhed <-> Taroda <-> Dasarkhed <-> Plant.
      // Give each toll a "distance from godown" position: Kurankhed=1,
      // Taroda/Kasba=2, Dasarkhed=3 (closest to the plant). Outward travel
      // climbs 1→2→3; return travel descends 3→2→1. Direction for ANY toll
      // is simply whether the sequence is climbing or descending around it —
      // this reflects the physical route regardless of which end of the
      // cycle a trip is considered to "start" from.
      const tollPosition = (description: string): 1 | 2 | 3 | null => {
        const d = description.toLowerCase();
        if (d.includes('dasarkhed')) return 3;
        if (d.includes('taroda') || d.includes('kasba')) return 2;
        if (d.includes('kurankhed')) return 1;
        return null;
      };

      const positions = list.map(tx => tollPosition(tx.description));
      const directions: ('GODOWN TO PLANT' | 'PLANT TO GODOWN')[] = new Array(list.length);

      for (let i = 0; i < list.length; i++) {
        const p = positions[i];
        if (p === null) { directions[i] = directions[i - 1] || 'GODOWN TO PLANT'; continue; }

        if (i === 0) {
          // No previous toll to compare to — peek forward to the first toll
          // with a different position to see whether we're climbing or
          // descending right from the start of the statement.
          let j = 1;
          while (j < list.length && positions[j] === p) j++;
          if (j < list.length && positions[j] !== null) {
            directions[i] = (positions[j] as number) > p ? 'GODOWN TO PLANT' : 'PLANT TO GODOWN';
          } else {
            directions[i] = 'GODOWN TO PLANT';
          }
          continue;
        }

        const prevP = positions[i - 1];
        if (prevP === null) { directions[i] = directions[i - 1]; continue; }

        if (p > prevP) {
          directions[i] = 'GODOWN TO PLANT';
        } else if (p < prevP) {
          directions[i] = 'PLANT TO GODOWN';
        } else if (p === 3) {
          // Two Dasarkhed crossings back to back = arrived at the plant
          // gateway (D1), loaded, then departed (D2) — bounces us into the
          // return leg.
          directions[i] = 'PLANT TO GODOWN';
        } else if (p === 1) {
          // Two Kurankhed crossings back to back = arrived at the godown
          // gateway, then immediately turned around for the next trip —
          // Kurankhed is the same kind of boundary toll as Dasarkhed, just on
          // the godown side, so a repeat here bounces us the other way too.
          directions[i] = 'GODOWN TO PLANT';
        } else {
          // A repeated Taroda charge (double scan, duplicate entry) — Taroda
          // is a pass-through waypoint, not a gateway, so a repeat here isn't
          // a real direction change. Keep whatever direction we were already
          // travelling in.
          directions[i] = directions[i - 1];
        }
      }

      list.forEach((tx, i) => { tx.tripDirection = directions[i]; });

      // INVOICE ASSIGNMENT — reworked to use invoice timestamps as the
      // source of truth instead of toll-sequence pairing. A trip starts the
      // moment a truck leaves the plant already loaded (right after an
      // invoice is billed) and ends the moment the NEXT invoice is billed
      // (having gone plant -> godown -> plant again, ~6 toll rows). So:
      //   - Invoice[i]'s window is [invoice[i] time, invoice[i+1] time).
      //     Every toll falling in that half-open window gets invoice[i]'s
      //     number and date.
      //   - Tolls before the very first invoice are left blank — no invoice
      //     existed yet, so there's nothing for them to be billed against.
      //   - Tolls at/after the very last invoice are ALSO left blank, even
      //     if the truck's return to godown looks fully complete — there is
      //     no next invoice to close that window against, so it is never
      //     guessed forward.
      if (truckInvoices.length >= 2) {
        for (let i = 0; i < truckInvoices.length - 1; i++) {
          const invStart = truckInvoices[i].parsedDateTime.getTime();
          const invEnd = truckInvoices[i + 1].parsedDateTime.getTime();

          let matchedCount = 0;
          list.forEach((tx) => {
            const t = tx.parsedDate.getTime();
            if (t >= invStart && t < invEnd) {
              tx.invoiceNo = truckInvoices[i].invoiceNo;
              tx.invoiceDate = truckInvoices[i].invoiceDateStr;
              matchedCount++;
            }
          });

          console.log(`[RECON] ${truckNo}: invoice ${truckInvoices[i].invoiceNo} window [${truckInvoices[i].invoiceDateStr} → ${truckInvoices[i + 1].invoiceDateStr}) matched ${matchedCount} toll(s).`);
        }
      } else {
        console.log(`[RECON] ${truckNo}: fewer than 2 invoices found for this truck — no invoice window can be formed, all tolls left blank.`);
      }

      if (truckInvoices.length > 0) {
        const firstInvTime = truckInvoices[0].parsedDateTime.getTime();
        const beforeFirstCount = list.filter(tx => tx.parsedDate.getTime() < firstInvTime).length;
        if (beforeFirstCount > 0) {
          console.log(`[RECON] ${truckNo}: ${beforeFirstCount} toll(s) occur before the first invoice (${truckInvoices[0].invoiceDateStr}) — left blank, no invoice existed yet.`);
        }

        // Trailing tolls at/after the LAST invoice. Only the immediately
        // following return leg (the run of tolls right after the invoice,
        // heading PLANT TO GODOWN) is eligible to belong to that invoice:
        //   - If that leg fully completes the return all the way back to
        //     Kurankhed (the godown-side gateway), it's a finished trip —
        //     implying the truck went out again afterward and a further
        //     invoice should exist that simply isn't in this SAP file — so
        //     it's left blank rather than guessed.
        //   - If that leg is partial (statement ends mid-descent, never
        //     reaching Kurankhed), it's still clearly this same last
        //     invoice's trip in progress, so it gets attached — even a
        //     single entry.
        // Anything AFTER that immediate leg (e.g. a new outward leg that
        // starts once the return completes) is a separate, later trip with
        // no invoice of its own yet, so it stays blank regardless.
        const lastInv = truckInvoices[truckInvoices.length - 1];
        const lastInvTime = lastInv.parsedDateTime.getTime();
        const trailingStartIdx = list.findIndex(tx => tx.parsedDate.getTime() >= lastInvTime);

        if (trailingStartIdx !== -1) {
          // Everything from the last invoice's timestamp through the END of
          // the statement gets stamped with the last invoice — full round
          // trip or not, direction changes or not. There is no later
          // invoice in this file to ever hand these tolls off to, so they
          // all belong to the last invoice until a new SAP file supersedes
          // this one next month.
          for (let k = trailingStartIdx; k < list.length; k++) {
            list[k].invoiceNo = lastInv.invoiceNo;
            list[k].invoiceDate = lastInv.invoiceDateStr;
          }
          console.log(`[RECON] ${truckNo}: ${list.length - trailingStartIdx} toll(s) from the last invoice (${lastInv.invoiceDateStr}) to end of statement attached to invoice ${lastInv.invoiceNo}.`);
        }
      }
    });

    setTruckGroups(grouped);

    if (trucksWithNoInvoices.length > 0) {
      Alert.alert(
        'Vehicle Number Mismatch',
        `No SAP invoices matched for: ${trucksWithNoInvoices.join(', ')}.\n\nThis usually means the truck number text differs between the two files (extra characters, state code, spacing, etc.). Compare "Truck No" in the Fastag file with "Vehicle No" in the SAP file for these trucks.`
      );
    }
  };

  // Thin black border reused on every cell so tables render with visible
  // gridlines instead of the borderless look XLSX.js produces by default.
  const THIN = { style: 'thin', color: { rgb: '000000' } } as const;
  const THIN_BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

  // Applies column widths, thin borders, wrap text, and bold title/header
  // rows to every used cell in a sheet (including merged-away cells, so the
  // merged block's outer border still renders correctly).
  const styleWorksheet = (
    ws: XLSX.WorkSheet,
    colWidths: number[],
    options?: { boldRows?: number[]; rightAlignCols?: number[] }
  ) => {
    ws['!cols'] = colWidths.map((wch) => ({ wch }));
    if (!ws['!ref']) return;

    const range = XLSX.utils.decode_range(ws['!ref']);
    const boldRows = new Set(options?.boldRows || []);
    const rightAlignCols = new Set(options?.rightAlignCols || []);

    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { t: 's', v: '' };
        const isNumeric = typeof ws[addr].v === 'number';
        ws[addr].s = {
          border: THIN_BORDER,
          font: { bold: boldRows.has(R), sz: 10, name: 'Arial' },
          alignment: {
            wrapText: true,
            vertical: 'center',
            horizontal: rightAlignCols.has(C) || isNumeric ? 'right' : 'left',
          },
        };
      }
    }
  };

  // 4. EXPORT HANDLER
  const handleExportExcel = async () => {
    if (Object.keys(truckGroups).length === 0) {
      Alert.alert('No Data', 'Please upload statement files first.');
      return;
    }

    try {
      setLoading(true);
      const wb = XLSX.utils.book_new();
      const summaryData: { truckNo: string; amount: number }[] = [];

      Object.keys(truckGroups).forEach((truckNo) => {
        const list = truckGroups[truckNo];

        const dates = list.map(tx => tx.parsedDate.getTime());
        const minDate = new Date(Math.min(...dates)).toLocaleDateString('en-GB').replace(/\//g, '.');
        const maxDate = new Date(Math.max(...dates)).toLocaleDateString('en-GB').replace(/\//g, '.');

        const sheetData: any[][] = [
          ['SHREEJEE GAS SERVICE, AMRAVATI', '', '', '', '', '', ''],
          ['Statement of account for reimbursement of Taroda Kasba, Dassarkhed and Kurankhed toll plaza charges', '', '', '', '', '', ''],
          [`Period: ${minDate}-${maxDate}`, '', '', '', '', `Vehicle No.: ${truckNo}`, ''],
          [],
          ['Sr.No', 'Trip Date', 'Fast Tag Transaction Reference', 'Trip', 'Toll Charges (Rs.)', 'Invoice No. (SAP)', 'Invoice Date (SAP)']
        ];

        let totalAmount = 0;
        list.forEach((item, index) => {
          sheetData.push([
            index + 1,
            item.time,
            item.transactionId,
            item.tripDirection,
            item.amount,
            item.invoiceNo,
            item.invoiceDate
          ]);
          totalAmount += item.amount;
        });

        sheetData.push(['TOTAL', '', '', '', totalAmount, '', '']);
        summaryData.push({ truckNo, amount: totalAmount });

        const ws = XLSX.utils.aoa_to_sheet(sheetData);

        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
          { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } },
          { s: { r: 2, c: 5 }, e: { r: 2, c: 6 } },
        ];

        styleWorksheet(ws, [7, 20, 26, 18, 16, 16, 14], {
          boldRows: [0, 1, 2, 4, sheetData.length - 1],
          rightAlignCols: [4],
        });

        XLSX.utils.book_append_sheet(wb, ws, truckNo);
      });

      const summaryRows: any[][] = [
        ['SHREEJEE GAS SERVICE, AMRAVATI', '', ''],
        ['Consolidated Toll Reimbursement Summary', '', ''],
        [],
        ['Sr No.', 'Truck No', 'Total Amount (Rs.)']
      ];

      let grandTotal = 0;
      summaryData.forEach((item, index) => {
        summaryRows.push([index + 1, item.truckNo, item.amount]);
        grandTotal += item.amount;
      });

      summaryRows.push(['TOTAL', '', grandTotal]);

      const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
      summarySheet['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }
      ];

      styleWorksheet(summarySheet, [8, 18, 18], {
        boldRows: [0, 1, 3, summaryRows.length - 1],
        rightAlignCols: [2],
      });

      XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary Report');

      // 4TH SHEET — Bill, replicating the JAN-2026 invoice template. Only
      // the period and amount change; everything else (company details,
      // BPCL details, GST/HSN codes, wording) is carried over exactly.
      const allDates: number[] = [];
      Object.keys(truckGroups).forEach((truckNo) => {
        truckGroups[truckNo].forEach((item) => allDates.push(item.parsedDate.getTime()));
      });
      const periodStart = formatDDMMYYYY(new Date(Math.min(...allDates)));
      const periodEnd = formatDDMMYYYY(new Date(Math.max(...allDates)));
      const billAmount = grandTotal;
      const billAmountWords = numberToWordsIndian(billAmount);

      const billRows: any[][] = [
        ['SHREEJEE GAS SERVICE,AMRAVATI', '', '', '', '', '', '', '', '', ''],
        ['(LPG Distributors of Bharat Petroleum Corporation Ltd.)', '', '', '', '', '', '', '', '', ''],
        ['Kesharbag, Near Mantri Motors, Badnera Road, Amravati - 444602\nEmail : shreejeegas_amravati@bharatgas.in\nPhone: 0721259251 / 07212676104 Mob. : 9133444342', '', '', '', '', '', '', '', '', ''],
        ['TAX INVOICE', '', '', '', '', '', '', '', '', ''],
        [
          'To,\nBharat Petroleum Corporation Ltd.\nBPCL office Complex,\nBusiness Process Excellence Center ( BPEC)\nPlot No. 6, Sector – 2, Behind CIDCO Garden, Kharghar\nNavi Mumbai, MAHARASHTRA – 410210\nBPCL GST No : 27AAACB2902M1ZT\nBPCL PAN No : AAACB2902M',
          '', '', '', '',
          // Labels-only column (bold) and values-only column (normal),
          // line-for-line aligned — this is how the "Vendor :" style labels
          // end up bold while the values next to them stay regular weight.
          'Vendor :\n\n\n\nMob. :\nEmail ID :\nGST No :\nVendor Code :',
          'SHREEJEE GAS SERVICE,\nKeshar bag, Near Mantri Motors\nBadnera Road, Amravati. – 444602\n\n9133444342\nshreejeegas_amravati@bharatgas.in\n27AFIFS8094R1ZR\n232928',
          '', '', ''
        ],
        [
          'Consignee:\nTerritory Co-Ordinator (LPG)\nBharat Petroleum Corporation Limited,\nBharat Gas LPG Plant\nP –27, Addi M.I.D.C. Industrial Area, Jalgaon,\nJalgaon, Maharashtra – 425003, STATE CODE : 27\nGST No : 27AAACB2902M1ZT',
          '', '', '', '',
          'Invoice No :\nInvoice Date :\nPO No :\nPO Date :\nGST No :\nPAN No :',
          '\n\n\n\n27AFIFS8094R1ZR\nAFIFS8094R',
          '', '', ''
        ],
        [`SUBJECT: Toll Tax Reimbursement for ${periodStart} TO ${periodEnd}.`, '', '', '', '', '', '', '', '', ''],
        [1, `Reimbursement of toll charges for Dasarkhed, Taroda-Kasba & Kunarkhed toll plaza Period ${periodStart} to ${periodEnd}`, '', '', 9965, '', 1, 'LS', billAmount, billAmount],
        [`Total Invoice Value (In Words) :\n${billAmountWords}\nTax is payable on reverse Charge Mechanism Reimbursement bill Hence no tax applicable`, '', '', '', '', '', '', 'NET AMOUNT :', '', billAmount],
        ['', '', '', '', '', '', '', 'CGST : 0%', '', 0],
        ['', '', '', '', '', '', '', 'SGST : 0%', '', 0],
        ['', '', '', '', '', '', '', 'TOTAL AMOUNT :', '', billAmount],
        ['', '', '', '', '', '', '', '', '', ''],
        ['SR No.', 'HSN/SAC Code', 'Taxable Amount', 'For SHREEJEE GAS SERVICE, AMRAVATI\nAuthorized Signatory/ Proprietor', '', '', '', '', '', ''],
        [1, 9965, 0, '', '', '', '', '', '', ''],
        ['Total Taxable Amount', '', 0, '', '', '', '', '', '', ''],
      ];

      const billSheet = XLSX.utils.aoa_to_sheet(billRows);
      billSheet['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: 9 } },
        { s: { r: 3, c: 0 }, e: { r: 3, c: 9 } },
        { s: { r: 4, c: 0 }, e: { r: 4, c: 4 } },
        { s: { r: 4, c: 6 }, e: { r: 4, c: 9 } },
        { s: { r: 5, c: 0 }, e: { r: 5, c: 4 } },
        { s: { r: 5, c: 6 }, e: { r: 5, c: 9 } },
        { s: { r: 6, c: 0 }, e: { r: 6, c: 9 } },
        { s: { r: 7, c: 1 }, e: { r: 7, c: 3 } },
        { s: { r: 7, c: 4 }, e: { r: 7, c: 5 } },
        { s: { r: 8, c: 0 }, e: { r: 11, c: 6 } },
        { s: { r: 8, c: 7 }, e: { r: 8, c: 8 } },
        { s: { r: 9, c: 7 }, e: { r: 9, c: 8 } },
        { s: { r: 10, c: 7 }, e: { r: 10, c: 8 } },
        { s: { r: 11, c: 7 }, e: { r: 11, c: 8 } },
        { s: { r: 12, c: 0 }, e: { r: 12, c: 9 } },
        { s: { r: 13, c: 3 }, e: { r: 15, c: 9 } },
        { s: { r: 15, c: 0 }, e: { r: 15, c: 1 } },
      ];

      styleWorksheet(billSheet, [13, 15, 9, 9, 9, 12, 9, 15, 9, 13], {
        boldRows: [0, 3, 6, 8, 11, 13],
        rightAlignCols: [9],
      });

      // Row heights (points): address block, To/Vendor block, Consignee/
      // Invoice block, and the item row all need extra room for their
      // multi-line content.
      billSheet['!rows'] = [];
      billSheet['!rows'][2] = { hpt: 45 };
      billSheet['!rows'][4] = { hpt: 110 };
      billSheet['!rows'][5] = { hpt: 90 };
      billSheet['!rows'][7] = { hpt: 45 };

      // A1:J8 (rows 0-7) center-aligned by default, except rows 4 and 5
      // (the To/Vendor and Consignee/Invoice blocks) which stay left-aligned
      // since dense multi-line address text reads better that way.
      for (let R = 0; R <= 7; R++) {
        for (let C = 0; C <= 9; C++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (!billSheet[addr]) continue;
          const isLeftAlignRow = R === 4 || R === 5;
          billSheet[addr].s = {
            ...billSheet[addr].s,
            alignment: {
              wrapText: true,
              vertical: 'center',
              horizontal: isLeftAlignRow ? 'left' : 'center',
            },
          };
        }
      }

      // D14 (row13, col3) — the "For SHREEJEE GAS SERVICE... Authorized
      // Signatory" cell — bottom + center aligned.
      const d14Addr = XLSX.utils.encode_cell({ r: 13, c: 3 });
      if (billSheet[d14Addr]) {
        billSheet[d14Addr].s = {
          ...billSheet[d14Addr].s,
          alignment: { wrapText: true, vertical: 'bottom', horizontal: 'center' },
        };
      }

      // Bold the label columns (F5 and F6 — "Vendor :", "Mob.", "Email ID",
      // "GST No", "Vendor Code", "Invoice No", "Invoice Date", "PO No",
      // "PO Date", "GST No", "PAN No") while their neighbouring value column
      // (G5/G6) stays regular weight. NOTE: the xlsx-js-style writer does
      // not support mixed bold/normal text WITHIN a single cell (rich-text
      // runs are silently dropped on write) — confirmed by inspecting the
      // generated file directly — so labels and values are split into their
      // own whole cells instead, each fully bold or fully normal.
      const labelCellAddrs = [
        XLSX.utils.encode_cell({ r: 4, c: 5 }),
        XLSX.utils.encode_cell({ r: 5, c: 5 }),
      ];
      labelCellAddrs.forEach((addr) => {
        if (billSheet[addr]) {
          billSheet[addr].s = {
            ...billSheet[addr].s,
            font: { ...(billSheet[addr].s?.font || {}), bold: true },
          };
        }
      });

      XLSX.utils.book_append_sheet(wb, billSheet, 'Bill');

      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const filename = `Toll_Reimbursement_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const fileUri = `${cacheDirectory}${filename}`;

      await writeAsStringAsync(fileUri, wbout, { encoding: EncodingType.Base64 });

      await Sharing.shareAsync(fileUri, {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dialogTitle: 'Share Fastag Reimbursement Statement',
      });
    } catch (error: any) {
      Alert.alert('Export Error', error?.message || 'Could not compile report sheets.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Fastag Reimbursement</Text>
        <Text style={styles.headerSubtitle}>Toll Reconciliation Utility</Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={BPCL_BLUE} />
          <Text style={styles.loaderText}>Processing configurations...</Text>
        </View>
      ) : (
        <ScrollView style={styles.scroll}>
          {/* STEP 1 */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons
                name={fastagUploaded ? "checkmark-circle" : "cloud-upload"}
                size={24}
                color={fastagUploaded ? "#15803d" : BPCL_BLUE}
              />
              <Text style={styles.cardTitle}>1. Upload Fastag Statement</Text>
            </View>
            <Text style={styles.cardText}>Import the downloaded Excel/CSV statement containing transaction times and toll amounts.</Text>

            <Text style={styles.dropdownLabel}>Fastag Provider</Text>
            <TouchableOpacity
              style={styles.dropdownTrigger}
              onPress={() => setProviderDropdownOpen((open) => !open)}
            >
              <Text style={styles.dropdownTriggerText}>
                {FASTAG_PROVIDER_OPTIONS.find((o) => o.value === fastagProvider)?.label}
              </Text>
              <Ionicons name={providerDropdownOpen ? "chevron-up" : "chevron-down"} size={18} color="#4b5563" />
            </TouchableOpacity>

            {providerDropdownOpen && (
              <View style={styles.dropdownList}>
                {FASTAG_PROVIDER_OPTIONS.map((option) => (
                  <TouchableOpacity
                    key={option.value}
                    style={styles.dropdownOption}
                    onPress={() => {
                      setFastagProvider(option.value);
                      setProviderDropdownOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.dropdownOptionText,
                        option.value === fastagProvider && styles.dropdownOptionTextActive,
                      ]}
                    >
                      {option.label}
                    </Text>
                    {option.value === fastagProvider && (
                      <Ionicons name="checkmark" size={16} color={BPCL_BLUE} />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <TouchableOpacity style={styles.uploadButton} onPress={handleFastagUpload}>
              <Ionicons name="document-attach" size={18} color="#fff" />
              <Text style={styles.buttonText}>{fastagUploaded ? "Change Fastag File" : "Upload Fastag"}</Text>
            </TouchableOpacity>
          </View>

          {/* STEP 2 */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons
                name={sapUploaded ? "checkmark-circle" : "cloud-upload"}
                size={24}
                color={sapUploaded ? "#15803d" : BPCL_BLUE}
              />
              <Text style={styles.cardTitle}>2. Upload SAP Invoices (XLS)</Text>
            </View>
            <Text style={styles.cardText}>Import the invoice spreadsheet containing the billing timings and matched vehicle columns.</Text>
            <TouchableOpacity style={[styles.uploadButton, { backgroundColor: '#4b5563' }]} onPress={handleSapUpload}>
              <Ionicons name="receipt" size={18} color="#fff" />
              <Text style={styles.buttonText}>{sapUploaded ? "Change Invoices File" : "Upload Invoices"}</Text>
            </TouchableOpacity>
          </View>

          {/* PREVIEW */}
          {Object.keys(truckGroups).length > 0 && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Reconciliation Preview</Text>
              {Object.keys(truckGroups).map((truckNo) => {
                const list = truckGroups[truckNo];
                const sum = list.reduce((acc, curr) => acc + curr.amount, 0);
                return (
                  <View key={truckNo} style={styles.infoRow}>
                    <View>
                      <Text style={styles.truckTitle}>{truckNo}</Text>
                      <Text style={styles.truckSub}>{list.length} Records Processed</Text>
                    </View>
                    <Text style={styles.truckAmount}>₹{sum.toFixed(2)}</Text>
                  </View>
                );
              })}

              <TouchableOpacity style={styles.exportButton} onPress={handleExportExcel}>
                <Ionicons name="share-social-outline" size={18} color="#fff" />
                <Text style={styles.buttonText}>Generate & Share Excel</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
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
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 4 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loaderText: { marginTop: 12, fontSize: 14, color: '#666', fontWeight: '500' },
  scroll: { flex: 1, paddingHorizontal: 12, paddingTop: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  cardText: { fontSize: 13, color: '#666', lineHeight: 18, marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 12 },
  dropdownLabel: { fontSize: 12, fontWeight: '600', color: '#4b5563', marginBottom: 6 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
    backgroundColor: '#fafafa',
  },
  dropdownTriggerText: { fontSize: 14, color: '#111827', fontWeight: '500' },
  dropdownList: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    marginTop: -10,
    marginBottom: 14,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  dropdownOptionText: { fontSize: 14, color: '#374151' },
  dropdownOptionTextActive: { color: BPCL_BLUE, fontWeight: '700' },
  uploadButton: {
    backgroundColor: BPCL_BLUE,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  exportButton: {
    backgroundColor: '#15803d',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
    marginTop: 16,
  },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  truckTitle: { fontSize: 14, fontWeight: '700', color: '#374151' },
  truckSub: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  truckAmount: { fontSize: 15, fontWeight: 'bold', color: BPCL_BLUE },
});
