// api/parse-bank-statement.ts
//
// Plain Node.js serverless function (Vercel's Node runtime — NOT the Edge
// runtime, so no Deno anywhere in this file). Uses the standard `pdf-parse`
// npm package to extract text from the uploaded PDF, then parses it into
// structured transaction rows.
//
// Install:
//   npm install pdf-parse
//   npm install -D @vercel/node
//
// Deploy: just push this file inside an /api folder at your project root —
// Vercel auto-detects it. No extra config needed for a basic setup.
//
// Client call (see app/other-entries.tsx):
//   fetch(`${PARSE_API_URL}`, { method: 'POST', body: JSON.stringify({ fileBase64, fileName }) })
//
// NOTE ON PARSING: tuned to the HDFC "Statement of Account" export used
// here, where each transaction also appears as a single flattened text
// line in the form:
//   DD/MM/YY  <narration...>  <RefNo>  DD/MM/YY  [withdrawal]  [deposit]  <closing balance>
// If you switch banks / statement formats, only the LINE_RE regex below
// needs to change.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PDFParse } from 'pdf-parse';

// NOTE: Vercel Serverless Functions (this file — plain /api, not a Next.js
// pages/api route) enforce a HARD, non-configurable 4.5MB request body
// limit at the platform level. There is no `config.api.bodyParser`
// override for this (that pattern only works inside actual Next.js
// projects). If your bank statement PDFs are typically small text-based
// exports, base64-encoding still fits comfortably under 4.5MB. If you
// start hitting genuinely large / scanned PDFs, you'll need to upload the
// file to storage (e.g. Supabase Storage) first and have this function
// fetch it by URL instead of receiving it inline — ask if you want that
// version.// Skip anything already handled by the Online Payment tab.
const EXCLUDE_KEYWORDS = ['PAYTM', 'INDIAIDEAS', 'EURONET'];

const LINE_RE =
  /^(\d{2}\/\d{2}\/\d{2})\s+(.+?)\s+([A-Za-z0-9]{6,30})\s+(\d{2}\/\d{2}\/\d{2})\s+(?:([\d,]+\.\d{2})\s+)?(?:([\d,]+\.\d{2})\s+)?(-?[\d,]+\.\d{2})\s*$/;

interface ParsedRow {
  statement_date: string; // YYYY-MM-DD
  narration: string;
  ref_no: string | null;
  txn_type: 'DEBIT' | 'CREDIT';
  amount: number;
  closing_balance: number | null;
}

function toIsoDate(ddmmyy: string): string {
  const [dd, mm, yy] = ddmmyy.split('/');
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm}-${dd}`;
}

function toNumber(v?: string): number | null {
  if (!v) return null;
  const n = parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseStatementText(rawText: string): ParsedRow[] {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: ParsedRow[] = [];

  for (const line of lines) {
    const match = line.match(LINE_RE);
    if (!match) continue;

    const [, dateStr, narrationRaw, refNo, , withdrawalStr, depositStr, closingStr] = match;
    const narration = narrationRaw.replace(/\s+/g, ' ').trim();

    const upperNarration = narration.toUpperCase();
    if (EXCLUDE_KEYWORDS.some((kw) => upperNarration.includes(kw))) continue;

    const withdrawal = toNumber(withdrawalStr);
    const deposit = toNumber(depositStr);
    const closingBalance = toNumber(closingStr);

    if (withdrawal == null && deposit == null) continue;

    rows.push({
      statement_date: toIsoDate(dateStr),
      narration,
      ref_no: refNo || null,
      txn_type: withdrawal != null ? 'DEBIT' : 'CREDIT',
      amount: withdrawal != null ? withdrawal : (deposit as number),
      closing_balance: closingBalance,
    });
  }

  // The same statement often repeats each row once in a "table" layout and
  // once in a "flattened" layout — keep first occurrence only.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.statement_date}|${r.ref_no}|${r.amount}|${r.txn_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Basic CORS so the Expo app (dev + prod) can call this directly.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { fileBase64, fileName } = req.body as { fileBase64?: string; fileName?: string };
    if (!fileBase64) {
      res.status(400).json({ error: 'fileBase64 is required' });
      return;
    }

    const buffer = Buffer.from(fileBase64, 'base64');
    const parser = new PDFParse({ data: buffer });
    let text: string;
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy();
    }
    const rows = parseStatementText(text);

    res.status(200).json({
      fileName: fileName ?? null,
      totalParsed: rows.length,
      rows,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to parse PDF';
    res.status(500).json({ error: message });
  }
}
