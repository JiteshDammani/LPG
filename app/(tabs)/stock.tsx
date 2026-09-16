import React, { useState, useEffect, useCallback } from 'react';
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
import { supabase } from '../../lib/supabase';
import { format } from 'date-fns';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';
const TODAY = format(new Date(), 'yyyy-MM-dd');

// ─── Types ────────────────────────────────────────────────────────────────────

type Product = '14.2 KG Cylinder' | '19 KG Cylinder' | '5 KG - Godown' | '5 KG - Office';

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

interface CylinderStockData {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
  total_refill: number;
  total_nc: number;
  total_dbc: number;
  total_tv: number;
  total_tv_out: number;
}

interface CommercialStockData {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
  cylinder_delivered: number;
  empty_received: number;
}

interface GodownStockData {
  opening_full: number;
  closing_full: number;
  opening_empty: number;
  closing_empty: number;
}

interface OfficeStockData {
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
      if (!isNaN(fullQty) && fullQty !== 0) {
        parts.push(`${e.party_name.trim()} (FULL): ${fullQty}`);
      }
      if (!isNaN(emptyQty) && emptyQty !== 0) {
        parts.push(`${e.party_name.trim()} (EMPTY): ${emptyQty}`);
      }
      return parts.join('; ');
    })
    .filter(Boolean)
    .join('; ');
};

