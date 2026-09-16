import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
// Remove `Share,` from this line if unused:
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, RefreshControl, Platform, Modal, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '@/lib/supabase';
import { format } from 'date-fns';
import DateTimePicker from '@react-native-community/datetimepicker';
import { captureRef } from 'react-native-view-shot';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

const BPCL_BLUE  = '#017DC5';
const BPCL_YELLOW = '#FFDC02';
const DICT_START = '2019-07-31';

type Mode = 'register' | 'jd';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegCyl {
  prev_full: number; prev_empty: number;
  add_full: number; total_refill: number;
  total_nc: number; total_dbc: number; total_tv: number; total_tv_out: number;
  borrow_full: number; borrow_empty: number;
  empty_received: number; empty_sent: number;
  closing_full: number; closing_empty: number;
  calc_full: number; full_match: boolean;
  remarks: string;
}

interface RegComm {
  prev_full: number; prev_empty: number;
  from_bpcl: number; delivered: number;
  empty_received: number; empty_sent: number;
  borrow_full: number; borrow_empty: number;
  closing_full: number; closing_empty: number;
  calc_full: number; full_match: boolean;
  remarks: string;
}

interface RegGodown {
  prev_full: number; prev_empty: number;
  from_bpcl: number; sent_to_office: number; recv_from_office: number;
  empty_from_office: number; empty_sent: number;
  borrow_full: number; borrow_empty: number;
  closing_full: number; closing_empty: number;
  calc_full: number; calc_empty: number;
  full_match: boolean; empty_match: boolean;
  empty_is_estimated: boolean;
  remarks: string;
}

interface RegOffice {
  prev_full: number; prev_empty: number;
  add_stock: number; refill: number; nc: number; to_godown: number;
  borrow_full: number; borrow_empty: number;
  closing_full: number; closing_empty: number;
  calc_full: number; calc_empty: number;
  full_match: boolean; empty_match: boolean; remarks: string;
}

interface JD14 {
  opening_full: number; supply_bpcl: number;
  borrowed_full: number; given_full: number;
  total_full: number; deliveries: number; closing_full: number; stored_full: number; full_match: boolean;
  opening_empty: number; empty_received: number;
  borrowed_empty: number; given_empty: number;
  total_empty: number; returned_bpcl: number; closing_empty: number; stored_empty: number;
  total_nc: number; total_dbc: number; total_tv: number; total_tv_out: number;
  running_dict: Record<string, number>;
  dict_entries: Record<string, { date: string; qty: number }[]>;
  remarks: string;
}

interface JD19 {
  opening_full: number; supply_bpcl: number;
  borrowed_full: number; given_full: number;
  total_full: number; deliveries: number; closing_full: number; stored_full: number; full_match: boolean;
  opening_empty: number; empty_received: number;
  borrowed_empty: number; given_empty: number;
  total_empty: number; returned_bpcl: number; closing_empty: number; stored_empty: number;
  customer_shortage: { name: string; delivered: number; empty: number; diff: number }[];
  running_dict: Record<string, number>;
  dict_entries: Record<string, { date: string; qty: number }[]>;
  remarks: string;
}

interface JD5 {
  g_open_full: number; g_supply: number; g_borrow_full: number; g_given_full: number;
  g_total_full: number; g_sent_office: number; g_recv_office: number;
  g_calc_full: number; g_stored_full: number; g_full_match: boolean;
  g_open_empty: number; g_recv_office_empty: number; g_borrow_empty: number; g_given_empty: number;
  g_total_empty: number; g_returned: number; g_calc_empty: number; g_stored_empty: number; g_empty_match: boolean;
  g_remarks: string;
  o_open_full: number; o_add_stock: number; o_borrow_full: number; o_given_full: number;
  o_total_full: number; o_nc: number; o_calc_full: number; o_stored_full: number; o_full_match: boolean;
  o_open_empty: number; o_refill: number; o_borrow_empty: number; o_given_empty: number;
  o_total_empty: number; o_to_godown: number; o_calc_empty: number; o_stored_empty: number; o_empty_match: boolean;
  o_remarks: string;
  running_dict: Record<string, number>;
  dict_entries: Record<string, { date: string; qty: number }[]>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Normalise key: uppercase, collapse spaces → "DGS (FULL)"
const normaliseKey = (raw: string): string =>
  raw.trim().toUpperCase().replace(/\s+/g, ' ');

// Parse "DGS (FULL): 150; MANGALAM (EMPTY): -76" → { "DGS (FULL)": 150, ... }
const parseBorrow = (remarks: string): Record<string, number> => {
  const result: Record<string, number> = {};
  if (!remarks) return result;
  const regex = /([A-Za-z0-9\s]+\(\s*(?:FULL|EMPTY)\s*\))\s*:\s*(-?\d+)/gi;
  let m;
  while ((m = regex.exec(remarks)) !== null) {
    const key = normaliseKey(m[1]);
    result[key] = parseInt(m[2], 10);
  }
  return result;
};

const sumType = (dict: Record<string, number>, type: 'FULL' | 'EMPTY', sign: '+' | '-'): number =>
  Object.entries(dict)
    .filter(([k, v]) => k.includes(`(${type})`) && (sign === '+' ? v > 0 : v < 0))
    .reduce((s, [, v]) => s + v, 0);

// Build running dict + per-key entries from DICT_START to date
const buildDict = async (
  table: string, toDate: string
): Promise<{ dict: Record<string, number>; entries: Record<string, { date: string; qty: number }[]> }> => {
  const { data } = await supabase
    .from(table).select('date,remarks')
    .gte('date', DICT_START).lte('date', toDate)
    .order('date', { ascending: true });
  const dict: Record<string, number> = {};
  const entries: Record<string, { date: string; qty: number }[]> = {};
  for (const row of data || []) {
    const parsed = parseBorrow(row.remarks || '');
    for (const [k, v] of Object.entries(parsed)) {
      dict[k] = (dict[k] || 0) + v;
      if (!entries[k]) entries[k] = [];
      entries[k].push({ date: row.date, qty: v });
    }
  }
  return { dict, entries };
};

const parseRemarksForBorrowFull  = (r: string) => sumType(parseBorrow(r), 'FULL', '+');
const parseRemarksForBorrowEmpty = (r: string) => sumType(parseBorrow(r), 'EMPTY', '+');
const parseRemarksForGivenFull   = (r: string) => Math.abs(sumType(parseBorrow(r), 'FULL', '-'));
const parseRemarksForGivenEmpty  = (r: string) => Math.abs(sumType(parseBorrow(r), 'EMPTY', '-'));

// ─── Sub Components ───────────────────────────────────────────────────────────

const SummaryRow = ({ label, value, indent, bold, color, separator }: {
  label: string; value: string | number;
  indent?: boolean; bold?: boolean; color?: string; separator?: boolean;
}) => (
  <View style={[styles.summaryRow, separator && styles.summaryRowSeparator]}>
    <Text style={[styles.summaryLabel, indent && styles.summaryLabelIndent, bold && styles.summaryLabelBold]}>{label}</Text>
    <Text style={[styles.summaryValue, bold && styles.summaryValueBold, color ? { color } : {}]}>{value}</Text>
  </View>
);

const MatchBadge = ({ match, label }: { match: boolean; label: string }) => (
  <View style={[styles.matchBadge, { backgroundColor: match ? '#e8f5e9' : '#ffebee' }]}>
    <Ionicons name={match ? 'checkmark-circle' : 'close-circle'} size={16} color={match ? '#27ae60' : '#e74c3c'} />
    <Text style={[styles.matchBadgeText, { color: match ? '#27ae60' : '#e74c3c' }]}>
      {label}: {match ? 'Verified ✓' : 'Mismatch ✗'}
    </Text>
  </View>
);

const NoDataCard = ({ title }: { title: string }) => (
  <View style={styles.noDataCard}>
    <Ionicons name="alert-circle-outline" size={32} color="#ccc" />
    <Text style={styles.noDataText}>No stock entry for {title}</Text>
    <Text style={styles.noDataSubText}>Go to Stock tab to add entry</Text>
  </View>
);

// One entry row + its running cumulative total, computed for the modal list.
interface DictEntryRow {
  date: string;
  qty: number;
  cumulative: number;
}

// Clickable running dictionary — alphabetical, modal on press
const DictSection = ({
  dict, entries,
}: {
  dict: Record<string, number>;
  entries: Record<string, { date: string; qty: number }[]>;
}) => {
  const [modalKey, setModalKey] = useState<string | null>(null);
  const nonZero = Object.entries(dict)
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (nonZero.length === 0) return null;

  // Entries for the open key, in date order, each carrying a running
  // cumulative total (e.g. +26, then -56 → cumulative -30, then +28 →
  // cumulative -2). Recomputed whenever the selected key or its entries
  // change — cheap since a single customer's history is a short list.
  const modalRows: DictEntryRow[] = useMemo(() => {
    if (!modalKey) return [];
    const list = entries[modalKey] || [];
    let running = 0;
    return list.map((e) => {
      running += e.qty;
      return { date: e.date, qty: e.qty, cumulative: running };
    });
  }, [modalKey, entries]);

  return (
    <View style={styles.dictBox}>
      <Text style={styles.dictTitle}>📋 Running Balance (from {DICT_START})</Text>
      {nonZero.map(([key, val]) => (
        <TouchableOpacity key={key} style={styles.dictRow} onPress={() => setModalKey(key)}>
          <Text style={styles.dictKey}>{key}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.dictVal, { color: val > 0 ? '#27ae60' : '#e74c3c' }]}>
              {val > 0 ? '+' : ''}{val}
            </Text>
            <Ionicons name="chevron-forward" size={14} color="#aaa" />
          </View>
        </TouchableOpacity>
      ))}

