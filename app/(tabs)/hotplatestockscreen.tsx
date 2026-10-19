import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

// This screen is ONLY for Hot Plate stock. It reads/writes its own two
// tables (dashboard_hotplateproductmaster, dashboard_hotplatestocktransactions)
// and never touches dashboard_cylinderstock / dashboard_godownftlstock /
// dashboard_officeftlstock / dashboard_commercialstock / dashboard_rubbertubestock
// / dashboard_hotplatestock (the old single-row-per-day LPG hot plate table) —
// those keep working exactly as they do today in StockScreen.tsx.

const BPCL_BLUE   = '#017DC5';
const BPCL_YELLOW = '#FFDC02';
const GREEN  = '#27ae60';
const RED    = '#e74c3c';
const AMBER  = '#c98a1a';

type InnerTab = 'dashboard' | 'ledger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HotPlateProduct {
  id: number;
  product_name: string;
  burner_type: string;
  model: string;
  unit: string;
  purchase_price: number;
  sale_price: number;
  reorder_level: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

type TxnType = 'OPENING' | 'ADD' | 'SALE' | 'RETURN' | 'ADJUSTMENT';
type ReturnType = 'CUSTOMER' | 'SUPPLIER';

export interface HotPlateStockRow {
  id: number;
  date: string;
  product_id: number;
  burner_type: string;
  opening_balance: number;
  add_quantity: number;
  sale_quantity: number;
  return_quantity: number;      // signed: +customer return, -supplier return
  adjustment_quantity: number;  // signed: + increase, - decrease
  closing_balance: number;
  purchase_price: number;
  sale_price: number;
  remarks: string | null;
  transaction_type: TxnType;
  return_type?: ReturnType | null;
  adjustment_reason?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface CurrentStockRow {
  product: HotPlateProduct;
  latest: HotPlateStockRow | null; // null = product has never had a transaction yet
}

// ─── Tables & fixed option lists ───────────────────────────────────────────

const TABLES = {
  products: 'dashboard_hotplateproductmaster',
  transactions: 'dashboard_hotplatestocktransactions',
};

// Starting suggestions only — burner_type is a free column on the product,
// not a separate table, so a brand-new type can always be typed in the
// "Add new hot plate" form without any schema change.
const DEFAULT_BURNER_TYPES = ['1 Burner', '2 Burner', '3 Burner', '4 Burner'];

const ADJUSTMENT_REASONS = ['Damaged', 'Missing', 'Physical stock difference', 'Correction', 'Other'];

const rupee = (v: number) => `₹${(v ?? 0).toLocaleString('en-IN')}`;
const n = (v: string) => {
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

// ─── Supabase helpers ──────────────────────────────────────────────────────

async function loadProducts(): Promise<HotPlateProduct[]> {
  const { data, error } = await supabase
    .from(TABLES.products)
    .select('*')
    .order('burner_type', { ascending: true })
    .order('product_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as HotPlateProduct[];
}

/** The most recent transaction for a product — its closing_balance is the
 *  correct opening balance for whatever happens next. Never derive opening
 *  balance any other way. */
async function getLatestTransaction(productId: number): Promise<HotPlateStockRow | null> {
  const { data, error } = await supabase
    .from(TABLES.transactions)
    .select('*')
    .eq('product_id', productId)
    .order('date', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as HotPlateStockRow | null;
}

async function insertTransaction(row: Omit<HotPlateStockRow, 'id' | 'created_at' | 'updated_at'>) {
  const { error } = await supabase.from(TABLES.transactions).insert(row);
  if (error) throw error;
}

/** ADD STOCK — always inserts a brand-new row; never edits a past one. */
async function addStock(opts: {
  product: HotPlateProduct;
  date: string;
  quantity: number;
  purchasePrice: number;
  remarks: string;
}) {
  const prev = await getLatestTransaction(opts.product.id);
  const opening = prev?.closing_balance ?? 0;
  const closing = opening + opts.quantity;
  await insertTransaction({
    date: opts.date,
    product_id: opts.product.id,
    burner_type: opts.product.burner_type,
    opening_balance: opening,
    add_quantity: opts.quantity,
    sale_quantity: 0,
    return_quantity: 0,
    adjustment_quantity: 0,
    closing_balance: closing,
    purchase_price: opts.purchasePrice,
    sale_price: opts.product.sale_price,
    remarks: opts.remarks || null,
    transaction_type: 'ADD',
  });
}

/** SALE — refuses to let sale_quantity exceed the current stock. */
async function sellStock(opts: {
  product: HotPlateProduct;
  date: string;
  quantity: number;
  salePrice: number;
  remarks: string;
}) {
  const prev = await getLatestTransaction(opts.product.id);
  const opening = prev?.closing_balance ?? 0;
  if (opts.quantity > opening) {
    throw new Error(`Only ${opening} in stock for ${opts.product.product_name} — cannot sell ${opts.quantity}`);
  }
  const closing = opening - opts.quantity;
  await insertTransaction({
    date: opts.date,
    product_id: opts.product.id,
    burner_type: opts.product.burner_type,
    opening_balance: opening,
    add_quantity: 0,
    sale_quantity: opts.quantity,
    return_quantity: 0,
    adjustment_quantity: 0,
    closing_balance: closing,
    purchase_price: opts.product.purchase_price,
    sale_price: opts.salePrice,
    remarks: opts.remarks || null,
    transaction_type: 'SALE',
  });
}

/** RETURN — customer return adds stock back, supplier return removes it.
 *  The direction is recorded in return_type so the ledger always shows why
 *  the number moved the way it did. */
async function returnStock(opts: {
  product: HotPlateProduct;
  date: string;
  quantity: number;
  returnType: ReturnType;
  remarks: string;
}) {
  const prev = await getLatestTransaction(opts.product.id);
  const opening = prev?.closing_balance ?? 0;
  const signedQty = opts.returnType === 'SUPPLIER' ? -opts.quantity : opts.quantity;
  const closing = opening + signedQty;
  if (closing < 0) {
    throw new Error(`This supplier return would take ${opts.product.product_name} stock below zero (currently ${opening})`);
  }
  await insertTransaction({
    date: opts.date,
    product_id: opts.product.id,
    burner_type: opts.product.burner_type,
    opening_balance: opening,
    add_quantity: 0,
    sale_quantity: 0,
    return_quantity: signedQty,
    adjustment_quantity: 0,
    closing_balance: closing,
    purchase_price: opts.product.purchase_price,
    sale_price: opts.product.sale_price,
    remarks: opts.remarks || null,
    transaction_type: 'RETURN',
    return_type: opts.returnType,
  });
}

/** ADJUSTMENT — always needs a reason + remark, per spec. */
async function adjustStock(opts: {
  product: HotPlateProduct;
  date: string;
  signedQuantity: number;
  reason: string;
  remarks: string;
}) {
  const prev = await getLatestTransaction(opts.product.id);
  const opening = prev?.closing_balance ?? 0;
  const closing = opening + opts.signedQuantity;
  if (closing < 0) {
    throw new Error(`This adjustment would take ${opts.product.product_name} stock below zero (currently ${opening})`);
  }
  await insertTransaction({
    date: opts.date,
    product_id: opts.product.id,
    burner_type: opts.product.burner_type,
    opening_balance: opening,
    add_quantity: 0,
    sale_quantity: 0,
    return_quantity: 0,
    adjustment_quantity: opts.signedQuantity,
    closing_balance: closing,
    purchase_price: opts.product.purchase_price,
    sale_price: opts.product.sale_price,
    remarks: opts.remarks || null,
    transaction_type: 'ADJUSTMENT',
    adjustment_reason: opts.reason,
  });
}

/** ADD NEW HOT PLATE — creates the product, and only if an opening stock
 *  figure was entered, writes the very first transaction row for it
 *  (opening_balance is 0 here by definition — there is no earlier row). */
async function createProduct(opts: {
  productName: string;
  burnerType: string;
  model: string;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  reorderLevel: number;
  isActive: boolean;
  openingStock: number;
  date: string;
}): Promise<HotPlateProduct> {
  const { data: product, error } = await supabase
    .from(TABLES.products)
    .insert({
      product_name: opts.productName,
      burner_type: opts.burnerType,
      model: opts.model,
      unit: opts.unit || 'PCS',
      purchase_price: opts.purchasePrice,
      sale_price: opts.salePrice,
      reorder_level: opts.reorderLevel,
      is_active: opts.isActive,
    })
    .select()
    .single();
  if (error) throw error;

  if (opts.openingStock > 0) {
    await insertTransaction({
      date: opts.date,
      product_id: product.id,
      burner_type: opts.burnerType,
      opening_balance: 0,
      add_quantity: opts.openingStock,
      sale_quantity: 0,
      return_quantity: 0,
      adjustment_quantity: 0,
      closing_balance: opts.openingStock,
      purchase_price: opts.purchasePrice,
      sale_price: opts.salePrice,
      remarks: 'Opening stock',
      transaction_type: 'OPENING',
    });
  }

  return product as HotPlateProduct;
}

interface LedgerFilters {
  dateFrom: string;
  dateTo: string;
  burnerType: string | null; // null = all
  productId: number | null;  // null = all
}

async function loadLedger(filters: LedgerFilters): Promise<HotPlateStockRow[]> {
  let query = supabase
    .from(TABLES.transactions)
    .select('*')
    .gte('date', filters.dateFrom)
    .lte('date', filters.dateTo)
    .order('date', { ascending: false })
    .order('id', { ascending: false })
    .limit(300);

  if (filters.burnerType) query = query.eq('burner_type', filters.burnerType);
  if (filters.productId != null) query = query.eq('product_id', filters.productId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as HotPlateStockRow[];
}

// ─── Small reusable UI pieces (same visual language as StockScreen) ────────

function SectionCard({
  title, iconName, iconColor, iconBg, right, children,
}: {
  title: string;
  iconName: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={[styles.cardIcon, { backgroundColor: iconBg }]}>
          <Ionicons name={iconName} size={15} color={iconColor} />
        </View>
        <Text style={styles.cardTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function StatTile({
  label, value, sub, dotColor, danger,
}: { label: string; value: number | string; sub?: string; dotColor?: string; danger?: boolean }) {
  return (
    <View style={[styles.statTile, danger && styles.statTileDanger]}>
      <View style={styles.statLabelRow}>
        {dotColor && <View style={[styles.dot, { backgroundColor: dotColor }]} />}
        <Text style={styles.statLabel}>{label}</Text>
      </View>
      <Text style={[styles.statValue, danger && { color: RED }]}>{value}</Text>
      {sub ? <Text style={styles.statSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function Field({
  label, value, onChangeText, readonly = false, multiline = false, keyboardType = 'numeric',
}: {
  label: string; value: string; onChangeText?: (v: string) => void;
  readonly?: boolean; multiline?: boolean; keyboardType?: 'numeric' | 'default';
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, readonly && styles.fieldInputRo, multiline && styles.fieldInputMultiline]}
        value={value}
        onChangeText={onChangeText}
        editable={!readonly}
        keyboardType={keyboardType}
        multiline={multiline}
        selectTextOnFocus
      />
    </View>
  );
}

/** Two-way toggle used for return direction and active/inactive, matching
 *  the Add/Subtract selector already used in StockScreen's tile modal. */
function SegmentedToggle({
  leftLabel, rightLabel, leftColor, rightColor, value, onChange,
}: {
  leftLabel: string; rightLabel: string; leftColor: string; rightColor: string;
  value: boolean; onChange: (v: boolean) => void; // false = left, true = right
}) {
  return (
    <View style={styles.opSelectorRow}>
      <TouchableOpacity
        style={[styles.opSelectorBtn, !value && { backgroundColor: leftColor, borderColor: leftColor }]}
        onPress={() => onChange(false)}
      >
        <Text style={[styles.opSelectorText, !value && styles.opSelectorTextSelected]}>{leftLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.opSelectorBtn, value && { backgroundColor: rightColor, borderColor: rightColor }]}
        onPress={() => onChange(true)}
      >
        <Text style={[styles.opSelectorText, value && styles.opSelectorTextSelected]}>{rightLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ChipGroup({
  options, value, onChange,
}: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt}
          style={[styles.chip, value === opt && styles.chipSelected]}
          onPress={() => onChange(opt)}
        >
          <Text style={[styles.chipText, value === opt && styles.chipTextSelected]}>{opt}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

/** Generic "pick one from a list" modal, reused for product and burner-type
 *  pickers so we don't need a native <select> that RN doesn't have. */
function OptionPickerModal({
  visible, title, options, onSelect, onClose,
}: {
  visible: boolean; title: string;
  options: { label: string; sub?: string; value: string }[];
  onSelect: (value: string) => void; onClose: () => void;
}) {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-circle" size={26} color="#aaa" />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: 360 }}>
            <View style={styles.truckOptionList}>
              {options.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={styles.truckOptionBtn}
                  onPress={() => onSelect(opt.value)}
                >
                  <View>
                    <Text style={styles.truckOptionText}>{opt.label}</Text>
                    {opt.sub ? <Text style={styles.pickerOptionSub}>{opt.sub}</Text> : null}
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="#bbb" />
                </TouchableOpacity>
              ))}
              {options.length === 0 && (
                <Text style={styles.emptyListText}>Nothing to pick from yet.</Text>
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function PickerField({ label, valueLabel, onPress }: { label: string; valueLabel: string; onPress: () => void }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={onPress}>
        <Text style={styles.pickerBtnText} numberOfLines={1}>{valueLabel}</Text>
        <Ionicons name="chevron-down" size={14} color="#888" />
      </TouchableOpacity>
    </View>
  );
}

/** A small horizontally-scrollable grid table — used for both the current
 *  stock table and the ledger, matching the columns from the spec. */
function DataTable({
  columns, rows,
}: { columns: { key: string; label: string; width: number }[]; rows: Record<string, string>[] }) {
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={rows.length > 0}>
      <View style={{ width: totalWidth }}>
        <View style={styles.tableHeaderRow}>
          {columns.map((c) => (
            <Text key={c.key} style={[styles.tableHeaderCell, { width: c.width }]}>{c.label}</Text>
          ))}
        </View>
        {rows.length === 0 ? (
          <Text style={styles.emptyListText}>No rows to show.</Text>
        ) : (
          rows.map((row, i) => (
            <View key={i} style={[styles.tableRow, i % 2 === 1 && styles.tableRowAlt]}>
              {columns.map((c) => (
                <Text key={c.key} style={[styles.tableCell, { width: c.width }]} numberOfLines={2}>
                  {row[c.key] ?? '—'}
                </Text>
              ))}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function HotPlateStockScreen() {
  const [innerTab, setInnerTab] = useState<InnerTab>('dashboard');

  const [products, setProducts] = useState<HotPlateProduct[]>([]);
  const [stockRows, setStockRows] = useState<CurrentStockRow[]>([]);
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  // ── Ledger state ───────────────────────────────────────────────────────
  const [ledgerRows, setLedgerRows] = useState<HotPlateStockRow[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [ledgerFrom, setLedgerFrom] = useState(format(new Date(new Date().setDate(new Date().getDate() - 30)), 'yyyy-MM-dd'));
  const [ledgerTo, setLedgerTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [ledgerBurnerFilter, setLedgerBurnerFilter] = useState<string | null>(null);
  const [ledgerProductFilter, setLedgerProductFilter] = useState<HotPlateProduct | null>(null);
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const [burnerFilterPickerVisible, setBurnerFilterPickerVisible] = useState(false);
  const [productFilterPickerVisible, setProductFilterPickerVisible] = useState(false);

  // ── Shared "which product is this action for" picker ─────────────────────
  const [productPickerVisible, setProductPickerVisible] = useState(false);
  const [productPickerTarget, setProductPickerTarget] = useState<'add' | 'sale' | 'return' | 'adjust' | null>(null);

  // ── Add Stock modal ───────────────────────────────────────────────────────
  const [addVisible, setAddVisible] = useState(false);
  const [addProduct, setAddProduct] = useState<HotPlateProduct | null>(null);
  const [addDate, setAddDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showAddDatePicker, setShowAddDatePicker] = useState(false);
  const [addQty, setAddQty] = useState('');
  const [addPrice, setAddPrice] = useState('');
  const [addRemarks, setAddRemarks] = useState('');
  const [addSubmitting, setAddSubmitting] = useState(false);

  // ── Sale modal ─────────────────────────────────────────────────────────────
  const [saleVisible, setSaleVisible] = useState(false);
  const [saleProduct, setSaleProduct] = useState<HotPlateProduct | null>(null);
  const [saleDate, setSaleDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showSaleDatePicker, setShowSaleDatePicker] = useState(false);
  const [saleQty, setSaleQty] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [saleRemarks, setSaleRemarks] = useState('');
  const [saleSubmitting, setSaleSubmitting] = useState(false);

  // ── Return modal ───────────────────────────────────────────────────────────
  const [returnVisible, setReturnVisible] = useState(false);
  const [returnProduct, setReturnProduct] = useState<HotPlateProduct | null>(null);
  const [returnDate, setReturnDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showReturnDatePicker, setShowReturnDatePicker] = useState(false);
  const [returnIsSupplier, setReturnIsSupplier] = useState(false); // false = customer
  const [returnQty, setReturnQty] = useState('');
  const [returnRemarks, setReturnRemarks] = useState('');
  const [returnSubmitting, setReturnSubmitting] = useState(false);

  // ── Adjustment modal ───────────────────────────────────────────────────────
  const [adjustVisible, setAdjustVisible] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState<HotPlateProduct | null>(null);
  const [adjustDate, setAdjustDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showAdjustDatePicker, setShowAdjustDatePicker] = useState(false);
  const [adjustIsDecrease, setAdjustIsDecrease] = useState(true);
  const [adjustReason, setAdjustReason] = useState(ADJUSTMENT_REASONS[0]);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustRemarks, setAdjustRemarks] = useState('');
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);

  // ── Add New Hot Plate modal ─────────────────────────────────────────────
  const [newVisible, setNewVisible] = useState(false);
  const [newBurnerPickerVisible, setNewBurnerPickerVisible] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [newBurnerType, setNewBurnerType] = useState('');
  const [newCustomBurner, setNewCustomBurner] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [newUnit, setNewUnit] = useState('PCS');
  const [newPurchasePrice, setNewPurchasePrice] = useState('');
  const [newSalePrice, setNewSalePrice] = useState('');
  const [newReorderLevel, setNewReorderLevel] = useState('5');
  const [newIsInactive, setNewIsInactive] = useState(false);
  const [newOpeningStock, setNewOpeningStock] = useState('0');
  const [newSubmitting, setNewSubmitting] = useState(false);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadDashboard = useCallback(async () => {
    setLoadingDashboard(true);
    try {
      const prods = await loadProducts();
      setProducts(prods);
      const active = prods.filter((p) => p.is_active);
      const latests = await Promise.all(active.map((p) => getLatestTransaction(p.id)));
      setStockRows(active.map((p, i) => ({ product: p, latest: latests[i] })));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load hot plate stock');
    } finally {
      setLoadingDashboard(false);
    }
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const runLedger = useCallback(async () => {
    setLoadingLedger(true);
    try {
      const rows = await loadLedger({
        dateFrom: ledgerFrom,
        dateTo: ledgerTo,
        burnerType: ledgerBurnerFilter,
        productId: ledgerProductFilter?.id ?? null,
      });
      setLedgerRows(rows);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load ledger');
    } finally {
      setLoadingLedger(false);
    }
  }, [ledgerFrom, ledgerTo, ledgerBurnerFilter, ledgerProductFilter]);

  useEffect(() => { if (innerTab === 'ledger') runLedger(); }, [innerTab, runLedger]);

  // ── Derived dashboard numbers ────────────────────────────────────────────

  const burnerTypesPresent = useMemo(
    () => Array.from(new Set(products.filter((p) => p.is_active).map((p) => p.burner_type))),
    [products],
  );

  const totalStock = useMemo(
    () => stockRows.reduce((s, r) => s + (r.latest?.closing_balance ?? 0), 0),
    [stockRows],
  );

  const stockByBurnerType = useMemo(() => {
    const map: Record<string, number> = {};
    stockRows.forEach((r) => {
      map[r.product.burner_type] = (map[r.product.burner_type] ?? 0) + (r.latest?.closing_balance ?? 0);
    });
    return map;
  }, [stockRows]);

  const lowStockRows = useMemo(
    () => stockRows.filter((r) => (r.latest?.closing_balance ?? 0) <= r.product.reorder_level),
    [stockRows],
  );

  const productMap = useMemo(() => {
    const map: Record<number, HotPlateProduct> = {};
    products.forEach((p) => { map[p.id] = p; });
    return map;
  }, [products]);

  // ── Product picker plumbing (shared by Add/Sale/Return/Adjust) ───────────

  const openProductPicker = (target: 'add' | 'sale' | 'return' | 'adjust') => {
    setProductPickerTarget(target);
    setProductPickerVisible(true);
  };

  const handleProductPicked = (value: string) => {
    const product = productMap[Number(value)];
    setProductPickerVisible(false);
    if (!product) return;
    if (productPickerTarget === 'add') {
      setAddProduct(product);
      setAddPrice(String(product.purchase_price));
    } else if (productPickerTarget === 'sale') {
      setSaleProduct(product);
      setSalePrice(String(product.sale_price));
    } else if (productPickerTarget === 'return') {
      setReturnProduct(product);
    } else if (productPickerTarget === 'adjust') {
      setAdjustProduct(product);
    }
  };

  const productOptions = useMemo(
    () => products.filter((p) => p.is_active).map((p) => ({
      label: `${p.product_name} — ${p.burner_type}`,
      sub: `${p.model} · Purchase ${rupee(p.purchase_price)} · Sale ${rupee(p.sale_price)}`,
      value: String(p.id),
    })),
    [products],
  );

  // ── Submit handlers ────────────────────────────────────────────────────────

  const resetAddForm = () => { setAddProduct(null); setAddQty(''); setAddPrice(''); setAddRemarks(''); };
  const submitAdd = async () => {
    if (!addProduct) { Alert.alert('Pick a hot plate first'); return; }
    const qty = n(addQty);
    if (qty <= 0) { Alert.alert('Enter a valid quantity'); return; }
    setAddSubmitting(true);
    try {
      await addStock({ product: addProduct, date: addDate, quantity: qty, purchasePrice: n(addPrice), remarks: addRemarks.trim() });
      Alert.alert('Success', 'Stock added');
      setAddVisible(false);
      resetAddForm();
      loadDashboard();
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not add stock');
    } finally {
      setAddSubmitting(false);
    }
  };

  const resetSaleForm = () => { setSaleProduct(null); setSaleQty(''); setSalePrice(''); setSaleRemarks(''); };
  const submitSale = async () => {
    if (!saleProduct) { Alert.alert('Pick a hot plate first'); return; }
    const qty = n(saleQty);
    if (qty <= 0) { Alert.alert('Enter a valid quantity'); return; }
    setSaleSubmitting(true);
    try {
      await sellStock({ product: saleProduct, date: saleDate, quantity: qty, salePrice: n(salePrice), remarks: saleRemarks.trim() });
      Alert.alert('Success', 'Sale recorded');
      setSaleVisible(false);
      resetSaleForm();
      loadDashboard();
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not record sale');
    } finally {
      setSaleSubmitting(false);
    }
  };

  const resetReturnForm = () => { setReturnProduct(null); setReturnQty(''); setReturnRemarks(''); setReturnIsSupplier(false); };
  const submitReturn = async () => {
    if (!returnProduct) { Alert.alert('Pick a hot plate first'); return; }
    const qty = n(returnQty);
    if (qty <= 0) { Alert.alert('Enter a valid quantity'); return; }
    setReturnSubmitting(true);
    try {
      await returnStock({
        product: returnProduct, date: returnDate, quantity: qty,
        returnType: returnIsSupplier ? 'SUPPLIER' : 'CUSTOMER', remarks: returnRemarks.trim(),
      });
      Alert.alert('Success', 'Return recorded');
      setReturnVisible(false);
      resetReturnForm();
      loadDashboard();
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not record return');
    } finally {
      setReturnSubmitting(false);
    }
  };

  const resetAdjustForm = () => { setAdjustProduct(null); setAdjustQty(''); setAdjustRemarks(''); setAdjustReason(ADJUSTMENT_REASONS[0]); setAdjustIsDecrease(true); };
  const submitAdjust = async () => {
    if (!adjustProduct) { Alert.alert('Pick a hot plate first'); return; }
    const qty = n(adjustQty);
    if (qty <= 0) { Alert.alert('Enter a valid quantity'); return; }
    if (!adjustRemarks.trim()) { Alert.alert('A remark is required for every adjustment'); return; }
    setAdjustSubmitting(true);
    try {
      await adjustStock({
        product: adjustProduct, date: adjustDate,
        signedQuantity: adjustIsDecrease ? -qty : qty,
        reason: adjustReason, remarks: adjustRemarks.trim(),
      });
      Alert.alert('Success', 'Adjustment recorded');
      setAdjustVisible(false);
      resetAdjustForm();
      loadDashboard();
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not record adjustment');
    } finally {
      setAdjustSubmitting(false);
    }
  };

  const resetNewForm = () => {
    setNewProductName(''); setNewBurnerType(''); setNewCustomBurner(false); setNewModel('');
    setNewUnit('PCS'); setNewPurchasePrice(''); setNewSalePrice(''); setNewReorderLevel('5');
    setNewIsInactive(false); setNewOpeningStock('0');
  };
  const submitNew = async () => {
    if (!newProductName.trim()) { Alert.alert('Enter a product name'); return; }
    if (!newBurnerType.trim()) { Alert.alert('Pick or type a burner type'); return; }
    setNewSubmitting(true);
    try {
      await createProduct({
        productName: newProductName.trim(),
        burnerType: newBurnerType.trim(),
        model: newModel.trim(),
        unit: newUnit.trim() || 'PCS',
        purchasePrice: n(newPurchasePrice),
        salePrice: n(newSalePrice),
        reorderLevel: n(newReorderLevel),
        isActive: !newIsInactive,
        openingStock: n(newOpeningStock),
        date: format(new Date(), 'yyyy-MM-dd'),
      });
      Alert.alert('Success', 'Hot plate added to the master list');
      setNewVisible(false);
      resetNewForm();
      loadDashboard();
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not create the new hot plate');
    } finally {
      setNewSubmitting(false);
    }
  };

  // ── Table data ─────────────────────────────────────────────────────────────

  const currentStockTableRows = useMemo(() => stockRows.map((r) => {
    const t = r.latest;
    const closing = t?.closing_balance ?? 0;
    return {
      product: r.product.product_name,
      burner: r.product.burner_type,
      opening: String(t?.opening_balance ?? 0),
      added: String(t?.add_quantity ?? 0),
      sold: String(t?.sale_quantity ?? 0),
      returned: String(t?.return_quantity ?? 0),
      adjustment: String(t?.adjustment_quantity ?? 0),
      closing: String(closing),
      salePrice: rupee(r.product.sale_price),
      value: rupee(closing * r.product.purchase_price),
    };
  }), [stockRows]);

  const ledgerTableRows = useMemo(() => ledgerRows.map((t) => ({
    date: t.date,
    product: productMap[t.product_id]?.product_name ?? `#${t.product_id}`,
    burner: t.burner_type,
    opening: String(t.opening_balance),
    added: String(t.add_quantity),
    sold: String(t.sale_quantity),
    returned: String(t.return_quantity),
    adjustment: String(t.adjustment_quantity),
    closing: String(t.closing_balance),
    remarks: t.remarks ?? (t.return_type ? `${t.return_type} return` : t.adjustment_reason ?? '—'),
  })), [ledgerRows, productMap]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Hot plate stock</Text>
          <Text style={styles.headerSub}>
            {innerTab === 'dashboard' ? `${products.filter((p) => p.is_active).length} active products` : 'Full transaction history'}
          </Text>

          <View style={styles.segControl}>
            <TouchableOpacity style={[styles.segBtn, innerTab === 'dashboard' && styles.segBtnActive]} onPress={() => setInnerTab('dashboard')}>
              <Ionicons name="grid-outline" size={14} color={innerTab === 'dashboard' ? BPCL_BLUE : 'rgba(255,255,255,0.7)'} />
              <Text style={[styles.segBtnText, innerTab === 'dashboard' && styles.segBtnTextActive]}>Dashboard</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.segBtn, innerTab === 'ledger' && styles.segBtnActive]} onPress={() => setInnerTab('ledger')}>
              <Ionicons name="list-outline" size={14} color={innerTab === 'ledger' ? BPCL_BLUE : 'rgba(255,255,255,0.7)'} />
              <Text style={[styles.segBtnText, innerTab === 'ledger' && styles.segBtnTextActive]}>Ledger</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {/* ════════ DASHBOARD ════════ */}
      {innerTab === 'dashboard' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={loadingDashboard} onRefresh={loadDashboard} tintColor={BPCL_BLUE} />}
        >
          {loadingDashboard && stockRows.length === 0 ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={BPCL_BLUE} />
              <Text style={styles.loadingText}>Loading hot plate stock…</Text>
            </View>
          ) : (
            <>
              {/* Quick actions */}
              <View style={styles.actionRow}>
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#E6F1FB' }]} onPress={() => setAddVisible(true)}>
                  <Ionicons name="add-circle-outline" size={16} color="#185FA5" />
                  <Text style={[styles.actionBtnText, { color: '#185FA5' }]}>Add stock</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#EAF3DE' }]} onPress={() => setSaleVisible(true)}>
                  <Ionicons name="cash-outline" size={16} color="#3B6D11" />
                  <Text style={[styles.actionBtnText, { color: '#3B6D11' }]}>Sale</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#FAEEDA' }]} onPress={() => setReturnVisible(true)}>
                  <Ionicons name="return-down-back-outline" size={16} color="#854F0B" />
                  <Text style={[styles.actionBtnText, { color: '#854F0B' }]}>Return</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#FBEAF0' }]} onPress={() => setAdjustVisible(true)}>
                  <Ionicons name="build-outline" size={16} color="#993556" />
                  <Text style={[styles.actionBtnText, { color: '#993556' }]}>Adjust</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.newHotPlateBtn} onPress={() => setNewVisible(true)}>
                <Ionicons name="flame-outline" size={16} color="#fff" />
                <Text style={styles.newHotPlateBtnText}>Add new hot plate</Text>
              </TouchableOpacity>

              {/* Summary cards */}
              <Text style={styles.sectionLabel}>Summary</Text>
              <View style={styles.statGrid}>
                <StatTile label="Total hot plate stock" value={totalStock} dotColor={BPCL_BLUE} />
                <StatTile
                  label="Low stock items"
                  value={lowStockRows.length}
                  dotColor={lowStockRows.length > 0 ? RED : GREEN}
                  danger={lowStockRows.length > 0}
                  sub={lowStockRows.length > 0 ? lowStockRows.map((r) => r.product.product_name).slice(0, 2).join(', ') : 'All above reorder level'}
                />
              </View>
              <View style={[styles.statGrid, { marginTop: 8 }]}>
                {burnerTypesPresent.map((bt) => (
                  <StatTile key={bt} label={bt} value={stockByBurnerType[bt] ?? 0} dotColor={AMBER} />
                ))}
                {burnerTypesPresent.length === 0 && (
                  <Text style={styles.emptyListText}>No active hot plate products yet — add one below.</Text>
                )}
              </View>

              {/* Current stock table */}
              <Text style={styles.sectionLabel}>Current stock</Text>
              <View style={styles.card}>
                <DataTable
                  columns={[
                    { key: 'product', label: 'Product', width: 130 },
                    { key: 'burner', label: 'Burner type', width: 90 },
                    { key: 'opening', label: 'Opening', width: 70 },
                    { key: 'added', label: 'Added', width: 60 },
                    { key: 'sold', label: 'Sold', width: 55 },
                    { key: 'returned', label: 'Returned', width: 75 },
                    { key: 'adjustment', label: 'Adjust.', width: 65 },
                    { key: 'closing', label: 'Closing', width: 65 },
                    { key: 'salePrice', label: 'Sale price', width: 85 },
                    { key: 'value', label: 'Stock value', width: 100 },
                  ]}
                  rows={currentStockTableRows}
                />
              </View>
            </>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ════════ LEDGER ════════ */}
      {innerTab === 'ledger' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={loadingLedger} onRefresh={runLedger} tintColor={BPCL_BLUE} />}
        >
          <SectionCard title="Filters" iconName="options-outline" iconColor="#534AB7" iconBg="#EEEDFE">
            <View style={styles.fields2}>
              <View style={styles.fieldWrap}>
                <Text style={styles.fieldLabel}>Date from</Text>
                <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowFromPicker(true)}>
                  <Text style={styles.pickerBtnText}>{format(new Date(ledgerFrom + 'T00:00:00'), 'dd MMM yyyy')}</Text>
                  <Ionicons name="calendar-outline" size={14} color="#888" />
                </TouchableOpacity>
              </View>
              <View style={styles.fieldWrap}>
                <Text style={styles.fieldLabel}>Date to</Text>
                <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowToPicker(true)}>
                  <Text style={styles.pickerBtnText}>{format(new Date(ledgerTo + 'T00:00:00'), 'dd MMM yyyy')}</Text>
                  <Ionicons name="calendar-outline" size={14} color="#888" />
                </TouchableOpacity>
              </View>
              <PickerField
                label="Burner type"
                valueLabel={ledgerBurnerFilter ?? 'All'}
                onPress={() => setBurnerFilterPickerVisible(true)}
              />
              <PickerField
                label="Product"
                valueLabel={ledgerProductFilter ? ledgerProductFilter.product_name : 'All'}
                onPress={() => setProductFilterPickerVisible(true)}
              />
            </View>
            <TouchableOpacity style={styles.applyFilterBtn} onPress={runLedger} disabled={loadingLedger}>
              {loadingLedger ? <ActivityIndicator size="small" color="#fff" /> : (
                <><Ionicons name="funnel-outline" size={15} color="#fff" /><Text style={styles.applyFilterBtnText}>Apply filters</Text></>
              )}
            </TouchableOpacity>
          </SectionCard>

          <Text style={styles.sectionLabel}>Transactions ({ledgerRows.length})</Text>
          <View style={styles.card}>
            <DataTable
              columns={[
                { key: 'date', label: 'Date', width: 85 },
                { key: 'product', label: 'Product', width: 120 },
                { key: 'burner', label: 'Burner type', width: 90 },
                { key: 'opening', label: 'Opening', width: 65 },
                { key: 'added', label: 'Added', width: 55 },
                { key: 'sold', label: 'Sold', width: 50 },
                { key: 'returned', label: 'Return', width: 60 },
                { key: 'adjustment', label: 'Adjust.', width: 60 },
                { key: 'closing', label: 'Closing', width: 60 },
                { key: 'remarks', label: 'Remarks', width: 160 },
              ]}
              rows={ledgerTableRows}
            />
          </View>
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── Shared date pickers for ledger filters ── */}
      {showFromPicker && (
        <DateTimePicker
          value={new Date(ledgerFrom + 'T00:00:00')}
          mode="date"
          display="default"
          onChange={(evt, d) => { setShowFromPicker(false); if (evt.type === 'set' && d) setLedgerFrom(format(d, 'yyyy-MM-dd')); }}
        />
      )}
      {showToPicker && (
        <DateTimePicker
          value={new Date(ledgerTo + 'T00:00:00')}
          mode="date"
          display="default"
          onChange={(evt, d) => { setShowToPicker(false); if (evt.type === 'set' && d) setLedgerTo(format(d, 'yyyy-MM-dd')); }}
        />
      )}

      <OptionPickerModal
        visible={burnerFilterPickerVisible}
        title="Filter by burner type"
        options={[{ label: 'All burner types', value: '__ALL__' }, ...burnerTypesPresent.map((bt) => ({ label: bt, value: bt }))]}
        onSelect={(v) => { setLedgerBurnerFilter(v === '__ALL__' ? null : v); setBurnerFilterPickerVisible(false); }}
        onClose={() => setBurnerFilterPickerVisible(false)}
      />
      <OptionPickerModal
        visible={productFilterPickerVisible}
        title="Filter by product"
        options={[{ label: 'All products', value: '__ALL__' }, ...productOptions]}
        onSelect={(v) => { setLedgerProductFilter(v === '__ALL__' ? null : productMap[Number(v)] ?? null); setProductFilterPickerVisible(false); }}
        onClose={() => setProductFilterPickerVisible(false)}
      />

      {/* ── Shared product picker for the four action modals ── */}
      <OptionPickerModal
        visible={productPickerVisible}
        title="Select hot plate"
        options={productOptions}
        onSelect={handleProductPicked}
        onClose={() => setProductPickerVisible(false)}
      />

      {/* ════════ ADD STOCK MODAL ════════ */}
      <Modal animationType="slide" transparent visible={addVisible} onRequestClose={() => setAddVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add stock</Text>
              <TouchableOpacity onPress={() => setAddVisible(false)}><Ionicons name="close-circle" size={26} color="#aaa" /></TouchableOpacity>
            </View>
            <PickerField label="Hot plate" valueLabel={addProduct ? `${addProduct.product_name} (${addProduct.burner_type})` : 'Tap to select'} onPress={() => openProductPicker('add')} />
            <PickerField label="Date" valueLabel={format(new Date(addDate + 'T00:00:00'), 'dd MMM yyyy')} onPress={() => setShowAddDatePicker(true)} />
            {showAddDatePicker && (
              <DateTimePicker value={new Date(addDate + 'T00:00:00')} mode="date" display="default"
                onChange={(evt, d) => { setShowAddDatePicker(false); if (evt.type === 'set' && d) setAddDate(format(d, 'yyyy-MM-dd')); }} />
            )}
            <View style={styles.fields2}>
              <Field label="Quantity" value={addQty} onChangeText={setAddQty} />
              <Field label="Purchase price" value={addPrice} onChangeText={setAddPrice} />
            </View>
            <Field label="Remarks" value={addRemarks} onChangeText={setAddRemarks} keyboardType="default" />
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setAddVisible(false)}><Text style={styles.modalCancelBtnText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalSubmitBtn, addSubmitting && { opacity: 0.6 }]} onPress={submitAdd} disabled={addSubmitting}>
                {addSubmitting ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.modalSubmitBtnText}>Save</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ SALE MODAL ════════ */}
      <Modal animationType="slide" transparent visible={saleVisible} onRequestClose={() => setSaleVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Sale</Text>
              <TouchableOpacity onPress={() => setSaleVisible(false)}><Ionicons name="close-circle" size={26} color="#aaa" /></TouchableOpacity>
            </View>
            <PickerField label="Product" valueLabel={saleProduct ? `${saleProduct.product_name} (${saleProduct.burner_type})` : 'Tap to select'} onPress={() => openProductPicker('sale')} />
            <PickerField label="Date" valueLabel={format(new Date(saleDate + 'T00:00:00'), 'dd MMM yyyy')} onPress={() => setShowSaleDatePicker(true)} />
            {showSaleDatePicker && (
              <DateTimePicker value={new Date(saleDate + 'T00:00:00')} mode="date" display="default"
                onChange={(evt, d) => { setShowSaleDatePicker(false); if (evt.type === 'set' && d) setSaleDate(format(d, 'yyyy-MM-dd')); }} />
            )}
            <View style={styles.fields2}>
              <Field label="Quantity" value={saleQty} onChangeText={setSaleQty} />
              <Field label="Sale price" value={salePrice} onChangeText={setSalePrice} />
            </View>
            <Field label="Remarks" value={saleRemarks} onChangeText={setSaleRemarks} keyboardType="default" />
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setSaleVisible(false)}><Text style={styles.modalCancelBtnText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalSubmitBtn, saleSubmitting && { opacity: 0.6 }]} onPress={submitSale} disabled={saleSubmitting}>
                {saleSubmitting ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.modalSubmitBtnText}>Save</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ RETURN MODAL ════════ */}
      <Modal animationType="slide" transparent visible={returnVisible} onRequestClose={() => setReturnVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Stock return</Text>
              <TouchableOpacity onPress={() => setReturnVisible(false)}><Ionicons name="close-circle" size={26} color="#aaa" /></TouchableOpacity>
            </View>
            <PickerField label="Product" valueLabel={returnProduct ? `${returnProduct.product_name} (${returnProduct.burner_type})` : 'Tap to select'} onPress={() => openProductPicker('return')} />
            <PickerField label="Date" valueLabel={format(new Date(returnDate + 'T00:00:00'), 'dd MMM yyyy')} onPress={() => setShowReturnDatePicker(true)} />
            {showReturnDatePicker && (
              <DateTimePicker value={new Date(returnDate + 'T00:00:00')} mode="date" display="default"
                onChange={(evt, d) => { setShowReturnDatePicker(false); if (evt.type === 'set' && d) setReturnDate(format(d, 'yyyy-MM-dd')); }} />
            )}
            <Text style={styles.fieldLabel}>Return type</Text>
            <SegmentedToggle
              leftLabel="Customer return (+)" rightLabel="Supplier return (−)"
              leftColor={GREEN} rightColor={RED}
              value={returnIsSupplier} onChange={setReturnIsSupplier}
            />
            <Field label="Quantity" value={returnQty} onChangeText={setReturnQty} />
            <Field label="Remarks" value={returnRemarks} onChangeText={setReturnRemarks} keyboardType="default" />
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setReturnVisible(false)}><Text style={styles.modalCancelBtnText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalSubmitBtn, returnSubmitting && { opacity: 0.6 }]} onPress={submitReturn} disabled={returnSubmitting}>
                {returnSubmitting ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.modalSubmitBtnText}>Save</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ ADJUSTMENT MODAL ════════ */}
      <Modal animationType="slide" transparent visible={adjustVisible} onRequestClose={() => setAdjustVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Stock adjustment</Text>
              <TouchableOpacity onPress={() => setAdjustVisible(false)}><Ionicons name="close-circle" size={26} color="#aaa" /></TouchableOpacity>
            </View>
            <PickerField label="Product" valueLabel={adjustProduct ? `${adjustProduct.product_name} (${adjustProduct.burner_type})` : 'Tap to select'} onPress={() => openProductPicker('adjust')} />
            <PickerField label="Date" valueLabel={format(new Date(adjustDate + 'T00:00:00'), 'dd MMM yyyy')} onPress={() => setShowAdjustDatePicker(true)} />
            {showAdjustDatePicker && (
              <DateTimePicker value={new Date(adjustDate + 'T00:00:00')} mode="date" display="default"
                onChange={(evt, d) => { setShowAdjustDatePicker(false); if (evt.type === 'set' && d) setAdjustDate(format(d, 'yyyy-MM-dd')); }} />
            )}
            <Text style={styles.fieldLabel}>Reason</Text>
            <ChipGroup options={ADJUSTMENT_REASONS} value={adjustReason} onChange={setAdjustReason} />
            <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Direction</Text>
            <SegmentedToggle
              leftLabel="Increase (+)" rightLabel="Decrease (−)"
              leftColor={GREEN} rightColor={RED}
              value={adjustIsDecrease} onChange={setAdjustIsDecrease}
            />
            <Field label="Quantity" value={adjustQty} onChangeText={setAdjustQty} />
            <Field label="Remarks (required)" value={adjustRemarks} onChangeText={setAdjustRemarks} keyboardType="default" />
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setAdjustVisible(false)}><Text style={styles.modalCancelBtnText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalSubmitBtn, adjustSubmitting && { opacity: 0.6 }]} onPress={submitAdjust} disabled={adjustSubmitting}>
                {adjustSubmitting ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.modalSubmitBtnText}>Save</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ ADD NEW HOT PLATE MODAL ════════ */}
      <Modal animationType="slide" transparent visible={newVisible} onRequestClose={() => setNewVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <ScrollView style={styles.modalContainer} keyboardShouldPersistTaps="handled">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add new hot plate</Text>
              <TouchableOpacity onPress={() => setNewVisible(false)}><Ionicons name="close-circle" size={26} color="#aaa" /></TouchableOpacity>
            </View>
            <Field label="Product name" value={newProductName} onChangeText={setNewProductName} keyboardType="default" />

            <Text style={styles.fieldLabel}>Burner type</Text>
            {!newCustomBurner ? (
              <>
                <ChipGroup options={DEFAULT_BURNER_TYPES} value={newBurnerType} onChange={setNewBurnerType} />
                <TouchableOpacity onPress={() => { setNewCustomBurner(true); setNewBurnerType(''); }}>
                  <Text style={styles.linkText}>+ Type a new burner type</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TextInput style={styles.fieldInput} value={newBurnerType} onChangeText={setNewBurnerType} placeholder="e.g. 6 Burner" />
                <TouchableOpacity onPress={() => setNewCustomBurner(false)}>
                  <Text style={styles.linkText}>← Choose from existing types instead</Text>
                </TouchableOpacity>
              </>
            )}

            <View style={styles.fields2}>
              <Field label="Model" value={newModel} onChangeText={setNewModel} keyboardType="default" />
              <Field label="Unit" value={newUnit} onChangeText={setNewUnit} keyboardType="default" />
              <Field label="Purchase price" value={newPurchasePrice} onChangeText={setNewPurchasePrice} />
              <Field label="Sale price" value={newSalePrice} onChangeText={setNewSalePrice} />
              <Field label="Reorder level" value={newReorderLevel} onChangeText={setNewReorderLevel} />
              <Field label="Opening stock" value={newOpeningStock} onChangeText={setNewOpeningStock} />
            </View>

            <Text style={styles.fieldLabel}>Status</Text>
            <SegmentedToggle
              leftLabel="Active" rightLabel="Inactive"
              leftColor={GREEN} rightColor="#888"
              value={newIsInactive} onChange={setNewIsInactive}
            />

            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setNewVisible(false)}><Text style={styles.modalCancelBtnText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalSubmitBtn, newSubmitting && { opacity: 0.6 }]} onPress={submitNew} disabled={newSubmitting}>
                {newSubmitting ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="save-outline" size={16} color="#fff" /><Text style={styles.modalSubmitBtnText}>Create</Text></>}
              </TouchableOpacity>
            </View>
            <View style={{ height: 20 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ─── Styles (same palette/shapes as StockScreen.tsx) ───────────────────────

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#f5f5f5' },

  header:         { backgroundColor: BPCL_BLUE },
  headerContent:  { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 },
  headerTitle:    { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  headerSub:      { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },

  segControl:     { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 10, padding: 3, marginTop: 14 },
  segBtn:         { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: 8 },
  segBtnActive:   { backgroundColor: '#fff' },
  segBtnText:     { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.75)' },
  segBtnTextActive:{ color: BPCL_BLUE },

  scroll:         { flex: 1 },
  scrollContent:  { padding: 14 },
  loadingBox:     { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  loadingText:    { color: '#888', fontSize: 15 },

  sectionLabel:   { fontSize: 11, fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 14 },

  actionRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionBtn:      { flexGrow: 1, minWidth: '45%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 12 },
  actionBtnText:  { fontSize: 13, fontWeight: '700' },

  newHotPlateBtn: { marginTop: 10, backgroundColor: BPCL_BLUE, borderRadius: 10, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  newHotPlateBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  statGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 4 },
  statTile:       { flex: 1, minWidth: '45%', backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.09)', padding: 12 },
  statTileDanger: { borderColor: RED + '66', backgroundColor: '#fff7f7' },
  statLabelRow:   { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  dot:            { width: 7, height: 7, borderRadius: 4 },
  statLabel:      { fontSize: 10.5, color: '#888', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, flex: 1 },
  statValue:      { fontSize: 24, fontWeight: '700', color: '#222' },
  statSub:        { fontSize: 11, color: '#aaa', marginTop: 3 },

  card:           { backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.09)', marginBottom: 12, overflow: 'hidden' },
  cardHead:       { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 9, borderBottomWidth: 0.5, borderBottomColor: 'rgba(0,0,0,0.08)' },
  cardIcon:       { width: 28, height: 28, borderRadius: 7, justifyContent: 'center', alignItems: 'center' },
  cardTitle:      { fontSize: 13, fontWeight: '600', color: '#333', flex: 1 },

  fields2:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  fieldWrap:      { width: '31%', minWidth: 95, gap: 4, marginBottom: 8 },
  fieldLabel:     { fontSize: 10, color: '#888', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  fieldInput:     { backgroundColor: '#f6f7fb', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.12)', borderRadius: 7, padding: 8, fontSize: 13, color: '#333', width: '100%' },
  fieldInputRo:   { color: '#aaa', backgroundColor: '#f0f0f0' },
  fieldInputMultiline: { minHeight: 44, textAlignVertical: 'top' },

  pickerBtn:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f6f7fb', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.12)', borderRadius: 7, padding: 9 },
  pickerBtnText:  { fontSize: 13, color: '#333', fontWeight: '600', flexShrink: 1 },
  pickerOptionSub:{ fontSize: 11, color: '#999', marginTop: 2 },

  chipRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 4 },
  chip:           { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#f9f9f9' },
  chipSelected:   { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  chipText:       { fontSize: 12, fontWeight: '600', color: '#666' },
  chipTextSelected: { color: '#fff' },

  linkText:       { color: BPCL_BLUE, fontSize: 12, fontWeight: '600', marginTop: 4, marginBottom: 8 },

  applyFilterBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: BPCL_BLUE, borderRadius: 8, paddingVertical: 11, margin: 12, marginTop: 0 },
  applyFilterBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  tableHeaderRow: { flexDirection: 'row', backgroundColor: '#f4f5f8', borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.08)' },
  tableHeaderCell:{ fontSize: 10.5, fontWeight: '700', color: '#666', textTransform: 'uppercase', paddingVertical: 8, paddingHorizontal: 6 },
  tableRow:       { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: 'rgba(0,0,0,0.06)' },
  tableRowAlt:    { backgroundColor: '#fafbfd' },
  tableCell:      { fontSize: 12, color: '#333', paddingVertical: 8, paddingHorizontal: 6 },
  emptyListText:  { fontSize: 12, color: '#999', padding: 16, textAlign: 'center' },

  opSelectorRow:  { flexDirection: 'row', gap: 10, marginBottom: 12 },
  opSelectorBtn:  { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingVertical: 11, backgroundColor: '#f9f9f9' },
  opSelectorText: { fontSize: 12, fontWeight: '600', color: '#666' },
  opSelectorTextSelected: { color: '#fff' },

  modalOverlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContainer: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, maxHeight: '90%' },
  modalHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalTitle:     { fontSize: 16, fontWeight: 'bold', color: '#333' },
  modalFooter:    { flexDirection: 'row', gap: 10, marginTop: 12 },
  modalCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fafafa' },
  modalCancelBtnText: { color: '#666', fontSize: 14, fontWeight: '600' },
  modalSubmitBtn: { flex: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 8, backgroundColor: BPCL_BLUE },
  modalSubmitBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },

  truckOptionList: { gap: 8, marginBottom: 8 },
  truckOptionBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, backgroundColor: '#f9fafc' },
  truckOptionText: { fontSize: 14, fontWeight: '600', color: '#333' },
});
