/// <reference lib="es2021" />
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
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDataStore } from '../../store/dataStore';
import { format } from 'date-fns';
import { supabase } from '@/lib/supabase';

import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as XLSX from 'xlsx';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

// Pure-JS decompression library check to avoid app crashes if not yet installed
let pako: any = null;
try {
  pako = require('pako');
} catch (e) {
  // Gracefully ignored; prompt alert will handle it when a PDF is parsed
}

const BPCL_BLUE = '#017DC5';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
type BankType = 'HDFC' | 'ARVIND' | 'AUB';

type OnlineCategory = 'PAYTM' | 'INDIAIDEAS' | 'EURONET';
const EXCLUDE_KEYWORDS: OnlineCategory[] = ['PAYTM', 'INDIAIDEAS', 'EURONET'];
const CATEGORY_COLORS: Record<OnlineCategory, string> = {
  PAYTM: '#1a73e8',
  INDIAIDEAS: '#188038',
  EURONET: '#b31412',
};
const DATE_BG = ['#e8f0fe', '#fff8e1'];

type CategoryValue =
  | 'COMMERCIAL_PAYMENT'
  | 'TAX_PAYMENT'
  | 'OTHER_EXPENDITURE'
  | 'PARTNER_SALARY'
  | 'BPCL'
  | 'TRANSPORT_BILL'
  | 'OWN BANK'
  | 'TOLL RECHARGE'
  | 'DIESEL PAYMENT'
  | 'CASH_DEPOSIT'
  | 'ONLINE_PAYMENT'
  | 'SALARY'
  | 'OTHER';

const CATEGORY_OPTIONS: { value: CategoryValue; label: string; color: string }[] = [
  { value: 'COMMERCIAL_PAYMENT', label: 'Commercial Payment',       color: '#1a73e8' },
  { value: 'TAX_PAYMENT',        label: 'Tax Payment',              color: '#b31412' },
  { value: 'OTHER_EXPENDITURE',  label: 'Other Expenditure',        color: '#f57f17' },
  { value: 'PARTNER_SALARY',     label: 'Partner / Salary Transfer',color: '#188038' },
  { value: 'BPCL',               label: 'BPCL',                     color: '#7b1fa2' },
  { value: 'TRANSPORT_BILL',     label: 'Transport Bill',           color: '#00796b' },
  { value: 'OWN BANK',           label: 'Own Bank',                 color: '#5d4037' },
  { value: 'TOLL RECHARGE',      label: 'Toll Recharge',            color: '#c2185b' },
  { value: 'DIESEL PAYMENT',     label: 'Diesel Payment',           color: '#455a64' },
  { value: 'CASH_DEPOSIT',       label: 'Cash Deposit',             color: '#2e7d32' },
  { value: 'ONLINE_PAYMENT',     label: 'Online Payment',           color: '#0288d1' },
  { value: 'SALARY',     label: 'Salary',           color: '#0788d1' },
  { value: 'OTHER',              label: 'Other (custom)',            color: '#616161' },
];

interface OtherEntryRow {
  id: string;
  statement_date: string;
  narration: string;
  ref_no: string | null;
  txn_type: 'DEBIT' | 'CREDIT';
  amount: number;
  closing_balance: number | null;
  category: CategoryValue | null;
  category_note: string | null;
  approved: boolean;
  bank_source?: string;
}

interface ParsedStatementRow {
  statement_date: string;
  narration: string;
  ref_no: string | null;
  txn_type: 'DEBIT' | 'CREDIT';
  amount: number;
  closing_balance: number | null;
}

interface ParsedOnlineRow extends ParsedStatementRow {
  source_category: OnlineCategory;
}

// ─────────────────────────────────────────────────────────────────────────────
// RC4 (pure JS)
// ─────────────────────────────────────────────────────────────────────────────
function rc4(key: any, data: any): any {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) & 0xff;
    y = (y + S[x]) & 0xff;
    const tmp = S[x]; S[x] = S[y]; S[y] = tmp;
    out[i] = data[i] ^ S[(S[x] + S[y]) & 0xff];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MD5 (pure JS — PDF spec §3.5.2 key derivation)
// ─────────────────────────────────────────────────────────────────────────────
function md5(input: any): any {
  const s = [
    7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,
    5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,
    4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,
    6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++)
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  const msgLen = input.length;
  const bitLen = msgLen * 8;
  const padLen = msgLen % 64 < 56 ? 56 - (msgLen % 64) : 120 - (msgLen % 64);

  // Build padded message in a guaranteed plain ArrayBuffer
  const paddedAb = new ArrayBuffer(msgLen + padLen + 8);
  const padded   = new Uint8Array(paddedAb);
  padded.set(input);
  padded[msgLen] = 0x80;
  const dv = new DataView(paddedAb);
  dv.setUint32(msgLen + padLen,     bitLen & 0xffffffff,          true);
  dv.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++)
      M[i] = dv.getUint32(offset + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if      (i < 16) { F = (B & C) | (~B & D);  g = i; }
      else if (i < 32) { F = (D & B) | (~D & C);  g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D;            g = (3 * i + 5) % 16; }
      else             { F = C ^ (B | ~D);         g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const resultAb = new ArrayBuffer(16);
  const rv       = new DataView(resultAb);
  rv.setUint32(0,  a0, true);
  rv.setUint32(4,  b0, true);
  rv.setUint32(8,  c0, true);
  rv.setUint32(12, d0, true);
  return new Uint8Array(resultAb);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF ENCRYPTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const PDF_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

interface PdfEncryptDict {
  revision:  number;
  keyLength: number;
  oValue:    any;
  uValue:    any;
  pValue:    number;
  fileId:    any;
}

function hexToBytes(hex: string): any {
  const clean = hex.replace(/\s/g, '');
  const bytes = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function pdfLiteralStringToBytes(s: string): any {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      switch (s[i]) {
        case 'n':  bytes.push(10); break;
        case 'r':  bytes.push(13); break;
        case 't':  bytes.push(9);  break;
        case 'b':  bytes.push(8);  break;
        case 'f':  bytes.push(12); break;
        case '(':  bytes.push(40); break;
        case ')':  bytes.push(41); break;
        case '\\': bytes.push(92); break;
        default:
          if (/[0-7]/.test(s[i])) {
            let oct = s[i];
            if (i + 1 < s.length && /[0-7]/.test(s[i + 1])) { oct += s[++i]; }
            if (i + 1 < s.length && /[0-7]/.test(s[i + 1])) { oct += s[++i]; }
            bytes.push(parseInt(oct, 8));
          }
      }
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function deriveEncryptionKey(password: string, dict: PdfEncryptDict): any {
  const pwdBytes = new Uint8Array(32);
  const pwdRaw   = new TextEncoder().encode(password);
  pwdBytes.set(pwdRaw.slice(0, 32));
  if (pwdRaw.length < 32)
    pwdBytes.set(PDF_PADDING.slice(0, 32 - pwdRaw.length), pwdRaw.length);

  const pBytesAb = new ArrayBuffer(4);
  new DataView(pBytesAb).setInt32(0, dict.pValue, true);
  const pBytes = new Uint8Array(pBytesAb);

  const combined = new Uint8Array(32 + dict.oValue.length + 4 + dict.fileId.length);
  let off = 0;
  combined.set(pwdBytes,     off); off += 32;
  combined.set(dict.oValue,  off); off += dict.oValue.length;
  combined.set(pBytes,       off); off += 4;
  combined.set(dict.fileId,  off);

  let hash   = md5(combined);
  const keyLen = dict.keyLength >> 3;
  if (dict.revision >= 3)
    for (let i = 0; i < 50; i++) hash = md5(hash.slice(0, keyLen));

  return hash.slice(0, keyLen);
}

function verifyUserPassword(password: string, dict: PdfEncryptDict): boolean {
  const key = deriveEncryptionKey(password, dict);

  if (dict.revision === 2) {
    const encrypted = rc4(key, PDF_PADDING);
    return encrypted.every((b: number, i: number) => b === dict.uValue[i]);
  }

  const combined = new Uint8Array(32 + dict.fileId.length);
  combined.set(PDF_PADDING);
  combined.set(dict.fileId, 32);
  let result = rc4(key, md5(combined));
  for (let i = 1; i <= 19; i++) {
    const roundKey = key.map((b) => b ^ i);
    result = rc4(roundKey, result);
  }
  return result.every((b: number, i: number) => b === dict.uValue[i]);
}

function objectKey(encKey: any, objNum: number, genNum: number): any {
  const extra = new Uint8Array(5);
  extra[0] = objNum        & 0xff;
  extra[1] = (objNum >> 8) & 0xff;
  extra[2] = (objNum >> 16)& 0xff;
  extra[3] = genNum        & 0xff;
  extra[4] = (genNum >> 8) & 0xff;
  const combined = new Uint8Array(encKey.length + 5);
  combined.set(encKey);
  combined.set(extra, encKey.length);
  return md5(combined).slice(0, Math.min(encKey.length + 5, 16));
}

// ─────────────────────────────────────────────────────────────────────────────
// BT / ET TEXT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────
function extractBtEtText(content: string): string {
  const parts: string[] = [];
  const btEtRegex = /BT([\s\S]*?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = btEtRegex.exec(content)) !== null) {
    const block    = m[1];
    const strRegex = /\(([^)]*)\)/g;
    let sm: RegExpExecArray | null;
    const strs: string[] = [];
    while ((sm = strRegex.exec(block)) !== null) strs.push(sm[1]);
    if (strs.length) parts.push(strs.join(' '));
  }
  return parts.join('\n');
}

// ── Detects FlateDecode whether written as a bare name (/Filter /FlateDecode)
//    or wrapped in an array (/Filter [/FlateDecode]) — some bank PDF
//    generators use the array form, which the old bare-name regex missed,
//    silently treating compressed binary as plain text (== empty extraction).
function isFlateFilter(dict: string): boolean {
  return (
    /\/Filter\s*\/(FlateDecode|Fl)\b/i.test(dict) ||
    /\/Filter\s*\[[^\]]*\/(FlateDecode|Fl)\b[^\]]*\]/i.test(dict)
  );
}