      {/* Detail Modal */}
      <Modal visible={!!modalKey} transparent animationType="slide" onRequestClose={() => setModalKey(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{modalKey}</Text>
              <TouchableOpacity onPress={() => setModalKey(null)} style={styles.modalClose}>
                <Ionicons name="close" size={22} color="#666" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSubtitle}>All entries from {DICT_START}</Text>

            {/* Column header */}
            <View style={styles.modalColHeaderRow}>
              <Text style={[styles.modalColHeaderText, { flex: 1.3 }]}>Date</Text>
              <Text style={[styles.modalColHeaderText, styles.modalColRight]}>Change</Text>
              <Text style={[styles.modalColHeaderText, styles.modalColRight]}>Cumulative</Text>
            </View>

            <FlatList
              data={modalRows}
              keyExtractor={(_, i) => String(i)}
              renderItem={({ item }) => (
                <View style={styles.modalRow}>
                  <Text style={[styles.modalDate, { flex: 1.3 }]}>
                    {format(new Date(item.date + 'T00:00:00'), 'dd MMM yyyy')}
                  </Text>
                  <Text style={[styles.modalQty, styles.modalColRight, { color: item.qty > 0 ? '#27ae60' : '#e74c3c' }]}>
                    {item.qty > 0 ? '+' : ''}{item.qty}
                  </Text>
                  <Text style={[styles.modalCumulative, styles.modalColRight, { color: item.cumulative > 0 ? '#27ae60' : item.cumulative < 0 ? '#e74c3c' : '#666' }]}>
                    {item.cumulative > 0 ? '+' : ''}{item.cumulative}
                  </Text>
                </View>
              )}
              ListEmptyComponent={<Text style={{ color: '#999', textAlign: 'center', padding: 16 }}>No entries found</Text>}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SummaryScreen() {
  const [selectedDate,   setSelectedDate]   = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [mode,           setMode]           = useState<Mode>('register');
  const [loading,        setLoading]        = useState(false);
  const [refreshing,     setRefreshing]     = useState(false);
  const [sharing,        setSharing]        = useState(false);

  const [reg142,    setReg142]    = useState<RegCyl | null>(null);
  const [reg19,     setReg19]     = useState<RegComm | null>(null);
  const [regGodown, setRegGodown] = useState<RegGodown | null>(null);
  const [regOffice, setRegOffice] = useState<RegOffice | null>(null);

  const [jd14, setJd14] = useState<JD14 | null>(null);
  const [jd19, setJd19] = useState<JD19 | null>(null);
  const [jd5,  setJd5]  = useState<JD5 | null>(null);

  const scrollRef  = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);

  const fetchAll = useCallback(async (date: string, m: Mode) => {
    try {
      if (m === 'register') {
        await Promise.all([fetchReg142(date), fetchReg19(date), fetchRegGodown(date), fetchRegOffice(date)]);
      } else {
        await Promise.all([fetchJD14(date), fetchJD19(date), fetchJD5(date)]);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAll(selectedDate, mode).finally(() => setLoading(false));
  }, [selectedDate, mode, fetchAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll(selectedDate, mode);
    setRefreshing(false);
  }, [selectedDate, mode, fetchAll]);

  // ─── Register Fetches ──────────────────────────────────────────────────────

  const fetchReg142 = async (date: string) => {
    const { data: td } = await supabase.from('dashboard_cylinderstocksachin').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: pd } = await supabase.from('dashboard_cylinderstocksachin').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();
    if (!td) { setReg142(null); return; }
    const pf = pd?.closing_full || 0, pe = pd?.closing_empty || 0;
    const bf = parseRemarksForBorrowFull(td.remarks || '');
    const be = parseRemarksForBorrowEmpty(td.remarks || '');
    const calc = pf + (td.add_full || 0) - (td.total_refill || 0) + bf;
    const emptyRec = td.total_refill || 0;
    const emptySent = Math.max(0, (td.opening_empty || 0) + emptyRec + be - (td.closing_empty || 0));
    setReg142({ prev_full: pf, prev_empty: pe, add_full: td.add_full || 0, total_refill: td.total_refill || 0, total_nc: td.total_nc || 0, total_dbc: td.total_dbc || 0, total_tv: td.total_tv || 0, total_tv_out: td.total_tv_out || 0, borrow_full: bf, borrow_empty: be, empty_received: emptyRec, empty_sent: emptySent, closing_full: td.closing_full || 0, closing_empty: td.closing_empty || 0, calc_full: calc, full_match: calc === (td.closing_full || 0), remarks: td.remarks || '' });
  };

  const fetchReg19 = async (date: string) => {
    const { data: td } = await supabase.from('dashboard_commercialstocksachin').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: pd } = await supabase.from('dashboard_commercialstocksachin').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();
    if (!td) { setReg19(null); return; }
    const pf = pd?.closing_full || 0, pe = pd?.closing_empty || 0;
    const bf = parseRemarksForBorrowFull(td.remarks || '');
    const be = parseRemarksForBorrowEmpty(td.remarks || '');
    const calc = pf + (td.from_bpcl || 0) - (td.cylinder_delivered || 0) + bf;
    const emptySent = Math.max(0, pe + (td.empty_received || 0) + be - (td.closing_empty || 0));
    setReg19({ prev_full: pf, prev_empty: pe, from_bpcl: td.from_bpcl || 0, delivered: td.cylinder_delivered || 0, empty_received: td.empty_received || 0, empty_sent: emptySent, borrow_full: bf, borrow_empty: be, closing_full: td.closing_full || 0, closing_empty: td.closing_empty || 0, calc_full: calc, full_match: calc === (td.closing_full || 0), remarks: td.remarks || '' });
  };

  // 5 KG GODOWN — Register
  // NOTE: Godown's empty-cylinder inflow comes from Office's "to_godown" field
  // (empties Office ships back to Godown), NOT from "received_from_office" —
  // that field is the FULL-cylinder handoff and was being reused incorrectly
  // for empties before, which broke the empty count entirely. We now pull the
  // matching Office row for the same date to get the real empty inflow.
  const fetchRegGodown = async (date: string) => {
    const { data: td } = await supabase.from('dashboard_godownftlstocksachin').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: pd } = await supabase.from('dashboard_godownftlstocksachin').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();
    const { data: otd } = await supabase.from('dashboard_officeftlstocksachin').select('to_godown').eq('date', date).order('id', { ascending: false }).limit(1).single();
    if (!td) { setRegGodown(null); return; }

    const pf = pd?.closing_full || 0, pe = pd?.closing_empty || 0;
    const bf = parseRemarksForBorrowFull(td.remarks || '');
    const be = parseRemarksForBorrowEmpty(td.remarks || '');
    const emptyFromOffice = otd?.to_godown || 0;

    const calcFull = pf + (td.from_bpcl || 0) - (td.sent_to_office || 0) + (td.received_from_office || 0) + bf;

    // There is no explicit "empty cylinders sent out by Godown" field in this
    // table, so empty_sent is still derived (a plug) rather than an
    // independently-verified figure. empty_is_estimated flags this in the UI
    // so it isn't shown as a false "Verified" match.
    const totalEmpty = pe + emptyFromOffice + be;
    const emptySent = Math.max(0, totalEmpty - (td.closing_empty || 0));
    const calcEmpty = totalEmpty - emptySent;

    setRegGodown({
      prev_full: pf, prev_empty: pe,
      from_bpcl: td.from_bpcl || 0, sent_to_office: td.sent_to_office || 0, recv_from_office: td.received_from_office || 0,
      empty_from_office: emptyFromOffice, empty_sent: emptySent,
      borrow_full: bf, borrow_empty: be,
      closing_full: td.closing_full || 0, closing_empty: td.closing_empty || 0,
      calc_full: calcFull, calc_empty: calcEmpty,
      full_match: calcFull === (td.closing_full || 0),
      empty_match: calcEmpty === (td.closing_empty || 0),
      empty_is_estimated: true,
      remarks: td.remarks || '',
    });
  };

