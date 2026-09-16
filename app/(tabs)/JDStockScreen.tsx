import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from '../../lib/supabase';

const BPCL_BLUE   = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

type InnerTab = 'stock' | 'update';

// ─── Stock view types ──────────────────────────────────────────────────────────

interface StockData {
  // 14.2 KG
  fullCylinder: number;
  emptyCylinder: number;
  bpclIn: number;
  // 5 KG godown
  ftlGodownFull: number;
  ftlGodownEmpty: number;
  ftlBpcl: number;
  // 5 KG office
  ftlOfficeFull: number;
  ftlOfficeEmpty: number;
  ftlFromGodown: number;
  ftlToGodown: number;
  // Accessories
  srt: number;
  todaySrt: number;
  hotPlate: number;
  todayHot: number;
  // Commercial
  fullCommercial: number;
  emptyCommercial: number;
  bpclInCommercial: number;
  // Meta
  latestDate: string;
}

// ─── Update form types ─────────────────────────────────────────────────────────

interface StockFormState {
  bpcl: string;
  totalRefill: string;
  newConnection: string;
  dbc: string;
  tvIn: string;
  tvOut: string;
  ftlBpcl: string;
  addOfficeStock: string;
  emptyToGodown: string;
  smallRefill: string;
  smallNewConnection: string;
  addSrt: string;
  srtSale: string;
  srtNc: string;
  addDpr: string;
  dprSale: string;
  dprNc: string;
  addHotPlate: string;
  hotPlateSale: string;
  hotPlateNc: string;
  commercialFromBpcl: string;
  cylinderDelivered: string;
  emptyReceived: string;
}

const emptyForm = (): StockFormState => ({
  bpcl: '0', totalRefill: '0', newConnection: '0', dbc: '0', tvIn: '0', tvOut: '0',
  ftlBpcl: '0', addOfficeStock: '0', emptyToGodown: '0', smallRefill: '0', smallNewConnection: '0',
  addSrt: '0', srtSale: '0', srtNc: '0',
  addDpr: '0', dprSale: '0', dprNc: '0',
  addHotPlate: '0', hotPlateSale: '0', hotPlateNc: '0',
  commercialFromBpcl: '0', cylinderDelivered: '0', emptyReceived: '0',
});

// ─── Reusable: Section card ────────────────────────────────────────────────────

