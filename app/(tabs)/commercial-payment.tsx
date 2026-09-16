// app/(tabs)/commercial-payment.tsx

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Modal,
  Switch,
  RefreshControl,
} from 'react-native';
import { useDataStore } from '@/store/dataStore';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';

const BPCL_BLUE = '#017DC5';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i);

const BANK_OPTIONS = [
  { value: 'AUB', label: 'AKOLA URBAN BANK', icon: '🏦' },
  { value: 'ARVIND', label: 'ARVIND CO-OPERATIVE BANK', icon: '🏦' },
  { value: 'HDFC', label: 'HDFC BANK', icon: '🏦' },
  { value: 'SBI', label: 'SBI BANK', icon: '🏦' },
];

// ─── Types ────────────────────────────────────────────────────────────────────
interface PendingRow {
  id: string;
  delivery_date: string;
  actual_rate: number;
  discounted_rate: number;
  quantity: number;   // editable
  rate: number;       // editable (starts as actual or discounted)
  amount: number;     // quantity × rate
  checked: boolean;
}

interface TodayPayment {
  id: string;
  transaction_date: string;
  customer_name: string;
  bank_name: string;
  quantity: number;
  amount: number;
  remarks: string;
}

// Row from dashboard_otherbankentries — category = 'COMMERCIAL_PAYMENT', is_processed = false
// NOTE: source table's date column is `statement_date` — the store function
// (getUnprocessedBankEntries) maps it to `date` before returning, so this
// screen can stay agnostic to the underlying column name.
// NOTE: `narration` maps directly to dashboard_otherbankentries.narration —
// the store function selects it as-is (no renaming needed, unlike statement_date).
interface BankEntry {
  id: string;
  date: string;
  amount: number;
  category: string;
  account_no?: string | null;
  narration?: string | null;
  is_processed?: boolean;
}

type EntryMode = 'manual' | 'bank';