  const fetchRegOffice = async (date: string) => {
    const { data: td } = await supabase.from('dashboard_officeftlstocksachin').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: pd } = await supabase.from('dashboard_officeftlstocksachin').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();
    if (!td) { setRegOffice(null); return; }
    const pf = pd?.closing_full || 0, pe = pd?.closing_empty || 0;
    const bf = parseRemarksForBorrowFull(td.remarks || '');
    const be = parseRemarksForBorrowEmpty(td.remarks || '');
    const calcF = pf + (td.add_office_stock || 0) - (td.refill || 0) - (td.new_connection || 0) + bf;
    const calcE = pe - (td.to_godown || 0) + (td.refill || 0) + be;
    setRegOffice({ prev_full: pf, prev_empty: pe, add_stock: td.add_office_stock || 0, refill: td.refill || 0, nc: td.new_connection || 0, to_godown: td.to_godown || 0, borrow_full: bf, borrow_empty: be, closing_full: td.closing_full || 0, closing_empty: td.closing_empty || 0, calc_full: calcF, calc_empty: calcE, full_match: calcF === (td.closing_full || 0), empty_match: calcE === (td.closing_empty || 0), remarks: td.remarks || '' });
  };

  // ─── JD Fetches ────────────────────────────────────────────────────────────

  const fetchJD14 = async (date: string) => {
    const { data: td } = await supabase.from('dashboard_cylinderstock').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: pd } = await supabase.from('dashboard_cylinderstock').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();
    if (!td) { setJd14(null); return; }

    const openFull  = pd?.closing_full  || 0;
    const openEmpty = pd?.closing_empty || 0;
    const bf = parseRemarksForBorrowFull(td.remarks || '');
    const gf = parseRemarksForGivenFull(td.remarks || '');
    const be = parseRemarksForBorrowEmpty(td.remarks || '');
    const ge = parseRemarksForGivenEmpty(td.remarks || '');

    const totalFull  = openFull  + (td.add_full    || 0) + bf;
    const deliveries = td.total_refill || 0;
    const calcFull   = totalFull - deliveries - gf;

    const totalEmpty = openEmpty + deliveries + be;          // empty received = refill delivered
    const returnedBpcl = Math.max(0, totalEmpty - ge - (td.closing_empty || 0));
    const calcEmpty  = totalEmpty - ge - returnedBpcl;

    const { dict, entries } = await buildDict('dashboard_cylinderstock', date);

    setJd14({
      opening_full: openFull, supply_bpcl: td.add_full || 0,
      borrowed_full: bf, given_full: gf,
      total_full: totalFull, deliveries, closing_full: calcFull,
      stored_full: td.closing_full || 0, full_match: calcFull === (td.closing_full || 0),
      opening_empty: openEmpty, empty_received: deliveries,
      borrowed_empty: be, given_empty: ge,
      total_empty: totalEmpty, returned_bpcl: returnedBpcl,
      closing_empty: calcEmpty, stored_empty: td.closing_empty || 0,
      total_nc: td.total_nc || 0, total_dbc: td.total_dbc || 0,
      total_tv: td.total_tv || 0, total_tv_out: td.total_tv_out || 0,
      running_dict: dict, dict_entries: entries, remarks: td.remarks || '',
    });
  };

  const fetchJD19 = async (date: string) => {
    const { data: td } = await supabase.from('dashboard_commercialstock').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: pd } = await supabase.from('dashboard_commercialstock').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();

    // Count deliveries and empties from commercialrecords
    const { data: delRows }   = await supabase.from('dashboard_commercialrecords').select('customer_name').eq('delivery_date', date);
    const { data: emptyRows } = await supabase.from('dashboard_commercialrecords').select('customer_name').eq('empty_received', date);

    if (!td) { setJd19(null); return; }

    const openFull  = pd?.closing_full  || 0;
    const openEmpty = pd?.closing_empty || 0;
    const bf = parseRemarksForBorrowFull(td.remarks || '');
    const gf = parseRemarksForGivenFull(td.remarks || '');
    const be = parseRemarksForBorrowEmpty(td.remarks || '');
    const ge = parseRemarksForGivenEmpty(td.remarks || '');

    const totalDeliveries = (delRows || []).length;
    const totalEmptyRec   = (emptyRows || []).length;

    const totalFull  = openFull  + (td.from_bpcl || 0) + bf;
    const calcFull   = totalFull - totalDeliveries - gf;
    const totalEmpty = openEmpty + totalEmptyRec + be;
    const returnedBpcl = Math.max(0, totalEmpty - ge - (td.closing_empty || 0));
    const calcEmpty  = totalEmpty - ge - returnedBpcl;

    // Customer shortage — normalise name case
    const custMap: Record<string, { delivered: number; empty: number }> = {};
    for (const r of delRows || []) {
      const n = (r.customer_name || '').trim().toUpperCase();
      if (!custMap[n]) custMap[n] = { delivered: 0, empty: 0 };
      custMap[n].delivered += 1;
    }
    for (const r of emptyRows || []) {
      const n = (r.customer_name || '').trim().toUpperCase();
      if (!custMap[n]) custMap[n] = { delivered: 0, empty: 0 };
      custMap[n].empty += 1;
    }
    const customerShortage = Object.entries(custMap)
      .map(([name, v]) => ({ name, delivered: v.delivered, empty: v.empty, diff: v.delivered - v.empty }))
      .filter(r => r.diff !== 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    const { dict, entries } = await buildDict('dashboard_commercialstock', date);

    setJd19({
      opening_full: openFull, supply_bpcl: td.from_bpcl || 0,
      borrowed_full: bf, given_full: gf,
      total_full: totalFull, deliveries: totalDeliveries,
      closing_full: calcFull, stored_full: td.closing_full || 0,
      full_match: calcFull === (td.closing_full || 0),
      opening_empty: openEmpty, empty_received: totalEmptyRec,
      borrowed_empty: be, given_empty: ge,
      total_empty: totalEmpty, returned_bpcl: returnedBpcl,
      closing_empty: calcEmpty, stored_empty: td.closing_empty || 0,
      customer_shortage: customerShortage,
      running_dict: dict, dict_entries: entries, remarks: td.remarks || '',
    });
  };

  // 5 KG (GODOWN + OFFICE) — JD Entry
  // NOTE: Office ships empties back to Godown via `to_godown`. Godown's empty
  // total previously never added this inflow, so Godown's closing empty could
  // never reconcile. Fixed below: g_recv_office_empty = otd.to_godown, folded
  // into g_total_empty, and g_empty_match is now computed and surfaced.
  const fetchJD5 = async (date: string) => {
    const { data: gtd } = await supabase.from('dashboard_godownftlstock').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: gpd } = await supabase.from('dashboard_godownftlstock').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();
    const { data: otd } = await supabase.from('dashboard_officeftlstock').select('*').eq('date', date).order('id', { ascending: false }).limit(1).single();
    const { data: opd } = await supabase.from('dashboard_officeftlstock').select('closing_full,closing_empty').lt('date', date).order('date', { ascending: false }).limit(1).single();

    if (!gtd && !otd) { setJd5(null); return; }

    // Godown
    const gOpenF = gpd?.closing_full  || 0;
    const gOpenE = gpd?.closing_empty || 0;
    const gBF = parseRemarksForBorrowFull(gtd?.remarks  || '');
    const gGF = parseRemarksForGivenFull(gtd?.remarks   || '');
    const gBE = parseRemarksForBorrowEmpty(gtd?.remarks || '');
    const gGE = parseRemarksForGivenEmpty(gtd?.remarks  || '');
    const gRecvOfficeEmpty = otd?.to_godown || 0; // empties Office sends back to Godown
    const gTotalF = gOpenF + (gtd?.from_bpcl || 0) + gBF;
    const gCalcF  = gTotalF - (gtd?.sent_to_office || 0) + (gtd?.received_from_office || 0) - gGF;
    const gTotalE = gOpenE + gRecvOfficeEmpty + gBE;
    const gReturned = Math.max(0, gTotalE - gGE - (gtd?.closing_empty || 0));
    const gCalcE  = gTotalE - gGE - gReturned;

    // Office
    const oOpenF = opd?.closing_full  || 0;
    const oOpenE = opd?.closing_empty || 0;
    const oBF = parseRemarksForBorrowFull(otd?.remarks  || '');
    const oGF = parseRemarksForGivenFull(otd?.remarks   || '');
    const oBE = parseRemarksForBorrowEmpty(otd?.remarks || '');
    const oGE = parseRemarksForGivenEmpty(otd?.remarks  || '');
    const oTotalF = oOpenF + (otd?.add_office_stock || 0) + oBF;
    const oCalcF  = oTotalF - (otd?.new_connection || 0) - oGF;
    const oTotalE = oOpenE + (otd?.refill || 0) + oBE;
    const oCalcE  = oTotalE - (otd?.to_godown || 0) - oGE;

    // Running dict from both Godown and Office tables, merged
    const { dict: gDict, entries: gEntries } = await buildDict('dashboard_godownftlstock', date);
    const { dict: oDict, entries: oEntries } = await buildDict('dashboard_officeftlstock', date);

    // Merge dicts
    const combined: Record<string, number> = { ...gDict };
    const combinedEntries: Record<string, { date: string; qty: number }[]> = { ...gEntries };
    for (const [k, v] of Object.entries(oDict)) {
      combined[k] = (combined[k] || 0) + v;
      combinedEntries[k] = [...(combinedEntries[k] || []), ...(oEntries[k] || [])].sort((a, b) => a.date.localeCompare(b.date));
    }

    setJd5({
      g_open_full: gOpenF, g_supply: gtd?.from_bpcl || 0, g_borrow_full: gBF, g_given_full: gGF,
      g_total_full: gTotalF, g_sent_office: gtd?.sent_to_office || 0, g_recv_office: gtd?.received_from_office || 0,
      g_calc_full: gCalcF, g_stored_full: gtd?.closing_full || 0, g_full_match: gCalcF === (gtd?.closing_full || 0),
      g_open_empty: gOpenE, g_recv_office_empty: gRecvOfficeEmpty, g_borrow_empty: gBE, g_given_empty: gGE,
      g_total_empty: gTotalE, g_returned: gReturned, g_calc_empty: gCalcE, g_stored_empty: gtd?.closing_empty || 0,
      g_empty_match: gCalcE === (gtd?.closing_empty || 0),
      g_remarks: gtd?.remarks || '',
      o_open_full: oOpenF, o_add_stock: otd?.add_office_stock || 0, o_borrow_full: oBF, o_given_full: oGF,
      o_total_full: oTotalF, o_nc: otd?.new_connection || 0, o_calc_full: oCalcF,
      o_stored_full: otd?.closing_full || 0, o_full_match: oCalcF === (otd?.closing_full || 0),
      o_open_empty: oOpenE, o_refill: otd?.refill || 0, o_borrow_empty: oBE, o_given_empty: oGE,
      o_total_empty: oTotalE, o_to_godown: otd?.to_godown || 0, o_calc_empty: oCalcE,
      o_stored_empty: otd?.closing_empty || 0, o_empty_match: oCalcE === (otd?.closing_empty || 0),
      o_remarks: otd?.remarks || '',
      running_dict: combined, dict_entries: combinedEntries,
    });
  };

  // ─── Share / Download ──────────────────────────────────────────────────────

  const captureScreen = async (quality = 0.9): Promise<string> => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    await new Promise(r => setTimeout(r, 400));
    return await captureRef(contentRef, { format: 'jpg', quality, result: 'tmpfile' });
  };

  const handleShare = async () => {
    try {
      setSharing(true);

      // Capture the screen to a temp image file
      const uri = await captureScreen(0.9);

      // Check if sharing is available on this device
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Not Available', 'Sharing is not available on this device.');
        return;
      }

      // Share the actual IMAGE file
      await Sharing.shareAsync(uri, {
        mimeType: 'image/jpeg',
        dialogTitle: `Stock Summary - ${selectedDate}`,
        UTI: 'public.jpeg', // iOS
      });
    } catch (err: any) {
      console.error('Share error:', err);
      Alert.alert('Share failed', 'Could not share the summary.');
    } finally {
      setSharing(false);
    }
  };

  const handleDownload = async () => {
    try {
      setSharing(true);
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to save images to your gallery.');
        return;
      }

      // captureRef returns a tmpfile URI — MediaLibrary can use it directly
      const uri = await captureScreen(0.95);

      // Create the asset directly from the captured temp file
      const asset = await MediaLibrary.createAssetAsync(uri);

      // Try to put it in an album (catch failures so the save still "succeeds")
      try {
        const album = await MediaLibrary.getAlbumAsync('BPCL Stock');
        if (album) {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
        } else {
          await MediaLibrary.createAlbumAsync('BPCL Stock', asset, false);
        }
      } catch (albumErr) {
        console.warn('Album step failed, but image was saved:', albumErr);
      }

      Alert.alert('✅ Saved', 'Stock summary saved to your Gallery in "BPCL Stock" album.');
    } catch (err: any) {
      console.error('Download error:', err);
      Alert.alert('Download Failed', err?.message || 'Could not save the image.');
    } finally {
      setSharing(false);
    }
  };

  // ─── Register Cards ────────────────────────────────────────────────────────

  const renderReg142 = () => (
    <View style={[styles.productCard, { borderLeftColor: BPCL_BLUE }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#e3f2fd' }]}><Text style={styles.productIconText}>14.2</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>14.2 KG — Register</Text><Text style={styles.productTable}>dashboard_cylinderstocksachin</Text></View>
      </View>
      {!reg142 ? <NoDataCard title="14.2 KG" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📦 Full Cylinders</Text>
            <SummaryRow label="Opening Full:" value={reg142.prev_full} />
            <SummaryRow label="+ Supply BPCL:" value={reg142.add_full} indent />
            {reg142.borrow_full !== 0 && <SummaryRow label="± Borrow/Give Full:" value={`${reg142.borrow_full > 0 ? '+' : ''}${reg142.borrow_full}`} indent color={reg142.borrow_full > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Refill Delivered:" value={reg142.total_refill} indent />
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={reg142.calc_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={reg142.closing_full} bold color={reg142.full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🔵 Empty Cylinders</Text>
            <SummaryRow label="Opening Empty:" value={reg142.prev_empty} />
            <SummaryRow label="+ Empty Received:" value={reg142.empty_received} indent />
            {reg142.borrow_empty !== 0 && <SummaryRow label="± Borrow/Give Empty:" value={`${reg142.borrow_empty > 0 ? '+' : ''}${reg142.borrow_empty}`} indent color={reg142.borrow_empty > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Sent to Plant:" value={reg142.empty_sent} indent />
            <View style={styles.divider} />
            <SummaryRow label="Closing Empty:" value={reg142.closing_empty} bold color={BPCL_BLUE} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📊 Reconciliation</Text>
            <SummaryRow label="NC:" value={reg142.total_nc} />
            <SummaryRow label="DBC:" value={reg142.total_dbc} />
            <SummaryRow label="TV (Extra):" value={reg142.total_tv} />
            <SummaryRow label="TV Out (Missing):" value={reg142.total_tv_out} />
          </View>
          <View style={styles.matchRow}><MatchBadge match={reg142.full_match} label="Full" /></View>
        </>
      )}
    </View>
  );

  const renderReg19 = () => (
    <View style={[styles.productCard, { borderLeftColor: BPCL_YELLOW }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#fffde7' }]}><Text style={[styles.productIconText, { color: '#f57f17' }]}>19</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>19 KG — Register</Text><Text style={styles.productTable}>dashboard_commercialstocksachin</Text></View>
      </View>
      {!reg19 ? <NoDataCard title="19 KG" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📦 Full Cylinders</Text>
            <SummaryRow label="Opening Full:" value={reg19.prev_full} />
            <SummaryRow label="+ From BPCL:" value={reg19.from_bpcl} indent />
            {reg19.borrow_full !== 0 && <SummaryRow label="± Borrow/Give Full:" value={`${reg19.borrow_full > 0 ? '+' : ''}${reg19.borrow_full}`} indent color={reg19.borrow_full > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Delivered:" value={reg19.delivered} indent />
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={reg19.calc_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={reg19.closing_full} bold color={reg19.full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🔵 Empty Cylinders</Text>
            <SummaryRow label="Opening Empty:" value={reg19.prev_empty} />
            <SummaryRow label="+ Empty Received:" value={reg19.empty_received} indent />
            {reg19.borrow_empty !== 0 && <SummaryRow label="± Borrow/Give Empty:" value={`${reg19.borrow_empty > 0 ? '+' : ''}${reg19.borrow_empty}`} indent color={reg19.borrow_empty > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Sent to Plant:" value={reg19.empty_sent} indent />
            <View style={styles.divider} />
            <SummaryRow label="Closing Empty:" value={reg19.closing_empty} bold color={BPCL_BLUE} separator />
          </View>
          <View style={styles.matchRow}><MatchBadge match={reg19.full_match} label="Full" /></View>
        </>
      )}
    </View>
  );

  const renderRegGodown = () => (
    <View style={[styles.productCard, { borderLeftColor: '#27ae60' }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#e8f5e9' }]}><Text style={[styles.productIconText, { color: '#27ae60' }]}>5G</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>5 KG Godown — Register</Text><Text style={styles.productTable}>dashboard_godownftlstocksachin</Text></View>
      </View>
      {!regGodown ? <NoDataCard title="5 KG Godown" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📦 Full Cylinders</Text>
            <SummaryRow label="Opening Full:" value={regGodown.prev_full} />
            <SummaryRow label="+ From BPCL:" value={regGodown.from_bpcl} indent />
            <SummaryRow label="- Sent to Office:" value={regGodown.sent_to_office} indent />
            <SummaryRow label="+ From Office:" value={regGodown.recv_from_office} indent />
            {regGodown.borrow_full !== 0 && <SummaryRow label="± Borrow/Give Full:" value={`${regGodown.borrow_full > 0 ? '+' : ''}${regGodown.borrow_full}`} indent color={regGodown.borrow_full > 0 ? '#27ae60' : '#e74c3c'} />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={regGodown.calc_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={regGodown.closing_full} bold color={regGodown.full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🔵 Empty Cylinders</Text>
            <SummaryRow label="Opening Empty:" value={regGodown.prev_empty} />
            <SummaryRow label="+ Received from Office:" value={regGodown.empty_from_office} indent />
            {regGodown.borrow_empty !== 0 && <SummaryRow label="± Borrow/Give Empty:" value={`${regGodown.borrow_empty > 0 ? '+' : ''}${regGodown.borrow_empty}`} indent color={regGodown.borrow_empty > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Sent Out (est.):" value={regGodown.empty_sent} indent />
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Empty:" value={regGodown.calc_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Empty:" value={regGodown.closing_empty} bold color={regGodown.empty_match ? '#27ae60' : '#e74c3c'} separator />
            {regGodown.empty_is_estimated && (
              <Text style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
                "Sent Out" is a derived figure (no direct field for Godown empty outflow) — match will always hold.
              </Text>
            )}
          </View>
          <View style={styles.matchRow}>
            <MatchBadge match={regGodown.full_match} label="Full" />
            <MatchBadge match={regGodown.empty_match} label="Empty" />
          </View>
        </>
      )}
    </View>
  );

  const renderRegOffice = () => (
    <View style={[styles.productCard, { borderLeftColor: '#e67e22' }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#fef3e2' }]}><Text style={[styles.productIconText, { color: '#e67e22' }]}>5O</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>5 KG Office — Register</Text><Text style={styles.productTable}>dashboard_officeftlstocksachin</Text></View>
      </View>
      {!regOffice ? <NoDataCard title="5 KG Office" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📦 Full Cylinders</Text>
            <SummaryRow label="Opening Full:" value={regOffice.prev_full} />
            <SummaryRow label="+ From Godown:" value={regOffice.add_stock} indent />
            {regOffice.borrow_full !== 0 && <SummaryRow label="± Borrow/Give Full:" value={`${regOffice.borrow_full > 0 ? '+' : ''}${regOffice.borrow_full}`} indent color={regOffice.borrow_full > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Refill:" value={regOffice.refill} indent />
            <SummaryRow label="- NC:" value={regOffice.nc} indent />
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={regOffice.calc_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={regOffice.closing_full} bold color={regOffice.full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🔵 Empty Cylinders</Text>
            <SummaryRow label="Opening Empty:" value={regOffice.prev_empty} />
            <SummaryRow label="+ Refill Returns:" value={regOffice.refill} indent />
            {regOffice.borrow_empty !== 0 && <SummaryRow label="± Borrow/Give Empty:" value={`${regOffice.borrow_empty > 0 ? '+' : ''}${regOffice.borrow_empty}`} indent color={regOffice.borrow_empty > 0 ? '#27ae60' : '#e74c3c'} />}
            <SummaryRow label="- Sent to Godown:" value={regOffice.to_godown} indent />
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Empty:" value={regOffice.calc_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Empty:" value={regOffice.closing_empty} bold color={regOffice.empty_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.matchRow}>
            <MatchBadge match={regOffice.full_match} label="Full" />
            <MatchBadge match={regOffice.empty_match} label="Empty" />
          </View>
        </>
      )}
    </View>
  );

  // ─── JD Cards ──────────────────────────────────────────────────────────────

  const renderJD14 = () => (
    <View style={[styles.productCard, { borderLeftColor: BPCL_BLUE }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#e3f2fd' }]}><Text style={styles.productIconText}>14.2</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>14.2 KG — JD Entry</Text><Text style={styles.productTable}>dashboard_cylinderstock</Text></View>
      </View>
      {!jd14 ? <NoDataCard title="14.2 KG" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📦 Full Cylinders</Text>
            <SummaryRow label="Opening Full:" value={jd14.opening_full} />
            <SummaryRow label="+ Supply BPCL:" value={jd14.supply_bpcl} indent />
            {jd14.borrowed_full > 0 && <SummaryRow label="+ Borrowed Full:" value={jd14.borrowed_full} indent color="#27ae60" />}
            <SummaryRow label="= Total Full:" value={jd14.total_full} bold color={BPCL_BLUE} />
            <SummaryRow label="- Deliveries (Refill):" value={jd14.deliveries} indent />
            {jd14.given_full > 0 && <SummaryRow label="- Given Full:" value={jd14.given_full} indent color="#e74c3c" />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={jd14.closing_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={jd14.stored_full} bold color={jd14.full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🔵 Empty Cylinders</Text>
            <SummaryRow label="Opening Empty:" value={jd14.opening_empty} />
            <SummaryRow label="+ Empty Received (= Refill):" value={jd14.empty_received} indent />
            {jd14.borrowed_empty > 0 && <SummaryRow label="+ Borrowed Empty:" value={jd14.borrowed_empty} indent color="#27ae60" />}
            <SummaryRow label="= Total Empty:" value={jd14.total_empty} bold color={BPCL_BLUE} />
            {jd14.given_empty > 0 && <SummaryRow label="- Given Empty:" value={jd14.given_empty} indent color="#e74c3c" />}
            {jd14.returned_bpcl > 0 && <SummaryRow label="- Returned to BPCL:" value={jd14.returned_bpcl} indent />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Empty:" value={jd14.closing_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Empty:" value={jd14.stored_empty} bold color="#555" separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📊 Reconciliation</Text>
            <SummaryRow label="NC:" value={jd14.total_nc} />
            <SummaryRow label="DBC:" value={jd14.total_dbc} />
            <SummaryRow label="TV (Extra):" value={jd14.total_tv} />
            <SummaryRow label="TV Out (Missing):" value={jd14.total_tv_out} />
          </View>
          <View style={styles.matchRow}><MatchBadge match={jd14.full_match} label="Full" /></View>
          <DictSection dict={jd14.running_dict} entries={jd14.dict_entries} />
        </>
      )}
    </View>
  );

  const renderJD19 = () => (
    <View style={[styles.productCard, { borderLeftColor: BPCL_YELLOW }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#fffde7' }]}><Text style={[styles.productIconText, { color: '#f57f17' }]}>19</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>19 KG — JD Entry</Text><Text style={styles.productTable}>dashboard_commercialstock + dashboard_commercialrecords</Text></View>
      </View>
      {!jd19 ? <NoDataCard title="19 KG" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>📦 Full Cylinders</Text>
            <SummaryRow label="Opening Full:" value={jd19.opening_full} />
            <SummaryRow label="+ Supply BPCL:" value={jd19.supply_bpcl} indent />
            {jd19.borrowed_full > 0 && <SummaryRow label="+ Borrowed Full:" value={jd19.borrowed_full} indent color="#27ae60" />}
            <SummaryRow label="= Total Full:" value={jd19.total_full} bold color={BPCL_BLUE} />
            <SummaryRow label="- Deliveries:" value={jd19.deliveries} indent />
            {jd19.given_full > 0 && <SummaryRow label="- Given Full:" value={jd19.given_full} indent color="#e74c3c" />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={jd19.closing_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={jd19.stored_full} bold color={jd19.full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🔵 Empty Cylinders</Text>
            <SummaryRow label="Opening Empty:" value={jd19.opening_empty} />
            <SummaryRow label="+ Empty Received:" value={jd19.empty_received} indent />
            {jd19.borrowed_empty > 0 && <SummaryRow label="+ Borrowed Empty:" value={jd19.borrowed_empty} indent color="#27ae60" />}
            <SummaryRow label="= Total Empty:" value={jd19.total_empty} bold color={BPCL_BLUE} />
            {jd19.given_empty > 0 && <SummaryRow label="- Given Empty:" value={jd19.given_empty} indent color="#e74c3c" />}
            {jd19.returned_bpcl > 0 && <SummaryRow label="- Returned to BPCL:" value={jd19.returned_bpcl} indent />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Empty:" value={jd19.closing_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Empty:" value={jd19.stored_empty} bold color="#555" separator />
          </View>
          {jd19.customer_shortage.length > 0 && (
            <View style={styles.sectionBox}>
              <Text style={styles.sectionBoxTitle}>⚠️ Customer Stock Difference</Text>
              {jd19.customer_shortage.map(c => (
                <View key={c.name} style={styles.shortageRow}>
                  <Text style={styles.shortageCustomer}>{c.name}</Text>
                  <Text style={styles.shortageDetail}>Del: {c.delivered} | Emp: {c.empty}</Text>
                  <Text style={[styles.shortageVal, { color: c.diff > 0 ? '#e74c3c' : '#27ae60' }]}>
                    {c.diff > 0 ? `-${c.diff}` : `+${Math.abs(c.diff)}`}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <View style={styles.matchRow}><MatchBadge match={jd19.full_match} label="Full" /></View>
          <DictSection dict={jd19.running_dict} entries={jd19.dict_entries} />
        </>
      )}
    </View>
  );

  const renderJD5 = () => (
    <View style={[styles.productCard, { borderLeftColor: '#27ae60' }]}>
      <View style={styles.productCardHeader}>
        <View style={[styles.productIcon, { backgroundColor: '#e8f5e9' }]}><Text style={[styles.productIconText, { color: '#27ae60' }]}>5K</Text></View>
        <View style={styles.productTitleBox}><Text style={styles.productTitle}>5 KG (Godown + Office) — JD</Text><Text style={styles.productTable}>dashboard_godownftlstock + dashboard_officeftlstock</Text></View>
      </View>
      {!jd5 ? <NoDataCard title="5 KG" /> : (
        <>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🏭 Godown — Full</Text>
            <SummaryRow label="Opening Full:" value={jd5.g_open_full} />
            <SummaryRow label="+ Supply BPCL:" value={jd5.g_supply} indent />
            {jd5.g_borrow_full > 0 && <SummaryRow label="+ Borrowed Full:" value={jd5.g_borrow_full} indent color="#27ae60" />}
            <SummaryRow label="= Total Full:" value={jd5.g_total_full} bold color={BPCL_BLUE} />
            <SummaryRow label="- Sent to Office:" value={jd5.g_sent_office} indent />
            <SummaryRow label="+ From Office:" value={jd5.g_recv_office} indent />
            {jd5.g_given_full > 0 && <SummaryRow label="- Given Full:" value={jd5.g_given_full} indent color="#e74c3c" />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={jd5.g_calc_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={jd5.g_stored_full} bold color={jd5.g_full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🏭 Godown — Empty</Text>
            <SummaryRow label="Opening Empty:" value={jd5.g_open_empty} />
            <SummaryRow label="+ Received from Office:" value={jd5.g_recv_office_empty} indent />
            {jd5.g_borrow_empty > 0 && <SummaryRow label="+ Borrowed Empty:" value={jd5.g_borrow_empty} indent color="#27ae60" />}
            <SummaryRow label="= Total Empty:" value={jd5.g_total_empty} bold color={BPCL_BLUE} />
            {jd5.g_given_empty > 0 && <SummaryRow label="- Given Empty:" value={jd5.g_given_empty} indent color="#e74c3c" />}
            {jd5.g_returned > 0 && <SummaryRow label="- Returned to BPCL:" value={jd5.g_returned} indent />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Empty:" value={jd5.g_calc_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Empty:" value={jd5.g_stored_empty} bold color={jd5.g_empty_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🏢 Office — Full</Text>
            <SummaryRow label="Opening Full:" value={jd5.o_open_full} />
            <SummaryRow label="+ From Godown:" value={jd5.o_add_stock} indent />
            {jd5.o_borrow_full > 0 && <SummaryRow label="+ Borrowed Full:" value={jd5.o_borrow_full} indent color="#27ae60" />}
            <SummaryRow label="= Total Full:" value={jd5.o_total_full} bold color={BPCL_BLUE} />
            <SummaryRow label="- NC Given:" value={jd5.o_nc} indent />
            {jd5.o_given_full > 0 && <SummaryRow label="- Given Full:" value={jd5.o_given_full} indent color="#e74c3c" />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Full:" value={jd5.o_calc_full} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Full:" value={jd5.o_stored_full} bold color={jd5.o_full_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.sectionBox}>
            <Text style={styles.sectionBoxTitle}>🏢 Office — Empty</Text>
            <SummaryRow label="Opening Empty:" value={jd5.o_open_empty} />
            <SummaryRow label="+ Refill Returns:" value={jd5.o_refill} indent />
            {jd5.o_borrow_empty > 0 && <SummaryRow label="+ Borrowed Empty:" value={jd5.o_borrow_empty} indent color="#27ae60" />}
            <SummaryRow label="= Total Empty:" value={jd5.o_total_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="- Sent to Godown:" value={jd5.o_to_godown} indent />
            {jd5.o_given_empty > 0 && <SummaryRow label="- Given Empty:" value={jd5.o_given_empty} indent color="#e74c3c" />}
            <View style={styles.divider} />
            <SummaryRow label="Calc Closing Empty:" value={jd5.o_calc_empty} bold color={BPCL_BLUE} />
            <SummaryRow label="Stored Closing Empty:" value={jd5.o_stored_empty} bold color={jd5.o_empty_match ? '#27ae60' : '#e74c3c'} separator />
          </View>
          <View style={styles.matchRow}>
            <MatchBadge match={jd5.g_full_match} label="Godown Full" />
            <MatchBadge match={jd5.g_empty_match} label="Godown Empty" />
            <MatchBadge match={jd5.o_full_match} label="Office Full" />
            <MatchBadge match={jd5.o_empty_match} label="Office Empty" />
          </View>
          <DictSection dict={jd5.running_dict} entries={jd5.dict_entries} />
        </>
      )}
    </View>
  );

  // ─── Main Render ──────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.headerTitle}>Stock Summary</Text>
              <TouchableOpacity onPress={() => setShowDatePicker(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <Ionicons name="calendar-outline" size={14} color="rgba(255,255,255,0.9)" />
                <Text style={styles.headerDate}>{format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}</Text>
                <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.9)" />
              </TouchableOpacity>
              {showDatePicker && (
                <DateTimePicker value={new Date(selectedDate + 'T00:00:00')} mode="date" display="default" maximumDate={new Date()}
                  onChange={(event: any, date?: Date) => { setShowDatePicker(false); if (event.type === 'set' && date) setSelectedDate(format(date, 'yyyy-MM-dd')); }} />
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity style={styles.refreshButton} onPress={handleRefresh} disabled={refreshing}>
                <Ionicons name="refresh" size={18} color="#fff" style={refreshing ? { opacity: 0.4 } : {}} />
                <Text style={styles.refreshText}>Refresh</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.shareButton, sharing && { opacity: 0.6 }]} onPress={handleShare} disabled={sharing}>
                {sharing ? <ActivityIndicator size="small" color={BPCL_BLUE} /> : (
                  <><Ionicons name="share-social" size={18} color={BPCL_BLUE} /><Text style={styles.shareButtonText}>Share</Text></>
                )}
              </TouchableOpacity>
            </View>
          </View>
          {/* Mode Toggle */}
          <View style={styles.modeToggle}>
            <TouchableOpacity style={[styles.modeBtn, mode === 'register' && styles.modeBtnActive]} onPress={() => setMode('register')}>
              <Text style={[styles.modeBtnText, mode === 'register' && styles.modeBtnTextActive]}>📒 Register Stock</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modeBtn, mode === 'jd' && styles.modeBtnActive]} onPress={() => setMode('jd')}>
              <Text style={[styles.modeBtnText, mode === 'jd' && styles.modeBtnTextActive]}>📋 JD Entry Stock</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {loading ? (
        <View style={styles.loadingBox}><ActivityIndicator size="large" color={BPCL_BLUE} /><Text style={styles.loadingText}>Loading summary...</Text></View>
      ) : (
        <ScrollView ref={scrollRef} style={styles.scrollView} showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} colors={[BPCL_BLUE]} />}
        >
          <View ref={contentRef} collapsable={false} style={styles.viewShotContainer}>
            {mode === 'register'
              ? <>{renderReg142()}{renderReg19()}{renderRegGodown()}{renderRegOffice()}</>
              : <>{renderJD14()}{renderJD19()}{renderJD5()}</>
            }
            <TouchableOpacity style={styles.downloadBtn} onPress={handleDownload} disabled={sharing}>
              <Ionicons name="download-outline" size={20} color="#fff" />
              <Text style={styles.downloadBtnText}>Download as Image</Text>
            </TouchableOpacity>
            <View style={styles.footer}>
              <Text style={styles.footerText}>Pull down to refresh • Tap Share to export</Text>
              <Text style={styles.footerDate}>Generated: {format(new Date(), 'dd MMM yyyy, hh:mm a')}</Text>
            </View>
          </View>
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:            { flex: 1, backgroundColor: '#f5f5f5' },
  header:               { backgroundColor: BPCL_BLUE, elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4 },
  headerContent:        { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  headerRow:            { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle:          { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  headerDate:           { fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: '500' },
  refreshButton:        { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  refreshText:          { color: '#fff', fontSize: 13, fontWeight: '600' },
  shareButton:          { backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  shareButtonText:      { color: BPCL_BLUE, fontWeight: 'bold', fontSize: 14 },
  modeToggle:           { flexDirection: 'row', marginTop: 12, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 10, padding: 3, gap: 3 },
  modeBtn:              { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  modeBtnActive:        { backgroundColor: '#fff' },
  modeBtnText:          { fontSize: 13, color: 'rgba(255,255,255,0.8)', fontWeight: '600' },
  modeBtnTextActive:    { color: BPCL_BLUE },
  loadingBox:           { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText:          { color: '#999', fontSize: 16 },
  scrollView:           { flex: 1 },
  viewShotContainer:    { backgroundColor: '#f5f5f5', paddingBottom: 16 },
  productCard:          { backgroundColor: '#fff', margin: 16, marginTop: 8, borderRadius: 12, borderLeftWidth: 5, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4, overflow: 'hidden' },
  productCardHeader:    { flexDirection: 'row', alignItems: 'center', padding: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', gap: 12 },
  productIcon:          { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  productIconText:      { fontSize: 13, fontWeight: 'bold', color: BPCL_BLUE },
  productTitleBox:      { flex: 1 },
  productTitle:         { fontSize: 16, fontWeight: 'bold', color: '#333' },
  productTable:         { fontSize: 10, color: '#999', marginTop: 2 },
  sectionBox:           { padding: 14, paddingTop: 10, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  sectionBoxTitle:      { fontSize: 13, fontWeight: 'bold', color: '#555', marginBottom: 10, marginTop: 4 },
  summaryRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  summaryRowSeparator:  { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 4, paddingTop: 8 },
  summaryLabel:         { fontSize: 13, color: '#666', flex: 1 },
  summaryLabelIndent:   { paddingLeft: 12, color: '#888' },
  summaryLabelBold:     { fontWeight: 'bold', color: '#333', fontSize: 14 },
  summaryValue:         { fontSize: 14, fontWeight: '600', color: '#333', minWidth: 50, textAlign: 'right' },
  summaryValueBold:     { fontSize: 16, fontWeight: 'bold' },
  divider:              { height: 1, backgroundColor: '#eee', marginVertical: 8 },
  matchRow:             { flexDirection: 'row', gap: 8, padding: 14, paddingTop: 10, flexWrap: 'wrap' },
  matchBadge:           { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  matchBadgeText:       { fontSize: 13, fontWeight: 'bold' },
  noDataCard:           { padding: 24, alignItems: 'center', gap: 8 },
  noDataText:           { fontSize: 14, color: '#999', fontWeight: '600' },
  noDataSubText:        { fontSize: 12, color: '#bbb' },
  shortageRow:          { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  shortageCustomer:     { flex: 1, fontSize: 13, color: '#333', fontWeight: '600' },
  shortageDetail:       { fontSize: 12, color: '#888', marginRight: 8 },
  shortageVal:          { fontSize: 14, fontWeight: 'bold', minWidth: 30, textAlign: 'right' },
  dictBox:              { margin: 14, marginTop: 0, backgroundColor: '#f0f8ff', padding: 12, borderRadius: 10, borderLeftWidth: 3, borderLeftColor: BPCL_BLUE },
  dictTitle:            { fontSize: 13, fontWeight: 'bold', color: '#333', marginBottom: 8 },
  dictRow:              { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#e8f0f8' },
  dictKey:              { fontSize: 13, color: '#555', flex: 1 },
  dictVal:              { fontSize: 13, fontWeight: 'bold' },
  // Modal
  modalOverlay:         { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard:            { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 30 },
  modalHeader:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#eee' },
  modalTitle:           { fontSize: 17, fontWeight: 'bold', color: '#222', flex: 1 },
  modalClose:           { width: 32, height: 32, borderRadius: 16, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
  modalSubtitle:        { fontSize: 12, color: '#999', paddingHorizontal: 20, paddingVertical: 8 },
  // Column header row above the entry list, labels the new cumulative column
  modalColHeaderRow:    { flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#eee' },
  modalColHeaderText:   { fontSize: 11, color: '#999', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, flex: 1 },
  modalColRight:        { textAlign: 'right' },
  modalRow:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  modalDate:            { fontSize: 14, color: '#555' },
  modalQty:             { fontSize: 15, fontWeight: 'bold', flex: 1 },
  modalCumulative:       { fontSize: 15, fontWeight: 'bold', flex: 1 },
  downloadBtn:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, margin: 16, marginTop: 8, backgroundColor: '#27ae60', padding: 14, borderRadius: 12 },
  downloadBtnText:      { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  footer:               { alignItems: 'center', padding: 16, gap: 4 },
  footerText:           { fontSize: 12, color: '#bbb' },
  footerDate:           { fontSize: 11, color: '#ccc' },
});