function SectionCard({
  title, iconName, iconColor, iconBg, badge, children,
}: {
  title: string;
  iconName: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  badge?: { label: string; color: string; bg: string };
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={[styles.cardIcon, { backgroundColor: iconBg }]}>
          <Ionicons name={iconName} size={15} color={iconColor} />
        </View>
        <Text style={styles.cardTitle}>{title}</Text>
        {badge && (
          <View style={[styles.badge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>
        )}
      </View>
      {children}
    </View>
  );
}

// ─── Reusable: Stat tile ───────────────────────────────────────────────────────

function StatTile({
  label, value, sub, dotColor, onPress,
}: {
  label: string; value: number | string; sub?: string; dotColor?: string; onPress?: () => void;
}) {
  const content = (
    <View style={[styles.statTile, onPress && styles.interactiveTile]}>
      <View style={styles.statLabelRow}>
        {dotColor && <View style={[styles.dot, { backgroundColor: dotColor }]} />}
        <Text style={styles.statLabel}>{label}</Text>
        {onPress && (
          <Ionicons name="pencil-outline" size={12} color="#888" style={styles.editIcon} />
        )}
      </View>
      <Text style={styles.statValue}>{value}</Text>
      {sub ? <Text style={styles.statSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={{ flex: 1, minWidth: '45%' }}>
        {content}
      </TouchableOpacity>
    );
  }

  return <View style={{ flex: 1, minWidth: '45%' }}>{content}</View>;
}

// ─── Reusable: Form field ──────────────────────────────────────────────────────

function Field({
  label, value, onChangeText, readonly = false, prefilled = false,
}: {
  label: string; value: string;
  onChangeText?: (v: string) => void;
  readonly?: boolean; prefilled?: boolean;
}) {
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.labelContainer}>
        <Text style={styles.fieldLabel} numberOfLines={3}>
          {label}
        </Text>
      </View>
      <TextInput
        style={[
          styles.fieldInput,
          readonly  && styles.fieldInputRo,
          prefilled && styles.fieldInputPre,
        ]}
        value={value}
        onChangeText={onChangeText}
        editable={!readonly}
        keyboardType="numeric"
        selectTextOnFocus
      />
    </View>
  );
}

// ─── Supabase read/write helpers ────────────────────────────────────────────────

/** Parse a form string to an int, defaulting to 0. */
const n = (v: string) => parseInt(v, 10) || 0;

/**
 * Fetch the most recent row on-or-before `asOfDate` in `table`, selecting
 * only `cols`. Used to show "stock as of the picked date" even on days the
 * table has no row (the closing balances are cumulative, so the latest row
 * at-or-before the date is still correct).
 */
async function getRowAsOf(table: string, cols: string[], asOfDate: string) {
  const { data, error } = await supabase
    .from(table)
    .select(cols.join(','))
    .lte('date', asOfDate)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, any> | null;
}

/**
 * Fetch the most recent row strictly before `beforeDate` in `table`, selecting
 * only `cols`. Returns null if no earlier row exists (treated as opening = 0).
 */
async function getPrevRow(table: string, cols: string[], beforeDate: string) {
  const { data, error } = await supabase
    .from(table)
    .select(cols.join(','))
    .lt('date', beforeDate)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, number> | null;
}

/**
 * Write a day's row to `table`, keyed on `date`. These tables have no
 * unique/exclusion constraint on `date`, so a real .upsert({ onConflict })
 * fails — instead we check for an existing row for that date and
 * update it, or insert a new one if none exists.
 *
 * `insertOnlyDefaults` (e.g. { remarks: ' ' }) only apply on a brand-new
 * insert — they never overwrite fields on an existing row, so an update
 * never clobbers remarks already logged against that date.
 */
async function upsertByDate(
  table: string,
  date: string,
  payload: Record<string, any>,
  insertOnlyDefaults?: Record<string, any>,
) {
  const { data: existing, error: fetchErr } = await supabase
    .from(table)
    .select('id')
    .eq('date', date)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  if (existing) {
    const { error: updateErr } = await supabase
      .from(table)
      .update(payload)
      .eq('id', existing.id);
    if (updateErr) throw updateErr;
  } else {
    const { error: insertErr } = await supabase
      .from(table)
      .insert({ date, ...payload, ...insertOnlyDefaults });
    if (insertErr) throw insertErr;
  }
}

/**
 * Add `adjustedQty` (signed) to a customer's running balance in
 * dashboard_changequantity, keyed on name + category + cylinder_state.
 * Appends `settlementDate` (the date picked at the top of the screen) to
 * the settlement_date text log, and flips status to true once the running
 * quantity nets to zero.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FIX: a customer can go through many settle-to-zero cycles over time —
 * each time a running balance nets to 0, `status` flips to `true` and that
 * row becomes closed history. A brand-new adjustment should start a FRESH
 * row for the next cycle, not reopen an old closed one. The previous query
 * only filtered on name + category + cylinder_state, which matches EVERY
 * historical row (closed or open) for a long-running customer — once a
 * customer has 2+ closed cycles on record, .maybeSingle() throws
 * "JSON object requested, multiple (or no) rows returned" because more
 * than one row matches. Filtering to status = false (the currently open
 * cycle only) fixes this and matches the intended "one active running
 * balance per customer+category+state" behaviour.
 * ─────────────────────────────────────────────────────────────────────────
 */
async function applyChangeQuantity(
  name: string,
  category: number,
  cylinderState: 'FULL' | 'EMPTY',
  adjustedQty: number,
  settlementDate: string,
) {
  const { data: existing, error: fetchErr } = await supabase
    .from('dashboard_changequantity')
    .select('id, quantity, settlement_date')
    .eq('name', name)
    .eq('category', category)
    .eq('cylinder_state', cylinderState)
    .eq('status', false)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  if (existing) {
    const newQuantity = (existing.quantity ?? 0) + adjustedQty;
    const newSettlementDate = existing.settlement_date
      ? `${existing.settlement_date}, ${settlementDate}`
      : settlementDate;
    const { error: updateErr } = await supabase
      .from('dashboard_changequantity')
      .update({
        quantity: newQuantity,
        settlement_date: newSettlementDate,
        status: newQuantity === 0,
      })
      .eq('id', existing.id);
    if (updateErr) throw updateErr;
  } else {
    // No open cycle exists (brand-new customer, or their last cycle was
    // fully settled to zero) — start a fresh row for the new cycle.
    const { error: insertErr } = await supabase
      .from('dashboard_changequantity')
      .insert({
        name,
        category,
        quantity: adjustedQty,
        cylinder_state: cylinderState,
        settlement_date: settlementDate,
        status: adjustedQty === 0,
      });
    if (insertErr) throw insertErr;
  }
}

// ─── Known BPCL truck-load combinations ────────────────────────────────────────
// Each truck carries a fixed combination of 14.2 kg and 19 kg (commercial)
// cylinders. When a delivery lands, the person picks which combination it
// was instead of typing both numbers by hand.

interface TruckOption {
  kg14: number;
  kg19: number;
}

const TRUCK_OPTIONS: TruckOption[] = [
  { kg14: 483, kg19: 28 },
  { kg14: 504, kg19: 14 },
  { kg14: 420, kg19: 56 },
  { kg14: 441, kg19: 42 },
  { kg14: 518, kg19: 6 },
  { kg14: 525, kg19: 0 },
];

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function StockScreen() {
  const [innerTab, setInnerTab] = useState<InnerTab>('stock');

  // ── Shared date (drives Stock view balances, the tile-adjustment modal,
  //     and the daily "Update stock" fetch/submit) ────────────────────────────
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);

  // ── Stock view state ───────────────────────────────────────────────────────
  const [stockData, setStockData] = useState<StockData | null>(null);
  const [loadingStock, setLoadingStock] = useState(false);

  // ── Edit Stock Modal state ─────────────────────────────────────────────────
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedTile, setSelectedTile] = useState<{
    key: string;
    label: string;
    actionType: 'FULL' | 'EMPTY';
    category: number;
  } | null>(null);
  const [modalRemarks, setModalRemarks] = useState('');
  const [modalQuantity, setModalQuantity] = useState('');
  const [isSubtract, setIsSubtract] = useState(false);
  const [updatingStock, setUpdatingStock] = useState(false);

  // ── Update tab state ───────────────────────────────────────────────────────
  const [truckModalVisible, setTruckModalVisible] = useState(false);
  const [fetching, setFetching]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fetched, setFetched]     = useState(false);
  const [form, setForm]           = useState<StockFormState>(emptyForm());

  const set = useCallback(
    (key: keyof StockFormState) => (val: string) =>
      setForm(prev => ({ ...prev, [key]: val })),
    [],
  );

  // ── Load stock view — balances as of `selectedDate` ────────────────────────

  const loadStock = useCallback(async (asOfDate: string) => {
    setLoadingStock(true);
    try {
      const [cyl, comm, ftlOff, ftlGod, srtRow, hotRow] = await Promise.all([
        getRowAsOf('dashboard_cylinderstock', ['date', 'closing_full', 'closing_empty', 'add_full'], asOfDate),
        getRowAsOf('dashboard_commercialstock', ['closing_full', 'closing_empty', 'from_bpcl'], asOfDate),
        getRowAsOf('dashboard_officeftlstock', ['closing_full', 'closing_empty', 'add_office_stock', 'to_godown'], asOfDate),
        getRowAsOf('dashboard_godownftlstock', ['closing_full', 'closing_empty', 'from_bpcl'], asOfDate),
        getRowAsOf('dashboard_rubbertubestock', ['closing', 'sale'], asOfDate),
        getRowAsOf('dashboard_hotplatestock', ['closing', 'sale'], asOfDate),
      ]);

      setStockData({
        fullCylinder:     cyl?.closing_full ?? 0,
        emptyCylinder:    cyl?.closing_empty ?? 0,
        bpclIn:           cyl?.add_full ?? 0,
        ftlGodownFull:    ftlGod?.closing_full ?? 0,
        ftlGodownEmpty:   ftlGod?.closing_empty ?? 0,
        ftlBpcl:          ftlGod?.from_bpcl ?? 0,
        ftlOfficeFull:    ftlOff?.closing_full ?? 0,
        ftlOfficeEmpty:   ftlOff?.closing_empty ?? 0,
        ftlFromGodown:    ftlOff?.add_office_stock ?? 0,
        ftlToGodown:      ftlOff?.to_godown ?? 0,
        srt:              srtRow?.closing ?? 0,
        todaySrt:         srtRow?.sale ?? 0,
        hotPlate:         hotRow?.closing ?? 0,
        todayHot:         hotRow?.sale ?? 0,
        fullCommercial:   comm?.closing_full ?? 0,
        emptyCommercial:  comm?.closing_empty ?? 0,
        bpclInCommercial: comm?.from_bpcl ?? 0,
        latestDate: cyl?.date ?? asOfDate,
      });
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load stock data');
    } finally {
      setLoadingStock(false);
    }
  }, []);

  useEffect(() => { loadStock(selectedDate); }, [loadStock, selectedDate]);

  // ── Open interactive edit dialog ───────────────────────────────────────────

  const handleEditTile = (key: string, label: string, actionType: 'FULL' | 'EMPTY', category: number) => {
    setSelectedTile({ key, label, actionType, category });
    setModalRemarks('');
    setModalQuantity('');
    setIsSubtract(false);
    setModalVisible(true);
  };

  // ── Submit interactive stock adjustment directly to Supabase ───────────────

  const submitStockTransaction = async () => {
    if (!selectedTile) return;
    if (!modalRemarks.trim()) {
      Alert.alert('Error', 'Please enter remarks');
      return;
    }
    const qty = parseInt(modalQuantity, 10);
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Error', 'Please enter a valid positive quantity');
      return;
    }

    setUpdatingStock(true);
    try {
      const adjustedQty = isSubtract ? -qty : qty;
      const name = modalRemarks.trim().toUpperCase();
      const remarkLine = `${name} (${selectedTile.actionType}): ${adjustedQty}`;

      const tableByCategory: Record<number, string> = {
        14: 'dashboard_cylinderstock',
        5: 'dashboard_godownftlstock',
        19: 'dashboard_commercialstock',
      };
      const table = tableByCategory[selectedTile.category];
      if (!table) throw new Error(`Unknown category ${selectedTile.category}`);

      const closingCol = selectedTile.actionType === 'FULL' ? 'closing_full' : 'closing_empty';

      // Adjust the row as of the picked date (the same row Stock view is showing).
      const { data: row, error: fetchErr } = await supabase
        .from(table)
        .select(`id, ${closingCol}, remarks`)
        .lte('date', selectedDate)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!row) throw new Error('No stock row found on or before the selected date');

      const newClosing = (row[closingCol as keyof typeof row] as number ?? 0) + adjustedQty;
      const existingRemarks = (row as any).remarks as string | null;
      const newRemarks = existingRemarks ? `${remarkLine}; ${existingRemarks}` : remarkLine;

      const { error: updateErr } = await supabase
        .from(table)
        .update({ [closingCol]: newClosing, remarks: newRemarks })
        .eq('id', (row as any).id);
      if (updateErr) throw updateErr;

      // Track the customer's running pending-cylinder balance under the picked date.
      await applyChangeQuantity(name, selectedTile.category, selectedTile.actionType, adjustedQty, selectedDate);

      Alert.alert('Success', 'Stock transaction recorded successfully');
      setModalVisible(false);
      loadStock(selectedDate);
    } catch (error: any) {
      Alert.alert('Submission failed', error?.message || 'Failed to record transaction');
    } finally {
      setUpdatingStock(false);
    }
  };

  // ── Fetch for update tab ───────────────────────────────────────────────────

  const handleFetch = async () => {
    if (!selectedDate) { Alert.alert('Error', 'Please select a date'); return; }
    setFetching(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_dailyrecord')
        .select('category,remarks,transactions,quantity,amount')
        .eq('date', selectedDate);

      if (error) throw error;

      const records = data || [];

      const sum = (cat: string) =>
        String(records.filter(r => r.category === cat).reduce((s, r) => s + (r.quantity || 0), 0));

      const sumR = (cat: string, rem: string) =>
        String(records.filter(r => r.category === cat && r.remarks === rem).reduce((s, r) => s + (r.quantity || 0), 0));

      const tvIn = String(
        records.filter(r => r.transactions === 'CREDIT' && r.category === 'DISTRIBUTOR TRANSACTION' &&
          typeof r.remarks === 'string' && r.remarks.includes('TV - '))
          .reduce((s, r) => s + (r.quantity || 0), 0));

      const tvOut = String(
        records.filter(r => r.transactions === 'DEBIT' && r.category === 'DISTRIBUTOR TRANSACTION' &&
          typeof r.remarks === 'string' && r.remarks.includes('TV - '))
          .reduce((s, r) => s + (r.quantity || 0), 0));

      const ncCount = String(records.filter(r => r.category === 'NEW CONNECTION').length);

      let hotPlateNc = 0;
      records.filter(r => r.category === 'NEW CONNECTION').forEach(r => {
        if (r.quantity === 1 && r.amount > 5000) hotPlateNc++;
        if (r.quantity === 2 && r.amount > 7000) hotPlateNc++;
      });

      const { count: delivered } = await supabase
        .from('dashboard_commercialrecords')
        .select('id', { count: 'exact', head: true })
        .eq('delivery_date', selectedDate);

      const { count: emptyRec } = await supabase
        .from('dashboard_commercialrecords')
        .select('id', { count: 'exact', head: true })
        .eq('empty_received', selectedDate);

      setForm(prev => ({
        ...prev,
        totalRefill: sum('TOTAL AHD'),
        newConnection: sum('NEW CONNECTION'),
        dbc: sum('DOUBLE BOTTLE CYLINDER'),
        tvIn, tvOut,
        srtSale: sumR('SALE', 'SRT'),
        srtNc: ncCount,
        dprSale: sumR('SALE', 'DPR'),
        dprNc: ncCount,
        hotPlateSale: sumR('SALE', 'STOVE'),
        hotPlateNc: String(hotPlateNc),
        smallRefill: sumR('SMALL CYLINDER', 'REFILL'),
        smallNewConnection: sumR('SMALL CYLINDER', 'NC'),
        cylinderDelivered: String(delivered ?? 0),
        emptyReceived: String(emptyRec ?? 0),
      }));
      setFetched(true);
      setTruckModalVisible(true);
    } catch (err: any) {
      Alert.alert('Fetch failed', err?.message || 'Could not load data');
    } finally {
      setFetching(false);
    }
  };

  // ── Truck BPCL-load combination picker ──────────────────────────────────────

  const selectTruckOption = (opt: TruckOption) => {
    setForm(prev => ({
      ...prev,
      bpcl: String(opt.kg14),
      commercialFromBpcl: String(opt.kg19),
    }));
    setTruckModalVisible(false);
  };

  // ── Submit Update Form ─────────────────────────────────────────────────────

  const handleSubmit = () => {
    if (!fetched) { Alert.alert('Fetch first', 'Please fetch data before submitting'); return; }
    Alert.alert('Submit stock records', `Save all entries for ${selectedDate}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Submit', onPress: confirmSubmit },
    ]);
  };

  /**
   * Writes the full day's stock across all six tables directly to Supabase.
   * Opening figures are pulled from the closing figures of the most recent
   * row before `selectedDate`; closings are computed here and upserted.
   */
  const confirmSubmit = async () => {
    setSubmitting(true);
    try {
      // ── 14.2 kg ──────────────────────────────────────────────────────────
      const prevCyl = await getPrevRow('dashboard_cylinderstock', ['closing_full', 'closing_empty'], selectedDate);
      const openingFull14 = prevCyl?.closing_full ?? 0;
      const openingEmpty14 = prevCyl?.closing_empty ?? 0;

      const addFull = n(form.bpcl);
      const totalRefill = n(form.totalRefill);
      const totalNc = n(form.newConnection);
      const totalDbc = n(form.dbc);
      const totalTv = n(form.tvIn);
      const totalTvOut = n(form.tvOut);

      const closingFull14 = openingFull14 + addFull - totalRefill - totalNc - totalDbc - totalTv;
      const closingEmpty14 = openingEmpty14 + totalRefill + totalTvOut - addFull;

      await upsertByDate('dashboard_cylinderstock', selectedDate, {
        opening_full: openingFull14,
        add_full: addFull,
        total_refill: totalRefill,
        total_nc: totalNc,
        total_dbc: totalDbc,
        total_tv: totalTv,
        closing_full: closingFull14,
        opening_empty: openingEmpty14,
        total_tv_out: totalTvOut,
        closing_empty: closingEmpty14,
      }, { remarks: ' ' });

      // ── 5.0 kg godown ────────────────────────────────────────────────────
      const prevGodown = await getPrevRow('dashboard_godownftlstock', ['closing_full', 'closing_empty'], selectedDate);
      const openingFullG = prevGodown?.closing_full ?? 0;
      const openingEmptyG = prevGodown?.closing_empty ?? 0;

      const ftlBpcl = n(form.ftlBpcl);
      const toOffice = n(form.addOfficeStock);
      const fromOffice = n(form.emptyToGodown);

      const closingFullG = openingFullG + ftlBpcl - toOffice;
      const closingEmptyG = openingEmptyG + fromOffice - ftlBpcl;

      await upsertByDate('dashboard_godownftlstock', selectedDate, {
        opening_full: openingFullG,
        from_bpcl: ftlBpcl,
        sent_to_office: toOffice,
        closing_full: closingFullG,
        opening_empty: openingEmptyG,
        received_from_office: fromOffice,
        closing_empty: closingEmptyG,
      }, { remarks: ' ' });

      // ── 5.0 kg office ────────────────────────────────────────────────────
      const prevOffice = await getPrevRow('dashboard_officeftlstock', ['closing_full', 'closing_empty'], selectedDate);
      const openingFullO = prevOffice?.closing_full ?? 0;
      const openingEmptyO = prevOffice?.closing_empty ?? 0;

      const addOfficeStock = n(form.addOfficeStock);
      const smallRefill = n(form.smallRefill);
      const smallNc = n(form.smallNewConnection);
      const emptyToGodown = n(form.emptyToGodown);

      const closingFullO = openingFullO + addOfficeStock - smallRefill - smallNc;
      const closingEmptyO = openingEmptyO + smallRefill + smallNc - emptyToGodown;

      await upsertByDate('dashboard_officeftlstock', selectedDate, {
        opening_full: openingFullO,
        add_office_stock: addOfficeStock,
        refill: smallRefill,
        new_connection: smallNc,
        closing_full: closingFullO,
        opening_empty: openingEmptyO,
        to_godown: emptyToGodown,
        closing_empty: closingEmptyO,
      }, { remarks: ' ' });

      // ── Rubber tube (SRT) ────────────────────────────────────────────────
      const prevSrt = await getPrevRow('dashboard_rubbertubestock', ['closing'], selectedDate);
      const openingSrt = prevSrt?.closing ?? 0;
      const addSrt = n(form.addSrt);
      const srtSale = n(form.srtSale);
      const closingSrt = openingSrt + addSrt - srtSale;

      await upsertByDate('dashboard_rubbertubestock', selectedDate, {
        opening: openingSrt,
        add_stock: addSrt,
        sale: srtSale,
        new_connection: n(form.srtNc),
        closing: closingSrt,
      }, { remarks: ' ' });

      // ── Hot plate ────────────────────────────────────────────────────────
      const prevHot = await getPrevRow('dashboard_hotplatestock', ['closing'], selectedDate);
      const openingHot = prevHot?.closing ?? 0;
      const addHot = n(form.addHotPlate);
      const hotSale = n(form.hotPlateSale);
      const closingHot = openingHot + addHot - hotSale;

      await upsertByDate('dashboard_hotplatestock', selectedDate, {
        opening: openingHot,
        add_stock: addHot,
        sale: hotSale,
        new_connection: n(form.hotPlateNc),
        closing: closingHot,
      }, { remarks: ' ' });

      // ── Commercial cylinder ──────────────────────────────────────────────
      const prevComm = await getPrevRow('dashboard_commercialstock', ['closing_full', 'closing_empty'], selectedDate);
      const openingFullC = prevComm?.closing_full ?? 0;
      const openingEmptyC = prevComm?.closing_empty ?? 0;

      const commFromBpcl = n(form.commercialFromBpcl);
      const delivered = n(form.cylinderDelivered);
      const emptyReceived = n(form.emptyReceived);

      const closingFullC = openingFullC + commFromBpcl - delivered;
      const closingEmptyC = openingEmptyC + emptyReceived - commFromBpcl;

      await upsertByDate('dashboard_commercialstock', selectedDate, {
        opening_full: openingFullC,
        from_bpcl: commFromBpcl,
        cylinder_delivered: delivered,
        closing_full: closingFullC,
        new_connection: 0,
        opening_empty: openingEmptyC,
        empty_received: emptyReceived,
        closing_empty: closingEmptyC,
      }, { remarks: ' ' });

      Alert.alert('Success', 'Stock records saved');
      setForm(emptyForm());
      setFetched(false);
      loadStock(selectedDate);
    } catch (err: any) {
      Alert.alert('Submit failed', err?.message || 'Could not save records');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const headerSub = innerTab === 'stock'
    ? stockData ? `Showing stock as of ${format(new Date(stockData.latestDate + 'T00:00:00'), 'dd MMM yyyy')}` : 'Loading…'
    : 'Select date to fetch & submit';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Stock register</Text>
          <Text style={styles.headerSub}>{headerSub}</Text>

          {/* ── Shared date picker: drives Stock view, the adjustment modal, and Update stock ── */}
          <TouchableOpacity style={styles.dateBtn} onPress={() => setShowDatePicker(true)}>
            <Ionicons name="calendar-outline" size={16} color={BPCL_BLUE} />
            <Text style={styles.dateBtnText}>
              {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
            </Text>
            <Ionicons name="chevron-down" size={14} color="#aaa" />
          </TouchableOpacity>

          {showDatePicker && (
            <DateTimePicker
              value={new Date(selectedDate + 'T00:00:00')}
              mode="date"
              display="default"
              onChange={(evt, d) => {
                setShowDatePicker(false);
                if (evt.type === 'set' && d) {
                  setSelectedDate(format(d, 'yyyy-MM-dd'));
                  setFetched(false);
                }
              }}
            />
          )}

          {/* ── Inner segmented control ── */}
          <View style={styles.segControl}>
            <TouchableOpacity
              style={[styles.segBtn, innerTab === 'stock' && styles.segBtnActive]}
              onPress={() => setInnerTab('stock')}
            >
              <Ionicons
                name="cube-outline"
                size={14}
                color={innerTab === 'stock' ? BPCL_BLUE : 'rgba(255,255,255,0.7)'}
              />
              <Text style={[styles.segBtnText, innerTab === 'stock' && styles.segBtnTextActive]}>
                Stock view
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segBtn, innerTab === 'update' && styles.segBtnActive]}
              onPress={() => setInnerTab('update')}
            >
              <Ionicons
                name="create-outline"
                size={14}
                color={innerTab === 'update' ? BPCL_BLUE : 'rgba(255,255,255,0.7)'}
              />
              <Text style={[styles.segBtnText, innerTab === 'update' && styles.segBtnTextActive]}>
                Update stock
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {/* ════════ STOCK VIEW ════════ */}
      {innerTab === 'stock' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={loadingStock} onRefresh={() => loadStock(selectedDate)} tintColor={BPCL_BLUE} />
          }
        >
          {loadingStock && !stockData ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={BPCL_BLUE} />
              <Text style={styles.loadingText}>Loading stock…</Text>
            </View>
          ) : stockData ? (
            <>
              {/* 14.2 KG */}
              <Text style={styles.sectionLabel}>14.2 kg · domestic</Text>
              <View style={styles.statGrid}>
                <StatTile
                  label="Full · godown"
                  value={stockData.fullCylinder}
                  dotColor="#27ae60"
                  sub={`From BPCL: ${stockData.bpclIn}`}
                  onPress={() => handleEditTile('submit_full_14', '14.2 kg Full - Godown', 'FULL', 14)}
                />
                <StatTile
                  label="Empty · godown"
                  value={stockData.emptyCylinder}
                  dotColor="#e74c3c"
                  sub={`Sent to BPCL: ${stockData.bpclIn}`}
                  onPress={() => handleEditTile('submit_empty_14', '14.2 kg Empty - Godown', 'EMPTY', 14)}
                />
              </View>

              {/* 5.0 KG (Explicitly split into separate rows to avoid overlap bugs) */}
              <Text style={styles.sectionLabel}>5.0 kg · FTL</Text>
              <View style={styles.statGrid}>
                <StatTile
                  label="Full · godown"
                  value={stockData.ftlGodownFull}
                  dotColor="#27ae60"
                  sub={`From BPCL: ${stockData.ftlBpcl}`}
                  onPress={() => handleEditTile('submit_full_5', '5.0 kg Full - Godown', 'FULL', 5)}
                />
                <StatTile
                  label="Empty · godown"
                  value={stockData.ftlGodownEmpty}
                  dotColor="#e74c3c"
                  sub={`Sent to BPCL: ${stockData.ftlBpcl}`}
                  onPress={() => handleEditTile('submit_empty_5', '5.0 kg Empty - Godown', 'EMPTY', 5)}
                />
              </View>
              <View style={[styles.statGrid, { marginTop: 8 }]}>
                <StatTile
                  label="Full · office"
                  value={stockData.ftlOfficeFull}
                  dotColor={BPCL_BLUE}
                  sub={`Received: ${stockData.ftlFromGodown}`}
                />
                <StatTile
                  label="Empty · office"
                  value={stockData.ftlOfficeEmpty}
                  dotColor="#aaa"
                  sub={`To godown: ${stockData.ftlToGodown}`}
                />
              </View>

              {/* Accessories */}
              <Text style={styles.sectionLabel}>Accessories</Text>
              <View style={styles.statGrid}>
                <StatTile label="Rubber tube" value={stockData.srt}      sub={`Today's sale: ${stockData.todaySrt}`} />
                <StatTile label="Hot plate"   value={stockData.hotPlate} sub={`Today's sale: ${stockData.todayHot}`} />
              </View>

              {/* Commercial Cylinder */}
              <Text style={styles.sectionLabel}>Commercial cylinder</Text>
              <View style={styles.statGrid}>
                <StatTile
                  label="Full · commercial"
                  value={stockData.fullCommercial}
                  dotColor="#27ae60"
                  sub={`From BPCL: ${stockData.bpclInCommercial}`}
                  onPress={() => handleEditTile('submit_full_19', 'Commercial Full', 'FULL', 19)}
                />
                <StatTile
                  label="Empty · commercial"
                  value={stockData.emptyCommercial}
                  dotColor="#e74c3c"
                  sub={`Sent to BPCL: ${stockData.bpclInCommercial}`}
                  onPress={() => handleEditTile('submit_empty_19', 'Commercial Empty', 'EMPTY', 19)}
                />
              </View>
            </>
          ) : null}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ════════ UPDATE VIEW ════════ */}
      {innerTab === 'update' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Fetch row (date now lives in the header, shared across the whole screen) */}
          <View style={styles.dateRow}>
            <TouchableOpacity
              style={[styles.fetchBtn, { flex: 1 }, fetching && { opacity: 0.7 }]}
              onPress={handleFetch}
              disabled={fetching}
            >
              {fetching
                ? <ActivityIndicator size="small" color="#7a6100" />
                : <><Ionicons name="refresh" size={15} color="#7a6100" /><Text style={styles.fetchBtnText}>Fetch for {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}</Text></>}
            </TouchableOpacity>
          </View>

          {/* 14.2 KG */}
          <SectionCard title="14.2 kg cylinder" iconName="cube-outline" iconColor="#185FA5" iconBg="#E6F1FB" badge={{ label: 'Domestic', color: '#185FA5', bg: '#E6F1FB' }}>
            <View style={styles.fields2}>
              <Field label="BPCL"           value={form.bpcl}          onChangeText={set('bpcl')} />
              <Field label="Total refill"   value={form.totalRefill}   onChangeText={set('totalRefill')} prefilled={fetched} />
              <Field label="New connections" value={form.newConnection} onChangeText={set('newConnection')} prefilled={fetched} />
              <Field label="DBC"            value={form.dbc}           onChangeText={set('dbc')} prefilled={fetched} />
              <Field label="TV in"          value={form.tvIn}          onChangeText={set('tvIn')} prefilled={fetched} />
              <Field label="TV out"         value={form.tvOut}         onChangeText={set('tvOut')} prefilled={fetched} />
            </View>
          </SectionCard>

          {/* 5 KG */}
          <SectionCard title="5.0 kg cylinder" iconName="cube-outline" iconColor="#3B6D11" iconBg="#EAF3DE" badge={{ label: 'FTL', color: '#3B6D11', bg: '#EAF3DE' }}>
            <View style={styles.fields2}>
              <Field label="BPCL"             value={form.ftlBpcl}           onChangeText={set('ftlBpcl')} />
              <Field label="Add office stock" value={form.addOfficeStock}    onChangeText={set('addOfficeStock')} />
              <View style={styles.fieldWrap}>
                <View style={styles.labelContainer}>
                  <Text style={styles.fieldLabel} numberOfLines={3}>Empty to godown</Text>
                </View>
                <TextInput
                  style={styles.fieldInput}
                  value={form.emptyToGodown}
                  onChangeText={set('emptyToGodown')}
                  keyboardType="numeric"
                  selectTextOnFocus
                />
              </View>
              <Field label="Refill"           value={form.smallRefill}       onChangeText={set('smallRefill')} prefilled={fetched} />
              <Field label="New connections"  value={form.smallNewConnection} onChangeText={set('smallNewConnection')} prefilled={fetched} />
            </View>
          </SectionCard>

          {/* Rubber Tube */}
          <SectionCard title="Rubber tube" iconName="build-outline" iconColor="#854F0B" iconBg="#FAEEDA">
            <View style={styles.fields3}>
              <Field label="Add SRT stock"   value={form.addSrt}  onChangeText={set('addSrt')} />
              <Field label="Sale"            value={form.srtSale} onChangeText={set('srtSale')} prefilled={fetched} />
              <Field label="New connections" value={form.srtNc}   readonly />
            </View>
          </SectionCard>

          {/* DPR */}
          <SectionCard title="DPR" iconName="speedometer-outline" iconColor="#993556" iconBg="#FBEAF0">
            <View style={styles.fields3}>
              <Field label="Add DPR stock"   value={form.addDpr}  onChangeText={set('addDpr')} />
              <Field label="Sale"            value={form.dprSale} onChangeText={set('dprSale')} prefilled={fetched} />
              <Field label="New connections" value={form.dprNc}   readonly />
            </View>
          </SectionCard>

          {/* Hot Plate */}
          <SectionCard title="Hot plate" iconName="flame-outline" iconColor="#A32D2D" iconBg="#FCEBEB">
            <View style={styles.fields3}>
              <Field label="Add stock"       value={form.addHotPlate}  onChangeText={set('addHotPlate')} />
              <Field label="Sale"            value={form.hotPlateSale} onChangeText={set('hotPlateSale')} prefilled={fetched} />
              <Field label="New connections" value={form.hotPlateNc}   readonly />
            </View>
          </SectionCard>

          {/* Commercial */}
          <SectionCard title="Commercial cylinder" iconName="business-outline" iconColor="#534AB7" iconBg="#EEEDFE">
            <View style={styles.fields3}>
              <Field label="From BPCL"      value={form.commercialFromBpcl} onChangeText={set('commercialFromBpcl')} />
              <Field label="Delivered"      value={form.cylinderDelivered}  onChangeText={set('cylinderDelivered')} prefilled={fetched} />
              <Field label="Empty received" value={form.emptyReceived}      onChangeText={set('emptyReceived')} prefilled={fetched} />
            </View>
          </SectionCard>

          <TouchableOpacity
            style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator size="small" color="#fff" />
              : <><Ionicons name="checkmark-circle" size={20} color="#fff" /><Text style={styles.submitBtnText}>Submit all records</Text></>}
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ════════ INTERACTIVE UPDATE STOCK MODAL ════════ */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContainer}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {selectedTile ? `Update: ${selectedTile.label}` : 'Update Stock'}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close-circle" size={26} color="#aaa" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalDateNote}>
              Applies to: {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
            </Text>

            {/* Selector: Add or Subtract */}
            <View style={styles.opSelectorRow}>
              <TouchableOpacity
                style={[
                  styles.opSelectorBtn,
                  !isSubtract && styles.opSelectorBtnAdd,
                ]}
                onPress={() => setIsSubtract(false)}
              >
                <Ionicons
                  name="add-circle-outline"
                  size={16}
                  color={!isSubtract ? '#fff' : '#27ae60'}
                />
                <Text
                  style={[
                    styles.opSelectorText,
                    !isSubtract && styles.opSelectorTextSelected,
                  ]}
                >
                  Add Stock
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.opSelectorBtn,
                  isSubtract && styles.opSelectorBtnSub,
                ]}
                onPress={() => setIsSubtract(true)}
              >
                <Ionicons
                  name="remove-circle-outline"
                  size={16}
                  color={isSubtract ? '#fff' : '#e74c3c'}
                />
                <Text
                  style={[
                    styles.opSelectorText,
                    isSubtract && styles.opSelectorTextSelected,
                  ]}
                >
                  Subtract Stock
                </Text>
              </TouchableOpacity>
            </View>

            {/* Input fields */}
            <View style={styles.modalForm}>
              <View style={styles.modalFieldWrap}>
                <Text style={styles.modalFieldLabel}>Remarks</Text>
                <TextInput
                  style={styles.modalTextInput}
                  placeholder="Enter Remarks"
                  value={modalRemarks}
                  onChangeText={setModalRemarks}
                  autoCapitalize="characters"
                />
              </View>

              <View style={styles.modalFieldWrap}>
                <Text style={styles.modalFieldLabel}>Quantity</Text>
                <TextInput
                  style={styles.modalTextInput}
                  placeholder="Enter Qty"
                  keyboardType="numeric"
                  value={modalQuantity}
                  onChangeText={setModalQuantity}
                />
              </View>
            </View>

            {/* Footer Actions */}
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.modalCancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalSubmitBtn, updatingStock && { opacity: 0.6 }]}
                onPress={submitStockTransaction}
                disabled={updatingStock}
              >
                {updatingStock ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={16} color="#fff" />
                    <Text style={styles.modalSubmitBtnText}>Save</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ BPCL TRUCK-LOAD COMBINATION MODAL ════════ */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={truckModalVisible}
        onRequestClose={() => setTruckModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Which truck load came in?</Text>
              <TouchableOpacity onPress={() => setTruckModalVisible(false)}>
                <Ionicons name="close-circle" size={26} color="#aaa" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalDateNote}>
              Pick the BPCL combination for {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')} — this fills the 14.2 kg and 19 kg BPCL fields for you.
            </Text>

            <View style={styles.truckOptionList}>
              {TRUCK_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={`${opt.kg14}-${opt.kg19}`}
                  style={styles.truckOptionBtn}
                  onPress={() => selectTruckOption(opt)}
                >
                  <View style={styles.truckOptionIcon}>
                    <Ionicons name="car-outline" size={16} color={BPCL_BLUE} />
                  </View>
                  <Text style={styles.truckOptionText}>
                    {opt.kg14} × 14.2 kg  +  {opt.kg19} × 19 kg
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color="#bbb" />
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={styles.modalCancelBtn}
              onPress={() => setTruckModalVisible(false)}
            >
              <Text style={styles.modalCancelBtnText}>None of these / enter manually</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#f5f5f5' },

  // Header
  header:         { backgroundColor: BPCL_BLUE },
  headerContent:  { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 },
  headerTitle:    { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  headerSub:      { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },

  // Segmented control
  segControl:     { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 10, padding: 3, marginTop: 14 },
  segBtn:         { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: 8 },
  segBtnActive:   { backgroundColor: '#fff' },
  segBtnText:     { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.75)' },
  segBtnTextActive:{ color: BPCL_BLUE },

  // Scroll
  scroll:         { flex: 1 },
  scrollContent:  { padding: 14 },
  loadingBox:     { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  loadingText:    { color: '#888', fontSize: 15 },

  // Section label
  sectionLabel:   { fontSize: 11, fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 14 },

  // Stat tiles
  statGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 4 },
  statTile:       { flex: 1, minWidth: '45%', backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.09)', padding: 12 },
  interactiveTile:{ borderColor: BPCL_BLUE + '66', borderWidth: 1, backgroundColor: '#fcfdfe' },
  statLabelRow:   { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  editIcon:       { marginLeft: 'auto' },
  dot:            { width: 7, height: 7, borderRadius: 4 },
  statLabel:      { fontSize: 10.5, color: '#888', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, flex: 1 },
  statValue:      { fontSize: 24, fontWeight: '700', color: '#222' },
  statSub:        { fontSize: 11, color: '#aaa', marginTop: 3 },

  // Cards
  card:           { backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.09)', marginBottom: 12, overflow: 'hidden' },
  cardHead:       { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 9, borderBottomWidth: 0.5, borderBottomColor: 'rgba(0,0,0,0.08)' },
  cardIcon:       { width: 28, height: 28, borderRadius: 7, justifyContent: 'center', alignItems: 'center' },
  cardTitle:      { fontSize: 13, fontWeight: '600', color: '#333', flex: 1 },
  badge:          { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText:      { fontSize: 11, fontWeight: '600' },

  // Date row / picker (shared, shown in header)
  dateRow:        { flexDirection: 'row', gap: 10, marginBottom: 14 },
  dateBtn:        { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#fff', borderRadius: 9, height: 40, paddingHorizontal: 12, marginTop: 12, alignSelf: 'flex-start' },
  dateBtnText:    { fontSize: 14, color: '#333', fontWeight: '600' },
  fetchBtn:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: BPCL_YELLOW, borderRadius: 9, height: 42, paddingHorizontal: 16 },
  fetchBtnText:   { fontSize: 13, fontWeight: '600', color: '#7a6100' },

  // Grid Fields (3-column visual alignment)
  fields2:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  fields3:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  fieldWrap:      { width: '31%', minWidth: 95, gap: 4, marginBottom: 8 },
  labelContainer: { height: 32, justifyContent: 'flex-end', marginBottom: 2 },
  fieldLabel:     { fontSize: 10, color: '#888', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, lineHeight: 11 },
  fieldInput:     { backgroundColor: '#f6f7fb', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.12)', borderRadius: 7, padding: 8, fontSize: 13, color: '#333', width: '100%' },
  fieldInputRo:   { color: '#aaa', backgroundColor: '#f0f0f0' },
  fieldInputPre:  { color: BPCL_BLUE, fontWeight: '600', borderColor: BPCL_BLUE + '55' },

  // Submit
  submitBtn:      { backgroundColor: BPCL_BLUE, borderRadius: 10, padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  submitBtnText:  { color: '#fff', fontSize: 15, fontWeight: 'bold' },

  // Modal styling
  modalOverlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContainer: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, shadowColor: '#000', shadowOffset: { width: 0, height: -3 }, shadowOpacity: 0.15, shadowRadius: 5, elevation: 5 },
  modalHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  modalTitle:     { fontSize: 16, fontWeight: 'bold', color: '#333' },
  modalDateNote:  { fontSize: 12, color: BPCL_BLUE, fontWeight: '600', marginBottom: 14 },
  opSelectorRow:  { flexDirection: 'row', gap: 10, marginBottom: 16 },
  opSelectorBtn:  { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingVertical: 11, backgroundColor: '#f9f9f9' },
  opSelectorBtnAdd: { backgroundColor: '#27ae60', borderColor: '#27ae60' },
  opSelectorBtnSub: { backgroundColor: '#e74c3c', borderColor: '#e74c3c' },
  opSelectorText: { fontSize: 13, fontWeight: '600', color: '#666' },
  opSelectorTextSelected: { color: '#fff' },
  modalForm:      { gap: 12, marginBottom: 18 },
  modalFieldWrap: { gap: 4 },
  modalFieldLabel:{ fontSize: 11, color: '#888', fontWeight: '600', textTransform: 'uppercase' },
  modalTextInput: { backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 8, padding: 10, fontSize: 14, color: '#333' },
  modalFooter:    { flexDirection: 'row', gap: 10 },
  modalCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fafafa' },
  modalCancelBtnText: { color: '#666', fontSize: 14, fontWeight: '600' },
  modalSubmitBtn: { flex: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 8, backgroundColor: BPCL_BLUE },
  modalSubmitBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },

  // Truck combination picker
  truckOptionList: { gap: 8, marginBottom: 14 },
  truckOptionBtn:  { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, backgroundColor: '#f9fafc' },
  truckOptionIcon: { width: 28, height: 28, borderRadius: 7, backgroundColor: '#E6F1FB', justifyContent: 'center', alignItems: 'center' },
  truckOptionText: { flex: 1, fontSize: 14, fontWeight: '600', color: '#333' },
});