// ── Decompresses FlateDecode stream segments securely using pako ─────────────
function extractTextFromPdfBuffer(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);

  let binStr = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  }

  const textParts: string[] = [];
  const streamRegex = /(\d+)\s+(\d+)\s+obj[\s\S]*?<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(binStr)) !== null) {
    const dict = match[3];
    const streamRaw = match[4];
    const isFlate = isFlateFilter(dict);

    if (isFlate) {
      if (!pako) {
        throw new Error(
          "This PDF statement uses compressed data streams. To extract its text, please install 'pako' by running:\n\nnpm install pako"
        );
      }
      const streamBytes = new Uint8Array(streamRaw.length);
      for (let i = 0; i < streamRaw.length; i++) {
        streamBytes[i] = streamRaw.charCodeAt(i) & 0xff;
      }
      try {
        const decompressed = pako.inflate(streamBytes);
        let decompressedStr = '';
        for (let i = 0; i < decompressed.length; i += chunk) {
          decompressedStr += String.fromCharCode.apply(null, decompressed.subarray(i, i + chunk) as any);
        }
        const text = extractBtEtText(decompressedStr);
        if (text.trim()) textParts.push(text);
      } catch (e) {
        // Skip streams that fail decompression
      }
    } else {
      const text = extractBtEtText(streamRaw);
      if (text.trim()) textParts.push(text);
    }
  }

  if (textParts.length === 0) {
    const direct = extractBtEtText(binStr);
    if (direct.trim()) return direct;
  }

  return textParts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL PDF DECRYPT + TEXT EXTRACT (WITH PAKO DECOMPRESSION)
// ─────────────────────────────────────────────────────────────────────────────
function decryptPdfAndExtractText(buf: any, password: string): string | null {
  let raw = '';
  const chunk = 8192;
  for (let i = 0; i < buf.length; i += chunk) {
    raw += String.fromCharCode.apply(null, buf.subarray(i, i + chunk) as any);
  }

  const encMatch = raw.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/);
  if (!encMatch) return extractTextFromPdfBuffer(buf.buffer);

  const encObjNum = parseInt(encMatch[1], 10);

  let fileId: any = new Uint8Array(16);
  const idMatch = raw.match(/\/ID\s*\[\s*<([0-9a-fA-F]+)>/);
  if (idMatch) fileId = hexToBytes(idMatch[1]);

  const encObjRegex = new RegExp(
    `\\b${encObjNum}\\s+\\d+\\s+obj\\b([\\s\\S]*?)\\bendobj\\b`
  );
  const encObjMatch = raw.match(encObjRegex);
  if (!encObjMatch) return null;
  const encObjText = encObjMatch[1];

  const getVal = (key: string): string | null => {
    const mm = encObjText.match(
      new RegExp(`\\/${key}\\s+([^\\s\\/\\[\\]<>()]+)`)
    );
    return mm ? mm[1] : null;
  };
  const getHexStr = (key: string): any => {
    const mm = encObjText.match(
      new RegExp(`\\/${key}\\s*<([0-9a-fA-F\\s]+)>`)
    );
    return mm ? hexToBytes(mm[1]) : null;
  };
  const getLiteralStr = (key: string): any => {
    const mm = encObjText.match(new RegExp(`\\/${key}\\s*\\(([^)]*)\\)`));
    return mm ? pdfLiteralStringToBytes(mm[1]) : null;
  };

  const revision  = parseInt(getVal('R')      || '2',   10);
  const keyLength = parseInt(getVal('Length') || (revision >= 3 ? '128' : '40'), 10);
  const pValue    = parseInt(getVal('P')      || '-4',  10);
  const oValue = getHexStr('O') || getLiteralStr('O') || new Uint8Array(32);
  const uValue = getHexStr('U') || getLiteralStr('U') || new Uint8Array(32);

  const dict: PdfEncryptDict = { revision, keyLength, oValue, uValue, pValue, fileId };

  const pwdOk   = verifyUserPassword(password, dict);
  const emptyOk = verifyUserPassword('', dict);
  if (!pwdOk && !emptyOk) return null;

  const encKey     = deriveEncryptionKey(pwdOk ? password : '', dict);
  const textParts: string[] = [];

  const objRegex = /(\d+)\s+(\d+)\s+obj[\s\S]*?<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let objMatch: RegExpExecArray | null;

  while ((objMatch = objRegex.exec(raw)) !== null) {
    const objNum = parseInt(objMatch[1], 10);
    const genNum = parseInt(objMatch[2], 10);
    const dictText = objMatch[3];
    const streamRaw = objMatch[4];
    if (objNum === encObjNum) continue;

    const isFlate = isFlateFilter(dictText);

    const streamBytes = new Uint8Array(streamRaw.length);
    for (let i = 0; i < streamRaw.length; i++)
      streamBytes[i] = streamRaw.charCodeAt(i) & 0xff;

    const key       = objectKey(encKey, objNum, genNum);
    const decrypted = rc4(key, streamBytes);

    if (isFlate) {
      if (!pako) {
        throw new Error(
          "This encrypted PDF uses compressed streams. Please install 'pako' by running:\n\nnpm install pako"
        );
      }
      try {
        const decompressed = pako.inflate(decrypted);
        let decompressedStr = '';
        for (let i = 0; i < decompressed.length; i += chunk) {
          decompressedStr += String.fromCharCode.apply(null, decompressed.subarray(i, i + chunk) as any);
        }
        const extracted = extractBtEtText(decompressedStr);
        if (extracted) textParts.push(extracted);
      } catch (e) {
        // Ignored fallback
      }
    } else {
      let contentStr = '';
      for (let i = 0; i < decrypted.length; i++)
        contentStr += String.fromCharCode(decrypted[i]);

      const extracted = extractBtEtText(contentStr);
      if (extracted) textParts.push(extracted);
    }
  }

  if (textParts.length === 0) {
    const direct = extractBtEtText(raw);
    if (direct.trim()) return direct;
  }

  return textParts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// READ PDF FROM URI
// ─────────────────────────────────────────────────────────────────────────────
async function readPdfText(uri: string, password?: string): Promise<string> {
  const b64    = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = atob(b64);
  const ab     = new ArrayBuffer(binary.length);
  const buf    = new Uint8Array(ab);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

  if (password) {
    const result = decryptPdfAndExtractText(buf, password);
    if (result !== null) return result;
    throw new Error('Incorrect PDF password. Please check and try again.');
  }

  return extractTextFromPdfBuffer(ab);
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let inQuotes = false;
  let entry    = '';

  for (let i = 0; i < text.length; i++) {
    const char     = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') { entry += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(entry.trim()); entry = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      row.push(entry.trim()); lines.push(row); row = []; entry = '';
    } else {
      entry += char;
    }
  }
  if (entry || row.length > 0) { row.push(entry.trim()); lines.push(row); }
  return lines.filter((r) => r.length > 0 && r.some((c) => c !== ''));
}

