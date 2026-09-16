import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { format } from 'date-fns';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRole } from '../../hooks/useRole';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

// ─── Types ────────────────────────────────────────────────────────────────────
//
// NOTE (schema): dashboard_godownftlstocksachin needs `refill` and
// `new_connection` columns added (same names/types as the existing columns
// on dashboard_officeftlstocksachin) before Save can write the Godown split.
// This is a one-time manual Supabase migration — no code here creates columns.

type Product = '14.2 KG Cylinder' | '19 KG Cylinder' | '5 KG Cylinder';

interface BorrowEntry {
  party_name: string;
  full_qty: string;
  empty_qty: string;
}

interface TransferEntry {
  type: 'full' | 'empty';
  direction: 'godown_to_office' | 'office_to_godown';
  quantity: string;
}

interface Stock142 {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
  total_refill: number;
  total_empty_received: number;
  total_nc: number;
  total_dbc: number;
  total_tv: number;
  total_tv_out: number;
}

interface Stock19 {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
  cylinder_delivered: number;
  empty_received: number;
}

interface StockGodown {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
}

interface StockOffice {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parseRemarksForNC = (remarks: string): number => {
  if (!remarks) return 0;
  const matches = remarks.match(/\bNC\b/gi);
  return matches ? matches.length : 0;
};

const parseRemarksForDBC = (remarks: string): number => {
  if (!remarks) return 0;
  const matches = remarks.match(/DBC:/gi);
  return matches ? matches.length : 0;
};

const buildRemarksString = (entries: BorrowEntry[]): string => {
  return entries
    .filter((e) => e.party_name.trim())
    .map((e) => {
      const parts: string[] = [];
      const fullQty = parseInt(e.full_qty, 10);
      const emptyQty = parseInt(e.empty_qty, 10);
      if (!isNaN(fullQty) && fullQty !== 0)
        parts.push(`${e.party_name.trim()} (FULL): ${fullQty}`);
      if (!isNaN(emptyQty) && emptyQty !== 0)
        parts.push(`${e.party_name.trim()} (EMPTY): ${emptyQty}`);
      return parts.join('; ');
    })
    .filter(Boolean)
    .join('; ');
};

const calcBorrowedFull = (entries: BorrowEntry[]): number =>
  entries.reduce((sum, e) => {
    const v = parseInt(e.full_qty, 10);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

const calcBorrowedEmpty = (entries: BorrowEntry[]): number =>
  entries.reduce((sum, e) => {
    const v = parseInt(e.empty_qty, 10);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

// ─── Sub Components ───────────────────────────────────────────────────────────

const CalcRow = ({
  label,
  value,
  large,
  color,
}: {
  label: string;
  value: string | number;
  large?: boolean;
  color?: string;
}) => (
  <View style={styles.calcRow}>
    <Text style={styles.calcLabel}>{label}</Text>
    <Text
      style={[
        large ? styles.calcValueLarge : styles.calcValue,
        color ? { color } : {},
      ]}
    >
      {value}
    </Text>
  </View>
);

const StepHeader = ({ step, title }: { step: number; title: string }) => (
  <View style={styles.stepHeader}>
    <View style={styles.stepBadge}>
      <Text style={styles.stepBadgeText}>{step}</Text>
    </View>
    <Text style={styles.stepTitle}>{title}</Text>
  </View>
);

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StockScreen() {
  // ── Date State ─────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Helper: formatted date string used everywhere TODAY was used before —
  // this is always the DATE PICKER's selected date, never JS's literal "today".
  const TODAY = format(selectedDate, 'yyyy-MM-dd');

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // ── 14.2 KG State ──────────────────────────────────────────────────────────
  const [receivedFromPlant142, setReceivedFromPlant142] = useState('');
  const [emptyToPlant142, setEmptyToPlant142] = useState('');
  const [stock142, setStock142] = useState<Stock142 | null>(null);

  // ── 19 KG State ────────────────────────────────────────────────────────────
  const [receivedFromPlant19, setReceivedFromPlant19] = useState('');
  const [emptyToPlant19, setEmptyToPlant19] = useState('');
  const [stock19, setStock19] = useState<Stock19 | null>(null);

  // ── 5KG Combined State (Godown + Office) ───────────────────────────────────
  const [receivedFromPlantGodown, setReceivedFromPlantGodown] = useState('');
  const [emptyToPlantGodown, setEmptyToPlantGodown] = useState('');
  const [stockGodown, setStockGodown] = useState<StockGodown | null>(null);
  const [stockOffice, setStockOffice] = useState<StockOffice | null>(null);

  // Refill / NC — auto-fetched combined totals for the selected date,
  // editable after fetch.
  const [totalRefill, setTotalRefill] = useState('0');
  const [totalNC, setTotalNC] = useState('0');

  // "Any of this from Godown?" checkboxes + the split amounts they record.
  const [godownRefillChecked, setGodownRefillChecked] = useState(false);
  const [godownNCChecked, setGodownNCChecked] = useState(false);
  const [godownRefillSplit, setGodownRefillSplit] = useState('0'); // Y
  const [godownNCSplit, setGodownNCSplit] = useState('0'); // A

  // Popup modals for entering the Godown split.
  const [refillSplitModalVisible, setRefillSplitModalVisible] = useState(false);
  const [ncSplitModalVisible, setNcSplitModalVisible] = useState(false);
  const [tempRefillSplitInput, setTempRefillSplitInput] = useState('');
  const [tempNCSplitInput, setTempNCSplitInput] = useState('');

  // ── Transfer State (5KG) ───────────────────────────────────────────────────
  const [transfers, setTransfers] = useState<TransferEntry[]>([]);

  // ── Borrow/Give State ──────────────────────────────────────────────────────
  const [borrowEntries, setBorrowEntries] = useState<BorrowEntry[]>([]);

  // ─── Reset ─────────────────────────────────────────────────────────────────

  const resetAll = useCallback(() => {
    setCurrentStep(1);
    setReceivedFromPlant142('');
    setEmptyToPlant142('');
    setStock142(null);
    setReceivedFromPlant19('');
    setEmptyToPlant19('');
    setStock19(null);
    setReceivedFromPlantGodown('');
    setEmptyToPlantGodown('');
    setStockGodown(null);
    setStockOffice(null);
    setTotalRefill('0');
    setTotalNC('0');
    setGodownRefillChecked(false);
    setGodownNCChecked(false);
    setGodownRefillSplit('0');
    setGodownNCSplit('0');
    setRefillSplitModalVisible(false);
    setNcSplitModalVisible(false);
    setTempRefillSplitInput('');
    setTempNCSplitInput('');
    setTransfers([]);
    setBorrowEntries([]);
    setShowConfirmModal(false);
  }, []);

  const handleProductSelect = (product: Product) => {
    setSelectedProduct(product);
    setDropdownOpen(false);
    resetAll();
  };

  // ─── Date Change Handler ───────────────────────────────────────────────────

  const handleDateChange = (_event: any, date?: Date) => {
    // On Android the picker closes itself; on iOS we close manually
    if (Platform.OS === 'android') {
      setShowDatePicker(false);
    }
    if (date) {
      setSelectedDate(format(date, 'yyyy-MM-dd'));
      // Reset the form when date changes so stale data is cleared
      resetAll();
      setSelectedProduct(null);
    }
  };

  const handleRefresh = () => {
    resetAll();
    setSelectedProduct(null);
  };

  // ─── 5KG: Auto-fetch Refill/NC totals for the selected date ───────────────
  // Filters by TODAY (the date-picker's selected date), matching every other
  // fetch on this screen (fetch142KGData, fetch19KGData, etc.) — not JS's
  // literal "today".

  const fetchRefillNCTotals = useCallback(async () => {
    const { data: refillData, error: refillError } = await supabase
      .from('dashboard_dailyrecordsachin')
      .select('quantity')
      .eq('date', TODAY)
      .eq('category', 'SMALL CYLINDER')
      .eq('remarks', 'REFILL');
    if (refillError) throw refillError;

    const { data: ncData, error: ncError } = await supabase
      .from('dashboard_dailyrecordsachin')
      .select('quantity')
      .eq('date', TODAY)
      .eq('category', 'SMALL CYLINDER')
      .eq('remarks', 'NC');
    if (ncError) throw ncError;

    const refillSum = (refillData || []).reduce(
      (sum: number, r: any) => sum + (parseInt(r.quantity, 10) || 0),
      0
    );
    const ncSum = (ncData || []).reduce(
      (sum: number, r: any) => sum + (parseInt(r.quantity, 10) || 0),
      0
    );

    setTotalRefill(String(refillSum));
    setTotalNC(String(ncSum));
    // A fresh fetch invalidates any previously-entered Godown split.
    setGodownRefillChecked(false);
    setGodownNCChecked(false);
    setGodownRefillSplit('0');
    setGodownNCSplit('0');
  }, [TODAY]);

  // Auto-fetch as soon as "5 KG Cylinder" is selected on Step 1, per the plan
  // (fetched, then editable) — no need to wait for "Next".
  useEffect(() => {
    if (selectedProduct === '5 KG Cylinder' && currentStep === 1) {
      fetchRefillNCTotals().catch((err) =>
        Alert.alert('Error', err?.message || 'Failed to fetch Refill/NC totals')
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProduct]);

  // ─── Transfer Impact Calculator ────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const calcTransferImpact = useCallback(() => {
    let godownFullDelta = 0;
    let godownEmptyDelta = 0;
    let officeFullDelta = 0;
    let officeEmptyDelta = 0;

    transfers.forEach((t) => {
      const qty = parseInt(t.quantity, 10) || 0;
      if (t.direction === 'godown_to_office') {
        if (t.type === 'full') {
          godownFullDelta -= qty;
          officeFullDelta += qty;
        } else {
          godownEmptyDelta -= qty;
          officeEmptyDelta += qty;
        }
      } else {
        if (t.type === 'full') {
          officeFullDelta -= qty;
          godownFullDelta += qty;
        } else {
          officeEmptyDelta -= qty;
          godownEmptyDelta += qty;
        }
      }
    });

    return { godownFullDelta, godownEmptyDelta, officeFullDelta, officeEmptyDelta };
  }, [transfers]);

  // ─── Step 1 → Step 2: Fetch Data ──────────────────────────────────────────

  const handleStep1Next = async () => {
    if (!selectedProduct) return;
    setLoading(true);
    try {
      if (selectedProduct === '14.2 KG Cylinder') await fetch142KGData();
      else if (selectedProduct === '19 KG Cylinder') await fetch19KGData();
      else if (selectedProduct === '5 KG Cylinder') await fetch5KGData();
      setCurrentStep(2);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to fetch stock data');
    } finally {
      setLoading(false);
    }
  };

  // ─── 14.2 KG Fetch ────────────────────────────────────────────────────────

  const fetch142KGData = async () => {
    // Fetch the most recent stock BEFORE the selected date to use as opening
    const { data: stockData, error: stockError } = await supabase
      .from('dashboard_cylinderstocksachin')
      .select('closing_full, closing_empty')
      .lt('date', TODAY)          // strictly before selected date
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (stockError) throw stockError;

    // Fetch delivery records for the selected date
    const { data: deliveryData, error: deliveryError } = await supabase
      .from('dashboard_deliveryrecords')
      .select('number, empty_received, remarks')
      .eq('date', TODAY);

    if (deliveryError) throw deliveryError;

    const records = deliveryData || [];

    const totalRefill = records.reduce(
      (sum: number, r: any) => sum + (parseInt(r.number, 10) || 0),
      0
    );

    const totalEmptyReceived = records.reduce(
      (sum: number, r: any) => sum + (parseInt(r.empty_received, 10) || 0),
      0
    );

    let totalNC = 0;
    let totalDBC = 0;
    let totalTV = 0;
    let totalTVOut = 0;

    records.forEach((r: any) => {
      const num = parseInt(r.number, 10) || 0;
      const empty = parseInt(r.empty_received, 10) || 0;
      const remarks = r.remarks || '';
      totalNC += parseRemarksForNC(remarks);
      totalDBC += parseRemarksForDBC(remarks);
      // Each record's discrepancy is summed into its own bucket — a
      // shortage on one delivery and a surplus on another are two
      // separate real-world events and must NOT cancel each other out.
      // Per business rule: empty received MORE than delivered → TV Out (extra).
      // empty received LESS than delivered → TV (missing/short).
      if (empty > num) totalTVOut += (empty - num);
      if (num > empty) totalTV += (num - empty);
    });

    const openingFull = stockData?.closing_full || 0;
    const openingEmpty = stockData?.closing_empty || 0;
    const receivedPlant = parseInt(receivedFromPlant142, 10) || 0;
    const emptyPlant = parseInt(emptyToPlant142, 10) || 0;

    setStock142({
      opening_full: openingFull,
      closing_full: openingFull + receivedPlant - totalRefill,
      opening_empty: openingEmpty,
      closing_empty: openingEmpty + totalEmptyReceived - emptyPlant,
      total_refill: totalRefill,
      total_empty_received: totalEmptyReceived,
      total_nc: totalNC,
      total_dbc: totalDBC,
      total_tv: totalTV,
      total_tv_out: totalTVOut,
    });
  };

  // ─── 19 KG Fetch ──────────────────────────────────────────────────────────

  const fetch19KGData = async () => {
    if (!receivedFromPlant19) {
      throw new Error('Please enter cylinders received from plant');
    }

    // Fetch the most recent stock BEFORE the selected date
    const { data: stockData, error: stockError } = await supabase
      .from('dashboard_commercialstocksachin')
      .select('closing_full, closing_empty')
      .lt('date', TODAY)          // strictly before selected date
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (stockError) throw stockError;

    const { data: deliveredData, error: deliveredError } = await supabase
      .from('dashboard_commercialrecords')
      .select('id')
      .eq('delivery_date', TODAY);

    if (deliveredError) throw deliveredError;

    const { data: emptyData, error: emptyError } = await supabase
      .from('dashboard_commercialrecords')
      .select('id')
      .eq('empty_received', TODAY);

    if (emptyError) throw emptyError;

    const openingFull = stockData?.closing_full || 0;
    const openingEmpty = stockData?.closing_empty || 0;
    const fromBpcl = parseInt(receivedFromPlant19, 10) || 0;
    const emptyToPlant = parseInt(emptyToPlant19, 10) || 0;
    const cylinderDelivered = deliveredData?.length || 0;
    const emptyReceived = emptyData?.length || 0;

    setStock19({
      opening_full: openingFull,
      closing_full: openingFull + fromBpcl - cylinderDelivered,
      opening_empty: openingEmpty,
      closing_empty: openingEmpty + emptyReceived - emptyToPlant,
      cylinder_delivered: cylinderDelivered,
      empty_received: emptyReceived,
    });
  };

  // ─── 5KG Combined Fetch (Godown + Office opening stock, plus Refill/NC) ───

  const fetch5KGData = async () => {
    // Fetch the most recent Godown stock BEFORE the selected date
    const { data: godownData, error: godownError } = await supabase
      .from('dashboard_godownftlstocksachin')
      .select('closing_full, closing_empty')
      .lt('date', TODAY)          // strictly before selected date
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (godownError) throw godownError;

    // Fetch the most recent Office stock BEFORE the selected date
    const { data: officeData, error: officeError } = await supabase
      .from('dashboard_officeftlstocksachin')
      .select('closing_full, closing_empty')
      .lt('date', TODAY)          // strictly before selected date
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (officeError) throw officeError;

    setStockGodown({
      opening_full: godownData?.closing_full || 0,
      closing_full: godownData?.closing_full || 0,
      opening_empty: godownData?.closing_empty || 0,
      closing_empty: godownData?.closing_empty || 0,
    });

    setStockOffice({
      opening_full: officeData?.closing_full || 0,
      closing_full: officeData?.closing_full || 0,
      opening_empty: officeData?.closing_empty || 0,
      closing_empty: officeData?.closing_empty || 0,
    });

    // Refresh Refill/NC totals too, in case the user changed the date after
    // the Step-1 auto-fetch already ran.
    await fetchRefillNCTotals();
  };

  // ─── 5KG Split Helpers ─────────────────────────────────────────────────────

  const openRefillSplitModal = () => {
    setTempRefillSplitInput(godownRefillSplit !== '0' ? godownRefillSplit : '');
    setRefillSplitModalVisible(true);
  };

  const openNCSplitModal = () => {
    setTempNCSplitInput(godownNCSplit !== '0' ? godownNCSplit : '');
    setNcSplitModalVisible(true);
  };

  const handleRefillCheckboxToggle = () => {
    if (godownRefillChecked) {
      setGodownRefillChecked(false);
      setGodownRefillSplit('0');
    } else {
      openRefillSplitModal();
    }
  };

  const handleNCCheckboxToggle = () => {
    if (godownNCChecked) {
      setGodownNCChecked(false);
      setGodownNCSplit('0');
    } else {
      openNCSplitModal();
    }
  };

  const confirmRefillSplit = () => {
    const total = parseInt(totalRefill, 10) || 0;
    const val = parseInt(tempRefillSplitInput, 10);
    if (isNaN(val) || val < 0 || val > total) {
      Alert.alert('Invalid value', `Godown refill must be between 0 and ${total}.`);
      return;
    }
    setGodownRefillSplit(String(val));
    setGodownRefillChecked(true);
    setRefillSplitModalVisible(false);
  };

  const confirmNCSplit = () => {
    const total = parseInt(totalNC, 10) || 0;
    const val = parseInt(tempNCSplitInput, 10);
    if (isNaN(val) || val < 0 || val > total) {
      Alert.alert('Invalid value', `Godown NC must be between 0 and ${total}.`);
      return;
    }
    setGodownNCSplit(String(val));
    setGodownNCChecked(true);
    setNcSplitModalVisible(false);
  };

  const cancelRefillSplitModal = () => {
    setRefillSplitModalVisible(false);
    if ((parseInt(godownRefillSplit, 10) || 0) === 0) setGodownRefillChecked(false);
  };

  const cancelNCSplitModal = () => {
    setNcSplitModalVisible(false);
    if ((parseInt(godownNCSplit, 10) || 0) === 0) setGodownNCChecked(false);
  };

  // ─── Get Final Calculations: 14.2 / 19 KG ─────────────────────────────────

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const getFinalCalculations = useCallback(() => {
    const borrowedFull = calcBorrowedFull(borrowEntries);
    const borrowedEmpty = calcBorrowedEmpty(borrowEntries);
    const remarks = buildRemarksString(borrowEntries);

    if (selectedProduct === '14.2 KG Cylinder' && stock142) {
      return {
        closingFull: stock142.closing_full + borrowedFull,
        closingEmpty: stock142.closing_empty + borrowedEmpty,
        remarks,
      };
    }

    if (selectedProduct === '19 KG Cylinder' && stock19) {
      return {
        closingFull: stock19.closing_full + borrowedFull,
        closingEmpty: stock19.closing_empty + borrowedEmpty,
        remarks,
      };
    }

    return { closingFull: 0, closingEmpty: 0, remarks: '' };
  }, [selectedProduct, stock142, stock19, borrowEntries]);

  // ─── Get Final Calculations: 5KG Combined (Godown + Office) ──────────────
  //
  // NOTE (assumption): Borrow/Give entries are not location-tagged by the
  // UI, so — consistent with how borrow/give has historically applied to
  // the customer-facing side of 5KG stock — borrowedFull/borrowedEmpty are
  // applied to the Office leg only. Godown's closing figures are driven
  // purely by BPCL receipts, transfers, and its Refill/NC split.
  //
  // EMPTY RETURN RULE: the empty cylinders collected on a refill delivery
  // physically come back to Godown regardless of whether the full cylinder
  // was billed against the Office or Godown portion — so the FULL refill
  // total's empty return goes to Godown, and Office's empty side does NOT
  // get any refill-return addition.

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const get5KGCalculations = useCallback(() => {
    const borrowedFull = calcBorrowedFull(borrowEntries);
    const borrowedEmpty = calcBorrowedEmpty(borrowEntries);
    const remarks = buildRemarksString(borrowEntries);
    const {
      godownFullDelta,
      godownEmptyDelta,
      officeFullDelta,
      officeEmptyDelta,
    } = calcTransferImpact();

    const fromBpcl = parseInt(receivedFromPlantGodown, 10) || 0;
    const emptyToPlant = parseInt(emptyToPlantGodown, 10) || 0;
    const totalRefillNum = parseInt(totalRefill, 10) || 0;
    const totalNCNum = parseInt(totalNC, 10) || 0;
    const godownRefillY = parseInt(godownRefillSplit, 10) || 0;
    const godownNCY = parseInt(godownNCSplit, 10) || 0;
    const officeRefillPortion = totalRefillNum - godownRefillY;
    const officeNCPortion = totalNCNum - godownNCY;

    if (!stockGodown || !stockOffice) {
      return {
        godownClosingFull: 0,
        godownClosingEmpty: 0,
        officeClosingFull: 0,
        officeClosingEmpty: 0,
        officeRefillPortion,
        officeNCPortion,
        godownRefillSplitVal: godownRefillY,
        godownNCSplitVal: godownNCY,
        borrowedFull,
        borrowedEmpty,
        remarks,
      };
    }

    const godownClosingFull =
      stockGodown.opening_full +
      fromBpcl +
      godownFullDelta -
      godownRefillY -
      godownNCY;

    // All refill empty returns (Office portion + Godown portion) land on
    // Godown, not just Godown's own Y portion.
    const godownClosingEmpty =
      stockGodown.opening_empty -
      emptyToPlant +
      godownEmptyDelta +
      totalRefillNum;

    const officeClosingFull =
      stockOffice.opening_full +
      officeFullDelta -
      officeRefillPortion -
      officeNCPortion +
      borrowedFull;

    // No refill-return addition on Office's empty side — it all goes to Godown.
    const officeClosingEmpty =
      stockOffice.opening_empty +
      officeEmptyDelta +
      borrowedEmpty;

    return {
      godownClosingFull,
      godownClosingEmpty,
      officeClosingFull,
      officeClosingEmpty,
      officeRefillPortion,
      officeNCPortion,
      godownRefillSplitVal: godownRefillY,
      godownNCSplitVal: godownNCY,
      borrowedFull,
      borrowedEmpty,
      remarks,
    };
  }, [
    stockGodown,
    stockOffice,
    receivedFromPlantGodown,
    emptyToPlantGodown,
    totalRefill,
    totalNC,
    godownRefillSplit,
    godownNCSplit,
    borrowEntries,
    calcTransferImpact,
  ]);

  // ─── Transfer Handlers ────────────────────────────────────────────────────

  const addTransfer = () => {
    setTransfers((prev) => [
      ...prev,
      { type: 'full', direction: 'godown_to_office', quantity: '' },
    ]);
  };

  const updateTransfer = (
    index: number,
    field: keyof TransferEntry,
    value: any
  ) => {
    setTransfers((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeTransfer = (index: number) => {
    setTransfers((prev) => prev.filter((_, i) => i !== index));
  };

  // ─── Borrow Handlers ──────────────────────────────────────────────────────

  const addBorrowEntry = () => {
    setBorrowEntries((prev) => [
      ...prev,
      { party_name: '', full_qty: '', empty_qty: '' },
    ]);
  };

  const updateBorrowEntry = (
    index: number,
    field: keyof BorrowEntry,
    value: string
  ) => {
    setBorrowEntries((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeBorrowEntry = (index: number) => {
    setBorrowEntries((prev) => prev.filter((_, i) => i !== index));
  };

  // ─── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      // ── 14.2 KG ───────────────────────────────────────────────────────────
      if (selectedProduct === '14.2 KG Cylinder' && stock142) {
        const { closingFull, closingEmpty, remarks } = getFinalCalculations();
        const receivedPlant = parseInt(receivedFromPlant142, 10) || 0;
        const { error } = await supabase
          .from('dashboard_cylinderstocksachin')
          .insert([{
            date: TODAY,
            opening_full: stock142.opening_full,
            add_full: receivedPlant,
            total_refill: stock142.total_refill,
            total_nc: stock142.total_nc,
            total_dbc: stock142.total_dbc,
            total_tv: stock142.total_tv,
            total_tv_out: stock142.total_tv_out,
            closing_full: closingFull,
            opening_empty: stock142.opening_empty,
            closing_empty: closingEmpty,
            remarks: remarks || '',
          }]);
        if (error) throw error;
      }

      // ── 19 KG ─────────────────────────────────────────────────────────────
      if (selectedProduct === '19 KG Cylinder' && stock19) {
        const { closingFull, closingEmpty, remarks } = getFinalCalculations();
        const fromBpcl = parseInt(receivedFromPlant19, 10) || 0;
        const { error } = await supabase
          .from('dashboard_commercialstocksachin')
          .insert([{
            date: TODAY,
            opening_full: stock19.opening_full,
            from_bpcl: fromBpcl,
            empty_received: stock19.empty_received,
            cylinder_delivered: stock19.cylinder_delivered,
            closing_full: closingFull,
            opening_empty: stock19.opening_empty,
            new_connection: 0,
            closing_empty: closingEmpty,
            remarks: remarks || '',
          }]);
        if (error) throw error;
      }

      // ── 5KG Combined: dual insert (Godown + Office) from one Step 1 entry ──
      if (selectedProduct === '5 KG Cylinder' && stockGodown && stockOffice) {
        const calc = get5KGCalculations();
        const fromBpcl = parseInt(receivedFromPlantGodown, 10) || 0;

        const sentToOffice = transfers
          .filter((t) => t.direction === 'godown_to_office' && t.type === 'full')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const receivedFromOfficeAtGodown = transfers
          .filter((t) => t.direction === 'office_to_godown' && t.type === 'full')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const addOfficeStock = transfers
          .filter((t) => t.direction === 'godown_to_office' && t.type === 'full')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const toGodown = transfers
          .filter((t) => t.direction === 'office_to_godown' && t.type === 'empty')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        // Remarks trail (point 8): append the split so it's auditable later.
        const splitTrail = `Godown Refill: ${calc.godownRefillSplitVal}, Office Refill: ${calc.officeRefillPortion}, Godown NC: ${calc.godownNCSplitVal}, Office NC: ${calc.officeNCPortion}`;
        const combinedRemarks = [calc.remarks, splitTrail].filter(Boolean).join('; ');

        // Godown row — requires refill/new_connection columns to already
        // exist (see schema note at top of file).
        const { error: godownErr } = await supabase
          .from('dashboard_godownftlstocksachin')
          .insert([{
            date: TODAY,
            opening_full: stockGodown.opening_full,
            from_bpcl: fromBpcl,
            sent_to_office: sentToOffice,
            received_from_office: receivedFromOfficeAtGodown,
            refill: calc.godownRefillSplitVal,
            new_connection: calc.godownNCSplitVal,
            closing_full: calc.godownClosingFull,
            opening_empty: stockGodown.opening_empty,
            closing_empty: calc.godownClosingEmpty,
            remarks: combinedRemarks,
          }]);
        if (godownErr) throw godownErr;

        // Office row — refill/new_connection carry only the Office portion.
        const { error: officeErr } = await supabase
          .from('dashboard_officeftlstocksachin')
          .insert([{
            date: TODAY,
            opening_full: stockOffice.opening_full,
            add_office_stock: addOfficeStock,
            refill: calc.officeRefillPortion,
            new_connection: calc.officeNCPortion,
            closing_full: calc.officeClosingFull,
            opening_empty: stockOffice.opening_empty,
            to_godown: toGodown,
            closing_empty: calc.officeClosingEmpty,
            remarks: combinedRemarks,
          }]);
        if (officeErr) throw officeErr;
      }

      setShowConfirmModal(false);
      Alert.alert('Success', 'Stock entry saved successfully!');
      resetAll();
      setSelectedProduct(null);
    } catch (err: any) {
      console.error('Save error:', err);
      Alert.alert('Error', err?.message || 'Failed to save stock entry');
    } finally {
      setSaving(false);
    }
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const is5KG = selectedProduct === '5 KG Cylinder';

  const getBorrowStep = () => (is5KG ? 4 : 3);

  // ─── Render: Step 1 ───────────────────────────────────────────────────────

  const renderStep1 = () => {
    if (!selectedProduct) return null;

    return (
      <View style={styles.card}>
        <StepHeader step={1} title="Enter Details" />

        {selectedProduct === '14.2 KG Cylinder' && (
          <>
            <Text style={styles.label}>Cylinders Received from Plant</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={receivedFromPlant142}
              onChangeText={(v) => {
                setReceivedFromPlant142(v);
                // Real-time copy: sent-to-plant is usually the same qty as
                // received (equal empties go back). Still editable after —
                // it just gets re-synced if "received" changes again later.
                setEmptyToPlant142(v);
              }}
            />
            <Text style={[styles.label, { marginTop: 16 }]}>
              Empty Cylinders Sent to Plant
            </Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={emptyToPlant142}
              onChangeText={setEmptyToPlant142}
            />
          </>
        )}

        {selectedProduct === '19 KG Cylinder' && (
          <>
            <Text style={styles.label}>Cylinders Received from Plant</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={receivedFromPlant19}
              onChangeText={(v) => {
                setReceivedFromPlant19(v);
                // Real-time copy: sent-to-plant is usually the same qty as
                // received. Still editable after — only re-synced if
                // "received" changes again later.
                setEmptyToPlant19(v);
              }}
            />
            <Text style={[styles.label, { marginTop: 16 }]}>
              Empty Cylinders Sent to Plant
            </Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={emptyToPlant19}
              onChangeText={setEmptyToPlant19}
            />
          </>
        )}

        {selectedProduct === '5 KG Cylinder' && (
          <>
            <Text style={styles.label}>Cylinders Received from Plant (BPCL)</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={receivedFromPlantGodown}
              onChangeText={(v) => {
                setReceivedFromPlantGodown(v);
                // Real-time copy: sent-to-plant is usually the same qty as
                // received. Still editable after — only re-synced if
                // "received" changes again later.
                setEmptyToPlantGodown(v);
              }}
            />
            <Text style={[styles.label, { marginTop: 16 }]}>
              Empty Cylinders Sent to Plant
            </Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={emptyToPlantGodown}
              onChangeText={setEmptyToPlantGodown}
            />

            {/* ── Refill ── */}
            <Text style={[styles.label, { marginTop: 16 }]}>
              Refill Delivered Today (Combined)
            </Text>
            <Text style={styles.hintText}>
              Auto-fetched from today's records — editable if needed
            </Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={totalRefill}
              onChangeText={setTotalRefill}
            />
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={handleRefillCheckboxToggle}
              disabled={(parseInt(totalRefill, 10) || 0) === 0}
            >
              <Ionicons
                name={godownRefillChecked ? 'checkbox' : 'square-outline'}
                size={20}
                color={
                  (parseInt(totalRefill, 10) || 0) === 0 ? '#ccc' : BPCL_BLUE
                }
              />
              <Text
                style={[
                  styles.checkboxLabel,
                  (parseInt(totalRefill, 10) || 0) === 0 && { color: '#ccc' },
                ]}
              >
                Any of this from Godown?
              </Text>
            </TouchableOpacity>
            {godownRefillChecked && (
              <Text style={styles.splitPreviewText}>
                Office Refill: {(parseInt(totalRefill, 10) || 0) - (parseInt(godownRefillSplit, 10) || 0)}, Godown Refill: {parseInt(godownRefillSplit, 10) || 0}
              </Text>
            )}

            {/* ── NC ── */}
            <Text style={[styles.label, { marginTop: 16 }]}>
              New Connections (Combined)
            </Text>
            <Text style={styles.hintText}>
              Auto-fetched from today's records — editable if needed
            </Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={totalNC}
              onChangeText={setTotalNC}
            />
            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={handleNCCheckboxToggle}
              disabled={(parseInt(totalNC, 10) || 0) === 0}
            >
              <Ionicons
                name={godownNCChecked ? 'checkbox' : 'square-outline'}
                size={20}
                color={(parseInt(totalNC, 10) || 0) === 0 ? '#ccc' : BPCL_BLUE}
              />
              <Text
                style={[
                  styles.checkboxLabel,
                  (parseInt(totalNC, 10) || 0) === 0 && { color: '#ccc' },
                ]}
              >
                Any of this from Godown?
              </Text>
            </TouchableOpacity>
            {godownNCChecked && (
              <Text style={styles.splitPreviewText}>
                Office NC: {(parseInt(totalNC, 10) || 0) - (parseInt(godownNCSplit, 10) || 0)}, Godown NC: {parseInt(godownNCSplit, 10) || 0}
              </Text>
            )}
          </>
        )}

        <TouchableOpacity
          style={[styles.nextButton, loading && styles.buttonDisabled]}
          onPress={handleStep1Next}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text style={styles.nextButtonText}>Next</Text>
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  // ─── Render: Godown Refill Split Modal ─────────────────────────────────────

  const renderRefillSplitModal = () => (
    <Modal
      visible={refillSplitModalVisible}
      transparent
      animationType="fade"
      onRequestClose={cancelRefillSplitModal}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.smallModalCard}>
          <Text style={styles.modalTitle}>Record Godown Refill Delivery, if any?</Text>
          <TextInput
            style={[styles.input, { marginTop: 12 }]}
            placeholder="0"
            keyboardType="numeric"
            value={tempRefillSplitInput}
            onChangeText={setTempRefillSplitInput}
            autoFocus
          />
          <Text style={styles.hintText}>
            Between 0 and {parseInt(totalRefill, 10) || 0}
          </Text>
          <View style={styles.modalButtons}>
            <TouchableOpacity
              style={styles.modalCancelButton}
              onPress={cancelRefillSplitModal}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalConfirmButton}
              onPress={confirmRefillSplit}
            >
              <Text style={styles.modalConfirmText}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderNCSplitModal = () => (
    <Modal
      visible={ncSplitModalVisible}
      transparent
      animationType="fade"
      onRequestClose={cancelNCSplitModal}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.smallModalCard}>
          <Text style={styles.modalTitle}>Record Godown NC, if any?</Text>
          <TextInput
            style={[styles.input, { marginTop: 12 }]}
            placeholder="0"
            keyboardType="numeric"
            value={tempNCSplitInput}
            onChangeText={setTempNCSplitInput}
            autoFocus
          />
          <Text style={styles.hintText}>
            Between 0 and {parseInt(totalNC, 10) || 0}
          </Text>
          <View style={styles.modalButtons}>
            <TouchableOpacity
              style={styles.modalCancelButton}
              onPress={cancelNCSplitModal}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalConfirmButton}
              onPress={confirmNCSplit}
            >
              <Text style={styles.modalConfirmText}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ─── Render: Step 2 Summary ───────────────────────────────────────────────

  const renderStep2 = () => {
    if (currentStep < 2) return null;

    return (
      <View style={styles.calculationCard}>
        <StepHeader step={2} title="Stock Summary" />

        {selectedProduct === '14.2 KG Cylinder' && stock142 && (
          <>
            <Text style={styles.subSectionTitle}>📦 Full Cylinders</Text>
            <CalcRow label="Opening Full:" value={stock142.opening_full} />
            <CalcRow
              label="+ Received from Plant:"
              value={parseInt(receivedFromPlant142, 10) || 0}
            />
            <CalcRow label="- Total Delivered:" value={stock142.total_refill} />
            <View style={styles.divider} />
            <CalcRow
              label="Closing Full:"
              value={stock142.closing_full}
              large
              color={stock142.closing_full < 0 ? '#e74c3c' : BPCL_BLUE}
            />
            <View style={styles.divider} />
            <Text style={styles.subSectionTitle}>🔵 Empty Cylinders</Text>
            <CalcRow label="Opening Empty:" value={stock142.opening_empty} />
            <CalcRow
              label="+ Empty Received:"
              value={stock142.total_empty_received}
            />
            <CalcRow
              label="- Sent to Plant:"
              value={parseInt(emptyToPlant142, 10) || 0}
            />
            <View style={styles.divider} />
            <CalcRow
              label="Closing Empty:"
              value={stock142.closing_empty}
              large
              color={stock142.closing_empty < 0 ? '#e74c3c' : BPCL_BLUE}
            />
            <View style={styles.divider} />
            <Text style={styles.subSectionTitle}>📊 Reconciliation</Text>
            <CalcRow label="Total NC:" value={stock142.total_nc} />
            <CalcRow label="Total DBC:" value={stock142.total_dbc} />
            <CalcRow label="Total TV (Missing Empty):" value={stock142.total_tv} />
            <CalcRow
              label="Total TV Out (Extra Empty):"
              value={stock142.total_tv_out}
            />
          </>
        )}

        {selectedProduct === '19 KG Cylinder' && stock19 && (
          <>
            <Text style={styles.subSectionTitle}>📦 Full Cylinders</Text>
            <CalcRow label="Opening Full:" value={stock19.opening_full} />
            <CalcRow
              label="+ From BPCL:"
              value={parseInt(receivedFromPlant19, 10) || 0}
            />
            <CalcRow label="- Delivered:" value={stock19.cylinder_delivered} />
            <View style={styles.divider} />
            <CalcRow
              label="Closing Full:"
              value={stock19.closing_full}
              large
              color={stock19.closing_full < 0 ? '#e74c3c' : BPCL_BLUE}
            />
            <View style={styles.divider} />
            <Text style={styles.subSectionTitle}>🔵 Empty Cylinders</Text>
            <CalcRow label="Opening Empty:" value={stock19.opening_empty} />
            <CalcRow label="+ Empty Received:" value={stock19.empty_received} />
            <CalcRow
              label="- Sent to Plant:"
              value={parseInt(emptyToPlant19, 10) || 0}
            />
            <View style={styles.divider} />
            <CalcRow
              label="Closing Empty:"
              value={stock19.closing_empty}
              large
              color={stock19.closing_empty < 0 ? '#e74c3c' : BPCL_BLUE}
            />
          </>
        )}

        {selectedProduct === '5 KG Cylinder' && stockGodown && stockOffice && (
          <>
            {(() => {
              const fromBpcl = parseInt(receivedFromPlantGodown, 10) || 0;
              const emptyToPlant = parseInt(emptyToPlantGodown, 10) || 0;
              const totalRefillNum = parseInt(totalRefill, 10) || 0;
              const totalNCNum = parseInt(totalNC, 10) || 0;
              const godownRefillY = parseInt(godownRefillSplit, 10) || 0;
              const godownNCY = parseInt(godownNCSplit, 10) || 0;
              const officeRefillPortion = totalRefillNum - godownRefillY;
              const officeNCPortion = totalNCNum - godownNCY;

              const baseGodownFull =
                stockGodown.opening_full + fromBpcl - godownRefillY - godownNCY;
              // All refill empties (Office + Godown portion) return to Godown.
              const baseGodownEmpty =
                stockGodown.opening_empty - emptyToPlant + totalRefillNum;
              const baseOfficeFull =
                stockOffice.opening_full - officeRefillPortion - officeNCPortion;
              const baseOfficeEmpty = stockOffice.opening_empty;

              return (
                <>
                  <Text style={styles.subSectionTitle}>🏭 Godown</Text>
                  <CalcRow label="Opening Full:" value={stockGodown.opening_full} />
                  <CalcRow label="+ From BPCL:" value={fromBpcl} />
                  <CalcRow label="- Godown Refill:" value={godownRefillY} />
                  <CalcRow label="- Godown NC:" value={godownNCY} />
                  <Text style={styles.noteText}>
                    * Transfer impact will be applied in next step
                  </Text>
                  <View style={styles.divider} />
                  <CalcRow
                    label="Base Godown Full:"
                    value={baseGodownFull}
                    large
                    color={baseGodownFull < 0 ? '#e74c3c' : BPCL_BLUE}
                  />
                  <CalcRow label="Opening Empty:" value={stockGodown.opening_empty} />
                  <CalcRow label="- Sent to Plant:" value={emptyToPlant} />
                  <CalcRow label="+ Refill Return (all, Office + Godown):" value={totalRefillNum} />
                  <CalcRow
                    label="Base Godown Empty:"
                    value={baseGodownEmpty}
                    large
                    color={BPCL_BLUE}
                  />

                  <View style={styles.divider} />
                  <Text style={styles.subSectionTitle}>🏢 Office</Text>
                  <CalcRow label="Opening Full:" value={stockOffice.opening_full} />
                  <CalcRow label="- Office Refill:" value={officeRefillPortion} />
                  <CalcRow label="- Office NC:" value={officeNCPortion} />
                  <Text style={styles.noteText}>
                    * Transfer impact will be applied in next step
                  </Text>
                  <View style={styles.divider} />
                  <CalcRow
                    label="Base Office Full:"
                    value={baseOfficeFull}
                    large
                    color={baseOfficeFull < 0 ? '#e74c3c' : BPCL_BLUE}
                  />
                  <CalcRow label="Opening Empty:" value={stockOffice.opening_empty} />
                  <Text style={styles.noteText}>
                    * Refill empty returns go to Godown, not Office
                  </Text>
                  <CalcRow
                    label="Base Office Empty:"
                    value={baseOfficeEmpty}
                    large
                    color={BPCL_BLUE}
                  />
                </>
              );
            })()}
          </>
        )}

        <TouchableOpacity
          style={styles.nextButton}
          onPress={() => setCurrentStep(is5KG ? 3 : getBorrowStep())}
        >
          <Text style={styles.nextButtonText}>Next</Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  };

  // ─── Render: Step 3 Transfer (5KG Only) ──────────────────────────────────

  const renderStep3Transfer = () => {
    if (currentStep < 3 || !is5KG) return null;

    const {
      godownFullDelta,
      godownEmptyDelta,
      officeFullDelta,
      officeEmptyDelta,
    } = calcTransferImpact();

    const calc = get5KGCalculations();

    return (
      <View style={styles.card}>
        <StepHeader step={3} title="Godown ↔ Office Transfer" />

        {transfers.map((transfer, index) => (
          <View key={`transfer-${index}`} style={styles.transferCard}>
            <View style={styles.transferHeader}>
              <Text style={styles.transferTitle}>Transfer {index + 1}</Text>
              <TouchableOpacity onPress={() => removeTransfer(index)}>
                <Ionicons name="close-circle" size={24} color="#e74c3c" />
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Cylinder Type</Text>
            <View style={styles.toggleRow}>
              {(['full', 'empty'] as const).map((type) => (
                <TouchableOpacity
                  key={type}
                  style={[
                    styles.toggleButton,
                    transfer.type === type && styles.toggleButtonSelected,
                  ]}
                  onPress={() => updateTransfer(index, 'type', type)}
                >
                  <Text
                    style={[
                      styles.toggleButtonText,
                      transfer.type === type && styles.toggleButtonTextSelected,
                    ]}
                  >
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.label, { marginTop: 12 }]}>Direction</Text>
            <View style={styles.toggleRow}>
              {(
                [
                  { value: 'godown_to_office', label: 'Godown → Office' },
                  { value: 'office_to_godown', label: 'Office → Godown' },
                ] as const
              ).map((dir) => (
                <TouchableOpacity
                  key={dir.value}
                  style={[
                    styles.toggleButton,
                    styles.toggleButtonWide,
                    transfer.direction === dir.value &&
                      styles.toggleButtonSelected,
                  ]}
                  onPress={() =>
                    updateTransfer(index, 'direction', dir.value)
                  }
                >
                  <Text
                    style={[
                      styles.toggleButtonText,
                      transfer.direction === dir.value &&
                        styles.toggleButtonTextSelected,
                    ]}
                  >
                    {dir.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.label, { marginTop: 12 }]}>Quantity</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={transfer.quantity}
              onChangeText={(v) => updateTransfer(index, 'quantity', v)}
            />
          </View>
        ))}

        {transfers.length > 0 && (
          <View style={styles.impactCard}>
            <Text style={styles.impactTitle}>Transfer Impact</Text>
            {[
              { label: 'Godown Full:', value: godownFullDelta },
              { label: 'Godown Empty:', value: godownEmptyDelta },
              { label: 'Office Full:', value: officeFullDelta },
              { label: 'Office Empty:', value: officeEmptyDelta },
            ].map((item) => (
              <View key={item.label} style={styles.impactRow}>
                <Text style={styles.impactLabel}>{item.label}</Text>
                <Text
                  style={[
                    styles.impactValue,
                    { color: item.value >= 0 ? '#27ae60' : '#e74c3c' },
                  ]}
                >
                  {item.value >= 0 ? '+' : ''}
                  {item.value}
                </Text>
              </View>
            ))}
            <View style={styles.divider} />
            <View style={styles.impactRow}>
              <Text style={[styles.impactLabel, { fontWeight: 'bold' }]}>
                Godown Closing Full / Empty:
              </Text>
              <Text
                style={[
                  styles.impactValue,
                  {
                    fontWeight: 'bold',
                    color:
                      calc.godownClosingFull < 0 ? '#e74c3c' : BPCL_BLUE,
                  },
                ]}
              >
                {calc.godownClosingFull} / {calc.godownClosingEmpty}
              </Text>
            </View>
            <View style={styles.impactRow}>
              <Text style={[styles.impactLabel, { fontWeight: 'bold' }]}>
                Office Closing Full / Empty:
              </Text>
              <Text
                style={[
                  styles.impactValue,
                  {
                    fontWeight: 'bold',
                    color:
                      calc.officeClosingFull < 0 ? '#e74c3c' : BPCL_BLUE,
                  },
                ]}
              >
                {calc.officeClosingFull} / {calc.officeClosingEmpty}
              </Text>
            </View>
          </View>
        )}

        <TouchableOpacity style={styles.addReasonButton} onPress={addTransfer}>
          <Ionicons name="add-circle-outline" size={24} color={BPCL_BLUE} />
          <Text style={styles.addReasonText}>Add Transfer</Text>
        </TouchableOpacity>

        <View style={styles.rowButtons}>
          <TouchableOpacity
            style={styles.skipButton}
            onPress={() => setCurrentStep(4)}
          >
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.nextButton, { flex: 2 }]}
            onPress={() => setCurrentStep(4)}
          >
            <Text style={styles.nextButtonText}>Next</Text>
            <Ionicons name="arrow-forward" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Render: Borrow/Give Step ─────────────────────────────────────────────

  const renderBorrowStep = () => {
    const borrowStep = getBorrowStep();
    if (currentStep < borrowStep) return null;

    const single = !is5KG ? getFinalCalculations() : null;
    const combined = is5KG ? get5KGCalculations() : null;

    return (
      <View style={styles.card}>
        <StepHeader
          step={borrowStep}
          title="Borrow / Give Cylinders (Optional)"
        />
        {is5KG && (
          <Text style={styles.hintText}>
            Applies to Office stock (customer-facing borrow/give)
          </Text>
        )}

        {borrowEntries.map((entry, index) => (
          <View key={`borrow-${index}`} style={styles.borrowCard}>
            <View style={styles.transferHeader}>
              <Text style={styles.transferTitle}>Entry {index + 1}</Text>
              <TouchableOpacity onPress={() => removeBorrowEntry(index)}>
                <Ionicons name="close-circle" size={24} color="#e74c3c" />
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Party / Person Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. MANGALAM GAS / Raju"
              value={entry.party_name}
              onChangeText={(v) => updateBorrowEntry(index, 'party_name', v)}
            />

            <View style={styles.row}>
              <View style={styles.halfInput}>
                <Text style={[styles.label, { marginTop: 12 }]}>
                  Full Cylinders
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="+/- 0"
                  keyboardType="numbers-and-punctuation"
                  value={entry.full_qty}
                  onChangeText={(v) => updateBorrowEntry(index, 'full_qty', v)}
                />
                <Text style={styles.hintText}>+ Borrowed / - Given</Text>
              </View>

              <View style={styles.halfInput}>
                <Text style={[styles.label, { marginTop: 12 }]}>
                  Empty Cylinders
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="+/- 0"
                  keyboardType="numbers-and-punctuation"
                  value={entry.empty_qty}
                  onChangeText={(v) =>
                    updateBorrowEntry(index, 'empty_qty', v)
                  }
                />
                <Text style={styles.hintText}>+ Borrowed / - Given</Text>
              </View>
            </View>
          </View>
        ))}

        {borrowEntries.length > 0 && buildRemarksString(borrowEntries) ? (
          <View style={styles.remarksPreview}>
            <Text style={styles.remarksPreviewLabel}>Remarks Preview:</Text>
            <Text style={styles.remarksPreviewText}>
              {buildRemarksString(borrowEntries)}
            </Text>
          </View>
        ) : null}

        {borrowEntries.length > 0 && single && (
          <View style={styles.finalPreviewCard}>
            <Text style={styles.finalPreviewTitle}>
              Final Stock (After Borrow/Give)
            </Text>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Closing Full:</Text>
              <Text
                style={[
                  styles.impactValue,
                  {
                    fontWeight: 'bold',
                    color: single.closingFull < 0 ? '#e74c3c' : BPCL_BLUE,
                  },
                ]}
              >
                {single.closingFull}
              </Text>
            </View>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Closing Empty:</Text>
              <Text
                style={[
                  styles.impactValue,
                  {
                    fontWeight: 'bold',
                    color: single.closingEmpty < 0 ? '#e74c3c' : BPCL_BLUE,
                  },
                ]}
              >
                {single.closingEmpty}
              </Text>
            </View>
          </View>
        )}

        {borrowEntries.length > 0 && combined && (
          <View style={styles.finalPreviewCard}>
            <Text style={styles.finalPreviewTitle}>
              Final Stock (After Borrow/Give)
            </Text>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Godown Full / Empty:</Text>
              <Text style={[styles.impactValue, { fontWeight: 'bold', color: BPCL_BLUE }]}>
                {combined.godownClosingFull} / {combined.godownClosingEmpty}
              </Text>
            </View>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Office Full / Empty:</Text>
              <Text style={[styles.impactValue, { fontWeight: 'bold', color: BPCL_BLUE }]}>
                {combined.officeClosingFull} / {combined.officeClosingEmpty}
              </Text>
            </View>
          </View>
        )}

        <TouchableOpacity
          style={styles.addReasonButton}
          onPress={addBorrowEntry}
        >
          <Ionicons name="add-circle-outline" size={24} color={BPCL_BLUE} />
          <Text style={styles.addReasonText}>Add Entry</Text>
        </TouchableOpacity>

        <View style={styles.rowButtons}>
          <TouchableOpacity
            style={styles.skipButton}
            onPress={() => setShowConfirmModal(true)}
          >
            <Text style={styles.skipButtonText}>Skip & Confirm</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.nextButton, { flex: 2 }]}
            onPress={() => setShowConfirmModal(true)}
          >
            <Text style={styles.nextButtonText}>Review & Save</Text>
            <Ionicons name="checkmark-circle" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Render: Confirm Modal ────────────────────────────────────────────────

  const renderConfirmModal = () => {
    const single = !is5KG ? getFinalCalculations() : null;
    const combined = is5KG ? get5KGCalculations() : null;
    const borrowedFull = calcBorrowedFull(borrowEntries);
    const borrowedEmpty = calcBorrowedEmpty(borrowEntries);
    const remarks = is5KG ? combined?.remarks : single?.remarks;

    const ModalRow = ({
      label,
      value,
      color,
    }: {
      label: string;
      value: string | number;
      color?: string;
    }) => (
      <View style={styles.modalRow}>
        <Text style={styles.modalLabel}>{label}</Text>
        <Text style={[styles.modalValue, color ? { color } : {}]}>{value}</Text>
      </View>
    );

    const ModalRowFinal = ({
      label,
      value,
      color,
    }: {
      label: string;
      value: number;
      color?: string;
    }) => (
      <View style={[styles.modalRow, styles.modalRowFinal]}>
        <Text style={styles.modalLabelBold}>{label}</Text>
        <Text style={[styles.modalValueBold, color ? { color } : {}]}>
          {value}
        </Text>
      </View>
    );

    return (
      <Modal
        visible={showConfirmModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowConfirmModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.modalHeader}>
                <Ionicons name="checkmark-circle" size={40} color={BPCL_BLUE} />
                <Text style={styles.modalTitle}>Confirm Stock Entry</Text>
                <Text style={styles.modalSubtitle}>{selectedProduct}</Text>
                {/* Uses the dynamic TODAY state variable */}
                <Text style={styles.modalDate}>Date: {TODAY}</Text>
              </View>

              {!is5KG && (
                <>
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>📦 Full Cylinders</Text>

                    {selectedProduct === '14.2 KG Cylinder' && stock142 && (
                      <>
                        <ModalRow label="Opening Full:" value={stock142.opening_full} />
                        <ModalRow
                          label="+ Received from Plant:"
                          value={parseInt(receivedFromPlant142, 10) || 0}
                        />
                        <ModalRow label="- Delivered:" value={stock142.total_refill} />
                      </>
                    )}

                    {selectedProduct === '19 KG Cylinder' && stock19 && (
                      <>
                        <ModalRow label="Opening Full:" value={stock19.opening_full} />
                        <ModalRow
                          label="+ From BPCL:"
                          value={parseInt(receivedFromPlant19, 10) || 0}
                        />
                        <ModalRow
                          label="- Delivered:"
                          value={stock19.cylinder_delivered}
                        />
                      </>
                    )}

                    {borrowedFull !== 0 && (
                      <ModalRow
                        label="± Borrow/Give Full:"
                        value={`${borrowedFull > 0 ? '+' : ''}${borrowedFull}`}
                        color={borrowedFull > 0 ? '#27ae60' : '#e74c3c'}
                      />
                    )}

                    {single && (
                      <ModalRowFinal
                        label="Closing Full:"
                        value={single.closingFull}
                        color={single.closingFull < 0 ? '#e74c3c' : BPCL_BLUE}
                      />
                    )}
                  </View>

                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>🔵 Empty Cylinders</Text>

                    {selectedProduct === '14.2 KG Cylinder' && stock142 && (
                      <>
                        <ModalRow label="Opening Empty:" value={stock142.opening_empty} />
                        <ModalRow
                          label="+ Empty Received:"
                          value={stock142.total_empty_received}
                        />
                        <ModalRow
                          label="- Sent to Plant:"
                          value={parseInt(emptyToPlant142, 10) || 0}
                        />
                      </>
                    )}

                    {selectedProduct === '19 KG Cylinder' && stock19 && (
                      <>
                        <ModalRow label="Opening Empty:" value={stock19.opening_empty} />
                        <ModalRow
                          label="+ Empty Received:"
                          value={stock19.empty_received}
                        />
                        <ModalRow
                          label="- Sent to Plant:"
                          value={parseInt(emptyToPlant19, 10) || 0}
                        />
                      </>
                    )}

                    {borrowedEmpty !== 0 && (
                      <ModalRow
                        label="± Borrow/Give Empty:"
                        value={`${borrowedEmpty > 0 ? '+' : ''}${borrowedEmpty}`}
                        color={borrowedEmpty > 0 ? '#27ae60' : '#e74c3c'}
                      />
                    )}

                    {single && (
                      <ModalRowFinal
                        label="Closing Empty:"
                        value={single.closingEmpty}
                        color={single.closingEmpty < 0 ? '#e74c3c' : BPCL_BLUE}
                      />
                    )}
                  </View>
                </>
              )}

              {is5KG && stockGodown && stockOffice && combined && (
                <>
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>🏭 Godown</Text>
                    <ModalRow label="Opening Full:" value={stockGodown.opening_full} />
                    <ModalRow
                      label="+ From BPCL:"
                      value={parseInt(receivedFromPlantGodown, 10) || 0}
                    />
                    <ModalRow
                      label="- Sent to Office:"
                      value={transfers
                        .filter((t) => t.direction === 'godown_to_office' && t.type === 'full')
                        .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0)}
                    />
                    <ModalRow label="- Godown Refill:" value={combined.godownRefillSplitVal} />
                    <ModalRow label="- Godown NC:" value={combined.godownNCSplitVal} />
                    <ModalRowFinal
                      label="Godown Closing Full:"
                      value={combined.godownClosingFull}
                      color={combined.godownClosingFull < 0 ? '#e74c3c' : BPCL_BLUE}
                    />
                    <ModalRow label="Opening Empty:" value={stockGodown.opening_empty} />
                    <ModalRow
                      label="- Sent to Plant:"
                      value={parseInt(emptyToPlantGodown, 10) || 0}
                    />
                    <ModalRow
                      label="+ Received from Office:"
                      value={transfers
                        .filter((t) => t.direction === 'office_to_godown' && t.type === 'empty')
                        .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0)}
                    />
                    <ModalRow
                      label="+ Refill Return (all, Office + Godown):"
                      value={combined.officeRefillPortion + combined.godownRefillSplitVal}
                    />
                    <ModalRowFinal
                      label="Godown Closing Empty:"
                      value={combined.godownClosingEmpty}
                      color={BPCL_BLUE}
                    />
                  </View>

                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>🏢 Office</Text>
                    <ModalRow label="Opening Full:" value={stockOffice.opening_full} />
                    <ModalRow
                      label="+ Received from Godown:"
                      value={transfers
                        .filter((t) => t.direction === 'godown_to_office' && t.type === 'full')
                        .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0)}
                    />
                    <ModalRow label="- Office Refill:" value={combined.officeRefillPortion} />
                    <ModalRow label="- Office NC:" value={combined.officeNCPortion} />
                    {borrowedFull !== 0 && (
                      <ModalRow
                        label="± Borrow/Give Full:"
                        value={`${borrowedFull > 0 ? '+' : ''}${borrowedFull}`}
                        color={borrowedFull > 0 ? '#27ae60' : '#e74c3c'}
                      />
                    )}
                    <ModalRowFinal
                      label="Office Closing Full:"
                      value={combined.officeClosingFull}
                      color={combined.officeClosingFull < 0 ? '#e74c3c' : BPCL_BLUE}
                    />
                    <ModalRow label="Opening Empty:" value={stockOffice.opening_empty} />
                    <ModalRow
                      label="- Sent to Godown:"
                      value={transfers
                        .filter((t) => t.direction === 'office_to_godown' && t.type === 'empty')
                        .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0)}
                    />
                    {borrowedEmpty !== 0 && (
                      <ModalRow
                        label="± Borrow/Give Empty:"
                        value={`${borrowedEmpty > 0 ? '+' : ''}${borrowedEmpty}`}
                        color={borrowedEmpty > 0 ? '#27ae60' : '#e74c3c'}
                      />
                    )}
                    <ModalRowFinal
                      label="Office Closing Empty:"
                      value={combined.officeClosingEmpty}
                      color={BPCL_BLUE}
                    />
                  </View>
                </>
              )}

              {remarks ? (
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>📝 Remarks</Text>
                  <Text style={styles.remarksText}>{remarks}</Text>
                </View>
              ) : null}

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalCancelButton}
                  onPress={() => setShowConfirmModal(false)}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modalConfirmButton,
                    saving && styles.buttonDisabled,
                  ]}
                  onPress={handleSave}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.modalConfirmText}>Confirm & Save</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  };

  // ─── Main Render ──────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── Blue Header ───────────────────────────────────────────────────── */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerTopRow}>
            <Text style={styles.headerTitle}>Stock Entry</Text>
            <TouchableOpacity
              style={styles.refreshButton}
              onPress={handleRefresh}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="refresh" size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Date picker row — updated pattern */}
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
              onChange={(event: any, date?: Date) => {
                setShowDatePicker(false);
                if (event.type === 'set' && date) {
                  setSelectedDate(format(date, 'yyyy-MM-dd'));
                }
              }}
            />
          )}
        </View>
      </SafeAreaView>

      {/* ── Date Picker ───────────────────────────────────────────────────── */}
      {showDatePicker && (
        <DateTimePicker
          value={new Date(selectedDate + 'T00:00:00')}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          maximumDate={new Date()}
          onChange={handleDateChange}
          style={Platform.OS === 'ios' ? styles.iosDatePicker : undefined}
        />
      )}

      {/* iOS: show a "Done" button to close the inline picker */}
      {showDatePicker && Platform.OS === 'ios' && (
        <View style={styles.iosDoneRow}>
          <TouchableOpacity
            style={styles.iosDoneButton}
            onPress={() => setShowDatePicker(false)}
          >
            <Text style={styles.iosDoneText}>Done</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Main Content ──────────────────────────────────────────────────── */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Dropdown ────────────────────────────────────────────────────── */}
          <View style={styles.dropdownSection}>
            <Text style={styles.label}>Select Product *</Text>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => setDropdownOpen((prev) => !prev)}
            >
              <Text
                style={[
                  styles.dropdownButtonText,
                  !selectedProduct && styles.dropdownPlaceholder,
                ]}
              >
                {selectedProduct || 'Select a product...'}
              </Text>
              <Ionicons
                name={dropdownOpen ? 'chevron-up' : 'chevron-down'}
                size={20}
                color={BPCL_BLUE}
              />
            </TouchableOpacity>

            {dropdownOpen && (
              <View style={styles.dropdownList}>
                {(
                  [
                    '14.2 KG Cylinder',
                    '19 KG Cylinder',
                    '5 KG Cylinder',
                  ] as Product[]
                ).map((product) => (
                  <TouchableOpacity
                    key={product}
                    style={[
                      styles.dropdownItem,
                      selectedProduct === product &&
                        styles.dropdownItemSelected,
                    ]}
                    onPress={() => handleProductSelect(product)}
                  >
                    <Text
                      style={[
                        styles.dropdownItemText,
                        selectedProduct === product &&
                          styles.dropdownItemTextSelected,
                      ]}
                    >
                      {product}
                    </Text>
                    {selectedProduct === product && (
                      <Ionicons name="checkmark" size={18} color="#fff" />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {/* ── Steps ───────────────────────────────────────────────────────── */}
          {renderStep1()}
          {renderStep2()}
          {renderStep3Transfer()}
          {renderBorrowStep()}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Split Modals ──────────────────────────────────────────────────── */}
      {renderRefillSplitModal()}
      {renderNCSplitModal()}

      {/* ── Confirm Modal ─────────────────────────────────────────────────── */}
      {renderConfirmModal()}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },

  // ── Blue Header ───────────────────────────────────────────────────────────
  header: {
    backgroundColor: BPCL_BLUE,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 5,
  },
  headerContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerDate: { fontSize: 14, color: 'rgba(255,255,255,0.9)' },
  refreshButton: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BPCL_YELLOW,
  },
  datePickerText: {
    fontSize: 14,
    color: BPCL_YELLOW,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // ── iOS Date Picker ───────────────────────────────────────────────────────
  iosDatePicker: {
    backgroundColor: '#fff',
  },
  iosDoneRow: {
    backgroundColor: '#fff',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  iosDoneButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: BPCL_BLUE,
    borderRadius: 8,
  },
  iosDoneText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },

  scrollView: {
    flex: 1,
  },

  // ── Dropdown ──────────────────────────────────────────────────────────────
  dropdownSection: {
    margin: 16,
    marginBottom: 8,
  },
  dropdownButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: BPCL_BLUE,
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dropdownButtonText: {
    fontSize: 16,
    color: '#333',
    fontWeight: '600',
  },
  dropdownPlaceholder: {
    color: '#aaa',
    fontWeight: '400',
  },
  dropdownList: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    marginTop: 4,
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    zIndex: 999,
  },
  dropdownItem: {
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  dropdownItemSelected: {
    backgroundColor: BPCL_BLUE,
  },
  dropdownItemText: {
    fontSize: 15,
    color: '#333',
  },
  dropdownItemTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },

  // ── Step Header ───────────────────────────────────────────────────────────
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 10,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: BPCL_BLUE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepBadgeText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  stepTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },

  // ── Cards ─────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  calculationCard: {
    backgroundColor: '#e8f4f8',
    margin: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: BPCL_BLUE,
  },

  // ── Form Elements ─────────────────────────────────────────────────────────
  label: {
    fontSize: 14,
    color: '#666',
    marginBottom: 8,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  hintText: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
    marginBottom: 6,
    fontStyle: 'italic',
  },
  noteText: {
    fontSize: 11,
    color: '#999',
    fontStyle: 'italic',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfInput: {
    flex: 1,
  },

  // ── Checkbox / Split Preview ─────────────────────────────────────────────
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  checkboxLabel: {
    fontSize: 14,
    color: '#333',
    fontWeight: '600',
  },
  splitPreviewText: {
    fontSize: 13,
    color: BPCL_BLUE,
    marginTop: 6,
    fontWeight: '600',
  },

  // ── Calc Rows ─────────────────────────────────────────────────────────────
  calcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 5,
  },
  calcLabel: {
    fontSize: 14,
    color: '#666',
  },
  calcValue: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#333',
  },
  calcValueLarge: {
    fontSize: 20,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  divider: {
    height: 1,
    backgroundColor: '#ddd',
    marginVertical: 10,
  },
  subSectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#444',
    marginBottom: 8,
    marginTop: 4,
  },

  // ── Buttons ───────────────────────────────────────────────────────────────
  nextButton: {
    backgroundColor: BPCL_BLUE,
    padding: 14,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  skipButton: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BPCL_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  skipButtonText: {
    color: BPCL_BLUE,
    fontSize: 15,
    fontWeight: '600',
  },
  rowButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  addReasonButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 14,
    borderWidth: 2,
    borderColor: BPCL_BLUE,
    borderStyle: 'dashed',
    borderRadius: 10,
    marginTop: 8,
  },
  addReasonText: {
    color: BPCL_BLUE,
    fontSize: 15,
    fontWeight: '600',
  },

  // ── Transfer ──────────────────────────────────────────────────────────────
  transferCard: {
    backgroundColor: '#f8f9fa',
    padding: 14,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  transferHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  transferTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleButton: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  toggleButtonWide: {
    flex: 1,
  },
  toggleButtonSelected: {
    backgroundColor: BPCL_BLUE,
    borderColor: BPCL_BLUE,
  },
  toggleButtonText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
  },
  toggleButtonTextSelected: {
    color: '#fff',
  },
  impactCard: {
    backgroundColor: '#fff3cd',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 8,
    borderLeftWidth: 4,
    borderLeftColor: BPCL_YELLOW,
  },
  impactTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#856404',
    marginBottom: 8,
  },
  impactRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 3,
  },
  impactLabel: {
    fontSize: 13,
    color: '#666',
  },
  impactValue: {
    fontSize: 14,
    fontWeight: 'bold',
  },

  // ── Borrow ────────────────────────────────────────────────────────────────
  borrowCard: {
    backgroundColor: '#f8f9fa',
    padding: 14,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  remarksPreview: {
    backgroundColor: '#e8f5e9',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#27ae60',
  },
  remarksPreviewLabel: {
    fontSize: 12,
    color: '#2e7d32',
    fontWeight: 'bold',
    marginBottom: 4,
  },
  remarksPreviewText: {
    fontSize: 13,
    color: '#1b5e20',
    fontStyle: 'italic',
  },
  finalPreviewCard: {
    backgroundColor: '#e3f2fd',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
    borderLeftWidth: 4,
    borderLeftColor: BPCL_BLUE,
  },
  finalPreviewTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginBottom: 8,
  },

  // ── Modal ─────────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    maxHeight: '85%',
  },
  smallModalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 24,
    alignSelf: 'center',
    width: '85%',
  },
  modalHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginTop: 8,
  },
  modalSubtitle: {
    fontSize: 15,
    color: BPCL_BLUE,
    fontWeight: '600',
    marginTop: 4,
  },
  modalDate: {
    fontSize: 13,
    color: '#888',
    marginTop: 4,
  },
  modalSection: {
    backgroundColor: '#f8f9fa',
    padding: 14,
    borderRadius: 10,
    marginBottom: 12,
  },
  modalSectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#444',
    marginBottom: 10,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 4,
  },
  modalRowFinal: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#ddd',
  },
  modalLabel: {
    fontSize: 14,
    color: '#666',
  },
  modalValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  modalLabelBold: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#333',
  },
  modalValueBold: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  remarksText: {
    fontSize: 13,
    color: '#555',
    fontStyle: 'italic',
    lineHeight: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
    marginBottom: 16,
  },
  modalCancelButton: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
  },
  modalConfirmButton: {
    flex: 2,
    padding: 14,
    borderRadius: 10,
    backgroundColor: BPCL_BLUE,
    alignItems: 'center',
  },
  modalConfirmText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: 'bold',
  },
});