const calcBorrowedFull = (entries: BorrowEntry[]): number => {
  return entries.reduce((sum, e) => {
    const v = parseInt(e.full_qty, 10);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);
};

const calcBorrowedEmpty = (entries: BorrowEntry[]): number => {
  return entries.reduce((sum, e) => {
    const v = parseInt(e.empty_qty, 10);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);
};

// ─── Sub Components ───────────────────────────────────────────────────────────

// Calculation Preview Row
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

// Step Header
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
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // ── 14.2 KG State ──────────────────────────────────────────────────────────
  const [receivedFromPlant142, setReceivedFromPlant142] = useState('');
  const [emptyToPlant142, setEmptyToPlant142] = useState('');
  const [stock142, setStock142] = useState<CylinderStockData | null>(null);

  // ── 19 KG State ────────────────────────────────────────────────────────────
  const [receivedFromPlant19, setReceivedFromPlant19] = useState('');
  const [newConnection19, setNewConnection19] = useState('');
  const [stock19, setStock19] = useState<CommercialStockData | null>(null);

  // ── 5KG Godown State ───────────────────────────────────────────────────────
  const [receivedFromPlantGodown, setReceivedFromPlantGodown] = useState('');
  const [stockGodown, setStockGodown] = useState<GodownStockData | null>(null);

  // ── 5KG Office State ───────────────────────────────────────────────────────
  const [officeRefill, setOfficeRefill] = useState('');
  const [officeNC, setOfficeNC] = useState('');
  const [officeEmptyReceived, setOfficeEmptyReceived] = useState('');
  const [stockOffice, setStockOffice] = useState<OfficeStockData | null>(null);

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
    setNewConnection19('');
    setStock19(null);
    setReceivedFromPlantGodown('');
    setStockGodown(null);
    setOfficeRefill('');
    setOfficeNC('');
    setOfficeEmptyReceived('');
    setStockOffice(null);
    setTransfers([]);
    setBorrowEntries([]);
    setShowConfirmModal(false);
  }, []);

  const handleProductSelect = (product: Product) => {
    setSelectedProduct(product);
    setDropdownOpen(false);
    resetAll();
  };

  // ─── Step 1 → Step 2: Fetch Data ───────────────────────────────────────────

  const handleStep1Next = async () => {
    if (!selectedProduct) return;
    setLoading(true);

    try {
      if (selectedProduct === '14.2 KG Cylinder') {
        await fetch142KGData();
      } else if (selectedProduct === '19 KG Cylinder') {
        await fetch19KGData();
      } else if (selectedProduct === '5 KG - Godown') {
        await fetchGodownData();
      } else if (selectedProduct === '5 KG - Office') {
        await fetchOfficeData();
      }
      setCurrentStep(2);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to fetch stock data');
    } finally {
      setLoading(false);
    }
  };

  // ─── 14.2 KG Fetch ─────────────────────────────────────────────────────────

  const fetch142KGData = async () => {
    // Validate inputs
    if (!receivedFromPlant142 && !emptyToPlant142) {
      throw new Error('Please enter at least one value');
    }

    // Fetch latest cylinder stock
    const { data: stockData, error: stockError } = await supabase
      .from('dashboard_cylinderstock')
      .select('closing_full, closing_empty')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (stockError) throw stockError;

    // Fetch today's delivery records
    const { data: deliveryData, error: deliveryError } = await supabase
      .from('dashboard_deliveryrecords')
      .select('number, empty_received, remarks')
      .eq('date', TODAY);

    if (deliveryError) throw deliveryError;

    const records = deliveryData || [];

    // Calculate totals
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

      if (empty > num) totalTV += 1;
      if (num > empty) totalTVOut += 1;
    });

    const openingFull = stockData?.closing_full || 0;
    const openingEmpty = stockData?.closing_empty || 0;
    const receivedPlant = parseInt(receivedFromPlant142, 10) || 0;
    const emptyPlant = parseInt(emptyToPlant142, 10) || 0;

    const closingFull = openingFull + receivedPlant - totalRefill;
    const closingEmpty = openingEmpty + totalEmptyReceived - emptyPlant;

    setStock142({
      opening_full: openingFull,
      closing_full: closingFull,
      opening_empty: openingEmpty,
      closing_empty: closingEmpty,
      total_refill: totalRefill,
      total_nc: totalNC,
      total_dbc: totalDBC,
      total_tv: totalTV,
      total_tv_out: totalTVOut,
    });
  };

  // ─── 19 KG Fetch ───────────────────────────────────────────────────────────

  const fetch19KGData = async () => {
    if (!receivedFromPlant19) {
      throw new Error('Please enter cylinders received from plant');
    }

    // Fetch latest commercial stock
    const { data: stockData, error: stockError } = await supabase
      .from('dashboard_commercialstock')
      .select('closing_full, closing_empty')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (stockError) throw stockError;

    // Fetch today's commercial records - count rows for delivered
    const { data: deliveredData, error: deliveredError } = await supabase
      .from('dashboard_commercialrecords')
      .select('id')
      .eq('delivery_date', TODAY);

    if (deliveredError) throw deliveredError;

    // Fetch today's commercial records - count rows for empty received
    const { data: emptyData, error: emptyError } = await supabase
      .from('dashboard_commercialrecords')
      .select('id')
      .eq('empty_received', TODAY);

    if (emptyError) throw emptyError;

    const openingFull = stockData?.closing_full || 0;
    const openingEmpty = stockData?.closing_empty || 0;
    const fromBpcl = parseInt(receivedFromPlant19, 10) || 0;
    const nc = parseInt(newConnection19, 10) || 0;
    const cylinderDelivered = deliveredData?.length || 0;
    const emptyReceived = emptyData?.length || 0;

    const closingFull = openingFull + fromBpcl - cylinderDelivered - nc;
    const closingEmpty = openingEmpty + emptyReceived;

    setStock19({
      opening_full: openingFull,
      closing_full: closingFull,
      opening_empty: openingEmpty,
      closing_empty: closingEmpty,
      cylinder_delivered: cylinderDelivered,
      empty_received: emptyReceived,
    });
  };

  // ─── 5KG Godown Fetch ──────────────────────────────────────────────────────

  const fetchGodownData = async () => {
    const { data: stockData, error: stockError } = await supabase
      .from('dashboard_godownftlstock')
      .select('closing_full, closing_empty')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (stockError) throw stockError;

    setStockGodown({
      opening_full: stockData?.closing_full || 0,
      closing_full: stockData?.closing_full || 0,
      opening_empty: stockData?.closing_empty || 0,
      closing_empty: stockData?.closing_empty || 0,
    });
  };

  // ─── 5KG Office Fetch ──────────────────────────────────────────────────────

  const fetchOfficeData = async () => {
    if (!officeRefill && !officeNC) {
      throw new Error('Please enter refill or new connection count');
    }

    const { data: stockData, error: stockError } = await supabase
      .from('dashboard_officeftlstock')
      .select('closing_full, closing_empty')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (stockError) throw stockError;

    const openingFull = stockData?.closing_full || 0;
    const openingEmpty = stockData?.closing_empty || 0;
    const refill = parseInt(officeRefill, 10) || 0;
    const nc = parseInt(officeNC, 10) || 0;
    const emptyIn = parseInt(officeEmptyReceived, 10) || 0;

    const closingFull = openingFull - refill - nc;
    const closingEmpty = openingEmpty + emptyIn;

    setStockOffice({
      opening_full: openingFull,
      closing_full: closingFull,
      opening_empty: openingEmpty,
      closing_empty: closingEmpty,
    });
  };

  // ─── Transfer Handlers ─────────────────────────────────────────────────────

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

  // Calculate transfer impact on godown and office
  const calcTransferImpact = () => {
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
        // office_to_godown
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
  };

  // ─── Borrow/Give Handlers ──────────────────────────────────────────────────

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

  // ─── Final Calculations with Borrow/Give ───────────────────────────────────

  const getFinalCalculations = () => {
    const borrowedFull = calcBorrowedFull(borrowEntries);
    const borrowedEmpty = calcBorrowedEmpty(borrowEntries);
    const remarks = buildRemarksString(borrowEntries);
    const { godownFullDelta, godownEmptyDelta, officeFullDelta, officeEmptyDelta } =
      calcTransferImpact();

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

    if (selectedProduct === '5 KG - Godown' && stockGodown) {
      const fromBpcl = parseInt(receivedFromPlantGodown, 10) || 0;
      const closingFull =
        stockGodown.opening_full + fromBpcl + godownFullDelta + borrowedFull;
      const closingEmpty =
        stockGodown.opening_empty + godownEmptyDelta + borrowedEmpty;
      return { closingFull, closingEmpty, remarks };
    }

    if (selectedProduct === '5 KG - Office' && stockOffice) {
      const closingFull = stockOffice.closing_full + officeFullDelta + borrowedFull;
      const closingEmpty = stockOffice.closing_empty + officeEmptyDelta + borrowedEmpty;
      return { closingFull, closingEmpty, remarks };
    }

    return { closingFull: 0, closingEmpty: 0, remarks: '' };
  };

  // ─── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      const { closingFull, closingEmpty, remarks } = getFinalCalculations();
      const { godownFullDelta, godownEmptyDelta, officeFullDelta, officeEmptyDelta } =
        calcTransferImpact();

      if (selectedProduct === '14.2 KG Cylinder' && stock142) {
        const receivedPlant = parseInt(receivedFromPlant142, 10) || 0;
        const emptyPlant = parseInt(emptyToPlant142, 10) || 0;

        const { error } = await supabase
          .from('dashboard_cylinderstock')
          .insert([
            {
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
            },
          ]);

        if (error) throw error;
      }

      if (selectedProduct === '19 KG Cylinder' && stock19) {
        const fromBpcl = parseInt(receivedFromPlant19, 10) || 0;
        const nc = parseInt(newConnection19, 10) || 0;

        const { error } = await supabase
          .from('dashboard_commercialstock')
          .insert([
            {
              date: TODAY,
              opening_full: stock19.opening_full,
              from_bpcl: fromBpcl,
              empty_received: stock19.empty_received,
              cylinder_delivered: stock19.cylinder_delivered,
              closing_full: closingFull,
              opening_empty: stock19.opening_empty,
              new_connection: nc,
              closing_empty: closingEmpty,
              remarks: remarks || '',
            },
          ]);

        if (error) throw error;
      }

      if (
        (selectedProduct === '5 KG - Godown' ||
          selectedProduct === '5 KG - Office') &&
        stockGodown &&
        stockOffice
      ) {
        const fromBpcl = parseInt(receivedFromPlantGodown, 10) || 0;
        const refill = parseInt(officeRefill, 10) || 0;
        const nc = parseInt(officeNC, 10) || 0;
        const emptyIn = parseInt(officeEmptyReceived, 10) || 0;

        // Calculate transfer columns for godown
        const sentToOffice = transfers
          .filter((t) => t.direction === 'godown_to_office' && t.type === 'full')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const receivedFromOffice = transfers
          .filter((t) => t.direction === 'office_to_godown' && t.type === 'full')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const addOfficeStock = transfers
          .filter((t) => t.direction === 'godown_to_office' && t.type === 'full')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const toGodown = transfers
          .filter((t) => t.direction === 'office_to_godown' && t.type === 'empty')
          .reduce((sum, t) => sum + (parseInt(t.quantity, 10) || 0), 0);

        const godownFinalFull =
          stockGodown.opening_full + fromBpcl + godownFullDelta + calcBorrowedFull(borrowEntries);
        const godownFinalEmpty =
          stockGodown.opening_empty + godownEmptyDelta + calcBorrowedEmpty(borrowEntries);

        const officeFinalFull =
          stockOffice.opening_full + officeFullDelta - refill - nc + calcBorrowedFull(borrowEntries);
        const officeFinalEmpty =
          stockOffice.opening_empty + emptyIn + officeEmptyDelta + calcBorrowedEmpty(borrowEntries);

        // Insert Godown
        const { error: godownError } = await supabase
          .from('dashboard_godownftlstock')
          .insert([
            {
              date: TODAY,
              opening_full: stockGodown.opening_full,
              from_bpcl: fromBpcl,
              sent_to_office: sentToOffice,
              received_from_office: receivedFromOffice,
              closing_full: godownFinalFull,
              opening_empty: stockGodown.opening_empty,
              closing_empty: godownFinalEmpty,
              remarks: remarks || '',
            },
          ]);

        if (godownError) throw godownError;

        // Insert Office
        const { error: officeError } = await supabase
          .from('dashboard_officeftlstock')
          .insert([
            {
              date: TODAY,
              opening_full: stockOffice.opening_full,
              add_office_stock: addOfficeStock,
              refill,
              new_connection: nc,
              closing_full: officeFinalFull,
              opening_empty: stockOffice.opening_empty,
              to_godown: toGodown,
              closing_empty: officeFinalEmpty,
              remarks: remarks || '',
            },
          ]);

        if (officeError) throw officeError;
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

  // ─── Get Final Numbers for Modal ───────────────────────────────────────────

  const getFinalNumbers = () => {
    const { closingFull, closingEmpty, remarks } = getFinalCalculations();
    const borrowedFull = calcBorrowedFull(borrowEntries);
    const borrowedEmpty = calcBorrowedEmpty(borrowEntries);
    return { closingFull, closingEmpty, remarks, borrowedFull, borrowedEmpty };
  };

  // ─── Render Step 1 ─────────────────────────────────────────────────────────

  const renderStep1 = () => {
    if (!selectedProduct) return null;

    return (
      <View style={styles.card}>
        <StepHeader step={1} title="Enter Plant Details" />

        {selectedProduct === '14.2 KG Cylinder' && (
          <>
            <Text style={styles.label}>Cylinders Received from Plant</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={receivedFromPlant142}
              onChangeText={setReceivedFromPlant142}
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
              onChangeText={setReceivedFromPlant19}
            />
            <Text style={[styles.label, { marginTop: 16 }]}>
              New Connections
            </Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={newConnection19}
              onChangeText={setNewConnection19}
            />
          </>
        )}

        {selectedProduct === '5 KG - Godown' && (
          <>
            <Text style={styles.label}>Cylinders Received from Plant (BPCL)</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={receivedFromPlantGodown}
              onChangeText={setReceivedFromPlantGodown}
            />
          </>
        )}

        {selectedProduct === '5 KG - Office' && (
          <>
            <Text style={styles.label}>Refill Delivered Today</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={officeRefill}
              onChangeText={setOfficeRefill}
            />
            <Text style={[styles.label, { marginTop: 16 }]}>New Connections</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={officeNC}
              onChangeText={setOfficeNC}
            />
            {(parseInt(officeRefill, 10) > 0 || parseInt(officeNC, 10) > 0) && (
              <>
                <Text style={[styles.label, { marginTop: 16 }]}>
                  Empty Cylinders Received from Customers
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="0"
                  keyboardType="numeric"
                  value={officeEmptyReceived}
                  onChangeText={setOfficeEmptyReceived}
                />
              </>
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

  // ─── Render Step 2: Summary ─────────────────────────────────────────────────

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
            <CalcRow label="+ Empty Received:" value={stock142.total_refill} />
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
            <CalcRow label="Total TV (Extra Empty):" value={stock142.total_tv} />
            <CalcRow
              label="Total TV Out (Missing Empty):"
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
            <CalcRow
              label="- New Connections:"
              value={parseInt(newConnection19, 10) || 0}
            />
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
            <View style={styles.divider} />
            <CalcRow
              label="Closing Empty:"
              value={stock19.closing_empty}
              large
              color={stock19.closing_empty < 0 ? '#e74c3c' : BPCL_BLUE}
            />
          </>
        )}

        {selectedProduct === '5 KG - Godown' && stockGodown && (
          <>
            <Text style={styles.subSectionTitle}>📦 Godown Full Cylinders</Text>
            <CalcRow label="Opening Full:" value={stockGodown.opening_full} />
            <CalcRow
              label="+ From BPCL:"
              value={parseInt(receivedFromPlantGodown, 10) || 0}
            />
            <View style={styles.divider} />
            <CalcRow
              label="Current Full:"
              value={
                stockGodown.opening_full + (parseInt(receivedFromPlantGodown, 10) || 0)
              }
              large
              color={BPCL_BLUE}
            />

            <View style={styles.divider} />
            <Text style={styles.subSectionTitle}>🔵 Godown Empty Cylinders</Text>
            <CalcRow label="Opening Empty:" value={stockGodown.opening_empty} />
          </>
        )}

        {selectedProduct === '5 KG - Office' && stockOffice && (
          <>
            <Text style={styles.subSectionTitle}>📦 Office Full Cylinders</Text>
            <CalcRow label="Opening Full:" value={stockOffice.opening_full} />
            <CalcRow
              label="- Refill:"
              value={parseInt(officeRefill, 10) || 0}
            />
            <CalcRow
              label="- New Connections:"
              value={parseInt(officeNC, 10) || 0}
            />
            <View style={styles.divider} />
            <CalcRow
              label="Closing Full:"
              value={stockOffice.closing_full}
              large
              color={stockOffice.closing_full < 0 ? '#e74c3c' : BPCL_BLUE}
            />

            <View style={styles.divider} />
            <Text style={styles.subSectionTitle}>🔵 Office Empty Cylinders</Text>
            <CalcRow label="Opening Empty:" value={stockOffice.opening_empty} />
            <CalcRow
              label="+ Empty Received:"
              value={parseInt(officeEmptyReceived, 10) || 0}
            />
            <View style={styles.divider} />
            <CalcRow
              label="Closing Empty:"
              value={stockOffice.closing_empty}
              large
              color={stockOffice.closing_empty < 0 ? '#e74c3c' : BPCL_BLUE}
            />
          </>
        )}

        <TouchableOpacity
          style={styles.nextButton}
          onPress={() => setCurrentStep(3)}
        >
          <Text style={styles.nextButtonText}>Next</Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  };

  // ─── Render Step 3: Transfer (5KG Only) ────────────────────────────────────

  const renderStep3Transfer = () => {
    if (currentStep < 3) return null;
    if (
      selectedProduct !== '5 KG - Godown' &&
      selectedProduct !== '5 KG - Office'
    )
      return null;

    const { godownFullDelta, godownEmptyDelta, officeFullDelta, officeEmptyDelta } =
      calcTransferImpact();

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

            {/* Type Toggle */}
            <Text style={styles.label}>Cylinder Type</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  transfer.type === 'full' && styles.toggleButtonSelected,
                ]}
                onPress={() => updateTransfer(index, 'type', 'full')}
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    transfer.type === 'full' && styles.toggleButtonTextSelected,
                  ]}
                >
                  Full
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  transfer.type === 'empty' && styles.toggleButtonSelected,
                ]}
                onPress={() => updateTransfer(index, 'type', 'empty')}
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    transfer.type === 'empty' && styles.toggleButtonTextSelected,
                  ]}
                >
                  Empty
                </Text>
              </TouchableOpacity>
            </View>

            {/* Direction Toggle */}
            <Text style={[styles.label, { marginTop: 12 }]}>Direction</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  styles.toggleButtonWide,
                  transfer.direction === 'godown_to_office' &&
                    styles.toggleButtonSelected,
                ]}
                onPress={() =>
                  updateTransfer(index, 'direction', 'godown_to_office')
                }
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    transfer.direction === 'godown_to_office' &&
                      styles.toggleButtonTextSelected,
                  ]}
                >
                  Godown → Office
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleButton,
                  styles.toggleButtonWide,
                  transfer.direction === 'office_to_godown' &&
                    styles.toggleButtonSelected,
                ]}
                onPress={() =>
                  updateTransfer(index, 'direction', 'office_to_godown')
                }
              >
                <Text
                  style={[
                    styles.toggleButtonText,
                    transfer.direction === 'office_to_godown' &&
                      styles.toggleButtonTextSelected,
                  ]}
                >
                  Office → Godown
                </Text>
              </TouchableOpacity>
            </View>

            {/* Quantity */}
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

        {/* Transfer Impact Preview */}
        {transfers.length > 0 && (
          <View style={styles.impactCard}>
            <Text style={styles.impactTitle}>Transfer Impact</Text>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Godown Full:</Text>
              <Text
                style={[
                  styles.impactValue,
                  { color: godownFullDelta >= 0 ? '#27ae60' : '#e74c3c' },
                ]}
              >
                {godownFullDelta >= 0 ? '+' : ''}
                {godownFullDelta}
              </Text>
            </View>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Godown Empty:</Text>
              <Text
                style={[
                  styles.impactValue,
                  { color: godownEmptyDelta >= 0 ? '#27ae60' : '#e74c3c' },
                ]}
              >
                {godownEmptyDelta >= 0 ? '+' : ''}
                {godownEmptyDelta}
              </Text>
            </View>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Office Full:</Text>
              <Text
                style={[
                  styles.impactValue,
                  { color: officeFullDelta >= 0 ? '#27ae60' : '#e74c3c' },
                ]}
              >
                {officeFullDelta >= 0 ? '+' : ''}
                {officeFullDelta}
              </Text>
            </View>
            <View style={styles.impactRow}>
              <Text style={styles.impactLabel}>Office Empty:</Text>
              <Text
                style={[
                  styles.impactValue,
                  { color: officeEmptyDelta >= 0 ? '#27ae60' : '#e74c3c' },
                ]}
              >
                {officeEmptyDelta >= 0 ? '+' : ''}
                {officeEmptyDelta}
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
            style={styles.nextButton}
            onPress={() => setCurrentStep(4)}
          >
            <Text style={styles.nextButtonText}>Next</Text>
            <Ionicons name="arrow-forward" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Render Borrow/Give Step ────────────────────────────────────────────────

  const getBorrowStep = () => {
    if (
      selectedProduct === '5 KG - Godown' ||
      selectedProduct === '5 KG - Office'
    )
      return 4;
    return 3;
  };

  const renderBorrowStep = () => {
    const borrowStep = getBorrowStep();
    if (currentStep < borrowStep) return null;

    return (
      <View style={styles.card}>
        <StepHeader step={borrowStep} title="Borrow / Give Cylinders (Optional)" />

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
                  keyboardType="numeric"
                  value={entry.full_qty}
                  onChangeText={(v) => updateBorrowEntry(index, 'full_qty', v)}
                />
                <Text style={styles.hintText}>
                  + Borrowed / - Given
                </Text>
              </View>

              <View style={styles.halfInput}>
                <Text style={[styles.label, { marginTop: 12 }]}>
                  Empty Cylinders
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="+/- 0"
                  keyboardType="numeric"
                  value={entry.empty_qty}
                  onChangeText={(v) => updateBorrowEntry(index, 'empty_qty', v)}
                />
                <Text style={styles.hintText}>
                  + Borrowed / - Given
                </Text>
              </View>
            </View>
          </View>
        ))}

        {/* Remarks Preview */}
        {borrowEntries.length > 0 && buildRemarksString(borrowEntries) && (
          <View style={styles.remarksPreview}>
            <Text style={styles.remarksPreviewLabel}>Remarks Preview:</Text>
            <Text style={styles.remarksPreviewText}>
              {buildRemarksString(borrowEntries)}
            </Text>
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
            style={styles.nextButton}
            onPress={() => setShowConfirmModal(true)}
          >
            <Text style={styles.nextButtonText}>Review & Save</Text>
            <Ionicons name="checkmark-circle" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Confirm Modal ─────────────────────────────────────────────────────────

  const renderConfirmModal = () => {
    const { closingFull, closingEmpty, remarks, borrowedFull, borrowedEmpty } =
      getFinalNumbers();

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
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>📦 Full Cylinders</Text>

                {selectedProduct === '14.2 KG Cylinder' && stock142 && (
                  <>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>Opening Full:</Text>
                      <Text style={styles.modalValue}>{stock142.opening_full}</Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>+ Received from Plant:</Text>
                      <Text style={styles.modalValue}>
                        {parseInt(receivedFromPlant142, 10) || 0}
                      </Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>- Delivered:</Text>
                      <Text style={styles.modalValue}>{stock142.total_refill}</Text>
                    </View>
                  </>
                )}

                {selectedProduct === '19 KG Cylinder' && stock19 && (
                  <>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>Opening Full:</Text>
                      <Text style={styles.modalValue}>{stock19.opening_full}</Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>+ From BPCL:</Text>
                      <Text style={styles.modalValue}>
                        {parseInt(receivedFromPlant19, 10) || 0}
                      </Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>- Delivered:</Text>
                      <Text style={styles.modalValue}>{stock19.cylinder_delivered}</Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>- New Connections:</Text>
                      <Text style={styles.modalValue}>
                        {parseInt(newConnection19, 10) || 0}
                      </Text>
                    </View>
                  </>
                )}

                {borrowedFull !== 0 && (
                  <View style={styles.modalRow}>
                    <Text style={styles.modalLabel}>± Borrow/Give Full:</Text>
                    <Text
                      style={[
                        styles.modalValue,
                        { color: borrowedFull > 0 ? '#27ae60' : '#e74c3c' },
                      ]}
                    >
                      {borrowedFull > 0 ? '+' : ''}
                      {borrowedFull}
                    </Text>
                  </View>
                )}

                <View style={[styles.modalRow, styles.modalRowFinal]}>
                  <Text style={styles.modalLabelBold}>Closing Full:</Text>
                  <Text
                    style={[
                      styles.modalValueBold,
                      { color: closingFull < 0 ? '#e74c3c' : BPCL_BLUE },
                    ]}
                  >
                    {closingFull}
                  </Text>
                </View>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🔵 Empty Cylinders</Text>

                {selectedProduct === '14.2 KG Cylinder' && stock142 && (
                  <>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>Opening Empty:</Text>
                      <Text style={styles.modalValue}>{stock142.opening_empty}</Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>+ Empty Received:</Text>
                      <Text style={styles.modalValue}>{stock142.total_refill}</Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>- Sent to Plant:</Text>
                      <Text style={styles.modalValue}>
                        {parseInt(emptyToPlant142, 10) || 0}
                      </Text>
                    </View>
                  </>
                )}

                {selectedProduct === '19 KG Cylinder' && stock19 && (
                  <>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>Opening Empty:</Text>
                      <Text style={styles.modalValue}>{stock19.opening_empty}</Text>
                    </View>
                    <View style={styles.modalRow}>
                      <Text style={styles.modalLabel}>+ Empty Received:</Text>
                      <Text style={styles.modalValue}>{stock19.empty_received}</Text>
                    </View>
                  </>
                )}

                {borrowedEmpty !== 0 && (
                  <View style={styles.modalRow}>
                    <Text style={styles.modalLabel}>± Borrow/Give Empty:</Text>
                    <Text
                      style={[
                        styles.modalValue,
                        { color: borrowedEmpty > 0 ? '#27ae60' : '#e74c3c' },
                      ]}
                    >
                      {borrowedEmpty > 0 ? '+' : ''}
                      {borrowedEmpty}
                    </Text>
                  </View>
                )}

                <View style={[styles.modalRow, styles.modalRowFinal]}>
                  <Text style={styles.modalLabelBold}>Closing Empty:</Text>
                  <Text
                    style={[
                      styles.modalValueBold,
                      { color: closingEmpty < 0 ? '#e74c3c' : BPCL_BLUE },
                    ]}
                  >
                    {closingEmpty}
                  </Text>
                </View>
              </View>

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
                  style={[styles.modalConfirmButton, saving && styles.buttonDisabled]}
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

  // ─── Main Render ───────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Dropdown ─────────────────────────────────────────────────────── */}
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
                  '5 KG - Godown',
                  '5 KG - Office',
                ] as Product[]
              ).map((product) => (
                <TouchableOpacity
                  key={product}
                  style={[
                    styles.dropdownItem,
                    selectedProduct === product && styles.dropdownItemSelected,
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

        {/* ── Steps ────────────────────────────────────────────────────────── */}
        {renderStep1()}
        {renderStep2()}
        {renderStep3Transfer()}
        {renderBorrowStep()}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Confirm Modal ─────────────────────────────────────────────────── */}
      {renderConfirmModal()}
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollView: {
    flex: 1,
  },

  // ── Dropdown ────────────────────────────────────────────────────────────────
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

  // ── Step Header ─────────────────────────────────────────────────────────────
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

  // ── Cards ───────────────────────────────────────────────────────────────────
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

  // ── Form Elements ───────────────────────────────────────────────────────────
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
    marginTop: 4,
    fontStyle: 'italic',
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfInput: {
    flex: 1,
  },

  // ── Calc Rows ───────────────────────────────────────────────────────────────
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginBottom: 12,
  },

  // ── Buttons ─────────────────────────────────────────────────────────────────
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

  // ── Transfer ────────────────────────────────────────────────────────────────
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

  // ── Borrow ──────────────────────────────────────────────────────────────────
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

  // ── Modal ───────────────────────────────────────────────────────────────────
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
  modalHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
    marginTop: 8,
  },
  modalSubtitle: {
    fontSize: 14,
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