function cleanVal(val: any): string {
  if (val === null || val === undefined) return '';
  let str = val.toString().trim();
  if (str.startsWith('"') && str.endsWith('"'))
    str = str.substring(1, str.length - 1).trim();
  if (str.startsWith("'") && str.endsWith("'"))
    str = str.substring(1, str.length - 1).trim();
  return str;
}

function formatStatementDate(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^'+/, '').trim();
  if (!s || s.toLowerCase() === 'date') return null;
  if (s.startsWith('#')) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const parts = s.split(/[-/\s.]+/);
  if (parts.length === 3) {
    let dayStr   = parts[0];
    let monthStr = parts[1];
    let yearStr  = parts[2];

    if (dayStr.length === 4) {
      const tmp = dayStr;
      dayStr = yearStr;
      yearStr = tmp;
    }

    const day = parseInt(dayStr, 10);
    let month = parseInt(monthStr, 10);
    let year  = parseInt(yearStr, 10);

    if (isNaN(month)) {
      const months: Record<string, number> = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
      };
      const key = monthStr.substring(0, 3).toLowerCase();
      if (months[key]) {
        month = months[key];
      } else {
        return null;
      }
    }

    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

    // Validate to prevent PostgreSQL date out-of-range errors (like 00-00-1970)
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    const fullYear = year < 100 ? (year + (year > 50 ? 1900 : 2000)) : year;

    // Ensure the year falls within a realistic range for bank statement entries
    if (fullYear < 1990 || fullYear > 2100) return null;

    return `${fullYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }
  return null;
}

function formatDisplayDate(iso: string): string {
  try { return format(new Date(iso + 'T00:00:00'), 'dd MMM yyyy'); }
  catch { return iso; }
}

function darken(hex: string, factor = 0.85): string {
  const h = hex.replace('#', '');
  const r = Math.round(parseInt(h.substring(0, 2), 16) * factor);
  const g = Math.round(parseInt(h.substring(2, 4), 16) * factor);
  const b = Math.round(parseInt(h.substring(4, 6), 16) * factor);
  return `rgb(${r},${g},${b})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HDFC EXCEL / CSV PARSER
// ─────────────────────────────────────────────────────────────────────────────
function findHeaderAndColumns(rows: string[][]) {
  for (let i = 0; i < rows.length; i++) {
    const raw = Array.from(rows[i] || []);
    const row = raw.map((c) => cleanVal(c).toLowerCase());
    const dateIdx       = row.findIndex((c) => c === 'date');
    const narrationIdx  = row.findIndex((c) => c.includes('narration'));
    const withdrawalIdx = row.findIndex((c) => c.includes('withdrawal'));
    const depositIdx    = row.findIndex((c) => c.includes('deposit'));
    if (
      dateIdx      !== -1 &&
      narrationIdx !== -1 &&
      (withdrawalIdx !== -1 || depositIdx !== -1)
    ) {
      const refIdx     = row.findIndex((c) => c.includes('chq') || c.includes('ref'));
      const closingIdx = row.findIndex((c) => c.includes('closing'));
      return {
        headerRowIndex: i,
        dateIdx, narrationIdx, refIdx, withdrawalIdx, depositIdx, closingIdx,
      };
    }
  }
  return null;
}

function parseAmount(str: string): number {
  if (!str) return NaN;
  return parseFloat(str.replace(/[^0-9.]/g, ''));
}

function matchExcludeKeyword(narrationUpper: string): OnlineCategory | null {
  for (const kw of EXCLUDE_KEYWORDS) {
    if (narrationUpper.includes(kw)) return kw;
  }
  return null;
}

function parseHdfcRows(rows: string[][]): {
  otherRows:  ParsedStatementRow[];
  onlineRows: ParsedOnlineRow[];
} {
  const cols = findHeaderAndColumns(rows);
  if (!cols) return { otherRows: [], onlineRows: [] };
  const dataRows   = rows.slice(cols.headerRowIndex + 1);
  const otherRows:  ParsedStatementRow[] = [];
  const onlineRows: ParsedOnlineRow[]    = [];

  for (const rawRow of dataRows) {
    const row            = Array.from(rawRow || []);
    const dateRaw        = cleanVal(row[cols.dateIdx]);
    const normalizedDate = formatStatementDate(dateRaw);
    if (!normalizedDate) continue;

    const narration = cleanVal(row[cols.narrationIdx]).replace(/\s+/g, ' ').trim();
    if (!narration) continue;

    const withdrawalStr = cols.withdrawalIdx !== -1 ? cleanVal(row[cols.withdrawalIdx]) : '';
    const depositStr    = cols.depositIdx    !== -1 ? cleanVal(row[cols.depositIdx])    : '';
    const withdrawal    = parseAmount(withdrawalStr);
    const deposit       = parseAmount(depositStr);
    const hasWithdrawal = !isNaN(withdrawal) && withdrawal > 0;
    const hasDeposit    = !isNaN(deposit)    && deposit    > 0;
    if (!hasWithdrawal && !hasDeposit) continue;

    const refNo      = cols.refIdx     !== -1 ? cleanVal(row[cols.refIdx])     : '';
    const closingStr = cols.closingIdx !== -1 ? cleanVal(row[cols.closingIdx]) : '';
    const closing    = closingStr
      ? parseFloat(closingStr.replace(/[^0-9.-]/g, ''))
      : NaN;

    const base: ParsedStatementRow = {
      statement_date:  normalizedDate,
      narration,
      ref_no:          refNo || null,
      txn_type:        hasWithdrawal ? 'DEBIT' : 'CREDIT',
      amount:          hasWithdrawal ? withdrawal : deposit,
      closing_balance: isNaN(closing) ? null : closing,
    };

    const kw = matchExcludeKeyword(narration.toUpperCase());
    if (kw) onlineRows.push({ ...base, source_category: kw });
    else    otherRows.push(base);
  }
  return { otherRows, onlineRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARVIND BANK PDF PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseArvindBankText(text: string): ParsedStatementRow[] {
  const rows: ParsedStatementRow[] = [];
  if (!text) return rows;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const dateRegex = /\b\d{1,2}[-/\s.](?:\d{1,2}|[A-Za-z]{3})[-/\s.](?:\d{4}|\d{2})\b/;

  for (const line of lines) {
    const dateMatch = line.match(dateRegex);
    if (!dateMatch) continue;

    const rawDate = dateMatch[0];
    const isoDate = formatStatementDate(rawDate);
    if (!isoDate) continue;

    const numPattern = /\b[\d,]+\.\d{2}\b/g;
    const nums: string[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = numPattern.exec(line)) !== null) {
      nums.push(nm[0].replace(/,/g, ''));
    }

    if (nums.length >= 2) {
      const closing = parseFloat(nums[nums.length - 1]);
      let debit = 0;
      let credit = 0;

      if (nums.length >= 3) {
        debit  = parseFloat(nums[nums.length - 3]);
        credit = parseFloat(nums[nums.length - 2]);
      } else {
        const amount = parseFloat(nums[0]);
        const upper = line.toUpperCase();
        if (
          upper.includes('BY') ||
          upper.includes('CREDIT') ||
          upper.includes('CR') ||
          upper.includes('DEP') ||
          upper.includes('INTEREST')
        ) {
          credit = amount;
        } else {
          debit = amount;
        }
      }

      const hasDebit = !isNaN(debit) && debit > 0;
      const hasCredit = !isNaN(credit) && credit > 0;
      if (!hasDebit && !hasCredit) continue;

      let narration = line
        .replace(rawDate, '')
        .replace(/\b[\d,]+\.\d{2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const chqMatch = narration.match(/\b(\d{5,6})\b\s*$/);
      let refNo: string | null = null;
      if (chqMatch) {
        refNo = chqMatch[1] === '000000' ? null : chqMatch[1];
        narration = narration.replace(chqMatch[0], '').trim();
      }

      if (narration) {
        rows.push({
          statement_date: isoDate,
          narration,
          ref_no: refNo,
          txn_type: hasDebit ? 'DEBIT' : 'CREDIT',
          amount: hasDebit ? debit : credit,
          closing_balance: isNaN(closing) ? null : closing,
        });
      }
    }
  }

  if (rows.length === 0) {
    const fullText = text.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ');
    const globalDateRegex = /\b\d{1,2}[-/\s.](?:\d{1,2}|[A-Za-z]{3})[-/\s.](?:\d{4}|\d{2})\b/g;

    const dateMatches: Array<{ index: number; dateStr: string }> = [];
    let dm: RegExpExecArray | null;
    while ((dm = globalDateRegex.exec(fullText)) !== null) {
      dateMatches.push({ index: dm.index, dateStr: dm[0] });
    }

    for (let i = 0; i < dateMatches.length; i++) {
      const start   = dateMatches[i].index;
      const end     = i + 1 < dateMatches.length ? dateMatches[i + 1].index : fullText.length;
      const segment = fullText.substring(start, end).trim();
      const isoDate = formatStatementDate(dateMatches[i].dateStr);
      if (!isoDate) continue;

      const numPattern = /[\d,]+\.\d{2}/g;
      const nums: string[] = [];
      let nm: RegExpExecArray | null;
      while ((nm = numPattern.exec(segment)) !== null)
        nums.push(nm[0].replace(/,/g, ''));
      if (nums.length < 2) continue;

      let debit = 0;
      let credit = 0;
      let closing = NaN;

      if (nums.length >= 3) {
        debit   = parseFloat(nums[nums.length - 3]);
        credit  = parseFloat(nums[nums.length - 2]);
        closing = parseFloat(nums[nums.length - 1]);
      } else {
        const amt = parseFloat(nums[0]);
        closing = parseFloat(nums[1]);
        const upperSeg = segment.toUpperCase();
        if (upperSeg.includes('BY') || upperSeg.includes('CR') || upperSeg.includes('CREDIT')) {
          credit = amt;
        } else {
          debit = amt;
        }
      }

      const hasDebit  = !isNaN(debit)  && debit  > 0;
      const hasCredit = !isNaN(credit) && credit > 0;
      if (!hasDebit && !hasCredit) continue;

      let narrationRaw = segment
        .replace(dateMatches[i].dateStr, '')
        .replace(/[\d,]+\.\d{2}/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const refMatch = narrationRaw.match(/(\d{5,6})\s*$/);
      let refNo: string | null = null;
      if (refMatch) {
        refNo = refMatch[1] === '000000' ? null : refMatch[1];
        narrationRaw = narrationRaw.substring(0, narrationRaw.length - refMatch[0].length).trim();
      }

      if (narrationRaw) {
        rows.push({
          statement_date:  isoDate,
          narration:       narrationRaw,
          ref_no:          refNo,
          txn_type:        hasDebit ? 'DEBIT' : 'CREDIT',
          amount:          hasDebit ? debit : credit,
          closing_balance: isNaN(closing) ? null : closing,
        });
      }
    }
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUB BANK PDF PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseAubBankText(text: string): ParsedStatementRow[] {
  const rows: ParsedStatementRow[] = [];
  const fullText = text.split('\n').map((l) => l.replace(/\r/g, '').trim()).filter(Boolean).join(' ');

  const datePattern = /\b(\d{2}-\d{2}-\d{4})\b/g;
  const dateMatches: Array<{ index: number; date: string }> = [];
  let dm: RegExpExecArray | null;
  while ((dm = datePattern.exec(fullText)) !== null) {
    const nd = formatStatementDate(dm[1]);
    if (nd) dateMatches.push({ index: dm.index, date: nd });
  }

  // Some AUB statement layouts print "Closing Balance" footer text right
  // after the last transaction with no date in between, which would
  // otherwise get swallowed into (and poison) the last transaction's segment.
  const closingIdx = fullText.toUpperCase().indexOf('CLOSING BALANCE');

  for (let i = 0; i < dateMatches.length; i++) {
    const start = dateMatches[i].index;
    let end     = i + 1 < dateMatches.length ? dateMatches[i + 1].index : fullText.length;
    if (closingIdx !== -1 && closingIdx > start && closingIdx < end) {
      end = closingIdx;
    }
    const segment = fullText.substring(start, end).trim();
    const isoDate = dateMatches[i].date;

    const su = segment.toUpperCase();
    if (
      su.includes('OPENING BALANCE') || su.includes('CLOSING BALANCE') ||
      su.includes('STATEMENT FOR')   || su.includes('PERIOD OF')
    ) continue;

    const numPattern = /[\d,]+\.\d{2}/g;
    const nums: string[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = numPattern.exec(segment)) !== null)
      nums.push(nm[0].replace(/,/g, ''));
    // Newer AUB layout prints only amount + running balance (2 numbers) —
    // it does not print "0.00" for the unused Debit/Credit column. Older
    // layouts print all 3 columns explicitly. Support both.
    if (nums.length < 2) continue;

    const narrationAfterDate = segment.replace(/^\d{2}-\d{2}-\d{4}\s*/, '');
    const upperNarrPrefix    = narrationAfterDate.trim().toUpperCase();
    const isDebitPrefix      = upperNarrPrefix.startsWith('TO-') || upperNarrPrefix.startsWith('TO ');
    const isCreditPrefix     = upperNarrPrefix.startsWith('BY-') || upperNarrPrefix.startsWith('BY ');

    let debit   = 0;
    let credit  = 0;
    let closing = NaN;

    if (nums.length >= 3) {
      debit   = parseFloat(nums[nums.length - 3]);
      credit  = parseFloat(nums[nums.length - 2]);
      closing = parseFloat(nums[nums.length - 1]);
    } else {
      const amount = parseFloat(nums[0]);
      closing = parseFloat(nums[1]);
      // The narration prefix ("To-" / "By-") is the reliable signal here —
      // the trailing Dr/Cr marks whether the RUNNING BALANCE is overdrawn,
      // not the direction of this transaction.
      if (isCreditPrefix) {
        credit = amount;
      } else if (isDebitPrefix) {
        debit = amount;
      } else if (su.includes('CREDIT') || /\bCR\b\s*$/.test(su)) {
        credit = amount;
      } else {
        debit = amount;
      }
    }

    const hasDebit  = !isNaN(debit)  && debit  > 0;
    const hasCredit = !isNaN(credit) && credit > 0;
    if (!hasDebit && !hasCredit) continue;

    let narrationRaw = narrationAfterDate
      .replace(/[\d,]+\.\d{2}/g, '')   // strip all amount tokens
      .replace(/\b(Dr|Cr)\b/gi, '')    // strip balance-direction markers
      .replace(/\s+/g, ' ')
      .trim();

    const chqMatch = narrationRaw.match(/\b(\d{5,6})\s*$/);
    let refNo: string | null = null;
    if (chqMatch) {
      refNo = chqMatch[1];
      narrationRaw = narrationRaw
        .substring(0, narrationRaw.length - chqMatch[0].length)
        .trim();
    }

    if (!narrationRaw) continue;

    rows.push({
      statement_date:  isoDate,
      narration:       narrationRaw,
      ref_no:          refNo,
      txn_type:        hasDebit ? 'DEBIT' : 'CREDIT',
      amount:          hasDebit ? debit   : credit,
      closing_balance: isNaN(closing) ? null : closing,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED PDF PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parsePdfStatementRows(
  text: string,
  bank: 'ARVIND' | 'AUB'
): { otherRows: ParsedStatementRow[]; onlineRows: ParsedOnlineRow[] } {
  const rawRows = bank === 'ARVIND' ? parseArvindBankText(text) : parseAubBankText(text);
  const otherRows:  ParsedStatementRow[] = [];
  const onlineRows: ParsedOnlineRow[]    = [];
  for (const row of rawRows) {
    const kw = matchExcludeKeyword(row.narration.toUpperCase());
    if (kw) onlineRows.push({ ...row, source_category: kw });
    else    otherRows.push(row);
  }
  return { otherRows, onlineRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// ONLINE PAYMENT PDF REPORT BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildOnlinePaymentReportHtml(entries: ParsedOnlineRow[], rate: number): string {
  const byDate: Record<string, ParsedOnlineRow[]> = {};
  entries.forEach((e) => {
    byDate[e.statement_date] = byDate[e.statement_date] || [];
    byDate[e.statement_date].push(e);
  });
  const dates      = Object.keys(byDate).sort();
  const grandTotal = entries.reduce((s, e) => s + e.amount, 0);
  const totalUnits = grandTotal / rate;

  const byCategory: Record<string, { count: number; total: number }> = {};
  entries.forEach((e) => {
    byCategory[e.source_category] = byCategory[e.source_category] || { count: 0, total: 0 };
    byCategory[e.source_category].count += 1;
    byCategory[e.source_category].total += e.amount;
  });

  const money = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const categoryRows = Object.entries(byCategory)
    .map(([cat, v]) => `
      <tr>
        <td><span style="color:${CATEGORY_COLORS[cat as OnlineCategory]};font-weight:700">${cat}</span></td>
        <td style="text-align:right">${v.count}</td>
        <td style="text-align:right">${money(v.total)}</td>
        <td style="text-align:right">${((v.total / grandTotal) * 100).toFixed(1)}%</td>
      </tr>`)
    .join('');

  const dateSummaryRows = dates
    .map((d, i) => {
      const dayTotal = byDate[d].reduce((s, e) => s + e.amount, 0);
      const bg       = DATE_BG[i % 2];
      return `
      <tr style="background:${bg}">
        <td>${formatDisplayDate(d)}</td>
        <td style="text-align:right">${byDate[d].length}</td>
        <td style="text-align:right">${money(dayTotal)}</td>
        <td style="text-align:right">${(dayTotal / rate).toFixed(2)}</td>
      </tr>`;
    })
    .join('');

  const detailSections = dates
    .map((d, i) => {
      const bg       = DATE_BG[i % 2];
      const dayTotal = byDate[d].reduce((s, e) => s + e.amount, 0);
      const rowsHtml = byDate[d]
        .map((e) => `
      <tr style="background:${bg}">
        <td>${formatDisplayDate(e.statement_date)}</td>
        <td>${e.narration}</td>
        <td>${e.ref_no || ''}</td>
        <td><span style="color:${CATEGORY_COLORS[e.source_category]};font-weight:700">${e.source_category}</span></td>
        <td style="text-align:right">${money(e.amount)}</td>
      </tr>`)
        .join('');
      return (
        rowsHtml +
        `
      <tr style="background:${darken(bg)}">
        <td colspan="4" style="font-weight:700">Date Total — ${formatDisplayDate(d)}</td>
        <td style="text-align:right;font-weight:700">${money(dayTotal)}</td>
      </tr>`
      );
    })
    .join('');

  return `
  <html><head><meta charset="utf-8"/>
  <style>
    body{font-family:Helvetica,Arial,sans-serif;padding:24px;color:#222}
    h1{font-size:20px;margin-bottom:2px}
    .sub{font-size:11px;color:#555;margin-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:11px}
    th,td{border:1px solid #b0b0b0;padding:5px 6px}
    th{background:#263238;color:#fff;text-align:left}
    .overview td{padding:8px}
    .overview td:first-child{background:#eceff1;font-weight:700;width:55%}
    h2{font-size:14px;color:#263238;margin-top:22px;margin-bottom:6px}
    .grand td{background:#37474f;color:#fff;font-weight:700}
    .pagebreak{page-break-before:always}
    .note{font-size:9px;color:#666;margin-bottom:6px}
  </style></head><body>
  <h1>SHREEJEE GAS SERVICE — Online Payment Report</h1>
  <div class="sub">PAYTM / INDIAIDEAS / EURONET credits excluded from the Other Entries approval table</div>
  <table class="overview">
    <tr><td>Total Entries</td><td style="text-align:right">${entries.length}</td></tr>
    <tr><td>Distinct Dates</td><td style="text-align:right">${dates.length}</td></tr>
    <tr><td>Cylinder Rate Used</td><td style="text-align:right">₹${rate.toLocaleString('en-IN')}</td></tr>
    <tr><td>Grand Total (Rs.)</td><td style="text-align:right">${money(grandTotal)}</td></tr>
    <tr><td>Total Quantity (Amount ÷ Rate)</td><td style="text-align:right">${totalUnits.toFixed(2)}</td></tr>
  </table>
  <h2>Category-wise Totals</h2>
  <table>
    <tr><th>Category</th><th>Count</th><th>Total (Rs.)</th><th>% of Total</th></tr>
    ${categoryRows}
  </table>
  <h2>Date-wise Totals</h2>
  <div class="note">Quantity = Total Amount ÷ ₹${rate} (cylinder rate entered at export time)</div>
  <table>
    <tr><th>Date</th><th>Count</th><th>Total (Rs.)</th><th>Quantity</th></tr>
    ${dateSummaryRows}
    <tr class="grand">
      <td>GRAND TOTAL</td>
      <td style="text-align:right">${entries.length}</td>
      <td style="text-align:right">${money(grandTotal)}</td>
      <td style="text-align:right">${totalUnits.toFixed(2)}</td>
    </tr>
  </table>
  <div class="pagebreak"></div>
  <h1>Detailed Entries</h1>
  <div class="sub">Grouped by date, alternating highlight colors, per-date subtotals</div>
  <table>
    <tr><th>Date</th><th>Narration</th><th>Ref No</th><th>Category</th><th>Amount (Rs.)</th></tr>
    ${detailSections}
  </table>
  </body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BANK SELECTION MODAL
// ─────────────────────────────────────────────────────────────────────────────
interface BankSelectionModalProps {
  visible:  boolean;
  onSelect: (bank: BankType) => void;
  onClose:  () => void;
}

function BankSelectionModal({ visible, onSelect, onClose }: BankSelectionModalProps) {
  const banks: { id: BankType; label: string; subtitle: string; color: string; icon: string }[] = [
    {
      id: 'HDFC', label: 'HDFC Bank',
      subtitle: 'Excel / CSV statement from NetBanking',
      color: '#004C8F', icon: 'document-text-outline',
    },
    {
      id: 'ARVIND', label: 'Arvind Sahakari Bank',
      subtitle: 'PDF statement (not password protected)',
      color: '#1B5E20', icon: 'document-outline',
    },
    {
      id: 'AUB', label: 'Akola Urban Bank (AUB)',
      subtitle: 'PDF statement (password protected)',
      color: '#B71C1C', icon: 'lock-closed-outline',
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={[styles.popup, { paddingBottom: 16 }]}>
          <View style={styles.popupHeader}>
            <Text style={styles.popupTitle}>Select Bank</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeX}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
            Choose the bank whose statement you are importing. The correct parser
            will be applied automatically.
          </Text>
          {banks.map((bank) => (
            <TouchableOpacity
              key={bank.id}
              style={[bankModalStyles.bankCard, { borderLeftColor: bank.color }]}
              onPress={() => onSelect(bank.id)}
            >
              <View style={[bankModalStyles.iconBox, { backgroundColor: bank.color }]}>
                <Ionicons name={bank.icon as any} size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[bankModalStyles.bankLabel, { color: bank.color }]}>
                  {bank.label}
                </Text>
                <Text style={bankModalStyles.bankSub}>{bank.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#999" />
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const bankModalStyles = StyleSheet.create({
  bankCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f8f9fa', borderRadius: 10,
    padding: 12, marginBottom: 10, borderLeftWidth: 4, gap: 12,
  },
  iconBox:   { width: 36, height: 36, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  bankLabel: { fontSize: 14, fontWeight: '700' },
  bankSub:   { fontSize: 11, color: '#666', marginTop: 2 },
});

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD MODAL
// ─────────────────────────────────────────────────────────────────────────────
interface PasswordModalProps {
  visible:  boolean;
  onSubmit: (password: string) => void;
  onClose:  () => void;
  loading:  boolean;
}

function PasswordModal({ visible, onSubmit, onClose, loading }: PasswordModalProps) {
  const [pwd, setPwd] = useState('');
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.popup}>
          <View style={styles.popupHeader}>
            <Text style={styles.popupTitle}>AUB PDF Password</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeX}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
            The Akola Urban Bank PDF is password protected. Enter the password to
            decrypt and parse the statement.
          </Text>
          <Text style={styles.label}>Password *</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter PDF password"
            secureTextEntry
            value={pwd}
            onChangeText={setPwd}
            autoFocus
          />
          <TouchableOpacity
            style={[styles.submitButton, { marginTop: 16, opacity: loading ? 0.7 : 1 }]}
            onPress={() => onSubmit(pwd)}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>DECRYPT & PARSE</Text>
            }
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function OtherEntriesScreen() {
  const { currentUser } = useDataStore() as any;
  const isAdmin = currentUser?.username?.toLowerCase() === 'jitesh';

  const [loading,        setLoading]        = useState(false);
  const [importing,      setImporting]      = useState(false);
  const [pendingEntries, setPendingEntries] = useState<OtherEntryRow[]>([]);
  const [approvedCount,  setApprovedCount]  = useState(0);

  const [showCategoryPopup, setShowCategoryPopup] = useState(false);
  const [activeEntry,       setActiveEntry]        = useState<OtherEntryRow | null>(null);
  const [selectedCategory,  setSelectedCategory]   = useState<CategoryValue | null>(null);
  const [categoryNote,      setCategoryNote]        = useState('');
  const [savingApproval,    setSavingApproval]      = useState(false);

  const [excludedOnlineEntries, setExcludedOnlineEntries] = useState<ParsedOnlineRow[]>([]);
  const [showRatePopup,         setShowRatePopup]          = useState(false);
  const [cylinderRateInput,     setCylinderRateInput]      = useState('');
  const [generatingPdf,         setGeneratingPdf]          = useState(false);

  const [showBankModal,     setShowBankModal]     = useState(false);
  const [pendingPdfUri,     setPendingPdfUri]     = useState<string | null>(null);
  const [pendingFileName,   setPendingFileName]   = useState<string>('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordLoading,   setPasswordLoading]   = useState(false);

  useEffect(() => { loadEntries(); }, []);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_otherbankentries')
        .select('*')
        .eq('approved', false)
        .order('statement_date', { ascending: false });
      if (error) throw error;

      const seen    = new Set<string>();
      const deduped = ((data as OtherEntryRow[]) || []).filter((e) => {
        const key = `${e.statement_date}|${e.narration}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      setPendingEntries(deduped);

      const { count } = await supabase
        .from('dashboard_otherbankentries')
        .select('id', { count: 'exact', head: true })
        .eq('approved', true);
      setApprovedCount(count || 0);
    } catch (err: any) {
      Alert.alert('Load Error', err?.message || 'Failed to load entries');
    } finally {
      setLoading(false);
    }
  };

  const handleImportStatement = () => setShowBankModal(true);

  const handleBankSelected = async (bank: BankType) => {
    setShowBankModal(false);
    const isPdf = bank === 'ARVIND' || bank === 'AUB';
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: isPdf
          ? ['application/pdf']
          : [
              'text/csv',
              'text/comma-separated-values',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const fileUri  = result.assets[0].uri;
      const fileName = result.assets[0].name || '';

      if (bank === 'AUB') {
        setPendingPdfUri(fileUri);
        setPendingFileName(fileName);
        setShowPasswordModal(true);
      } else if (bank === 'ARVIND') {
        await processArvindPdf(fileUri, fileName);
      } else {
        await processHdfcFile(fileUri, fileName);
      }
    } catch (err: any) {
      Alert.alert('File Error', err?.message || 'Could not open file.');
    }
  };

  const processHdfcFile = async (fileUri: string, fileName: string) => {
    setImporting(true);
    try {
      const isXlsx = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
      let rows: string[][];
      if (isXlsx) {
        const b64 = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const workbook = XLSX.read(b64, { type: 'base64' });
        const ws       = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
      } else {
        const text = await FileSystem.readAsStringAsync(fileUri);
        rows = parseCSV(text);
      }
      const { otherRows, onlineRows } = parseHdfcRows(rows);
      if (otherRows.length === 0 && onlineRows.length === 0) {
        Alert.alert(
          'No Entries Found',
          'Could not find any entries. If HDFC\'s column headers differ from ' +
          '"Date / Narration / Withdrawal Amt. / Deposit Amt.", ' +
          'the parser needs updating for this format.'
        );
        return;
      }
      await finalizeImport(otherRows, onlineRows, fileName, 'HDFC');
    } catch (err: any) {
      Alert.alert('Import Error', err?.message || 'Failed to import HDFC statement.');
    } finally {
      setImporting(false);
    }
  };

  const processArvindPdf = async (fileUri: string, fileName: string) => {
    setImporting(true);
    try {
      const text = await readPdfText(fileUri);
      const { otherRows, onlineRows } = parsePdfStatementRows(text, 'ARVIND');
      if (otherRows.length === 0 && onlineRows.length === 0) {
        const length = text ? text.trim().length : 0;
        const sample = text ? text.trim().substring(0, 200).replace(/\s+/g, ' ') : '';
        Alert.alert(
          'No Entries Found',
          `Could not parse any entries from the Arvind Bank PDF.\n\n` +
          `• Extracted Characters: ${length}\n` +
          (length > 0
            ? `• Raw Sample: "${sample}..."`
            : `• Reason: The file contains no raw text streams. It may be a scanned copy, image-only format, or compressed with an unsupported filter.`)
        );
        return;
      }
      await finalizeImport(otherRows, onlineRows, fileName, 'ARVIND');
    } catch (err: any) {
      Alert.alert('Import Error', err?.message || 'Failed to parse Arvind Bank PDF.');
    } finally {
      setImporting(false);
    }
  };

  const processAubPdf = async (password: string) => {
    if (!pendingPdfUri) return;
    setPasswordLoading(true);
    try {
      const text = await readPdfText(pendingPdfUri, password);
      setShowPasswordModal(false);
      setPendingPdfUri(null);

      if (!text.trim()) {
        Alert.alert(
          'No Text Found',
          'The PDF was decrypted but no text could be extracted.\n\n' +
          'This usually means the PDF contains scanned images rather than ' +
          'digital text. Please ask your bank for a text-based statement.'
        );
        return;
      }
      const { otherRows, onlineRows } = parsePdfStatementRows(text, 'AUB');
      if (otherRows.length === 0 && onlineRows.length === 0) {
        Alert.alert(
          'No Entries Found',
          'PDF decrypted successfully but no transaction rows were found.\n\n' +
          'If the column layout has changed, the parser may need updating.'
        );
        return;
      }
      await finalizeImport(otherRows, onlineRows, pendingFileName, 'AUB');
    } catch (err: any) {
      Alert.alert('Decrypt / Parse Error', err?.message || 'Failed to process AUB PDF.');
    } finally {
      setPasswordLoading(false);
    }
  };

  // ───────────────────────────────────────────────────────────────────────
  // FIX: previously, re-importing a statement that contained an entry the
  // user had already approved would upsert that row again with
  // approved:false, silently un-approving it and making it reappear in the
  // "Awaiting Categorization" list. We now look up which (date, narration)
  // pairs are already approved in the DB BEFORE upserting, and skip those
  // rows entirely instead of overwriting them.
  // ───────────────────────────────────────────────────────────────────────
  const finalizeImport = async (
    otherRows:  ParsedStatementRow[],
    onlineRows: ParsedOnlineRow[],
    fileName:   string,
    bankSource: BankType
  ) => {
    let skippedAlreadyApproved = 0;
    let importedCount = 0;

    if (otherRows.length > 0) {
      const dates = Array.from(new Set(otherRows.map((r) => r.statement_date)));

      const { data: existingApproved, error: existingErr } = await supabase
        .from('dashboard_otherbankentries')
        .select('statement_date, narration')
        .eq('approved', true)
        .in('statement_date', dates);
      if (existingErr) throw existingErr;

      const approvedKeys = new Set(
        (existingApproved || []).map((e: any) => `${e.statement_date}|${e.narration}`)
      );

      const rowsToUpsert = otherRows.filter((r) => {
        const key = `${r.statement_date}|${r.narration}`;
        if (approvedKeys.has(key)) {
          skippedAlreadyApproved++;
          return false;
        }
        return true;
      });

      importedCount = rowsToUpsert.length;

      if (rowsToUpsert.length > 0) {
        const mappedRows = rowsToUpsert.map((r) => {
          const upperNarr = r.narration.toUpperCase();
          let category: CategoryValue | null = null;
          let approved = false;
          let approved_by: string | null = null;
          let approved_at: string | null = null;

          // Auto-Approval Rule 1: Cash deposits in Arvind Bank -> CASH_DEPOSIT
          if (
            bankSource === 'ARVIND' &&
            r.txn_type === 'CREDIT' &&
            upperNarr.includes('BY CASH')
          ) {
            category = 'CASH_DEPOSIT';
            approved = true;
            approved_by = 'system';
            approved_at = new Date().toISOString();
          }
          // Auto-Approval Rule 2: BPCL debits -> BPCL (Universal across all banks)
          else if (
            r.txn_type === 'DEBIT' &&
            upperNarr.includes('BEN: BHARAT PETROLEUM CORPN LIMITED')
          ) {
            category = 'BPCL';
            approved = true;
            approved_by = 'system';
            approved_at = new Date().toISOString();
          }

          return {
            statement_date:  r.statement_date,
            narration:       r.narration,
            ref_no:          r.ref_no,
            txn_type:        r.txn_type,
            amount:          r.amount,
            closing_balance: r.closing_balance,
            source_file:     fileName,
            bank_source:     bankSource,
            category,
            approved,
            approved_by,
            approved_at,
          };
        });

        const { error: upsertErr } = await supabase
          .from('dashboard_otherbankentries')
          .upsert(mappedRows, { onConflict: 'statement_date,narration' });

        if (upsertErr) throw upsertErr;
      }
    }

    await loadEntries();

    if (onlineRows.length > 0) {
      setExcludedOnlineEntries(onlineRows);
      setCylinderRateInput('');
      setShowRatePopup(true);
    } else {
      Alert.alert(
        'Import Successful ✓',
        `Bank: ${bankSource}\n` +
        `${importedCount} entries imported for review.\n` +
        (skippedAlreadyApproved > 0
          ? `${skippedAlreadyApproved} entries skipped (already approved earlier).\n`
          : '') +
        `(0 online-payment entries detected in this statement)`
      );
    }
  };

  const handleGeneratePdf = async () => {
    const rate = parseFloat(cylinderRateInput);
    if (!rate || rate <= 0) return Alert.alert('Error', 'Enter a valid cylinder rate');
    setGeneratingPdf(true);
    try {
      const html    = buildOnlinePaymentReportHtml(excludedOnlineEntries, rate);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Online Payment Report',
        });
      } else {
        Alert.alert('PDF Ready', `Saved to: ${uri}`);
      }
      setShowRatePopup(false);
      setExcludedOnlineEntries([]);
    } catch (err: any) {
      Alert.alert('PDF Error', err?.message || 'Failed to generate PDF');
    } finally {
      setGeneratingPdf(false);
    }
  };

  const openCategoryPopup = (entry: OtherEntryRow) => {
    setActiveEntry(entry);
    setSelectedCategory(entry.category);
    setCategoryNote(entry.category_note || '');
    setShowCategoryPopup(true);
  };

  const handleApprove = async () => {
    if (!activeEntry)     return;
    if (!selectedCategory) return Alert.alert('Error', 'Select a category');
    if (selectedCategory === 'OTHER' && !categoryNote.trim())
      return Alert.alert('Error', 'Add a short note describing this "Other" payment');

    setSavingApproval(true);
    try {
      const { error } = await supabase
        .from('dashboard_otherbankentries')
        .update({
          category:      selectedCategory,
          category_note: categoryNote.trim() || null,
          approved:      true,
          approved_by:   currentUser?.username || 'unknown',
          approved_at:   new Date().toISOString(),
        })
        .eq('id', activeEntry.id);
      if (error) throw error;
      setShowCategoryPopup(false);
      setActiveEntry(null);
      await loadEntries();
    } catch (err: any) {
      Alert.alert('Save Error', err?.message || 'Failed to save approval');
    } finally {
      setSavingApproval(false);
    }
  };

  const totalPendingAmount = pendingEntries.reduce((s, e) => s + e.amount, 0);

  const bankBadgeColor = (bank?: string) => {
    if (bank === 'ARVIND') return '#1B5E20';
    if (bank === 'AUB')    return '#B71C1C';
    return '#004C8F';
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Other Entries</Text>
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={loadEntries}
          disabled={loading}
        >
          <Ionicons name="refresh" size={20} color="#fff" style={loading ? { opacity: 0.4 } : {}} />
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={BPCL_BLUE} />
        </View>
      ) : (
        <ScrollView style={styles.scroll}>
          {isAdmin && (
            <View style={[styles.card, styles.adminCard]}>
              <View style={styles.adminHeader}>
                <Ionicons name="shield-checkmark" size={18} color="#9a3412" />
                <Text style={styles.adminTitle}>Import Bank Statement</Text>
              </View>
              <Text style={styles.subtext}>
                Supports HDFC Bank (Excel/CSV), Arvind Sahakari Bank (PDF) and
                Akola Urban Bank / AUB (password-protected PDF). PAYTM /
                INDIAIDEAS / EURONET entries are automatically separated into an
                Online Payment PDF report. Duplicate entries (same date +
                narration) are silently skipped, and already-approved entries
                are never re-added.
              </Text>

              <View style={styles.bankLegend}>
                {[
                  { label: 'HDFC',   color: '#004C8F' },
                  { label: 'ARVIND', color: '#1B5E20' },
                  { label: 'AUB',    color: '#B71C1C' },
                ].map((b) => (
                  <View key={b.label} style={[styles.bankLegendChip, { backgroundColor: b.color }]}>
                    <Text style={styles.bankLegendText}>{b.label}</Text>
                  </View>
                ))}
              </View>

              <TouchableOpacity
                style={[styles.csvButton, { backgroundColor: '#002E6E' }]}
                onPress={handleImportStatement}
                disabled={importing}
              >
                <Ionicons name="document-attach-outline" size={16} color="#fff" />
                <Text style={styles.csvButtonText}>Import Bank Statement</Text>
              </TouchableOpacity>

              {importing && (
                <View style={styles.csvLoader}>
                  <ActivityIndicator color={BPCL_BLUE} size="small" />
                  <Text style={styles.csvLoaderText}>Parsing & importing entries...</Text>
                </View>
              )}
            </View>
          )}

          <View style={styles.grandTotalCard}>
            <Text style={styles.grandTotalLabel}>Pending Approval</Text>
            <Text style={styles.grandTotalValue}>{pendingEntries.length} entries</Text>
            <Text style={styles.grandTotalSub}>₹{totalPendingAmount.toLocaleString('en-IN')}</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Awaiting Categorization</Text>
              <Text style={styles.approvedBadge}>{approvedCount} approved</Text>
            </View>

            {pendingEntries.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="checkmark-circle-outline" size={22} color="#15803d" />
                <Text style={styles.emptyText}>No entries waiting for approval.</Text>
              </View>
            ) : (
              pendingEntries.map((entry) => (
                <TouchableOpacity
                  key={entry.id}
                  style={styles.entryRow}
                  onPress={() => openCategoryPopup(entry)}
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.entryTopRow}>
                      <Text style={styles.entryDate}>
                        {format(new Date(entry.statement_date + 'T00:00:00'), 'dd MMM yyyy')}
                      </Text>
                      <View style={[
                        styles.txnBadge,
                        entry.txn_type === 'DEBIT' ? styles.debitBadge : styles.creditBadge,
                      ]}>
                        <Text style={styles.txnBadgeText}>{entry.txn_type}</Text>
                      </View>
                      {entry.bank_source && (
                        <View style={[
                          styles.txnBadge,
                          { backgroundColor: bankBadgeColor(entry.bank_source) },
                        ]}>
                          <Text style={[styles.txnBadgeText, { color: '#fff' }]}>
                            {entry.bank_source}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.entryNarration} numberOfLines={2}>
                      {entry.narration}
                    </Text>
                    {entry.ref_no
                      ? <Text style={styles.entryRef}>Ref: {entry.ref_no}</Text>
                      : null
                    }
                  </View>
                  <View style={styles.entryRight}>
                    <Text style={styles.entryAmount}>
                      ₹{entry.amount.toLocaleString('en-IN')}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color="#999" />
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* BANK SELECTION MODAL */}
      <BankSelectionModal
        visible={showBankModal}
        onSelect={handleBankSelected}
        onClose={() => setShowBankModal(false)}
      />

      {/* AUB PASSWORD MODAL */}
      <PasswordModal
        visible={showPasswordModal}
        onSubmit={processAubPdf}
        onClose={() => {
          setShowPasswordModal(false);
          setPendingPdfUri(null);
          setPendingFileName('');
        }}
        loading={passwordLoading}
      />

      {/* CATEGORY / APPROVAL POPUP */}
      {showCategoryPopup && activeEntry && (
        <View style={styles.overlay}>
          <View style={styles.popup}>
            <View style={styles.popupHeader}>
              <Text style={styles.popupTitle}>Categorize Entry</Text>
              <TouchableOpacity onPress={() => setShowCategoryPopup(false)}>
                <Text style={styles.closeX}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.popupNarration}>{activeEntry.narration}</Text>
            <Text style={styles.popupAmount}>
              {activeEntry.txn_type} · ₹{activeEntry.amount.toLocaleString('en-IN')} ·{' '}
              {format(new Date(activeEntry.statement_date + 'T00:00:00'), 'dd MMM yyyy')}
            </Text>
            <Text style={[styles.label, { marginTop: 14 }]}>Category *</Text>
            <View style={styles.categoryGrid}>
              {CATEGORY_OPTIONS.map((opt) => {
                const active = selectedCategory === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[
                      styles.categoryChip,
                      { borderColor: opt.color },
                      active && { backgroundColor: opt.color },
                    ]}
                    onPress={() => setSelectedCategory(opt.value)}
                  >
                    <Text style={[styles.categoryChipText, { color: active ? '#fff' : opt.color }]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={[styles.label, { marginTop: 14 }]}>
              Note {selectedCategory === 'OTHER' ? '*' : '(optional)'}
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Diesel bill for delivery vehicle"
              value={categoryNote}
              onChangeText={setCategoryNote}
            />
            <TouchableOpacity
              style={[styles.submitButton, { marginTop: 20 }]}
              onPress={handleApprove}
              disabled={savingApproval}
            >
              {savingApproval
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>APPROVE & SAVE</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* CYLINDER RATE / PDF EXPORT POPUP */}
      {showRatePopup && (
        <View style={styles.overlay}>
          <View style={styles.popup}>
            <View style={styles.popupHeader}>
              <Text style={styles.popupTitle}>Online Payment Report</Text>
              <TouchableOpacity onPress={() => setShowRatePopup(false)}>
                <Text style={styles.closeX}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.popupNarration}>
              {excludedOnlineEntries.length} PAYTM / INDIAIDEAS / EURONET entries found
              in this statement. Enter the cylinder rate to calculate quantities in the
              summary PDF.
            </Text>
            <Text style={[styles.label, { marginTop: 14 }]}>Cylinder Rate (₹) *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 950"
              keyboardType="numeric"
              value={cylinderRateInput}
              onChangeText={setCylinderRateInput}
            />
            <TouchableOpacity
              style={[styles.submitButton, { marginTop: 20 }]}
              onPress={handleGeneratePdf}
              disabled={generatingPdf}
            >
              {generatingPdf
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>GENERATE PDF</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    backgroundColor: BPCL_BLUE, padding: 20, paddingTop: 60,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  headerTitle:    { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  centered:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll:         { flex: 1 },
  card:           { backgroundColor: '#fff', margin: 12, padding: 16, borderRadius: 12, elevation: 2 },
  sectionHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle:   { fontSize: 16, fontWeight: 'bold', color: BPCL_BLUE },
  approvedBadge: {
    fontSize: 12, fontWeight: '600', color: '#15803d',
    backgroundColor: '#f0fdf4', borderColor: '#bbf7d0', borderWidth: 1,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
  },
  emptyBox:       { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#f0fdf4', padding: 12, borderRadius: 8 },
  emptyText:      { fontSize: 13, color: '#166534', fontWeight: '600' },
  entryRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  entryTopRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' },
  entryDate:      { fontSize: 12, fontWeight: '700', color: '#374151' },
  txnBadge:       { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  debitBadge:     { backgroundColor: '#fee2e2' },
  creditBadge:    { backgroundColor: '#dcfce7' },
  txnBadgeText:   { fontSize: 9, fontWeight: 'bold', color: '#374151' },
  entryNarration: { fontSize: 12, color: '#444', marginTop: 1 },
  entryRef:       { fontSize: 10, color: '#999', marginTop: 2 },
  entryRight:     { alignItems: 'flex-end', gap: 4, marginLeft: 8 },
  entryAmount:    { fontSize: 13, fontWeight: 'bold', color: BPCL_BLUE },
  grandTotalCard: { backgroundColor: BPCL_BLUE, margin: 12, padding: 20, borderRadius: 12, alignItems: 'center' },
  grandTotalLabel:{ fontSize: 14, color: 'rgba(255,255,255,0.8)', marginBottom: 4 },
  grandTotalValue:{ fontSize: 28, fontWeight: 'bold', color: '#fff' },
  grandTotalSub:  { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 4 },
  submitButton:   { backgroundColor: BPCL_BLUE, margin: 12, padding: 16, borderRadius: 12, alignItems: 'center' },
  submitText:     { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', zIndex: 999,
  },
  popup:          { backgroundColor: '#fff', borderRadius: 16, padding: 24, width: '88%', elevation: 10, maxHeight: '85%' },
  popupHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  popupTitle:     { fontSize: 17, fontWeight: 'bold', color: BPCL_BLUE },
  closeX:         { fontSize: 22, color: '#666', fontWeight: 'bold' },
  popupNarration: { fontSize: 13, color: '#333', marginBottom: 4 },
  popupAmount:    { fontSize: 12, color: '#777', marginBottom: 4 },
  label:          { fontSize: 14, fontWeight: '600', color: '#444', marginBottom: 6 },
  input:          { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 15 },
  categoryGrid:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip:   { borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  categoryChipText:{ fontSize: 12, fontWeight: '700' },
  refreshButton: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, gap: 6,
  },
  refreshText:    { color: '#fff', fontSize: 14, fontWeight: '600' },
  adminCard:      { backgroundColor: '#fffaf0', borderColor: '#fed7aa', borderWidth: 1 },
  adminHeader:    { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  adminTitle:     { fontSize: 15, fontWeight: 'bold', color: '#9a3412' },
  subtext:        { fontSize: 12, color: '#7c2d12', marginBottom: 14 },
  csvButton:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, gap: 6, elevation: 1 },
  csvButtonText:  { color: '#fff', fontSize: 13, fontWeight: '700' },
  csvLoader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 14, gap: 8 },
  csvLoaderText:  { fontSize: 12, color: '#c2410c', fontWeight: '600' },
  bankLegend:     { flexDirection: 'row', gap: 8, marginBottom: 12 },
  bankLegendChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  bankLegendText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