// ─── Component ───────────────────────────────────────────────────────────────
export default function CommercialBankPaymentScreen() {
  const {
    loadCommercialCustomers,
    loadCommercialRates,
    getPendingCommercialRecords,
    addCommercialBankPayment,
    updateCommercialRecordsPayment,
    updateBankBalance,
    getCommercialPaymentsByDate,
    // ── New store functions (see dataStore additions below) ──
    getUnprocessedBankEntries,
    markBankEntryProcessed,
    checkCommercialBankPaymentExists,
    commercialCustomers = [],
    commercialRates = [],
    loadingCommercialCustomers,
    loadDiscountSetting,
  } = useDataStore();

  // ── Step 1: Payment received date ────────────────────────────────────────
  const [paymentDate, setPaymentDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [todayPayments, setTodayPayments] = useState<TodayPayment[]>([]);
  const [loadingTodayPayments, setLoadingTodayPayments] = useState(false);
  const [visiblePaymentsLimit, setVisiblePaymentsLimit] = useState<2 | 5 | 'all'>(2);

  // ── Step 1b: Entry mode — Manual vs Bank Entry ───────────────────────────
  const [entryMode, setEntryMode] = useState<EntryMode>('manual');
  const [unprocessedBankEntries, setUnprocessedBankEntries] = useState<BankEntry[]>([]);
  const [loadingBankEntries, setLoadingBankEntries] = useState(false);
  const [selectedBankEntry, setSelectedBankEntry] = useState<BankEntry | null>(null);
  const [bankEntryDropdownOpen, setBankEntryDropdownOpen] = useState(false);
  const [quickTransferring, setQuickTransferring] = useState(false);
  const [skippingEntry, setSkippingEntry] = useState(false);

  // ── Step 2: Customer ──────────────────────────────────────────────────────
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [selectedCustomerData, setSelectedCustomerData] = useState<any>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);

  // ── Step 3: Month / Year periods + Discount ─────────────────────────────
  const [periods, setPeriods] = useState([
    { month: new Date().getMonth(), year: CURRENT_YEAR, monthOpen: false, yearOpen: false },
  ]);
  const [discountChecked, setDiscountChecked] = useState(false);

  // Round Figure Mode States
  const [roundOffEnabled, setRoundOffEnabled] = useState(false);
  const [roundOffAmount, setRoundOffAmount] = useState('');

  const addPeriod = () => {
    setPeriods(prev => [
      ...prev,
      { month: new Date().getMonth(), year: CURRENT_YEAR, monthOpen: false, yearOpen: false },
    ]);
  };

  const removePeriod = (idx: number) => {
    setPeriods(prev => prev.filter((_, i) => i !== idx));
  };

  const updatePeriod = (idx: number, field: 'month' | 'year', val: number) => {
    setPeriods(prev => prev.map((p, i) =>
      i === idx ? { ...p, [field]: val, monthOpen: false, yearOpen: false } : p
    ));
  };

  const togglePeriodDropdown = (idx: number, field: 'monthOpen' | 'yearOpen') => {
    setPeriods(prev => prev.map((p, i) => {
      if (i === idx) return { ...p, monthOpen: field === 'monthOpen' ? !p.monthOpen : false, yearOpen: field === 'yearOpen' ? !p.yearOpen : false };
      return { ...p, monthOpen: false, yearOpen: false };
    }));
  };

  // ── Step 4: Pending rows ──────────────────────────────────────────────────
  const [pendingRows, setPendingRows] = useState<PendingRow[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);

  // ── Step 5: Bank + Submit ─────────────────────────────────────────────────
  const [selectedBank, setSelectedBank] = useState('');
  const [bankDropdownOpen, setBankDropdownOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Confirm modal ────────────────────────────────────────────────────────
  const [confirmVisible, setConfirmVisible] = useState(false);

  // ── Pull to refresh ───────────────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        loadCommercialCustomers(),
        loadCommercialRates(),
        loadDiscountSetting(),
        fetchTodayPayments(),
        fetchUnprocessedBankEntries(),
      ]);
      if (selectedCustomer && !roundOffEnabled) {
        await fetchPendingRecords();
      }
    } catch (e) {
      console.error('Refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  }, [selectedCustomer, periods, paymentDate, roundOffEnabled]);

  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadCommercialCustomers();
    loadCommercialRates();
    loadDiscountSetting();
  }, []);

  // Fetch today's payments whenever paymentDate changes and reset limit
  useEffect(() => {
    fetchTodayPayments();
    setVisiblePaymentsLimit(2);
  }, [paymentDate]);

  // Fetch unprocessed bank entries when Bank Entry mode is selected
  useEffect(() => {
    if (entryMode === 'bank') {
      fetchUnprocessedBankEntries();
    } else {
      setSelectedBankEntry(null);
      setBankEntryDropdownOpen(false);
    }
  }, [entryMode]);

  const fetchTodayPayments = async () => {
    setLoadingTodayPayments(true);
    try {
      const payments = await getCommercialPaymentsByDate(paymentDate);
      setTodayPayments(payments || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingTodayPayments(false);
    }
  };

  const fetchUnprocessedBankEntries = async () => {
    setLoadingBankEntries(true);
    try {
      const entries = await getUnprocessedBankEntries('COMMERCIAL_PAYMENT');
      setUnprocessedBankEntries(entries || []);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to load pending bank entries');
    } finally {
      setLoadingBankEntries(false);
    }
  };

  // Fetch pending records when customer, periods, or round-off toggle changes
  useEffect(() => {
    if (selectedCustomer && periods.length > 0 && !roundOffEnabled) {
      fetchPendingRecords();
    }
  }, [selectedCustomer, periods, roundOffEnabled]);

  // Re-apply rates when discount toggle changes
  useEffect(() => {
    if (pendingRows.length > 0 && !roundOffEnabled) applyDiscountToggle();
  }, [discountChecked]);

  const fetchPendingRecords = async () => {
    setLoadingPending(true);
    try {
      const discount = selectedCustomerData?.discount || 0;
      const allRows: PendingRow[] = [];

      for (const period of periods) {
        const fromDate = format(startOfMonth(new Date(period.year, period.month, 1)), 'yyyy-MM-dd');
        const toDate = format(endOfMonth(new Date(period.year, period.month, 1)), 'yyyy-MM-dd');

        const records = await getPendingCommercialRecords(selectedCustomer, fromDate, toDate);

        const rows: PendingRow[] = records.map((r: any) => {
          const deliveryDate = new Date(r.delivery_date);
          const applicableRate = commercialRates.find((rate: any) => {
            const start = new Date(rate.start_date);
            const end = new Date(rate.end_date);
            return deliveryDate >= start && deliveryDate <= end;
          });

          const actualRate = applicableRate ? Math.round(applicableRate.actual_rate) : 0;
          const discountedRate = discount > 0 ? Math.max(0, actualRate - discount) : actualRate;
          const effectiveRate = discountChecked ? discountedRate : actualRate;

          return {
            id: r.id,
            delivery_date: r.delivery_date,
            actual_rate: actualRate,
            discounted_rate: discountedRate,
            quantity: 1,
            rate: effectiveRate,
            amount: effectiveRate,
            checked: false,
          };
        });

        allRows.push(...rows);
      }

      allRows.sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
      setPendingRows(allRows);
    } catch (e) {
      Alert.alert('Error', 'Failed to load pending records');
      console.error(e);
    } finally {
      setLoadingPending(false);
    }
  };

  const applyDiscountToggle = () => {
    setPendingRows(prev =>
      prev.map(row => {
        const newRate = discountChecked ? row.discounted_rate : row.actual_rate;
        return { ...row, rate: newRate, amount: newRate * row.quantity };
      })
    );
  };

  // ── Row editing ───────────────────────────────────────────────────────────
  const toggleRow = (id: string) => {
    setPendingRows(prev => prev.map(r => r.id === id ? { ...r, checked: !r.checked } : r));
  };

  const updateRowQuantity = (id: string, val: string) => {
    const qty = parseInt(val) || 0;
    setPendingRows(prev => prev.map(r =>
      r.id === id ? { ...r, quantity: qty, amount: qty * r.rate } : r
    ));
  };

  const updateRowRate = (id: string, val: string) => {
    const newRate = parseFloat(val) || 0;
    setPendingRows(prev => prev.map(r => {
      if (r.checked) return { ...r, rate: newRate, amount: r.quantity * newRate };
      if (r.id === id) return { ...r, rate: newRate, amount: r.quantity * newRate };
      return r;
    }));
  };

  // ── Bank entry selection ────────────────────────────────────────────────
  const selectBankEntry = (entry: BankEntry) => {
    setSelectedBankEntry(entry);
    setBankEntryDropdownOpen(false);
    // Auto-fill the payment date from the entry — still editable via the date picker above
    if (entry.date) {
      setPaymentDate(entry.date);
    }
    // A new entry means any previously selected customer no longer applies —
    // force a fresh customer pick for this entry (Quick Transfer needs it;
    // Skip doesn't, so it's available immediately below without one).
    setSelectedCustomer('');
    setSelectedCustomerData(null);
    setCustomerSearch('');
    setCustomerDropdownOpen(false);
  };

  // ── Quick Transfer — direct copy of a bank entry into commercial_bank_payments ──
  // For entries already reconciled/entered elsewhere: skips periods, discount, and
  // pending-record selection entirely. Bank is hardcoded to HDFC BANK per current setup.
  const handleQuickTransfer = () => {
    if (!selectedBankEntry || !selectedCustomer) return;

    Alert.alert(
      'Confirm Quick Transfer',
      `Transfer ₹${Math.round(selectedBankEntry.amount)} (${format(new Date(selectedBankEntry.date + 'T00:00:00'), 'dd MMM yyyy')}) to ${selectedCustomer}'s commercial bank payments?\n\nThis does NOT mark any delivery records as paid — it only records the payment entry.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Transfer', style: 'default', onPress: doQuickTransfer },
      ]
    );
  };

  const doQuickTransfer = async () => {
    if (!selectedBankEntry || !selectedCustomer) return;
    setQuickTransferring(true);
    try {
      const entryDate = selectedBankEntry.date;
      const entryAmount = selectedBankEntry.amount;
      const remarks = selectedBankEntry.narration
        ? `${selectedCustomer} (Quick Transfer: ${selectedBankEntry.narration})`
        : `${selectedCustomer} (Quick Transfer)`;

      // 1. Check if this payment (same customer + date + amount) already exists
      //    in commercial_bank_payments before inserting — avoids duplicate rows.
      const alreadyExists = await checkCommercialBankPaymentExists(
        selectedCustomer,
        entryDate,
        entryAmount,
      );

      if (!alreadyExists) {
        await addCommercialBankPayment({
          transaction_date: entryDate,
          received_from_date: entryDate,
          received_to_date: entryDate,
          customer_name: selectedCustomer,
          bank_name: 'HDFC',
          rate: entryAmount,
          quantity: 1,
          amount: entryAmount,
          remarks,
          round_off_value: true,
        });
      }

      // 2. Mark the source bank entry as processed either way — whether we just
      //    inserted it, or it was already there. This is what stops the entry
      //    from reappearing in the dropdown on every load.
      await markBankEntryProcessed(selectedBankEntry.id);

      Alert.alert(
        'Success',
        alreadyExists
          ? `Record already existed for ${selectedCustomer} — entry marked as processed, no duplicate created.`
          : `₹${Math.round(entryAmount)} transferred to ${selectedCustomer}.`
      );

      setSelectedBankEntry(null);
      fetchUnprocessedBankEntries();
      fetchTodayPayments();
    } catch (e) {
      Alert.alert('Error', 'Quick transfer failed');
      console.error(e);
    } finally {
      setQuickTransferring(false);
    }
  };

  // ── Skip — mark the bank entry processed without writing anything to
  //    commercial_bank_payments. For entries that shouldn't be recorded at
  //    all (e.g. not actually a commercial payment, entered elsewhere already
  //    under a different flow, etc). Just removes it from the dropdown.
  const handleSkipBankEntry = () => {
    if (!selectedBankEntry) return;
    Alert.alert(
      'Skip Entry',
      `Skip this entry (₹${Math.round(selectedBankEntry.amount)} on ${format(new Date(selectedBankEntry.date + 'T00:00:00'), 'dd MMM yyyy')})?\n\nNothing will be written to Commercial Bank Payments — it will just be marked as processed and removed from this list.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Skip', style: 'destructive', onPress: doSkipBankEntry },
      ]
    );
  };

  const doSkipBankEntry = async () => {
    if (!selectedBankEntry) return;
    setSkippingEntry(true);
    try {
      await markBankEntryProcessed(selectedBankEntry.id);
      setSelectedBankEntry(null);
      fetchUnprocessedBankEntries();
    } catch (e) {
      Alert.alert('Error', 'Failed to skip entry');
      console.error(e);
    } finally {
      setSkippingEntry(false);
    }
  };

  // ── Display list processing for today's payments ──────────────────────────
  const getDisplayedTodayPayments = () => {
    const sorted = [...todayPayments].reverse(); // newest first
    if (visiblePaymentsLimit === 2) {
      return sorted.slice(0, 2);
    }
    if (visiblePaymentsLimit === 5) {
      return sorted.slice(0, 5);
    }
    return sorted.filter(p => p.transaction_date >= '2025-01-01');
  };

  const displayedTodayPayments = getDisplayedTodayPayments();

  // ── Totals ────────────────────────────────────────────────────────────
  const checkedRows = pendingRows.filter(r => r.checked);

  const totalQuantity = roundOffEnabled
    ? 1
    : checkedRows.reduce((s, r) => s + r.quantity, 0);

  const totalAmount = roundOffEnabled
    ? (parseFloat(roundOffAmount) || 0)
    : checkedRows.reduce((s, r) => s + r.amount, 0);

  const bankEntryAmount = selectedBankEntry?.amount ?? 0;
  const bankEntryDifference = totalAmount - bankEntryAmount;

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    if (!selectedCustomer) return Alert.alert('Error', 'Please select a customer');
    if (!selectedBank) return Alert.alert('Error', 'Please select a bank');
    if (entryMode === 'bank' && !selectedBankEntry) {
      return Alert.alert('Error', 'Please select a bank entry from the list');
    }

    if (roundOffEnabled) {
      if (totalAmount <= 0) return Alert.alert('Error', 'Please enter a valid round figure amount');
    } else {
      if (checkedRows.length === 0) return Alert.alert('Error', 'Select at least one record');
      if (totalAmount <= 0) return Alert.alert('Error', 'Total amount must be greater than 0');
    }
    setConfirmVisible(true);
  };

  // Save changes to database
  const handleConfirmPayment = async () => {
    setConfirmVisible(false);
    setSubmitting(true);
    try {
      const fromDate = roundOffEnabled
        ? '1990-01-01'
        : format(startOfMonth(new Date(periods[0].year, periods[0].month, 1)), 'yyyy-MM-dd');
      const toDate = roundOffEnabled
        ? '1990-01-01'
        : format(endOfMonth(new Date(periods[periods.length - 1].year, periods[periods.length - 1].month, 1)), 'yyyy-MM-dd');

      const periodLabel = periods.map(p => `${MONTHS[p.month]} ${p.year}`).join(', ');
      const remarks = roundOffEnabled
        ? `${selectedCustomer} (Direct Round-off)`
        : `${selectedCustomer} ${periodLabel}`;

      const avgRate = roundOffEnabled
        ? totalAmount
        : totalQuantity > 0 ? parseFloat((totalAmount / totalQuantity).toFixed(2)) : 0;

      // 0. Check if a matching payment (same customer + date + amount) already
      //    exists in commercial_bank_payments — avoids duplicate rows and
      //    double-applying the delivery-record / bank-balance updates below.
      const alreadyExists = await checkCommercialBankPaymentExists(
        selectedCustomer,
        paymentDate,
        totalAmount,
      );

      if (!alreadyExists) {
        // 1. Insert payment record
        await addCommercialBankPayment({
          transaction_date: paymentDate,
          received_from_date: fromDate,
          received_to_date: toDate,
          customer_name: selectedCustomer,
          bank_name: selectedBank,
          rate: avgRate,
          quantity: totalQuantity,
          amount: totalAmount,
          remarks,
          round_off_value: roundOffEnabled,
        });

        // 2. Mark delivery records as paid (Only in Standard mode)
        if (!roundOffEnabled && checkedRows.length > 0) {
          const ids = checkedRows.map(r => r.id);
          const rateForRecords = checkedRows[0]?.rate ?? avgRate;
          await updateCommercialRecordsPayment(ids, paymentDate, Math.round(rateForRecords));
        }

        // 3. Update bank balance
        await updateBankBalance(selectedBank, paymentDate, totalAmount, remarks);
      }

      // 4. If this payment came from a Bank Entry, mark it processed either way —
      //    whether we just inserted it, or it already existed. This is what stops
      //    the entry from reappearing in the "remaining bank entries" dropdown.
      if (entryMode === 'bank' && selectedBankEntry) {
        await markBankEntryProcessed(selectedBankEntry.id);
      }

      Alert.alert(
        'Success',
        alreadyExists
          ? `Record already existed for ${selectedCustomer} — entry marked as processed, no duplicate created.`
          : `Payment recorded!\nCustomer: ${selectedCustomer}\nQty: ${totalQuantity} cylinders\nTotal: ₹${Math.round(totalAmount)}`
      );

      resetForm();
      fetchTodayPayments();
      if (entryMode === 'bank') {
        fetchUnprocessedBankEntries();
      }
    } catch (e) {
      Alert.alert('Error', 'Failed to save payment');
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setSelectedCustomer('');
    setSelectedCustomerData(null);
    setSelectedBank('');
    setPendingRows([]);
    setDiscountChecked(false);
    setCustomerSearch('');
    setRoundOffEnabled(false);
    setRoundOffAmount('');
    setSelectedBankEntry(null);
  };

  const filteredCustomers = (commercialCustomers || []).filter((c: any) =>
    c?.name?.toUpperCase().includes(customerSearch.toUpperCase())
  );

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[BPCL_BLUE]}
            tintColor={BPCL_BLUE}
            title="Refreshing..."
            titleColor={BPCL_BLUE}
          />
        }
      >

        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Commercial Bank Payment</Text>
          <Text style={styles.headerSubtitle}>Record online payments by customer</Text>
        </View>

        {/* ════════════════════════════════════════
            STEP 1 — Payment Received Date
        ════════════════════════════════════════ */}
        <View style={styles.stepCard}>
          <View style={styles.stepLabelRow}>
            <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>1</Text></View>
            <Text style={styles.stepTitle}>Payment Received Date</Text>
          </View>

          <TouchableOpacity style={styles.dateButton} onPress={() => setShowDatePicker(true)}>
            <Ionicons name="calendar-outline" size={20} color={BPCL_BLUE} />
            <Text style={styles.dateButtonText}>
              {format(new Date(paymentDate + 'T00:00:00'), 'dd MMM yyyy')}
            </Text>
            <Ionicons name="chevron-down" size={16} color="#666" />
          </TouchableOpacity>

          {/* Entry mode — Manual vs Bank Entry */}
          <Text style={styles.label}>Entry Type</Text>
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[styles.modeBtn, entryMode === 'manual' && styles.modeBtnActive]}
              onPress={() => setEntryMode('manual')}
              activeOpacity={0.8}
            >
              <Ionicons
                name="create-outline"
                size={16}
                color={entryMode === 'manual' ? '#fff' : BPCL_BLUE}
              />
              <Text style={[styles.modeBtnText, entryMode === 'manual' && styles.modeBtnTextActive]}>
                Manual Entry
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modeBtn, entryMode === 'bank' && styles.modeBtnActive]}
              onPress={() => setEntryMode('bank')}
              activeOpacity={0.8}
            >
              <Ionicons
                name="business-outline"
                size={16}
                color={entryMode === 'bank' ? '#fff' : BPCL_BLUE}
              />
              <Text style={[styles.modeBtnText, entryMode === 'bank' && styles.modeBtnTextActive]}>
                Bank Entry
              </Text>
            </TouchableOpacity>
          </View>

          {/* Remaining Bank Entries dropdown — only in Bank Entry mode */}
          {entryMode === 'bank' && (
            <View style={styles.bankEntrySection}>
              <Text style={styles.label}>Select Remaining Bank Entry *</Text>

              <TouchableOpacity
                style={styles.dropdownButton}
                onPress={() => setBankEntryDropdownOpen(!bankEntryDropdownOpen)}
              >
                <Text
                  style={[styles.dropdownButtonText, !selectedBankEntry && styles.dropdownPlaceholder]}
                  numberOfLines={1}
                >
                  {selectedBankEntry
                    ? `${format(new Date(selectedBankEntry.date + 'T00:00:00'), 'dd MMM yyyy')}  —  ₹${Math.round(selectedBankEntry.amount)}${selectedBankEntry.narration ? '  —  ' + selectedBankEntry.narration : ''}`
                    : loadingBankEntries
                      ? 'Loading entries...'
                      : unprocessedBankEntries.length === 0
                        ? 'No pending bank entries'
                        : 'Select bank entry...'}
                </Text>
                <Ionicons name={bankEntryDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
              </TouchableOpacity>

              {bankEntryDropdownOpen && (
                <View style={styles.dropdownList}>
                  {loadingBankEntries ? (
                    <ActivityIndicator color={BPCL_BLUE} style={{ padding: 20 }} />
                  ) : unprocessedBankEntries.length === 0 ? (
                    <Text style={styles.emptyText}>No unprocessed COMMERCIAL_PAYMENT entries.</Text>
                  ) : (
                    <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {unprocessedBankEntries.map((entry) => (
                        <TouchableOpacity
                          key={entry.id}
                          style={[
                            styles.dropdownItem,
                            selectedBankEntry?.id === entry.id && styles.dropdownItemSelected,
                          ]}
                          onPress={() => selectBankEntry(entry)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[
                              styles.dropdownItemText,
                              selectedBankEntry?.id === entry.id && styles.dropdownItemTextSelected,
                            ]}>
                              {format(new Date(entry.date + 'T00:00:00'), 'dd MMM yyyy')}
                            </Text>
                            <Text style={[
                              styles.discountHint,
                              selectedBankEntry?.id === entry.id && { color: 'rgba(255,255,255,0.8)' },
                            ]}>
                              Amount: ₹{Math.round(entry.amount)}
                            </Text>
                            {entry.narration ? (
                              <Text
                                style={[
                                  styles.discountHint,
                                  selectedBankEntry?.id === entry.id && { color: 'rgba(255,255,255,0.8)' },
                                ]}
                                numberOfLines={2}
                              >
                                {entry.narration}
                              </Text>
                            ) : null}
                          </View>
                          {selectedBankEntry?.id === entry.id && (
                            <Ionicons name="checkmark" size={16} color="#fff" />
                          )}
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  )}
                </View>
              )}

              {selectedBankEntry && (
                <>
                  <Text style={styles.bankEntryHint}>
                    Date above has been set from this entry. Adjust it using the date picker if it's incorrect.
                  </Text>

                  <TouchableOpacity
                    style={[styles.step1SkipBtn, skippingEntry && styles.submitButtonDisabled]}
                    onPress={handleSkipBankEntry}
                    disabled={skippingEntry}
                    activeOpacity={0.8}
                  >
                    {skippingEntry ? (
                      <ActivityIndicator color="#b91c1c" size="small" />
                    ) : (
                      <>
                        <Ionicons name="close-circle-outline" size={16} color="#b91c1c" />
                        <Text style={styles.step1SkipBtnText}>Skip This Entry (no customer needed)</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}

          {/* Today's payments for this date */}
          <View style={styles.todaySection}>
            <View style={styles.todaySectionHeader}>
              <Ionicons name="receipt-outline" size={16} color="#6b7280" />
              <Text style={styles.todaySectionTitle}>
                Payments on this date ({todayPayments.length})
              </Text>
            </View>

            {loadingTodayPayments ? (
              <ActivityIndicator color={BPCL_BLUE} style={{ padding: 10 }} />
            ) : todayPayments.length === 0 ? (
              <Text style={styles.emptyText}>No payments recorded yet for this date.</Text>
            ) : (
              <>
                <View style={styles.todayTable}>
                  {/* Header row */}
                  <View style={[styles.todayRow, styles.todayRowHeader]}>
                    <Text style={[styles.todayCell, styles.todayCellHeader, { flex: 2 }]}>Customer</Text>
                    <Text style={[styles.todayCell, styles.todayCellHeader, { flex: 1.2 }]}>Bank</Text>
                    <Text style={[styles.todayCell, styles.todayCellHeader, { flex: 0.8 }]}>Qty</Text>
                    <Text style={[styles.todayCell, styles.todayCellHeader, { flex: 1 }]}>Amount</Text>
                  </View>
                  {displayedTodayPayments.map((p) => (
                    <View key={p.id} style={styles.todayRow}>
                      <Text style={[styles.todayCell, { flex: 2 }]} numberOfLines={1}>{p.customer_name}</Text>
                      <Text style={[styles.todayCell, { flex: 1.2 }]}>{p.bank_name}</Text>
                      <Text style={[styles.todayCell, { flex: 0.8 }]}>{p.quantity}</Text>
                      <Text style={[styles.todayCell, styles.todayAmountCell, { flex: 1 }]}>₹{p.amount}</Text>
                    </View>
                  ))}
                  {/* Total row */}
                  <View style={[styles.todayRow, styles.todayTotalRow]}>
                    <Text style={[styles.todayCell, styles.todayTotalLabel, { flex: 3.2 }]}>Total (Shown)</Text>
                    <Text style={[styles.todayCell, styles.todayTotalLabel, { flex: 0.8 }]}>
                      {displayedTodayPayments.reduce((s, p) => s + p.quantity, 0)}
                    </Text>
                    <Text style={[styles.todayCell, styles.todayTotalAmount, { flex: 1 }]}>
                      ₹{displayedTodayPayments.reduce((s, p) => s + p.amount, 0)}
                    </Text>
                  </View>
                </View>

                {/* Show More Pagination Elements */}
                {todayPayments.length > displayedTodayPayments.length && (
                  <TouchableOpacity
                    style={styles.showMoreBtn}
                    onPress={() => {
                      if (visiblePaymentsLimit === 2) {
                        setVisiblePaymentsLimit(5);
                      } else if (visiblePaymentsLimit === 5) {
                        setVisiblePaymentsLimit('all');
                      }
                    }}
                  >
                    <Text style={styles.showMoreBtnText}>
                      {visiblePaymentsLimit === 2 ? 'Show More (+3)' : 'Show All (On/After 01-01-2025)'}
                    </Text>
                    <Ionicons name="chevron-down" size={14} color={BPCL_BLUE} />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>

        {/* ════════════════════════════════════════
            STEP 2 — Select Customer
        ════════════════════════════════════════ */}
        <View style={styles.stepCard}>
          <View style={styles.stepLabelRow}>
            <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>2</Text></View>
            <Text style={styles.stepTitle}>Select Customer</Text>
          </View>

          <TouchableOpacity
            style={styles.dropdownButton}
            onPress={() => { setCustomerDropdownOpen(!customerDropdownOpen); setCustomerSearch(''); }}
          >
            <Text style={[styles.dropdownButtonText, !selectedCustomer && styles.dropdownPlaceholder]}>
              {selectedCustomer || 'Select customer...'}
            </Text>
            <Ionicons name={customerDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
          </TouchableOpacity>

          {customerDropdownOpen && (
            <View style={styles.dropdownList}>
              <TextInput
                style={styles.dropdownSearch}
                placeholder="Search customer..."
                value={customerSearch}
                onChangeText={t => setCustomerSearch(t.toUpperCase())}
                autoCorrect={false}
              />
              <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {loadingCommercialCustomers ? (
                  <ActivityIndicator color={BPCL_BLUE} style={{ padding: 20 }} />
                ) : filteredCustomers.map((c: any) => (
                  <TouchableOpacity
                    key={c.name}
                    style={[styles.dropdownItem, selectedCustomer === c.name && styles.dropdownItemSelected]}
                    onPress={() => {
                      setSelectedCustomer(c.name);
                      setSelectedCustomerData(c);
                      setCustomerDropdownOpen(false);
                      setCustomerSearch('');
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.dropdownItemText, selectedCustomer === c.name && styles.dropdownItemTextSelected]}>
                        {c.name}
                      </Text>
                      {c.discount > 0 && (
                        <Text style={[styles.discountHint, selectedCustomer === c.name && { color: 'rgba(255,255,255,0.8)' }]}>
                          Discount: ₹{c.discount}
                        </Text>
                      )}
                    </View>
                    {selectedCustomer === c.name && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Quick Transfer — only when a Bank Entry is selected AND a customer is picked.
              Bypasses periods/discount/pending-records entirely: writes the bank entry
              straight into commercial_bank_payments as-is (already reconciled elsewhere). */}
          {entryMode === 'bank' && selectedBankEntry && selectedCustomer && (
            <View style={styles.quickTransferBox}>
              <View style={styles.quickTransferHeader}>
                <Ionicons name="flash-outline" size={16} color="#b45309" />
                <Text style={styles.quickTransferTitle}>Quick Transfer</Text>
              </View>
              <Text style={styles.quickTransferHint}>
                Skips periods, discount &amp; pending records — copies this bank entry
                straight into Commercial Bank Payments for{' '}
                <Text style={{ fontWeight: '700' }}>{selectedCustomer}</Text>.
              </Text>
              <View style={styles.quickTransferDetailRow}>
                <Text style={styles.quickTransferDetailLabel}>Date</Text>
                <Text style={styles.quickTransferDetailValue}>
                  {format(new Date(selectedBankEntry.date + 'T00:00:00'), 'dd MMM yyyy')}
                </Text>
              </View>
              <View style={styles.quickTransferDetailRow}>
                <Text style={styles.quickTransferDetailLabel}>Amount</Text>
                <Text style={styles.quickTransferDetailValue}>₹{Math.round(selectedBankEntry.amount)}</Text>
              </View>
              <View style={styles.quickTransferDetailRow}>
                <Text style={styles.quickTransferDetailLabel}>Bank</Text>
                <Text style={styles.quickTransferDetailValue}>HDFC BANK</Text>
              </View>

              <TouchableOpacity
                style={[styles.quickTransferBtn, styles.quickTransferBtnFull, quickTransferring && styles.submitButtonDisabled]}
                onPress={handleQuickTransfer}
                disabled={quickTransferring}
                activeOpacity={0.8}
              >
                {quickTransferring ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="checkmark-circle" size={18} color="#fff" />
                    <Text style={styles.quickTransferBtnText}>Confirm Quick Transfer</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ════════════════════════════════════════
            STEP 3 — Month / Year + Discount + Round-Off
        ════════════════════════════════════════ */}
        <View style={styles.stepCard}>
          <View style={styles.stepLabelRow}>
            <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>3</Text></View>
            <Text style={styles.stepTitle}>Select Month & Year</Text>
          </View>

          {periods.map((period, idx) => (
            <View key={idx}>
              {/* Period label */}
              <View style={styles.periodLabelRow}>
                <Text style={styles.periodLabel}>Period {idx + 1}</Text>
                {idx > 0 && (
                  <TouchableOpacity style={styles.periodRemoveBtn} onPress={() => removePeriod(idx)}>
                    <Ionicons name="close-circle" size={20} color="#ef4444" />
                    <Text style={styles.periodRemoveText}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.monthYearRow}>
                {/* Month dropdown */}
                <View style={{ flex: 1.4 }}>
                  <TouchableOpacity
                    style={styles.dropdownButton}
                    onPress={() => togglePeriodDropdown(idx, 'monthOpen')}
                  >
                    <Text style={styles.dropdownButtonText}>{MONTHS[period.month]}</Text>
                    <Ionicons name={period.monthOpen ? 'chevron-up' : 'chevron-down'} size={18} color={BPCL_BLUE} />
                  </TouchableOpacity>
                  {period.monthOpen && (
                    <View style={[styles.dropdownList, { zIndex: 100 }]}>
                      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {MONTHS.map((m, i) => (
                          <TouchableOpacity
                            key={m}
                            style={[styles.dropdownItem, period.month === i && styles.dropdownItemSelected]}
                            onPress={() => updatePeriod(idx, 'month', i)}
                          >
                            <Text style={[styles.dropdownItemText, period.month === i && styles.dropdownItemTextSelected]}>
                              {m}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}
                </View>

                {/* Year dropdown */}
                <View style={{ flex: 1 }}>
                  <TouchableOpacity
                    style={styles.dropdownButton}
                    onPress={() => togglePeriodDropdown(idx, 'yearOpen')}
                  >
                    <Text style={styles.dropdownButtonText}>{period.year}</Text>
                    <Ionicons name={period.yearOpen ? 'chevron-up' : 'chevron-down'} size={18} color={BPCL_BLUE} />
                  </TouchableOpacity>
                  {period.yearOpen && (
                    <View style={[styles.dropdownList, { zIndex: 100 }]}>
                      <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {YEAR_OPTIONS.map(y => (
                          <TouchableOpacity
                            key={y}
                            style={[styles.dropdownItem, period.year === y && styles.dropdownItemSelected]}
                            onPress={() => updatePeriod(idx, 'year', y)}
                          >
                            <Text style={[styles.dropdownItemText, period.year === y && styles.dropdownItemTextSelected]}>
                              {y}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}
                </View>
              </View>

              {/* Divider between periods */}
              {idx < periods.length - 1 && <View style={styles.periodDivider} />}
            </View>
          ))}

          {/* Add another month button */}
          <TouchableOpacity style={styles.addPeriodBtn} onPress={addPeriod}>
            <Ionicons name="add-circle-outline" size={20} color={BPCL_BLUE} />
            <Text style={styles.addPeriodBtnText}>Add Another Month</Text>
          </TouchableOpacity>

          {/* Discount toggle */}
          <View style={styles.discountRow}>
            <Ionicons name="pricetag-outline" size={18} color={discountChecked ? BPCL_BLUE : '#aaa'} />
            <Text style={[styles.discountLabel, discountChecked && { color: BPCL_BLUE }]}>
              Apply Discount (₹{selectedCustomerData?.discount || 0} per cylinder)
            </Text>
            <Switch
              value={discountChecked}
              onValueChange={setDiscountChecked}
              trackColor={{ false: '#ddd', true: '#b3d9f0' }}
              thumbColor={discountChecked ? BPCL_BLUE : '#f4f3f4'}
              disabled={!selectedCustomerData?.discount}
            />
          </View>

          {/* Divider */}
          <View style={styles.periodDivider} />

          {/* Round Figure Payment Toggle */}
          <View style={styles.roundOffToggleRow}>
            <Ionicons name="cash-outline" size={18} color={roundOffEnabled ? '#16a34a' : '#aaa'} />
            <Text style={[styles.roundOffLabel, roundOffEnabled && { color: '#16a34a', fontWeight: 'bold' }]}>
              OR: Record Round Figure Payment
            </Text>
            <Switch
              value={roundOffEnabled}
              onValueChange={setRoundOffEnabled}
              trackColor={{ false: '#ddd', true: '#bbf7d0' }}
              thumbColor={roundOffEnabled ? '#16a34a' : '#f4f3f4'}
            />
          </View>

          {roundOffEnabled && (
            <View style={styles.roundOffContainer}>
              <Text style={styles.roundOffHint}>
                Allows recording an arbitrary, direct payment amount. No cylinder quantities or matching rows are required.
              </Text>

              <View style={styles.roundOffInputRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.roundOffInputLabel}>Amount Received (₹) *</Text>
                  <TextInput
                    style={styles.roundOffInput}
                    placeholder="e.g. 300000"
                    keyboardType="numeric"
                    value={roundOffAmount}
                    onChangeText={setRoundOffAmount}
                  />
                </View>
              </View>
            </View>
          )}
        </View>

        {/* ════════════════════════════════════════
            STEP 4 — Pending Records List (Hidden in Round-Off Mode)
        ════════════════════════════════════════ */}
        {selectedCustomer && !roundOffEnabled && (
          <View style={styles.stepCard}>
            <View style={styles.stepLabelRow}>
              <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>4</Text></View>
              <Text style={styles.stepTitle}>Pending Deliveries</Text>
              {pendingRows.length > 0 && (
                <TouchableOpacity
                  style={[
                    styles.selectAllBtn,
                    pendingRows.every(r => r.checked) && styles.selectAllBtnActive,
                  ]}
                  onPress={() => {
                    const allSelected = pendingRows.every(r => r.checked);
                    setPendingRows(prev => prev.map(r => ({ ...r, checked: !allSelected })));
                  }}
                >
                  <Text style={[
                    styles.selectAllBtnText,
                    pendingRows.every(r => r.checked) && styles.selectAllBtnTextActive,
                  ]}>
                    {pendingRows.every(r => r.checked) ? '✓ All' : 'Select All'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {loadingPending ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <ActivityIndicator color={BPCL_BLUE} />
                <Text style={styles.emptyText}>Loading records...</Text>
              </View>
            ) : pendingRows.length === 0 ? (
              <Text style={styles.emptyText}>No pending deliveries for this month.</Text>
            ) : (
              <>
                {/* Table header */}
                <View style={styles.tableHeader}>
                  <View style={{ width: 32 }} />
                  <Text style={[styles.tableHeaderCell, { flex: 1.2 }]}>Date</Text>
                  <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Rate (₹)</Text>
                  <Text style={[styles.tableHeaderCell, { flex: 0.8 }]}>Qty</Text>
                  <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Amount</Text>
                </View>

                {pendingRows.map((row) => (
                  <View
                    key={row.id}
                    style={[styles.tableRow, row.checked && styles.tableRowChecked]}
                  >
                    {/* Checkbox */}
                    <TouchableOpacity style={styles.checkbox} onPress={() => toggleRow(row.id)}>
                      {row.checked
                        ? <Ionicons name="checkbox" size={22} color={BPCL_BLUE} />
                        : <Ionicons name="square-outline" size={22} color="#ccc" />
                      }
                    </TouchableOpacity>

                    {/* Date */}
                    <Text style={[styles.tableCell, { flex: 1.2 }]}>
                      {format(new Date(row.delivery_date + 'T00:00:00'), 'dd MMM')}
                    </Text>

                    {/* Rate — editable */}
                    <TextInput
                      style={[styles.tableCellInput, { flex: 1 }]}
                      keyboardType="numeric"
                      value={row.rate.toString()}
                      onChangeText={v => updateRowRate(row.id, v)}
                      editable={row.checked}
                      selectTextOnFocus
                    />

                    {/* Quantity — editable */}
                    <TextInput
                      style={[styles.tableCellInput, { flex: 0.8 }]}
                      keyboardType="numeric"
                      value={row.quantity.toString()}
                      onChangeText={v => updateRowQuantity(row.id, v)}
                      editable={row.checked}
                      selectTextOnFocus
                    />

                    {/* Amount — computed label */}
                    <Text style={[styles.tableCellAmount, { flex: 1 }]}>
                      ₹{Math.round(row.amount)}
                    </Text>
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        {/* ════════════════════════════════════════
            STEP 5 — Totals + Bank + Submit
        ════════════════════════════════════════ */}
        {(checkedRows.length > 0 || roundOffEnabled) && (
          <View style={styles.stepCard}>
            <View style={styles.stepLabelRow}>
              <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{roundOffEnabled ? '4' : '5'}</Text></View>
              <Text style={styles.stepTitle}>Payment Summary</Text>
            </View>

            {/* Summary box */}
            <View style={styles.summaryBox}>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  {roundOffEnabled ? 'Round-off Mode' : 'Selected Records'}
                </Text>
                <Text style={styles.summaryValue}>{roundOffEnabled ? 'Enabled' : checkedRows.length}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Cylinders</Text>
                <Text style={styles.summaryValue}>{totalQuantity}</Text>
              </View>
              <View style={[styles.summaryRow, styles.summaryTotalRow]}>
                <Text style={styles.summaryTotalLabel}>
                  {roundOffEnabled ? 'Round-off Amount' : 'Total Amount'}
                </Text>
                <Text style={styles.summaryTotalValue}>₹{Math.round(totalAmount)}</Text>
              </View>

              {/* Bank Entry comparison — only in Bank Entry mode with an entry selected */}
              {entryMode === 'bank' && selectedBankEntry && (
                <>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Bank Entry Amount</Text>
                    <Text style={styles.summaryValue}>₹{Math.round(bankEntryAmount)}</Text>
                  </View>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Difference</Text>
                    <Text style={[
                      styles.summaryValue,
                      { fontWeight: '800', color: Math.round(bankEntryDifference) === 0 ? '#16a34a' : '#ef4444' },
                    ]}>
                      {Math.round(bankEntryDifference) === 0 ? '₹0 (Matched)' : `₹${Math.round(bankEntryDifference)}`}
                    </Text>
                  </View>
                </>
              )}
            </View>

            {/* Bank selection */}
            <Text style={styles.label}>Select Bank *</Text>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => setBankDropdownOpen(!bankDropdownOpen)}
            >
              <Text style={[styles.dropdownButtonText, !selectedBank && styles.dropdownPlaceholder]}>
                {selectedBank ? BANK_OPTIONS.find(b => b.value === selectedBank)?.label : 'Select bank...'}
              </Text>
              <Ionicons name={bankDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
            </TouchableOpacity>

            {bankDropdownOpen && (
              <View style={styles.dropdownList}>
                <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {BANK_OPTIONS.map(bank => (
                    <TouchableOpacity
                      key={bank.value}
                      style={[styles.dropdownItem, selectedBank === bank.value && styles.dropdownItemSelected]}
                      onPress={() => { setSelectedBank(bank.value); setBankDropdownOpen(false); }}
                    >
                      <Text style={{ fontSize: 20, marginRight: 10 }}>{bank.icon}</Text>
                      <Text style={[styles.dropdownItemText, selectedBank === bank.value && styles.dropdownItemTextSelected]}>
                        {bank.label}
                      </Text>
                      {selectedBank === bank.value && <Ionicons name="checkmark" size={16} color="#fff" />}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Submit */}
            <TouchableOpacity
              style={[styles.submitButton, (!selectedBank || submitting) && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={!selectedBank || submitting}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={22} color="#fff" />
                  <Text style={styles.submitButtonText}>RECORD PAYMENT  ₹{Math.round(totalAmount)}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Date Picker */}
      {showDatePicker && (
        <DateTimePicker
          value={new Date(paymentDate + 'T00:00:00')}
          mode="date"
          display="default"
          onChange={(event, date) => {
            setShowDatePicker(false);
            if (event.type === 'set' && date) {
              setPaymentDate(format(date, 'yyyy-MM-dd'));
            }
          }}
        />
      )}

      {/* ── Confirm Payment Modal ── */}
      <Modal
        visible={confirmVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setConfirmVisible(false)}
      >
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmBox}>

            {/* Title */}
            <View style={styles.confirmTitleRow}>
              <View style={styles.confirmIconCircle}>
                <Text style={{ fontSize: 22 }}>🏦</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.confirmTitle}>Confirm Payment</Text>
                <Text style={styles.confirmSubtitle}>Please review before submitting</Text>
              </View>
            </View>

            <View style={styles.confirmDivider} />

            {/* Detail rows */}
            <View style={styles.confirmDetailRow}>
              <View style={styles.confirmDetailIcon}><Text>📅</Text></View>
              <Text style={styles.confirmDetailLabel}>Transaction Date</Text>
              <Text style={styles.confirmDetailValue}>
                {format(new Date(paymentDate + 'T00:00:00'), 'dd MMM yyyy')}
              </Text>
            </View>

            <View style={styles.confirmDetailRow}>
              <View style={styles.confirmDetailIcon}><Text>👤</Text></View>
              <Text style={styles.confirmDetailLabel}>Customer</Text>
              <Text style={styles.confirmDetailValue} numberOfLines={1}>{selectedCustomer}</Text>
            </View>

            <View style={styles.confirmDetailRow}>
              <View style={styles.confirmDetailIcon}><Text>🏦</Text></View>
              <Text style={styles.confirmDetailLabel}>Bank</Text>
              <Text style={styles.confirmDetailValue}>
                {BANK_OPTIONS.find(b => b.value === selectedBank)?.label || selectedBank}
              </Text>
            </View>

            <View style={styles.confirmDetailRow}>
              <View style={styles.confirmDetailIcon}><Text>🔢</Text></View>
              <Text style={styles.confirmDetailLabel}>Cylinders</Text>
              <Text style={styles.confirmDetailValue}>{totalQuantity}</Text>
            </View>

            <View style={styles.confirmDetailRow}>
              <View style={styles.confirmDetailIcon}><Text>ℹ️</Text></View>
              <Text style={styles.confirmDetailLabel}>Round-off Mode</Text>
              <Text style={[styles.confirmDetailValue, { color: roundOffEnabled ? '#16a34a' : '#6b7280' }]}>
                {roundOffEnabled ? 'YES' : 'NO'}
              </Text>
            </View>

            {entryMode === 'bank' && selectedBankEntry && (
              <View style={styles.confirmDetailRow}>
                <View style={styles.confirmDetailIcon}><Text>🧾</Text></View>
                <Text style={styles.confirmDetailLabel}>Bank Entry Difference</Text>
                <Text style={[
                  styles.confirmDetailValue,
                  { color: Math.round(bankEntryDifference) === 0 ? '#16a34a' : '#ef4444' },
                ]}>
                  ₹{Math.round(bankEntryDifference)}
                </Text>
              </View>
            )}

            <View style={styles.confirmDivider} />

            {/* Total amount highlight */}
            <View style={styles.confirmAmountRow}>
              <Text style={styles.confirmAmountLabel}>Total Amount</Text>
              <Text style={styles.confirmAmountValue}>₹{Math.round(totalAmount)}</Text>
            </View>

            <View style={styles.confirmDivider} />

            {/* Buttons */}
            <View style={styles.confirmBtnRow}>
              <TouchableOpacity
                style={styles.confirmCancelBtn}
                onPress={() => setConfirmVisible(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.confirmCancelBtnText}>✕  Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.confirmOkBtn}
                onPress={handleConfirmPayment}
                activeOpacity={0.8}
              >
                <Text style={styles.confirmOkBtnText}>✓  Confirm</Text>
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f4f8' },
  scrollView: { flex: 1 },

  header: {
    backgroundColor: BPCL_BLUE,
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff', letterSpacing: 0.3 },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 3 },

  stepCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginBottom: 0,
    padding: 16,
    borderRadius: 14,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  stepLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: BPCL_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  stepTitle: { fontSize: 16, fontWeight: '700', color: '#1a1a2e' },

  label: { fontSize: 13, fontWeight: '600', color: '#666', marginBottom: 8, marginTop: 12 },

  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
  },
  dateButtonText: { flex: 1, fontSize: 16, color: '#333', fontWeight: '600' },

  // Entry mode toggle (Manual / Bank Entry)
  modeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    backgroundColor: '#fff',
  },
  modeBtnActive: {
    backgroundColor: BPCL_BLUE,
  },
  modeBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: BPCL_BLUE,
  },
  modeBtnTextActive: {
    color: '#fff',
  },

  // Bank entry section
  bankEntrySection: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 12,
    marginBottom: 4,
  },
  bankEntryHint: {
    fontSize: 11,
    color: '#888',
    marginTop: 6,
    fontStyle: 'italic',
  },
  step1SkipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#fca5a5',
    borderRadius: 10,
    paddingVertical: 11,
    marginTop: 10,
  },
  step1SkipBtnText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '700',
  },

  // Quick Transfer box (Step 2)
  quickTransferBox: {
    marginTop: 16,
    backgroundColor: '#fffbeb',
    borderWidth: 1.5,
    borderColor: '#fde68a',
    borderRadius: 12,
    padding: 14,
  },
  quickTransferHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  quickTransferTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#b45309',
  },
  quickTransferHint: {
    fontSize: 12,
    color: '#92400e',
    lineHeight: 17,
    marginBottom: 10,
  },
  quickTransferDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  quickTransferDetailLabel: {
    fontSize: 12,
    color: '#92400e',
  },
  quickTransferDetailValue: {
    fontSize: 12,
    fontWeight: '700',
    color: '#78350f',
  },
  quickTransferBtnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  quickTransferSkipBtn: {
    flex: 0.8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#fca5a5',
    borderRadius: 10,
    paddingVertical: 12,
  },
  quickTransferSkipBtnText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '700',
  },
  quickTransferBtn: {
    flex: 1.2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#b45309',
    borderRadius: 10,
    paddingVertical: 12,
  },
  quickTransferBtnFull: {
    flex: undefined,
    marginTop: 10,
  },
  quickTransferBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },

  // Today's payments table
  todaySection: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#f0f0f0', paddingTop: 12 },
  todaySectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  todaySectionTitle: { fontSize: 13, color: '#6b7280', fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#aaa', textAlign: 'center', paddingVertical: 10 },
  todayTable: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, overflow: 'hidden' },
  todayRow: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  todayRowHeader: { backgroundColor: '#f8f9fa' },
  todayCell: { fontSize: 12, color: '#374151' },
  todayCellHeader: { fontWeight: '700', color: '#6b7280', fontSize: 11 },
  todayAmountCell: { fontWeight: '600', color: BPCL_BLUE },
  todayTotalRow: { backgroundColor: '#eff6ff', borderBottomWidth: 0 },
  todayTotalLabel: { fontWeight: '700', color: '#1e40af', fontSize: 12 },
  todayTotalAmount: { fontWeight: '800', color: BPCL_BLUE, fontSize: 13 },

  showMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginTop: 10,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    backgroundColor: '#fff',
  },
  showMoreBtnText: {
    fontSize: 13,
    color: BPCL_BLUE,
    fontWeight: '700',
  },

  // Dropdown
  dropdownButton: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: BPCL_BLUE,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dropdownButtonText: { fontSize: 15, color: '#333', fontWeight: '600' },
  dropdownPlaceholder: { color: '#aaa', fontWeight: '400' },
  dropdownList: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    marginTop: 4,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    zIndex: 100,
  },
  dropdownSearch: {
    padding: 10,
    fontSize: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#f8f9fa',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  dropdownItem: {
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  dropdownItemSelected: { backgroundColor: BPCL_BLUE },
  dropdownItemText: { fontSize: 14, color: '#333', flex: 1 },
  dropdownItemTextSelected: { color: '#fff', fontWeight: 'bold' },
  discountHint: { fontSize: 11, color: '#888', marginTop: 2 },

  monthYearRow: { flexDirection: 'row', gap: 10 },

  periodLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
  },
  periodLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: BPCL_BLUE,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  periodRemoveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  periodRemoveText: {
    fontSize: 12,
    color: '#ef4444',
    fontWeight: '600',
  },
  periodDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginVertical: 14,
  },
  addPeriodBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    borderStyle: 'dashed',
    backgroundColor: '#f0f6fb',
  },
  addPeriodBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: BPCL_BLUE,
  },

  discountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
    paddingTop: 14,
  },
  discountLabel: { flex: 1, fontSize: 14, color: '#666', fontWeight: '500' },

  // Round-off overrides styles
  roundOffToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  roundOffLabel: {
    flex: 1,
    fontSize: 14,
    color: '#666',
    fontWeight: '500',
  },
  roundOffContainer: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },
  roundOffHint: {
    fontSize: 12,
    color: '#16a34a',
    marginBottom: 8,
    lineHeight: 16,
  },
  roundOffInputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  roundOffInputLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#15803d',
    marginBottom: 4,
  },
  roundOffInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#111',
    fontWeight: '600',
  },

  // Pending records table
  selectAllBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    backgroundColor: '#fff',
  },
  selectAllBtnActive: {
    backgroundColor: BPCL_BLUE,
  },
  selectAllBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: BPCL_BLUE,
  },
  selectAllBtnTextActive: {
    color: '#fff',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f6fb',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 6,
    marginBottom: 4,
  },
  tableHeaderCell: { fontSize: 11, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
    borderRadius: 4,
  },
  tableRowChecked: { backgroundColor: '#eff6ff' },
  checkbox: { width: 32 },
  tableCell: { fontSize: 13, color: '#374151' },
  tableCellInput: {
    fontSize: 13,
    color: '#1a1a1a',
    fontWeight: '600',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    backgroundColor: '#fafafa',
    textAlign: 'center',
    marginHorizontal: 2,
  },
  tableCellAmount: {
    fontSize: 13,
    fontWeight: '700',
    color: BPCL_BLUE,
    textAlign: 'right',
    paddingRight: 4,
  },

  // Summary
  summaryBox: {
    backgroundColor: '#f0f6fb',
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#bcd9ee',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  summaryLabel: { fontSize: 13, color: '#555' },
  summaryValue: { fontSize: 13, fontWeight: '600', color: '#333' },
  summaryTotalRow: {
    borderTopWidth: 1,
    borderTopColor: '#bcd9ee',
    marginTop: 6,
    paddingTop: 10,
  },
  summaryTotalLabel: { fontSize: 15, fontWeight: '700', color: '#1a1a2e' },
  summaryTotalValue: { fontSize: 18, fontWeight: '800', color: BPCL_BLUE },

  submitButton: {
    backgroundColor: BPCL_BLUE,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    elevation: 3,
  },
  submitButtonDisabled: { opacity: 0.5 },
  submitButtonText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },


  // ── Confirm modal ─────────────────────────────────────────────────────────
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  confirmBox: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 36,
    elevation: 12,
  },
  confirmTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 16,
  },
  confirmIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E6F1FB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1a1a2e',
  },
  confirmSubtitle: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  confirmDivider: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginVertical: 12,
  },
  confirmDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  confirmDetailIcon: {
    width: 28,
    alignItems: 'center',
  },
  confirmDetailLabel: {
    flex: 1,
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  },
  confirmDetailValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1a1a2e',
    maxWidth: 180,
    textAlign: 'right',
  },
  confirmAmountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  confirmAmountLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a2e',
  },
  confirmAmountValue: {
    fontSize: 22,
    fontWeight: '900',
    color: BPCL_BLUE,
  },
  confirmBtnRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  confirmCancelBtn: {
    flex: 1,
    padding: 15,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#ddd',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
  },
  confirmCancelBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#555',
  },
  confirmOkBtn: {
    flex: 1,
    padding: 15,
    borderRadius: 12,
    backgroundColor: BPCL_BLUE,
    alignItems: 'center',
  },
  confirmOkBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
});
