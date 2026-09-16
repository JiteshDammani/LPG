import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useDataStore } from '@/store/dataStore';
import { useRole } from '@/hooks/useRole';
import { generateAndShareDailyLedgerPdf } from '@/lib/dailyLedgerPdf'

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';


// Categories that skip the Cash/Paytm popup and always go direct (no paytm flag)
const SKIP_PAYMENT_MODE_CATEGORIES = [
  'TOTAL AHD',
  'CLOSING BALANCE',
  'GODOWN',
  'PENALTY',
  'PRICE DIFFERENCE',
];

// ─── Auto-populated rate tables (editable after auto-fill) ────────────────────
const SALE_RATES: { [key: string]: number } = {
  'SRT': 190,
  'DPR': 550,
  'DPR-CHANGE': 250,
  'LIGHTER': 150,
  'TOP STOVE': 850,
  'STOVE': 2300,
  '3 BUNNER STOVE': 3500,
};

const GODOWN_RATES: { [key: string]: number } = {
  'HAMALI': 900,
  'HELPER': 150,
  'MAJURI': 200,
  'RL': 3000,
  'KD': 2250,
  'HAFTA': 300,
  'SUNDAY MAJURI': 200,
  'FUEL': 100,
};

const SMALL_CYLINDER_RATES: { [key: string]: number } = {
  'REFILL': 880,
  'NEW CONNECTION': 2000,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Transaction {
  id: number;
  date: string;
  transactions: 'CREDIT' | 'DEBIT';
  category: string;
  rate: number;
  quantity: number;
  amount: number;
  remarks: string;
  paytm_transaction: boolean;
  check_done: boolean;
  debit_balance_report_id: number | null;
}

type SelectedView = 'CREDIT' | 'DEBIT';

// ─── Helper: Parse commercial info from remarks ───────────────────────────────
function parseCommercialRemarks(remarks: string): {
  customerName: string;
  deliveryDate: string;
} | null {
  if (!remarks) return null;
  const match = remarks.match(/^(.+?)\((\d{4}-\d{2}-\d{2})\)$/);
  if (!match) return null;
  return {
    customerName: match[1].trim(),
    deliveryDate: match[2].trim(),
  };
}

export default function TransactionScreen() {
  const router = useRouter();
  const role = useRole();

  // ─── TAB NAVIGATION STATE ──────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'entry' | 'totals'>('entry');
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingJdPdf, setExportingJdPdf] = useState(false); // NEW: JD PDF export loading state

  // ─── UNIFIED TRANSACTION DATE STATE ────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);

  // ─── useDataStore Extraction ──────────────────────────────────────────────
  const {
    loadTransactionCategories,
    loadBalanceNames,
    loadBalanceDetails,
    loadEmployees,
    loadUnpaidSalaryNames,
    loadSalaryDetails,
    addTransaction,
    categories,
    balanceNames,
    balanceDetails,
    employees,
    unpaidSalaryNames,
    loadingCategories,
    loadingBalanceNames,
    loadingBalanceDetails,
    loadingEmployees,
    cylinderPrice,
    loadingUnpaidSalaryNames,
    loadingSalaryDetails,
    discountEnabled,
    loadDiscountSetting,
  } = useDataStore() as any;

  // ─── FORM ENTRY TAB STATES ─────────────────────────────────────────────────
  const [selectedType, setSelectedType]         = useState<'CREDIT' | 'DEBIT'>('DEBIT');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedName, setSelectedName]         = useState('');
  const [selectedRecord, setSelectedRecord]     = useState<any>(null);
  const [selectedBank, setSelectedBank]         = useState('');
  const [selectedSalaryName, setSelectedSalaryName] = useState('');

  const [rate, setRate]         = useState('');
  const [quantity, setQuantity] = useState('1');
  const [remarks, setRemarks]   = useState('');
  const [submitting, setSubmitting] = useState(false);

  const amount = Math.ceil((parseFloat(rate) || 0) * (parseInt(quantity) || 0));

  const [selectedSalesSub, setSelectedSalesSub]   = useState('');
  const [selectedSmallCyl, setSelectedSmallCyl]   = useState('');
  const [driverName, setDriverName]               = useState('');
  const [expType, setExpType]                     = useState('');

  const [commercialNames, setCommercialNames]               = useState<any[]>([]);
  const [selectedCommercialName, setSelectedCommercialName] = useState('');
  const [commercialDiscount, setCommercialDiscount]         = useState(0);
  const [commercialPendingDates, setCommercialPendingDates] = useState<any[]>([]);
  const [selectedCommercialDate, setSelectedCommercialDate] = useState('');
  const [loadingCommercialNames, setLoadingCommercialNames] = useState(false);
  const [loadingCommercialDates, setLoadingCommercialDates] = useState(false);
  const [commercialSearch, setCommercialSearch]             = useState('');
  const [discountActuallyApplied, setDiscountActuallyApplied] = useState(false);

  const [distributorSub, setDistributorSub]   = useState('');
  const [tvConsumerName, setTvConsumerName]   = useState('');
  const [tvCylinders, setTvCylinders]         = useState('');
  const [showTvPopup, setShowTvPopup]         = useState(false);
  const [tvAmount, setTvAmount]               = useState('');

  // ── SV - NAME CHANGE tally state ──────────────────────────────────────────
  const [svNameChangeAmount, setSvNameChangeAmount] = useState<number | null>(null);
  const [svNameChangeTally, setSvNameChangeTally]   = useState(0);

  // ── DBTL sub-selection state ──────────────────────────────────────────────
  const [dbtlSubSelected, setDbtlSubSelected] = useState<'568' | '435' | 'OTHER' | ''>('');

  // ── WEEKLY SALARY named-bonus checkbox state ──────────────────────────────
  const [bonusApplied, setBonusApplied]           = useState(false);
  const [bonusAmountApplied, setBonusAmountApplied] = useState(0);
  const [checkingBonus, setCheckingBonus]         = useState(false);

  // ── WEEKLY SALARY day-wise delivery breakdown (e.g. 15/04:50, 16/04:50, 17/04:55) ──
  const [weeklyDeliveryBreakdown, setWeeklyDeliveryBreakdown] = useState<{ date: string; qty: number }[]>([]);
  const [loadingWeeklyBreakdown, setLoadingWeeklyBreakdown]   = useState(false);

  // ── BALANCE CHECKBOX STATE ────────────────────────────────────────────────
  const [checkedBalances, setCheckedBalances]         = useState<{ [id: number]: boolean }>({});
  const [balanceInputAmounts, setBalanceInputAmounts] = useState<{ [id: number]: string }>({});

  // Balance amount confirmation popup
  const [balancePopupVisible, setBalancePopupVisible]       = useState(false);
  const [balancePopupItem, setBalancePopupItem]             = useState<any>(null);
  const [balancePopupTempAmount, setBalancePopupTempAmount] = useState('');

  // ── CASH / PAYTM PAYMENT MODE POPUP ───────────────────────────────────────
  const [paymentModeVisible, setPaymentModeVisible]   = useState(false);
  const [paymentModeSelected, setPaymentModeSelected] = useState<'CASH' | 'PAYTM' | null>(null);
  const [pendingPaymentAction, setPendingPaymentAction] = useState<
    ((paymentModeText: string, isPaytm: boolean) => void) | null
  >(null);

  // ── CATEGORY DROPDOWN STATE ───────────────────────────────────────────────
  const [categoryDropdownVisible, setCategoryDropdownVisible] = useState(false);
  const [categorySearchText, setCategorySearchText]           = useState('');
  const [categoryUsageCounts, setCategoryUsageCounts]         = useState<{ [cat: string]: number }>({});
  // Distinct-days-used per category — this is the "how often" signal (regularity),
  // as opposed to categoryUsageCounts which is raw row volume.
  const [categoryDaysUsedCounts, setCategoryDaysUsedCounts]   = useState<{ [cat: string]: number }>({});

  // ─── DAILY TOTALS / LEDGER STATES ──────────────────────────────────────────
  const [selectedView, setSelectedView] = useState<SelectedView>('CREDIT');
  const [creditTotal, setCreditTotal]   = useState(0);
  const [debitTotal, setDebitTotal]     = useState(0);
  const [loadingTotals, setLoadingTotals] = useState(false);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [savingLedger, setSavingLedger]   = useState(false);
  const [deletingId, setDeletingId]       = useState<number | null>(null);

  const [creditEntries, setCreditEntries] = useState<Transaction[]>([]);
  const [debitEntries, setDebitEntries] = useState<Transaction[]>([]);

  // Ledger Editing States
  const [editingEntry, setEditingEntry] = useState<Transaction | null>(null);
  const [editCategory, setEditCategory] = useState('');
  const [editRate, setEditRate] = useState('');
  const [editQuantity, setEditQuantity] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editRemarks, setEditRemarks] = useState('');

  const totalsBottomSheetRef = useRef<any>(null);
  const totalsSnapPoints = useMemo(() => ['80%'], []);

  // ─── FETCH TOTALS COUNTS ───────────────────────────────────────────────────

  const fetchTotals = async (date: string) => {
    setLoadingTotals(true);
    try {
      const { data } = await supabase
        .from('dashboard_dailyrecordsachin')
        .select('transactions, amount')
        .eq('date', date);

      if (data) {
        const cr = data
          .filter((r: any) => r.transactions === 'CREDIT')
          .reduce((sum, r) => sum + (r.amount || 0), 0);
        const db = data
          .filter((r: any) => r.transactions === 'DEBIT')
          .reduce((sum, r) => sum + (r.amount || 0), 0);
        setCreditTotal(cr);
        setDebitTotal(db);
      }
    } finally {
      setLoadingTotals(false);
    }
  };

  // Downloads the PDF built from dashboard_dailyrecordsachin (the original ledger)
  const handleDownloadPdf = async () => {
    setExportingPdf(true);
    try {
      await generateAndShareDailyLedgerPdf(selectedDate, 'dashboard_dailyrecordsachin', 'Daily Record');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to generate PDF');
    } finally {
      setExportingPdf(false);
    }
  };

  // NEW: Downloads the PDF built from dashboard_dailyrecord ("JD" ledger)
  // Same structure/columns as the Daily Record PDF, identical table schema,
  // just a different underlying table.
  const handleDownloadJdPdf = async () => {
    setExportingJdPdf(true);
    try {
      await generateAndShareDailyLedgerPdf(selectedDate, 'dashboard_dailyrecord', 'JD Record');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to generate JD PDF');
    } finally {
      setExportingJdPdf(false);
    }
  };


  // ─── FETCH DETAILED LEDGER ENTRIES ─────────────────────────────────────────

  const fetchLedgerData = useCallback(async () => {
    setLoadingLedger(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_dailyrecordsachin')
        .select('*')
        .eq('date', selectedDate)
        .order('id', { ascending: true });

      if (error) throw error;

      const records = (data || []) as Transaction[];
      const credits = records.filter((r) => r.transactions === 'CREDIT');
      const debits = records.filter((r) => r.transactions === 'DEBIT');

      setCreditEntries(credits);
      setDebitEntries(debits);
      setCreditTotal(credits.reduce((sum, r) => sum + (r.amount || 0), 0));
      setDebitTotal(debits.reduce((sum, r) => sum + (r.amount || 0), 0));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load daily ledger entries');
    } finally {
      setLoadingLedger(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchTotals(selectedDate);
    fetchLedgerData();
  }, [selectedDate, fetchLedgerData]);

  useEffect(() => {
    loadTransactionCategories(selectedType);
    resetForm();
  }, [selectedType]);

  useEffect(() => {
    if (activeTab === 'totals') {
      fetchLedgerData();
    }
  }, [activeTab, fetchLedgerData]);

  // Clean sheet refs when unmounted
  useEffect(() => {
    return () => {
      totalsBottomSheetRef.current?.close();
    };
  }, []);

  // ─── CATEGORY USAGE FREQUENCY (for smart dropdown ordering) ───────────────
  // Pulls how many DISTINCT DAYS each category has been used on historically
  // for the currently selected transaction type, so categories used regularly
  // (e.g. every day) float to the top of the dropdown list — not categories
  // that simply have a large raw row count from being bulk-entered on one day.
  // Total row count is kept only as a tiebreaker between categories used on
  // the same number of distinct days.
  useEffect(() => {
    const loadCategoryUsage = async () => {
      try {
        const { data, error } = await supabase
          .from('dashboard_dailyrecordsachin')
          .select('category, date')
          .eq('transactions', selectedType);

        if (!error && data) {
          const totalCounts: { [cat: string]: number } = {};
          const daysSets: { [cat: string]: Set<string> } = {};

          data.forEach((row: any) => {
            if (row.category) {
              totalCounts[row.category] = (totalCounts[row.category] || 0) + 1;
              if (!daysSets[row.category]) daysSets[row.category] = new Set();
              if (row.date) daysSets[row.category].add(row.date);
            }
          });

          const daysCounts: { [cat: string]: number } = {};
          Object.keys(daysSets).forEach((cat) => {
            daysCounts[cat] = daysSets[cat].size;
          });

          setCategoryUsageCounts(totalCounts);
          setCategoryDaysUsedCounts(daysCounts);
        }
      } catch (err) {
        // Silent fail — dropdown just falls back to alphabetical order
      }
    };
    loadCategoryUsage();
  }, [selectedType]);

  const sortedCategories = useMemo(() => {
    const list: string[] = categories || [];
    const filtered = categorySearchText
      ? list.filter((c) => c.toUpperCase().includes(categorySearchText.toUpperCase()))
      : list;

    return [...filtered].sort((a, b) => {
      const daysA = categoryDaysUsedCounts[a] || 0;
      const daysB = categoryDaysUsedCounts[b] || 0;
      if (daysB !== daysA) return daysB - daysA; // used on more distinct days first (regularity)

      const countA = categoryUsageCounts[a] || 0;
      const countB = categoryUsageCounts[b] || 0;
      if (countB !== countA) return countB - countA; // tiebreaker: total volume

      return a.localeCompare(b);
    });
  }, [categories, categoryUsageCounts, categoryDaysUsedCounts, categorySearchText]);

  // ─── FORM LOGICAL CAT LOADING RULES ────────────────────────────────────────

  useEffect(() => {
    const handleSpecialCategories = async () => {
      setCommercialSearch('');
      if (selectedCategory !== 'WEEKLY SALARY') {
        setWeeklyDeliveryBreakdown([]);
      }

      if (selectedCategory === 'BALANCE') {
        loadBalanceNames(selectedType);
        if (selectedType === 'DEBIT') loadEmployees();
      } else if (selectedCategory === 'WEEKLY SALARY' && selectedType === 'DEBIT') {
        loadUnpaidSalaryNames();
      } else if (selectedCategory === 'DISTRIBUTOR TRANSACTION') {
        setDistributorSub('');
        setTvConsumerName('');
        setTvCylinders('');
        setTvAmount('');
        setShowTvPopup(false);
        setSvNameChangeAmount(null);
        setSvNameChangeTally(0);
        setDbtlSubSelected('');
      } else if (selectedCategory === 'SALE') {
        setSelectedSalesSub('');
      } else if (selectedCategory === 'COMMERCIAL PAYMENT') {
        setSelectedCommercialName('');
        setCommercialDiscount(0);
        setCommercialPendingDates([]);
        setSelectedCommercialDate('');
        setRate('');
        setQuantity('1');
        setRemarks('');
        setCommercialSearch('');
        setDistributorSub('');
        setTvConsumerName('');
        setTvCylinders('');
        setTvAmount('');
        setShowTvPopup(false);

        await loadDiscountSetting();

        setLoadingCommercialNames(true);
        try {
          const { data, error } = await supabase
            .from('dashboard_customername')
            .select('name, discount')
            .order('name');
          if (!error && data) setCommercialNames(data);
        } finally {
          setLoadingCommercialNames(false);
        }

      } else if (selectedCategory === 'TOTAL AHD') {
        setRate((cylinderPrice || 0).toString());
        setRemarks('AHD');

        const { data } = await supabase
          .from('dashboard_deliveryrecords')
          .select('number, remarks')
          .eq('date', selectedDate);

        if (data) {
          let totalQty = data.reduce((sum: number, row: any) => sum + (row.number || 0), 0);
          let ncDbcCount = 0;
          data.forEach((row: any) => {
            const rem = row.remarks || '';
            const matches = rem.match(/NC:|DBC:/g);
            if (matches) ncDbcCount += matches.length;
          });
          setQuantity((totalQty - ncDbcCount).toString());
        }

      } else if (selectedCategory === 'ONLINE PAYMENT') {
        const { data: deliveryData } = await supabase
          .from('dashboard_deliveryrecords')
          .select('online_payment, paytm, additional_paytm')
          .eq('date', selectedDate);

        const { data: paytmCredits } = await supabase
          .from('dashboard_dailyrecordsachin')
          .select('amount')
          .eq('date', selectedDate)
          .eq('transactions', 'CREDIT')
          .eq('paytm_transaction', true);

        if (deliveryData) {
          const totalOnlineQty       = deliveryData.reduce((sum: number, row: any) => sum + (row.online_payment || 0), 0);
          const totalPaytmQty        = deliveryData.reduce((sum: number, row: any) => sum + (row.paytm || 0), 0);
          const totalAdditionalPaytm = deliveryData.reduce((sum: number, row: any) => sum + (row.additional_paytm || 0), 0);
          const extraPaytmAmount     = (paytmCredits || []).reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0);

          const onlineAmount  = Math.ceil(totalOnlineQty * (cylinderPrice || 0));
          const paytmAmount   = Math.ceil(totalPaytmQty * (cylinderPrice || 0));
          const totalPaytmAll = paytmAmount + totalAdditionalPaytm + extraPaytmAmount;
          const grandTotal    = onlineAmount + totalPaytmAll;

          setRate(grandTotal.toString());
          setQuantity('1');
          setRemarks(`ONLINE(${totalOnlineQty}) PAYTM(${totalPaytmAll})`);
        }

      } else if (
        selectedCategory === 'SALE' ||
        selectedCategory === 'SMALL CYLINDER' ||
        selectedCategory === 'DRIVER EXPENDITURE'
      ) {
        setSelectedSalesSub('');
        setSelectedSmallCyl('');
        setDriverName('');
        setExpType('');
        setRemarks('');

      } else if (selectedCategory === 'CLOSING BALANCE') {
          const selected = new Date(selectedDate + 'T00:00:00');
          const dayOfWeek = selected.getDay();
          const daysBack = dayOfWeek === 1 ? 2 : 1;
          const prevDate = format(
            new Date(selected.getTime() - daysBack * 86400000),
            'yyyy-MM-dd'
          );

        const { data }: { data: any[] | null } = await supabase
          .from('dashboard_dailyrecordsachin')
          .select('transactions, amount')
          .eq('date', prevDate);

        if (data) {
          const prevCredit = data
            .filter((r: any) => r.transactions === 'CREDIT')
            .reduce((sum: number, r: any) => sum + (Number(r.amount) || 0), 0);
          const prevDebit = data
            .filter((r: any) => r.transactions === 'DEBIT')
            .reduce((sum: number, r: any) => sum + (Number(r.amount) || 0), 0);

          setRate((prevCredit - prevDebit).toString());
          setQuantity('1');
          setRemarks('SHILLAK');
        }
      }
    };

    handleSpecialCategories();
  }, [selectedCategory, selectedType, selectedDate]);

  useEffect(() => {
    if (selectedName && selectedType === 'CREDIT' && selectedCategory === 'BALANCE') {
      loadBalanceDetails(selectedName, selectedType);
    }
  }, [selectedName]);

  useEffect(() => {
    setCheckedBalances({});
    setBalanceInputAmounts({});
  }, [balanceDetails]);

  useEffect(() => {
    if (selectedRecord) {
      setRate(selectedRecord.amount.toString());
      setQuantity('1');
      setRemarks(`${selectedName} (${selectedRecord.date})`);
    }
  }, [selectedRecord]);

  // ─── FORM RESET & COMMERCIAL SELECTION HELPERS ────────────────────────────

  const resetForm = () => {
    setSelectedCategory('');
    setSelectedName('');
    setSelectedRecord(null);
    setSelectedBank('');
    setSelectedSalaryName('');
    setRate('');
    setQuantity('1');
    setRemarks('');
    setSelectedSalesSub('');
    setSelectedSmallCyl('');
    setDriverName('');
    setExpType('');
    setSelectedCommercialName('');
    setCommercialDiscount(0);
    setCommercialPendingDates([]);
    setSelectedCommercialDate('');
    setCommercialSearch('');
    setDiscountActuallyApplied(false);
    setCheckedBalances({});
    setBalanceInputAmounts({});
    setSvNameChangeAmount(null);
    setSvNameChangeTally(0);
    setDbtlSubSelected('');
    setBonusApplied(false);
    setBonusAmountApplied(0);
    setCategorySearchText('');
    setWeeklyDeliveryBreakdown([]);
  };

  const handleCommercialNameSelect = async (name: string, discount: number) => {
    setSelectedCommercialName(name);
    setCommercialDiscount(discount);
    setSelectedCommercialDate('');
    setRate('');
    setQuantity('1');
    setRemarks('');
    setCommercialPendingDates([]);
    setLoadingCommercialDates(true);

    try {
      const { data, error } = await supabase
        .from('dashboard_commercialrecords')
        .select('id, delivery_date')
        .eq('customer_name', name)
        .is('payment_date', null)
        .order('delivery_date');

      if (!error && data) {
        const grouped: { [date: string]: number } = {};
        data.forEach((row: any) => {
          grouped[row.delivery_date] = (grouped[row.delivery_date] || 0) + 1;
        });
        const dateList = Object.entries(grouped).map(([date, count]) => ({
          date,
          count,
          discount,
          label: `📅 ${format(new Date(date), 'dd MMM yyyy')}  —  ${count} cylinder${count > 1 ? 's' : ''} pending`,
        }));
        setCommercialPendingDates(dateList);
      }
    } finally {
      setLoadingCommercialDates(false);
    }
  };

  const handleCommercialDateSelect = async (dateObj: any) => {
    setSelectedCommercialDate(dateObj.date);
    const freshDiscount = dateObj.discount || 0;

    try {
      const { data, error } = await supabase
        .from('dashboard_commercialrate')
        .select('actual_rate')
        .lte('start_date', dateObj.date)
        .gte('end_date', dateObj.date)
        .single();

      if (!error && data) {
        const actualRate = data.actual_rate || 0;
        const finalRate  = Math.round(actualRate - (discountEnabled ? freshDiscount : 0));

        setDiscountActuallyApplied(discountEnabled && freshDiscount > 0);
        setRate(finalRate.toString());
        setQuantity(dateObj.count.toString());
        setRemarks(`${selectedCommercialName}(${dateObj.date})`);
      } else {
        Alert.alert('Rate Not Found', 'No commercial rate found for this delivery date.');
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to fetch commercial rate');
    }
  };

  // ── BALANCE CHECKBOX HANDLERS ─────────────────────────────────────────────

  const handleBalanceCheckboxTap = (item: any) => {
    const id = item.id;
    if (checkedBalances[id]) {
      const newChecked = { ...checkedBalances };
      delete newChecked[id];
      const newAmounts = { ...balanceInputAmounts };
      delete newAmounts[id];
      setCheckedBalances(newChecked);
      setBalanceInputAmounts(newAmounts);
    } else {
      setBalancePopupItem(item);
      setBalancePopupTempAmount(item.amount.toString());
      setBalancePopupVisible(true);
    }
  };

  const handleBalancePopupConfirm = () => {
    if (!balancePopupItem) return;
    const id = balancePopupItem.id;
    const val = parseFloat(balancePopupTempAmount);
    if (!val || val <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }
    setCheckedBalances(prev => ({ ...prev, [id]: true }));
    setBalanceInputAmounts(prev => ({ ...prev, [id]: val.toString() }));
    setBalancePopupVisible(false);
    setBalancePopupItem(null);
    setBalancePopupTempAmount('');
  };

  const handleBalancePopupCancel = () => {
    setBalancePopupVisible(false);
    setBalancePopupItem(null);
    setBalancePopupTempAmount('');
  };

  const checkedBalanceTotal = Object.entries(checkedBalances)
    .filter(([, checked]) => checked)
    .reduce((sum, [id]) => {
      return sum + (parseFloat(balanceInputAmounts[Number(id)] || '0') || 0);
    }, 0);

  // ── PAYMENT MODE POPUP HELPERS ────────────────────────────────────────────

  const requestPaymentMode = (onConfirm: (paymentModeText: string, isPaytm: boolean) => void) => {
    if (SKIP_PAYMENT_MODE_CATEGORIES.includes(selectedCategory)) {
      onConfirm('', false);
      return;
    }
    setPaymentModeSelected(null);
    setPendingPaymentAction(() => onConfirm);
    setPaymentModeVisible(true);
  };

  const handlePaymentModeConfirm = () => {
    if (!paymentModeSelected || !pendingPaymentAction) return;
    const isPaytm = paymentModeSelected === 'PAYTM';
    setPaymentModeVisible(false);
    pendingPaymentAction('', isPaytm);
    setPendingPaymentAction(null);
    setPaymentModeSelected(null);
  };

  const handlePaymentModeClose = () => {
    setPaymentModeVisible(false);
    setPendingPaymentAction(null);
    setPaymentModeSelected(null);
  };

  // ── WEEKLY SALARY: NAMED BONUS CHECKBOX HANDLER ───────────────────────────
  // Adds ₹6.5 to the rate if the employee's name exists as a COLUMN NAME in
  // dashboard_pfsheet, otherwise adds ₹6. un-checking removes exactly what was
  // added, so repeated toggling never drifts the rate.
  const checkNameInPfSheetColumns = async (name: string): Promise<boolean> => {
  const { data, error } = await supabase
    .from('dashboard_pfsheet')
    .select('name')
    .ilike('name', name);

  if (error) return false;

  return data.length > 0;
};

  const handleToggleNamedBonus = async () => {
    if (!selectedSalaryName) return;

    if (bonusApplied) {
      // Remove the previously-applied bonus
      const currentRate = parseFloat(rate) || 0;
      setRate((currentRate - bonusAmountApplied).toString());
      setBonusApplied(false);
      setBonusAmountApplied(0);
      return;
    }

    setCheckingBonus(true);
    try {
      const isColumnPresent = await checkNameInPfSheetColumns(selectedSalaryName);
      const bonus = isColumnPresent ? 6.5 : 6;
      const currentRate = parseFloat(rate) || 0;
      setRate((currentRate + bonus).toString());
      setBonusApplied(true);
      setBonusAmountApplied(bonus);
    } finally {
      setCheckingBonus(false);
    }
  };

  // ── WEEKLY SALARY: fetch day-wise delivery quantity breakdown ────────────
  const fetchWeeklyDeliveryBreakdown = async (name: string) => {
    setLoadingWeeklyBreakdown(true);
    try {
      const isNamdev = name === 'NAMDEV 19KG';
      let query;

      if (isNamdev) {
        query = supabase
          .from('dashboard_commercialrecords')
          .select('delivery_date, id')
          .eq('delivery_boy', 'NAMDEV')
          .eq('commision_given', false); // Direct DB-level filter

        if (selectedDate) {
          query = query.lt('delivery_date', selectedDate);
        }
      } else {
        query = supabase
          .from('dashboard_deliveryrecords')
          .select('date, number')
          .eq('name', name)
          .eq('commission_given', false); // Direct DB-level filter

        if (selectedDate) {
          const upto = new Date(selectedDate); // Safe parsing compatible with React Native
          upto.setDate(upto.getDate() - 1);
          const oneDayBefore = format(upto, 'yyyy-MM-dd');
          query = query.lte('date', oneDayBefore);
        }
      }

      const { data, error } = await query.limit(10000);

      if (!error && data) {
        const grouped: { [date: string]: number } = {};
        data.forEach((row: any) => {
          const recordDate = isNamdev ? row.delivery_date : row.date;
          const recordQty  = isNamdev ? 1 : Number(row.number || 0);
          if (recordDate) {
            grouped[recordDate] = (grouped[recordDate] || 0) + recordQty;
          }
        });

        const list = Object.entries(grouped)
          .map(([date, qty]) => ({ date, qty }))
          .sort((a, b) => a.date.localeCompare(b.date));

        setWeeklyDeliveryBreakdown(list);
      } else {
        setWeeklyDeliveryBreakdown([]);
      }
    } catch (err) {
      setWeeklyDeliveryBreakdown([]);
    } finally {
      setLoadingWeeklyBreakdown(false);
    }
  };
  // ── DISTRIBUTOR TRANSACTION: SV - NAME CHANGE tally handlers ─────────────
  const handleSvAmountPress = (value: 850 | 1100) => {
    if (svNameChangeAmount === value) {
      const newTally = svNameChangeTally + 1;
      setSvNameChangeTally(newTally);
      setQuantity(newTally.toString());
    } else {
      setSvNameChangeAmount(value);
      setSvNameChangeTally(1);
      setQuantity('1');
    }
    setRate(value.toString());
    setRemarks('SV - NAME CHANGE');
  };

  const handleSvNameChangeClear = () => {
    setSvNameChangeAmount(null);
    setSvNameChangeTally(0);
    setRate('');
    setQuantity('1');
    setRemarks('');
  };

  // ── DISTRIBUTOR TRANSACTION: DBTL sub-selection handler ──────────────────
  const handleDbtlSelect = (value: '568' | '435' | 'OTHER' | '') => {
    setDbtlSubSelected(value);
    if (value === 'OTHER') {
      setRate('');
      setQuantity('1');
      setRemarks('');
    } else {
      setRate(value);
      setQuantity('1');
      setRemarks(`DBTL - ${value}`);
    }
  };

  // ── PROCESS FORM SUBMIT ────────────────────────────────────────────────────

  const processSubmit = async (paymentModeText: string, isPaytmBool: boolean) => {
    setSubmitting(true);
    try {
      let finalRemarks = remarks;
      if (paymentModeText) {
        finalRemarks = finalRemarks ? `${paymentModeText} ${finalRemarks}` : paymentModeText;
      }

      const payload: any = {
        date: selectedDate,
        transactions: selectedType,
        category: selectedCategory,
        rate: parseFloat(rate),
        quantity: parseInt(quantity),
        amount: amount,
        remarks: finalRemarks,
        paytm_transaction: isPaytmBool,
        check_done: false,
      };

      if (selectedCategory === 'WEEKLY SALARY' && selectedSalaryName) {
        payload.isSalaryUpdate = true;
        payload.salaryName = selectedSalaryName;
      }

      if (selectedType === 'CREDIT' && selectedCategory === 'BALANCE' && selectedRecord) {
        payload.balanceId = selectedRecord.id;
      }

      if (
        selectedCategory === 'COMMERCIAL PAYMENT' &&
        selectedCommercialName &&
        selectedCommercialDate
      ) {
        const { data: pendingRows } = await supabase
          .from('dashboard_commercialrecords')
          .select('id')
          .eq('customer_name', selectedCommercialName)
          .eq('delivery_date', selectedCommercialDate)
          .is('payment_date', null)
          .order('id')
          .limit(parseInt(quantity));

        if (pendingRows && pendingRows.length > 0) {
          const ids = pendingRows.map((r: any) => r.id);
          await supabase
            .from('dashboard_commercialrecords')
            .update({
              payment_date: selectedDate,
              amount: parseFloat(rate),
            })
            .in('id', ids);
        }
      }

      if (!(selectedType === 'CREDIT' && selectedCategory === 'BALANCE')) {
        await addTransaction(payload);
      }

      // Save checked balance sub-items
      const checkedIds = Object.keys(checkedBalances).filter(id => checkedBalances[Number(id)]);

      if (checkedIds.length > 0) {
        for (const idStr of checkedIds) {
          const id = Number(idStr);
          const creditAmt = parseFloat(balanceInputAmounts[id] || '0');
          if (!creditAmt || creditAmt <= 0) continue;

          const balItem = balanceDetails.find((b: any) => b.id === id);
          if (!balItem) continue;

          const creditPayload: any = {
            date: selectedDate,
            transactions: 'CREDIT',
            category: 'BALANCE',
            rate: creditAmt,
            quantity: 1,
            amount: creditAmt,
            remarks: `${selectedSalaryName === 'NAMDEV 19KG' ? 'NAMDEV - 19KG' : (selectedSalaryName || selectedName)} (${balItem.date})`,
            paytm_transaction: false,
            check_done: false,
            balanceId: id,
          };

          await addTransaction(creditPayload);
        }
      }

      Alert.alert('Success', 'Transaction saved successfully');
      fetchTotals(selectedDate);
      fetchLedgerData();
      resetForm();
    } catch (err) {
      Alert.alert('Error', 'Failed to save transaction');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = () => {
    if (!selectedCategory) return Alert.alert('Error', 'Please select a category');

    if (selectedCategory === 'BALANCE' && selectedType === 'CREDIT' && !selectedRecord) {
      const checkedIds = Object.keys(checkedBalances).filter(id => checkedBalances[Number(id)]);
      if (checkedIds.length === 0) {
        return Alert.alert('Error', 'Please select at least one balance record');
      }
      if (selectedType === 'CREDIT') {
        requestPaymentMode((paymentModeText, isPaytm) => processSubmit(paymentModeText, isPaytm));
      }
      return;
    }

    if (selectedCategory === 'WEEKLY SALARY' && !selectedSalaryName) {
      return Alert.alert('Error', 'Please select an unpaid employee');
    }

    if (selectedCategory === 'DISTRIBUTOR TRANSACTION') {
      if (!distributorSub) return Alert.alert('Error', 'Please select a sub-type');
      if (distributorSub === 'OTHER' && !remarks.trim())
        return Alert.alert('Error', 'Please enter remarks for OTHER');
      if (distributorSub === 'SV - NAME CHANGE' && !svNameChangeAmount)
        return Alert.alert('Error', 'Please select ₹850 or ₹1100');
      if (distributorSub === 'DBTL' && !dbtlSubSelected)
        return Alert.alert('Error', 'Please select a DBTL option');
      if (distributorSub === 'DBTL' && dbtlSubSelected === 'OTHER' && !remarks.trim())
        return Alert.alert('Error', 'Please enter remarks for OTHER');
      if (distributorSub === 'TV') {
        setTvConsumerName('');
        setTvCylinders('');
        setShowTvPopup(true);
        return;
      }
    }

    if (!rate || !quantity) return Alert.alert('Error', 'Rate and Quantity are required');

    if (selectedType === 'CREDIT') {
      requestPaymentMode((paymentModeText, isPaytm) => processSubmit(paymentModeText, isPaytm));
    } else {
      processSubmit('', false);
    }
  };

  const isAutoFilled =
    selectedCategory === 'WEEKLY SALARY' ||
    (selectedType === 'CREDIT' && selectedCategory === 'BALANCE');

  // ─── FILE 2: TOTALS/LEDGER DELETIONS & BOTTOM SHEET EDIT ──────────────────

  const revertCommercialRecords = async (entry: Transaction): Promise<boolean> => {
    if (entry.category !== 'COMMERCIAL PAYMENT') return true;

    const parsed = parseCommercialRemarks(entry.remarks);
    if (!parsed) {
      console.warn('⚠️ Could not parse commercial remarks:', entry.remarks);
      return true;
    }

    const { customerName, deliveryDate } = parsed;

    try {
      const { data: paidRows, error: fetchErr } = await supabase
        .from('dashboard_commercialrecords')
        .select('id')
        .eq('customer_name', customerName)
        .eq('delivery_date', deliveryDate)
        .eq('payment_date', entry.date)
        .order('id')
        .limit(entry.quantity);

      if (fetchErr) throw fetchErr;

      if (!paidRows || paidRows.length === 0) {
        console.warn(`⚠️ No paid commercial records found for ${customerName}`);
        return true;
      }

      const ids = paidRows.map((r: any) => r.id);

      const { error: revertErr } = await supabase
        .from('dashboard_commercialrecords')
        .update({ payment_date: null, amount: null })
        .in('id', ids);

      if (revertErr) throw revertErr;
      return true;
    } catch (err: any) {
      console.error('❌ Revert failed:', err.message);
      return false;
    }
  };

  const handleDeleteLedgerItem = (entry: Transaction) => {
    const isCommercial = entry.category === 'COMMERCIAL PAYMENT';
    const commercialWarning = isCommercial
      ? '\n\n⚠️ This will also revert the commercial payment record back to unpaid.'
      : '';

    Alert.alert(
      'Delete Entry',
      `Are you sure you want to delete this entry?\n\n📌 ${entry.category}\n💰 ₹${entry.amount}\n📅 ${entry.date}${commercialWarning}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => confirmDeleteLedgerItem(entry),
        },
      ]
    );
  };

  const confirmDeleteLedgerItem = async (entry: Transaction) => {
    setDeletingId(entry.id);
    try {
      if (entry.category === 'COMMERCIAL PAYMENT') {
        const reverted = await revertCommercialRecords(entry);
        if (!reverted) {
          Alert.alert('Warning', 'Could not revert commercial payment records. Entry NOT deleted.');
          return;
        }
      }

      if (entry.debit_balance_report_id) {
        if (entry.transactions === 'DEBIT') {
          const { error: debitDeleteErr } = await supabase
            .from('dashboard_debitbalancereport')
            .delete()
            .eq('id', entry.debit_balance_report_id);

          if (debitDeleteErr) throw debitDeleteErr;

        } else if (entry.transactions === 'CREDIT') {
          const { data: reportRow, error: fetchErr } = await supabase
            .from('dashboard_debitbalancereport')
            .select('date_received, amount_rec, amount')
            .eq('id', entry.debit_balance_report_id)
            .single();

          if (fetchErr) throw fetchErr;

          const existingDates: string[] = (reportRow.date_received || '')
            .split(',')
            .map((d: string) => d.trim())
            .filter(Boolean);

          let removed = false;
          const updatedDates = existingDates.filter(d => {
            if (!removed && d === entry.date) {
              removed = true;
              return false;
            }
            return true;
          });
          const newDateReceived = updatedDates.length > 0 ? updatedDates.join(', ') : null;

          const newAmountRec = (reportRow.amount_rec || 0) - entry.amount;
          const newStatus = newAmountRec >= (reportRow.amount || 0);

          const { error: updateErr } = await supabase
            .from('dashboard_debitbalancereport')
            .update({
              date_received: newDateReceived,
              amount_rec:    newAmountRec,
              status:        newStatus,
            })
            .eq('id', entry.debit_balance_report_id);

          if (updateErr) throw updateErr;
        }
      }

      const { error } = await supabase
        .from('dashboard_dailyrecordsachin')
        .delete()
        .eq('id', entry.id);

      if (error) throw error;

      Alert.alert(
        'Success',
        entry.category === 'COMMERCIAL PAYMENT'
          ? 'Entry deleted and commercial payment reverted successfully'
          : 'Entry deleted successfully'
      );
      fetchTotals(selectedDate);
      fetchLedgerData();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to delete entry');
    } finally {
      setDeletingId(null);
    }
  };

  const handleEditLedgerItem = (entry: Transaction) => {
    setEditingEntry(entry);
    setEditCategory(entry.category || '');
    setEditRate(String(entry.rate ?? ''));
    setEditQuantity(String(entry.quantity ?? ''));
    setEditAmount(String(entry.amount ?? ''));
    setEditRemarks(entry.remarks || '');
    setTimeout(() => {
      totalsBottomSheetRef.current?.snapToIndex(0);
    }, 50);
  };

  const handleEditClose = () => {
    totalsBottomSheetRef.current?.close();
    setEditingEntry(null);
  };

  const handleEditRateChange = (val: string) => {
    setEditRate(val);
    const rateVal = parseFloat(val) || 0;
    const qtyVal = parseInt(editQuantity, 10) || 0;
    if (rateVal > 0 && qtyVal > 0) {
      setEditAmount(String(Math.round(rateVal * qtyVal)));
    }
  };

  const handleEditQuantityChange = (val: string) => {
    setEditQuantity(val);
    const rateVal = parseFloat(editRate) || 0;
    const qtyVal = parseInt(val, 10) || 0;
    if (rateVal > 0 && qtyVal > 0) {
      setEditAmount(String(Math.round(rateVal * qtyVal)));
    }
  };

  const performDatabaseUpdate = async (entryId: number) => {
    const newRate     = parseFloat(editRate) || 0;
    const newQty      = parseInt(editQuantity, 10) || 0;
    const newAmount   = parseInt(editAmount, 10) || 0;
    const newCategory = editCategory.trim();
    const newRemarks  = editRemarks.trim();

    const { data, error } = await supabase
      .from('dashboard_dailyrecordsachin')
      .update({
        category: newCategory,
        rate:     newRate,
        quantity: newQty,
        amount:   newAmount,
        remarks:  newRemarks,
      })
      .eq('id', entryId)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error(`No row found with id=${entryId}. Update failed.`);
    }

    return data[0];
  };

  const applyCommercialRecords = async (
    customerName: string,
    deliveryDate: string,
    newRate: number,
    newQty: number
  ) => {
    const { data: pendingRows, error: pendingErr } = await supabase
      .from('dashboard_commercialrecords')
      .select('id')
      .eq('customer_name', customerName)
      .eq('delivery_date', deliveryDate)
      .is('payment_date', null)
      .order('id')
      .limit(newQty);

    if (pendingErr) throw pendingErr;

    if (!pendingRows || pendingRows.length === 0) {
      Alert.alert(
        'Warning',
        `Daily record updated, but no pending commercial records found for ${customerName} on ${deliveryDate}. Please verify manually.`
      );
      return;
    }

    const ids = pendingRows.map((r: any) => r.id);

    const { error: applyErr } = await supabase
      .from('dashboard_commercialrecords')
      .update({ payment_date: selectedDate, amount: newRate })
      .in('id', ids);

    if (applyErr) throw applyErr;
  };

  const handleSaveEdit = async () => {
    if (!editingEntry) return;

    if (!editCategory.trim()) {
      Alert.alert('Validation Error', 'Category cannot be empty');
      return;
    }

    const newAmt = parseInt(editAmount, 10);
    if (!editAmount || isNaN(newAmt) || newAmt <= 0) {
      Alert.alert('Validation Error', 'Amount must be greater than 0');
      return;
    }

    const isCommercialEntry = editingEntry.category === 'COMMERCIAL PAYMENT';

    if (isCommercialEntry) {
      const parsedOld = parseCommercialRemarks(editingEntry.remarks);
      const oldInfo = parsedOld
        ? `${parsedOld.customerName} (${parsedOld.deliveryDate})`
        : 'Unknown';

      Alert.alert(
        'Confirm Edit',
        `This will revert the old commercial payment for:\n${oldInfo}\n\nOld Amount: ₹${editingEntry.amount}\nNew Amount: ₹${newAmt}\n\nContinue?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm',
            onPress: () => { saveCommercialEdit(newAmt); },
          },
        ]
      );
    } else {
      await saveNonCommercialEdit();
    }
  };

  const saveNonCommercialEdit = async () => {
    if (!editingEntry) return;
    setSavingLedger(true);
    try {
      await performDatabaseUpdate(editingEntry.id);
      Alert.alert('Success', 'Entry updated successfully');
      handleEditClose();
      fetchLedgerData();
      fetchTotals(selectedDate);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update entry');
    } finally {
      setSavingLedger(false);
    }
  };

  const saveCommercialEdit = async (newAmt: number) => {
    if (!editingEntry) return;
    setSavingLedger(true);

    const newRate    = parseFloat(editRate) || 0;
    const newQty     = parseInt(editQuantity, 10) || 0;
    const newRemarks = editRemarks.trim();
    const parsedNew  = parseCommercialRemarks(newRemarks);

    try {
      const reverted = await revertCommercialRecords(editingEntry);
      if (!reverted) {
        Alert.alert('Error', 'Failed to revert old commercial records. Edit aborted.');
        setSavingLedger(false);
        return;
      }

      await performDatabaseUpdate(editingEntry.id);

      if (editCategory.trim() === 'COMMERCIAL PAYMENT' && parsedNew) {
        await applyCommercialRecords(
          parsedNew.customerName,
          parsedNew.deliveryDate,
          newRate,
          newQty
        );
      }

      Alert.alert('Success', 'Entry and commercial records updated successfully');
      handleEditClose();
      fetchLedgerData();
      fetchTotals(selectedDate);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update entry');
    } finally {
      setSavingLedger(false);
    }
  };

  const activeEntries = selectedView === 'CREDIT' ? creditEntries : debitEntries;
  const activeTotal   = selectedView === 'CREDIT' ? creditTotal   : debitTotal;
  const netBalance    = creditTotal - debitTotal;

  // ─── LEDGER CARD COMPONENT RENDER ──────────────────────────────────────────

  const renderEntryCard = (entry: Transaction, index: number) => {
    const isDeleting   = deletingId === entry.id;
    const isCredit     = entry.transactions === 'CREDIT';
    const isCommercial = entry.category === 'COMMERCIAL PAYMENT';
    const parsedCommercial = isCommercial ? parseCommercialRemarks(entry.remarks) : null;

    return (
      <View key={entry.id} style={styles.entryCard}>

        {isCommercial && parsedCommercial && (
          <View style={styles.commercialBanner}>
            <Ionicons name="business-outline" size={13} color="#7b4f00" />
            <Text style={styles.commercialBannerText}>
              Commercial · {parsedCommercial.customerName} ·{' '}
              {format(new Date(parsedCommercial.deliveryDate), 'dd MMM yyyy')}
            </Text>
          </View>
        )}

        <View style={styles.entryTopRow}>
          <View style={styles.entryLeft}>
            <View style={[styles.entryIndexBadge, { backgroundColor: isCredit ? '#e8f5e9' : '#ffebee' }]}>
              <Text style={[styles.entryIndex, { color: isCredit ? '#27ae60' : '#e74c3c' }]}>
                #{index + 1}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.entryCategory}>{entry.remarks ? entry.remarks : '—'}</Text>
              <Text style={styles.entrySource} numberOfLines={1}>{entry.category}</Text>
            </View>
          </View>

          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            {entry.paytm_transaction && (
              <View style={styles.paytmBadge}>
                <Text style={styles.paytmText}>📱 Paytm</Text>
              </View>
            )}
            <Text style={[styles.entryAmount, isCredit ? styles.creditAmount : styles.debitAmount]}>
              ₹{Number(entry.amount || 0).toLocaleString()}
            </Text>
          </View>
        </View>

        <View style={styles.entryDetails}>
          <View style={styles.detailCol}>
            <Text style={styles.detailLabel}>Rate</Text>
            <Text style={styles.detailValue}>₹{Number(entry.rate || 0).toFixed(2)}</Text>
          </View>
          <View style={styles.detailCol}>
            <Text style={styles.detailLabel}>Quantity</Text>
            <Text style={styles.detailValue}>{entry.quantity || 0}</Text>
          </View>
          <View style={styles.detailCol}>
            <Text style={styles.detailLabel}>Type</Text>
            <Text style={[styles.detailValue, isCredit ? styles.creditAmount : styles.debitAmount]}>
              {entry.transactions}
            </Text>
          </View>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.editButton}
            onPress={() => handleEditLedgerItem(entry)}
            disabled={isDeleting}
          >
            <Ionicons name="pencil" size={16} color={BPCL_BLUE} />
            <Text style={styles.editButtonText}>Edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.deleteButton, isDeleting && styles.buttonDisabled]}
            onPress={() => handleDeleteLedgerItem(entry)}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <ActivityIndicator size="small" color="#e74c3c" />
            ) : (
              <>
                <Ionicons name="trash" size={16} color="#e74c3c" />
                <Text style={styles.deleteButtonText}>
                  {isCommercial ? 'Delete & Revert' : 'Delete'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── RENDER: TRANSACTION FORM TAB ──────────────────────────────────────────

  const renderNewEntryTab = () => {
    return (
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* TYPE */}
        <View style={styles.card}>
          <Text style={styles.label}>Transaction Type</Text>
          <View style={styles.radioGroup}>
            <TouchableOpacity
              style={[styles.radioButton, selectedType === 'DEBIT' && styles.radioSelected]}
              onPress={() => setSelectedType('DEBIT')}
            >
              <Text style={[styles.radioText, selectedType === 'DEBIT' && styles.radioTextSelected]}>DEBIT</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.radioButton, selectedType === 'CREDIT' && styles.radioSelected]}
              onPress={() => setSelectedType('CREDIT')}
            >
              <Text style={[styles.radioText, selectedType === 'CREDIT' && styles.radioTextSelected]}>CREDIT</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* CATEGORY — searchable dropdown */}
        <View style={styles.card}>
          <Text style={styles.label}>Category *</Text>
          <TouchableOpacity
            style={styles.dropdownButton}
            onPress={() => setCategoryDropdownVisible(true)}
            activeOpacity={0.8}
          >
            <Text
              style={[styles.dropdownButtonText, !selectedCategory && styles.dropdownPlaceholder]}
              numberOfLines={1}
            >
              {selectedCategory || 'Tap to select category…'}
            </Text>
            <Ionicons name="chevron-down" size={18} color="#666" />
          </TouchableOpacity>
        </View>

        {/* SALES SUB-CATEGORIES */}
        {selectedCategory === 'SALE' && (
          <View style={styles.card}>
            <Text style={styles.label}>Select Item *</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {['SRT', 'DPR', 'DPR-CHANGE', 'LIGHTER', 'TOP STOVE', 'STOVE', '3 BUNNER STOVE', 'OTHER'].map((item) => (
                <TouchableOpacity
                  key={item}
                  style={[styles.categoryChip, selectedSalesSub === item && styles.categoryChipSelected]}
                  onPress={() => {
                    setSelectedSalesSub(item);
                    setRemarks(item);
                    if (SALE_RATES[item] !== undefined) {
                      setRate(SALE_RATES[item].toString());
                      setQuantity('1');
                    } else {
                      setRate('');
                    }
                  }}
                >
                  <Text style={[styles.categoryText, selectedSalesSub === item && styles.categoryTextSelected]}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {selectedSalesSub !== '' && SALE_RATES[selectedSalesSub] !== undefined && (
              <Text style={styles.autoRateHint}>
                💡 Rate auto-filled at ₹{SALE_RATES[selectedSalesSub]} — you can still edit it below
              </Text>
            )}
          </View>
        )}

        {/* SMALL CYLINDER */}
        {selectedCategory === 'SMALL CYLINDER' && (
          <View style={styles.card}>
            <Text style={styles.label}>Select Type *</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {['NC', 'REFILL', 'NEW CONNECTION'].map((item) => (
                <TouchableOpacity
                  key={item}
                  style={[styles.categoryChip, selectedSmallCyl === item && styles.categoryChipSelected]}
                  onPress={() => {
                    setSelectedSmallCyl(item);
                    setRemarks(item);
                    if (SMALL_CYLINDER_RATES[item] !== undefined) {
                      setRate(SMALL_CYLINDER_RATES[item].toString());
                      setQuantity('1');
                    } else {
                      setRate('');
                    }
                  }}
                >
                  <Text style={[styles.categoryText, selectedSmallCyl === item && styles.categoryTextSelected]}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {selectedSmallCyl !== '' && SMALL_CYLINDER_RATES[selectedSmallCyl] !== undefined && (
              <Text style={styles.autoRateHint}>
                💡 Rate auto-filled at ₹{SMALL_CYLINDER_RATES[selectedSmallCyl]} — you can still edit it below
              </Text>
            )}
          </View>
        )}

        {/* DRIVER EXPENDITURE */}
        {selectedCategory === 'DRIVER EXPENDITURE' && (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>Select Driver *</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {['AGRAWAL', 'VINOD', 'RAJESH SHINDE'].map((item) => (
                  <TouchableOpacity
                    key={item}
                    style={[styles.categoryChip, driverName === item && styles.categoryChipSelected]}
                    onPress={() => { setDriverName(item); setRemarks(expType ? `${item} - ${expType}` : item); }}
                  >
                    <Text style={[styles.categoryText, driverName === item && styles.categoryChipSelected]}>{item}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            {driverName !== '' && (
              <View style={styles.card}>
                <Text style={styles.label}>Select Expenditure Type *</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {['DAILY', 'BHATTA', 'CONDUCTOR', 'SALARY', 'U BOLT', 'HAVA'].map((item) => (
                    <TouchableOpacity
                      key={item}
                      style={[styles.categoryChip, expType === item && styles.categoryChipSelected]}
                      onPress={() => { setExpType(item); setRemarks(`${driverName} - ${item}`); }}
                    >
                      <Text style={[styles.categoryText, expType === item && styles.categoryChipSelected]}>{item}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </>
        )}

        {/* COMMERCIAL PAYMENT */}
        {selectedCategory === 'COMMERCIAL PAYMENT' && (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>Select Consumer *</Text>
              {selectedCommercialName !== '' ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#e8f4f8', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: BPCL_BLUE }}>
                  <View>
                    <Text style={{ color: '#888', fontSize: 12 }}>Selected Consumer</Text>
                    <Text style={{ color: BPCL_BLUE, fontWeight: 'bold', fontSize: 16, marginTop: 2 }}>{selectedCommercialName}</Text>
                    {commercialDiscount ? <Text style={{ color: '#888', fontSize: 12, marginTop: 2 }}>Discount: ₹{commercialDiscount}</Text> : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => { setSelectedCommercialName(''); setCommercialDiscount(0); setCommercialPendingDates([]); setSelectedCommercialDate(''); setCommercialSearch(''); setRate(''); setQuantity('1'); setRemarks(''); setDiscountActuallyApplied(false); }}
                    style={{ backgroundColor: '#fff', borderWidth: 1, borderColor: BPCL_BLUE, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
                  >
                    <Text style={{ color: BPCL_BLUE, fontWeight: '600', fontSize: 13 }}>✎ Change</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <TextInput
                    style={[styles.input, { marginBottom: 12 }]}
                    placeholder="Search consumer..."
                    value={commercialSearch}
                    onChangeText={(text) => setCommercialSearch(text.toUpperCase())}
                    autoCorrect={false}
                  />
                  {loadingCommercialNames ? (
                    <ActivityIndicator color={BPCL_BLUE} />
                  ) : (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {commercialNames
                        .filter((item: any) => item.name.toUpperCase().includes(commercialSearch))
                        .map((item: any) => (
                          <TouchableOpacity
                            key={item.name}
                            style={[styles.categoryChip, selectedCommercialName === item.name && styles.categoryChipSelected]}
                            onPress={() => { handleCommercialNameSelect(item.name, item.discount || 0); setCommercialSearch(''); }}
                          >
                            <Text style={[styles.categoryText, selectedCommercialName === item.name && styles.categoryChipSelected]}>
                              {item.name}{item.discount ? `  (-₹${item.discount})` : ''}
                            </Text>
                          </TouchableOpacity>
                        ))}
                    </View>
                  )}
                </>
              )}
            </View>

            {selectedCommercialName !== '' && (
              <View style={styles.card}>
                <Text style={styles.label}>Select Pending Date *</Text>
                {loadingCommercialDates ? (
                  <ActivityIndicator color={BPCL_BLUE} />
                ) : commercialPendingDates.length === 0 ? (
                  <Text style={styles.noInfoText}>✅ No pending records for {selectedCommercialName}</Text>
                ) : (
                  <View style={{ gap: 8 }}>
                    {commercialPendingDates.map((item: any) => {
                      return (
                        <TouchableOpacity
                          key={item.date}
                          style={[styles.categoryChip, selectedCommercialDate === item.date && styles.categoryChipSelected, { paddingVertical: 12 }]}
                          onPress={() => handleCommercialDateSelect(item)}
                        >
                          <Text style={[styles.categoryText, selectedCommercialDate === item.date && styles.categoryChipSelected]}>{item.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>
            )}

            {selectedCommercialDate !== '' && (
              <View style={[styles.card, { backgroundColor: discountActuallyApplied ? '#fff8e1' : '#f0fff4', borderLeftWidth: 4, borderLeftColor: discountActuallyApplied ? '#FFDC02' : '#27ae60' }]}>
                {discountActuallyApplied ? (
                  <>
                    <Text style={{ color: '#856404', fontWeight: '600', fontSize: 13 }}>💡 Discount Applied: ₹{commercialDiscount} per cylinder</Text>
                    <Text style={{ color: '#856404', fontSize: 12, marginTop: 4 }}>Rate after discount = Actual Rate − ₹{commercialDiscount}</Text>
                  </>
                ) : (
                  <Text style={{ color: '#276749', fontWeight: '600', fontSize: 13 }}>✅ No discount applied — full rate charged</Text>
                )}
              </View>
            )}
          </>
        )}

        {/* GODOWN */}
        {selectedCategory === 'GODOWN' && (
          <View style={styles.card}>
            <Text style={styles.label}>Select Type (Optional)</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {['HAMALI', 'HELPER', 'MAJURI', 'RL', 'KD', 'HAFTA', 'SUNDAY MAJURI', 'FUEL'].map((item) => (
                <TouchableOpacity
                  key={item}
                  style={[styles.categoryChip, remarks === `GODOWN - ${item}` && styles.categoryChipSelected]}
                  onPress={() => {
                    const isSelected = remarks === `GODOWN - ${item}`;
                    if (isSelected) {
                      setRemarks('');
                      setRate('');
                    } else {
                      setRemarks(`GODOWN - ${item}`);
                      setRate((GODOWN_RATES[item] ?? 0).toString());
                      setQuantity('1');
                    }
                  }}
                >
                  <Text style={[styles.categoryText, remarks === `GODOWN - ${item}` && styles.categoryChipSelected]}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {GODOWN_RATES[remarks.replace('GODOWN - ', '')] !== undefined && remarks.startsWith('GODOWN - ') && (
              <Text style={styles.autoRateHint}>
                💡 Rate auto-filled at ₹{GODOWN_RATES[remarks.replace('GODOWN - ', '')]} — tap again to clear
              </Text>
            )}
          </View>
        )}

        {/* BANK DEPOSIT */}
        {selectedCategory === 'BANK DEPOSIT' && (
          <View style={styles.card}>
            <Text style={styles.label}>Bank Name</Text>
            {['ARVIND', 'AUB', 'HDFC'].map((bank) => (
              <TouchableOpacity
                key={bank}
                style={[styles.categoryChip, selectedBank === bank && styles.categoryChipSelected]}
                onPress={() => { setSelectedBank(bank); setRemarks(bank); }}
              >
                <Text style={[styles.categoryText, selectedBank === bank && styles.categoryChipSelected]}>{bank}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* DISTRIBUTOR TRANSACTION */}
        {selectedCategory === 'DISTRIBUTOR TRANSACTION' && (
          <View style={styles.card}>
            <Text style={styles.label}>Select Sub-Type *</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(selectedType === 'CREDIT'
                ? ['SV', 'SV - NAME CHANGE', 'TV', 'DBTL', 'OTHER']
                : ['TV', 'OTHER']
              ).map((item) => (
                <TouchableOpacity
                  key={item}
                  style={[styles.categoryChip, distributorSub === item && styles.categoryChipSelected]}
                  onPress={() => {
                    setDistributorSub(item);
                    setSvNameChangeAmount(null);
                    setSvNameChangeTally(0);
                    setDbtlSubSelected('');
                    if (item === 'TV') { setTvConsumerName(''); setTvCylinders(''); setTvAmount(''); setShowTvPopup(true); }
                    else if (item === 'OTHER') { setRate(''); setQuantity('1'); setRemarks(''); }
                    else if (item === 'SV - NAME CHANGE') { setRate(''); setQuantity('1'); setRemarks('SV - NAME CHANGE'); }
                    else if (item === 'DBTL') { setRate(''); setQuantity('1'); setRemarks(''); }
                    else { setRate(''); setQuantity('1'); setRemarks(item); }
                  }}
                >
                  <Text style={[styles.categoryText, distributorSub === item && styles.categoryChipSelected]}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {distributorSub === 'OTHER' && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.label}>Specify Remarks *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter details..."
                  value={remarks}
                  onChangeText={(text) => setRemarks(text.toUpperCase())}
                  autoCorrect={false}
                />
              </View>
            )}

            {/* SV - NAME CHANGE */}
            {distributorSub === 'SV - NAME CHANGE' && (
              <View style={{ marginTop: 14 }}>
                <Text style={styles.label}>Select Amount (tap again to add another) *</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    style={[styles.svAmountBtn, svNameChangeAmount === 850 && styles.svAmountBtnSelected]}
                    onPress={() => handleSvAmountPress(850)}
                  >
                    <Text style={[styles.svAmountBtnText, svNameChangeAmount === 850 && styles.svAmountBtnTextSelected]}>
                      ₹850{svNameChangeAmount === 850 ? ` × ${svNameChangeTally}` : ''}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.svAmountBtn, svNameChangeAmount === 1100 && styles.svAmountBtnSelected]}
                    onPress={() => handleSvAmountPress(1100)}
                  >
                    <Text style={[styles.svAmountBtnText, svNameChangeAmount === 1100 && styles.svAmountBtnTextSelected]}>
                      ₹1100{svNameChangeAmount === 1100 ? ` × ${svNameChangeTally}` : ''}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.svClearBtn} onPress={handleSvNameChangeClear}>
                    <Text style={styles.svClearBtnText}>Clear</Text>
                  </TouchableOpacity>
                </View>
                {svNameChangeAmount !== null && (
                  <Text style={styles.autoRateHint}>
                    💡 Rate ₹{svNameChangeAmount} × Qty {svNameChangeTally} = ₹{svNameChangeAmount * svNameChangeTally}
                  </Text>
                )}
              </View>
            )}

            {/* DBTL */}
            {distributorSub === 'DBTL' && (
              <View style={{ marginTop: 14 }}>
                <Text style={styles.label}>Select DBTL Option *</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {(['568', '435', 'OTHER'] as const).map((item) => (
                    <TouchableOpacity
                      key={item}
                      style={[styles.categoryChip, dbtlSubSelected === item && styles.categoryChipSelected]}
                      onPress={() => handleDbtlSelect(item)}
                    >
                      <Text style={[styles.categoryText, dbtlSubSelected === item && styles.categoryChipSelected]}>
                        {item === 'OTHER' ? 'OTHER' : `₹${item}`}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {dbtlSubSelected !== '' && dbtlSubSelected !== 'OTHER' && (
                  <Text style={styles.autoRateHint}>💡 Rate auto-filled at ₹{dbtlSubSelected}</Text>
                )}
                {dbtlSubSelected === 'OTHER' && (
                  <View style={{ marginTop: 12 }}>
                    <Text style={styles.label}>Specify Remarks *</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Enter details..."
                      value={remarks}
                      onChangeText={(text) => setRemarks(text.toUpperCase())}
                      autoCorrect={false}
                    />
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {/* WEEKLY SALARY */}
        {selectedCategory === 'WEEKLY SALARY' && selectedType === 'DEBIT' && (
          <View style={styles.card}>
            <Text style={styles.label}>Unpaid Commission Staff *</Text>
            {loadingUnpaidSalaryNames || loadingSalaryDetails ? (
              <ActivityIndicator color={BPCL_BLUE} />
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {unpaidSalaryNames.map((name: string) => (
                  <TouchableOpacity
                    key={name}
                    style={[styles.categoryChip, selectedSalaryName === name && styles.categoryChipSelected]}
                    onPress={async () => {
                      setSelectedSalaryName(name);
                      setRemarks(name);
                      setBonusApplied(false);
                      setBonusAmountApplied(0);
                      loadBalanceDetails(name, 'DEBIT');
                      fetchWeeklyDeliveryBreakdown(name);
                      const details = await loadSalaryDetails(name, selectedDate);
                      if (details) { setRate(details.rate.toString()); setQuantity(details.quantity.toString()); }
                    }}
                  >
                    <Text style={[styles.categoryText, selectedSalaryName === name && styles.categoryChipSelected]}>{name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {selectedSalaryName !== '' && (
              <TouchableOpacity
                style={styles.bonusCheckboxRow}
                onPress={handleToggleNamedBonus}
                disabled={checkingBonus}
                activeOpacity={0.8}
              >
                <View style={[styles.checkbox, bonusApplied && styles.checkboxChecked]}>
                  {bonusApplied && <Text style={styles.checkboxTick}>✓</Text>}
                </View>
                <Text style={styles.bonusCheckboxLabel}>Apply Named Bonus</Text>
                {checkingBonus && <ActivityIndicator size="small" color={BPCL_BLUE} style={{ marginLeft: 8 }} />}
                {bonusApplied && !checkingBonus && (
                  <Text style={styles.bonusAppliedTag}>+₹{bonusAmountApplied}</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* PENDING DEBIT BALANCE WITH CHECKBOXES */}
        {selectedCategory === 'WEEKLY SALARY' && selectedType === 'DEBIT' && selectedSalaryName ? (
          <View style={styles.card}>
            <Text style={styles.infoBoxTitle}>Pending Debit Balances — Select to Deduct</Text>
            {loadingBalanceDetails ? (
              <ActivityIndicator color={BPCL_BLUE} size="small" />
            ) : balanceDetails.length === 0 ? (
              <Text style={styles.noInfoText}>No pending debit balance records found for {selectedSalaryName}.</Text>
            ) : (
              <>
                <View style={styles.balanceListContainer}>
                  {balanceDetails.map((item: any) => {
                    const isChecked = !!checkedBalances[item.id];
                    return (
                      <View key={item.id} style={styles.balanceCheckRow}>
                        <TouchableOpacity
                          style={[styles.checkbox, isChecked && styles.checkboxChecked]}
                          onPress={() => handleBalanceCheckboxTap(item)}
                        >
                          {isChecked && <Text style={styles.checkboxTick}>✓</Text>}
                        </TouchableOpacity>
                        <View style={styles.balanceCheckInfo}>
                          <Text style={styles.balanceCheckDate}>📅 {item.date}</Text>
                          <Text style={styles.balanceCheckAmt}>
                            ₹{item.amount}
                            {item.amount_rec ? <Text style={styles.balanceCheckRec}>  (Rec: ₹{item.amount_rec})</Text> : null}
                          </Text>
                        </View>
                        {isChecked && (
                          <TextInput
                            style={styles.balanceCheckInput}
                            keyboardType="numeric"
                            value={balanceInputAmounts[item.id] || ''}
                            onChangeText={(val) =>
                              setBalanceInputAmounts(prev => ({ ...prev, [item.id]: val }))
                            }
                          />
                        )}
                      </View>
                    );
                  })}
                </View>

                {checkedBalanceTotal > 0 && (
                  <View style={styles.deductionSummaryBox}>
                    <Text style={styles.deductionLabel}>Balance Deducted</Text>
                    <Text style={styles.deductionMinus}>− ₹{checkedBalanceTotal.toLocaleString('en-IN')}</Text>
                    <View style={styles.deductionDivider} />
                    <Text style={styles.deductionLabel}>Salary to be Given</Text>
                    <Text style={styles.deductionFinal}>
                      ₹{Math.max(0, amount - checkedBalanceTotal).toLocaleString('en-IN')}
                    </Text>
                    <Text style={styles.deductionNote}>
                      * Salary entry saved as ₹{amount} (original). Credit entries created separately for each deducted balance.
                    </Text>
                  </View>
                )}
              </>
            )}
          </View>
        ) : null}

        {/* BALANCE — name picker */}
        {selectedCategory === 'BALANCE' && (
          <View style={styles.card}>
            <Text style={styles.label}>{selectedType === 'CREDIT' ? 'Recent Closed Balance' : 'Delivery Boy Name'}</Text>
            {loadingBalanceNames || loadingEmployees ? (
              <ActivityIndicator color={BPCL_BLUE} />
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {(selectedType === 'CREDIT' ? balanceNames : employees).map((name: string) => (
                  <TouchableOpacity
                    key={name}
                    style={[styles.categoryChip, selectedName === name && styles.categoryChipSelected]}
                    onPress={() => { setSelectedName(name); if (selectedType === 'DEBIT') setRemarks(`${name}`); }}
                  >
                    <Text style={[styles.categoryText, selectedName === name && styles.categoryChipSelected]}>{name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        )}

        {/* CREDIT + BALANCE: multi-select checkboxes */}
        {selectedType === 'CREDIT' && selectedCategory === 'BALANCE' && selectedName && (
          <View style={styles.card}>
            <Text style={styles.label}>Select Balance Records *</Text>
            {loadingBalanceDetails ? (
              <ActivityIndicator color={BPCL_BLUE} />
            ) : balanceDetails.length === 0 ? (
              <Text style={styles.noInfoText}>No pending balance records found for {selectedName}.</Text>
            ) : (
              <>
                <View style={styles.balanceListContainer}>
                  {balanceDetails.map((item: any) => {
                    const isChecked = !!checkedBalances[item.id];
                    return (
                      <View key={item.id} style={styles.balanceCheckRow}>
                        <TouchableOpacity
                          style={[styles.checkbox, isChecked && styles.checkboxChecked]}
                          onPress={() => handleBalanceCheckboxTap(item)}
                        >
                          {isChecked && <Text style={styles.checkboxTick}>✓</Text>}
                        </TouchableOpacity>
                        <View style={styles.balanceCheckInfo}>
                          <Text style={styles.balanceCheckDate}>📅 {item.date}</Text>
                          <Text style={styles.balanceCheckAmt}>
                            ₹{item.amount}
                            {item.amount_rec ? <Text style={styles.balanceCheckRec}>  (Rec: ₹{item.amount_rec})</Text> : null}
                          </Text>
                        </View>
                        {isChecked && (
                          <TextInput
                            style={styles.balanceCheckInput}
                            keyboardType="numeric"
                            value={balanceInputAmounts[item.id] || ''}
                            onChangeText={(val) =>
                              setBalanceInputAmounts(prev => ({ ...prev, [item.id]: val }))
                            }
                          />
                        )}
                      </View>
                    );
                  })}
                </View>

                {checkedBalanceTotal > 0 && (
                  <View style={[styles.deductionSummaryBox, { backgroundColor: '#e8f4f8', borderColor: BPCL_BLUE }]}>
                    <Text style={[styles.deductionLabel, { color: BPCL_BLUE }]}>Total Credit Amount</Text>
                    <Text style={[styles.deductionFinal, { color: BPCL_BLUE }]}>
                      ₹{checkedBalanceTotal.toLocaleString('en-IN')}
                    </Text>
                    <Text style={styles.deductionNote}>
                      * {Object.keys(checkedBalances).filter(id => checkedBalances[Number(id)]).length} credit entry/entries will be created.
                    </Text>
                  </View>
                )}
              </>
            )}
          </View>
        )}

        {/* RATE / QUANTITY / AMOUNT */}
        {!(selectedType === 'CREDIT' && selectedCategory === 'BALANCE') && (
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.half}>
                <Text style={styles.label}>Rate</Text>
                <TextInput
                  style={[styles.input, isAutoFilled && styles.inputDisabled]}
                  keyboardType="decimal-pad"
                  value={rate}
                  onChangeText={setRate}
                  editable={true}
                  placeholder="Enter rate"
                />
              </View>
              <View style={styles.half}>
                <Text style={styles.label}>Quantity</Text>
                <TextInput
                  style={[styles.input, isAutoFilled && styles.inputDisabled]}
                  keyboardType="numeric"
                  value={quantity}
                  onChangeText={setQuantity}
                  editable={true}
                  placeholder="1"
                />
              </View>
            </View>
            <View style={styles.amountBox}>
              <Text style={styles.amountLabel}>Total Amount</Text>
              <Text style={styles.amountValue}>₹ {amount}</Text>
            </View>
          </View>
        )}

        {/* REMARKS */}
        {!(selectedType === 'CREDIT' && selectedCategory === 'BALANCE') && (
          <View style={styles.card}>
            <Text style={styles.label}>Remarks</Text>
            <TextInput
              style={[styles.input, styles.remarksInput]}
              value={remarks}
              onChangeText={(text) => setRemarks(text.toUpperCase())}
              multiline
              placeholder="Remarks field"
            />
          </View>
        )}

        {/* WEEKLY SALARY: day-wise delivery breakdown */}
        {selectedCategory === 'WEEKLY SALARY' && selectedType === 'DEBIT' && selectedSalaryName && (
          <View style={styles.card}>
            <Text style={styles.label}>Delivery Breakdown ({selectedSalaryName})</Text>
            {loadingWeeklyBreakdown ? (
              <ActivityIndicator color={BPCL_BLUE} size="small" />
            ) : weeklyDeliveryBreakdown.length === 0 ? (
              <Text style={styles.noInfoText}>No pending delivery records found for {selectedSalaryName}.</Text>
            ) : (
              <>
                <View style={styles.breakdownListContainer}>
                  {weeklyDeliveryBreakdown.map((item) => (
                    <View key={item.date} style={styles.breakdownRow}>
                      <Text style={styles.breakdownDate}>📅 {format(new Date(item.date + 'T00:00:00'), 'dd/MM/yy')}</Text>
                      <Text style={styles.breakdownQty}>{item.qty}</Text>
                    </View>
                  ))}
                </View>
                <View style={styles.breakdownTotalRow}>
                  <Text style={styles.breakdownTotalLabel}>Total</Text>
                  <Text style={styles.breakdownTotalValue}>
                    {weeklyDeliveryBreakdown.reduce((sum, item) => sum + item.qty, 0)}
                  </Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* SUBMIT */}
        {(selectedType === 'CREDIT' && selectedCategory === 'BALANCE')
          ? checkedBalanceTotal > 0 && (
              <TouchableOpacity style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
                {submitting
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitText}>SAVE {Object.keys(checkedBalances).filter(id => checkedBalances[Number(id)]).length} CREDIT ENTR{Object.keys(checkedBalances).filter(id => checkedBalances[Number(id)]).length === 1 ? 'Y' : 'IES'}</Text>
                }
              </TouchableOpacity>
            )
          : (
            <TouchableOpacity style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>SAVE TRANSACTION</Text>
              }
            </TouchableOpacity>
          )
        }
      </ScrollView>
    );
  };

  const renderDailyTotalsTab = () => {
    const activeEntries = selectedView === 'CREDIT' ? creditEntries : debitEntries;
    const activeTotal   = selectedView === 'CREDIT' ? creditTotal   : debitTotal;
    const netBalance    = creditTotal - debitTotal;

    return (
      <View style={{ flex: 1 }}>
        {loadingLedger ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={BPCL_BLUE} />
            <Text style={styles.loadingText}>Loading totals...</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.scrollView}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Summary Card */}
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>Transaction Summary</Text>

              <View style={styles.totalCardsRow}>
                <TouchableOpacity
                  style={[styles.totalCard, styles.creditCard, selectedView === 'CREDIT' && styles.totalCardSelected]}
                  onPress={() => setSelectedView('CREDIT')}
                  activeOpacity={0.8}
                >
                  <Ionicons name="arrow-down-circle" size={28} color="#27ae60" />
                  <Text style={styles.totalLabel}>Credit</Text>
                  <Text style={[styles.totalAmount, styles.creditAmount]}>
                    ₹{Number(creditTotal).toLocaleString()}
                  </Text>
                  <Text style={styles.entryCount}>{creditEntries.length} entries</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.totalCard, styles.debitCard, selectedView === 'DEBIT' && styles.totalCardSelected]}
                  onPress={() => setSelectedView('DEBIT')}
                  activeOpacity={0.8}
                >
                  <Ionicons name="arrow-up-circle" size={28} color="#dc2626" />
                  <Text style={styles.totalLabel}>Debit</Text>
                  <Text style={[styles.totalAmount, styles.debitAmount]}>
                    ₹{Number(debitTotal).toLocaleString()}
                  </Text>
                  <Text style={styles.entryCount}>{debitEntries.length} entries</Text>
                </TouchableOpacity>
              </View>

              <View style={[styles.balanceBox, { backgroundColor: netBalance >= 0 ? '#e8f5e9' : '#ffebee' }]}>
                <Text style={styles.balanceLabel}>Net Balance</Text>
                <Text style={[styles.balanceValue, netBalance >= 0 ? styles.balancePositive : styles.balanceNegative]}>
                  {netBalance >= 0 ? '+' : ''}₹{Number(netBalance).toLocaleString()}
                </Text>
              </View>
            </View>

            {/* Entries Toggle Header */}
            <View style={styles.entriesHeader}>
              <View style={styles.viewToggle}>
                <TouchableOpacity
                  style={[styles.viewToggleBtn, selectedView === 'CREDIT' && styles.viewToggleBtnActive]}
                  onPress={() => setSelectedView('CREDIT')}
                >
                  <Text style={[styles.viewToggleBtnText, selectedView === 'CREDIT' && styles.viewToggleBtnTextActive]}>
                    Credit ({creditEntries.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.viewToggleBtn, selectedView === 'DEBIT' && styles.viewToggleBtnActive]}
                  onPress={() => setSelectedView('DEBIT')}
                >
                  <Text style={[styles.viewToggleBtnText, selectedView === 'DEBIT' && styles.viewToggleBtnTextActive]}>
                    Debit ({debitEntries.length})
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={[styles.sectionTotal, selectedView === 'CREDIT' ? styles.creditAmount : styles.debitAmount]}>
                ₹{Number(activeTotal).toLocaleString()}
              </Text>
            </View>

            {activeEntries.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="document-text-outline" size={64} color="#ddd" />
                <Text style={styles.emptyText}>
                  No {selectedView.toLowerCase()} entries for this date
                </Text>
              </View>
            ) : (
              activeEntries.map((entry, index) => renderEntryCard(entry, index))
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* ══════════  HEADER  ══════════ */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>
                {activeTab === 'entry' ? 'Daily Transaction' : 'Daily Totals'}
              </Text>
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

            {/* ── PDF download buttons: Sachin ledger + JD ledger ── */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={styles.totalNavBtn}
                onPress={handleDownloadPdf}
                activeOpacity={0.8}
                disabled={exportingPdf}
              >
                {exportingPdf ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="download-outline" size={15} color="#fff" />
                    <Text style={styles.totalNavBtnText}>PDF</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.totalNavBtn}
                onPress={handleDownloadJdPdf}
                activeOpacity={0.8}
                disabled={exportingJdPdf}
              >
                {exportingJdPdf ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="download-outline" size={15} color="#fff" />
                    <Text style={styles.totalNavBtnText}>JD</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </SafeAreaView>

      {/* Segmented Inner Tab Bar */}
      <View style={styles.innerTabBar}>
        <TouchableOpacity
          style={[styles.innerTab, activeTab === 'entry' && styles.innerTabActive]}
          onPress={() => setActiveTab('entry')}
        >
          <Ionicons name="add-circle-outline" size={16} color={activeTab === 'entry' ? '#fff' : BPCL_BLUE} />
          <Text style={[styles.innerTabText, activeTab === 'entry' && styles.innerTabTextActive]}>
            New Entry
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.innerTab, activeTab === 'totals' && styles.innerTabActive]}
          onPress={() => setActiveTab('totals')}
        >
          <Ionicons name="list-outline" size={16} color={activeTab === 'totals' ? '#fff' : BPCL_BLUE} />
          <Text style={[styles.innerTabText, activeTab === 'totals' && styles.innerTabTextActive]}>
            Daily Totals
          </Text>
        </TouchableOpacity>
      </View>

      {/* Dynamic Tab Render */}
      <View style={{ flex: 1 }}>
        {activeTab === 'entry' ? renderNewEntryTab() : renderDailyTotalsTab()}
      </View>

      {/* ══════════  CATEGORY DROPDOWN MODAL  ══════════ */}
      <Modal
        visible={categoryDropdownVisible}
        transparent
        animationType="fade"
        onRequestClose={() => { setCategoryDropdownVisible(false); setCategorySearchText(''); }}
      >
        <TouchableOpacity
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => { setCategoryDropdownVisible(false); setCategorySearchText(''); }}
        >
          <View style={styles.dropdownModalBox} onStartShouldSetResponder={() => true}>
            <Text style={styles.dropdownModalTitle}>Select Category</Text>
            <TextInput
              style={styles.dropdownSearchInput}
              placeholder="Type to search e.g. TOTAL AHD..."
              value={categorySearchText}
              onChangeText={(text) => setCategorySearchText(text.toUpperCase())}
              autoCorrect={false}
              autoFocus
            />
            {sortedCategories.length === 0 ? (
              <Text style={styles.noInfoText}>No matching categories</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
                {sortedCategories.map((cat: string) => {
                  const daysUsed = categoryDaysUsedCounts[cat] || 0;
                  return (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.dropdownItem, selectedCategory === cat && styles.dropdownItemSelected]}
                      onPress={() => {
                        setSelectedCategory(cat);
                        setCategoryDropdownVisible(false);
                        setCategorySearchText('');
                      }}
                    >
                      <Text style={[styles.dropdownItemText, selectedCategory === cat && styles.dropdownItemTextSelected]}>
                        {cat}
                      </Text>
                      {daysUsed > 0 && (
                        <Text style={styles.dropdownItemBadge}>{daysUsed} day{daysUsed > 1 ? 's' : ''} used</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ══════════  CASH / PAYTM PAYMENT MODE MODAL  ══════════ */}
      <Modal
        visible={paymentModeVisible}
        transparent
        animationType="fade"
        onRequestClose={handlePaymentModeClose}
      >
        <View style={styles.popupOverlay}>
          <View style={styles.paymentPopupBox}>

            <TouchableOpacity style={styles.paymentCloseBtn} onPress={handlePaymentModeClose}>
              <Text style={styles.paymentCloseBtnText}>✕</Text>
            </TouchableOpacity>

            <View style={styles.paymentIconCircle}>
              <Text style={styles.paymentIconText}>💳</Text>
            </View>
            <Text style={styles.paymentTitle}>Payment mode</Text>
            <Text style={styles.paymentSubtitle}>How was this credit received?</Text>

            <View style={styles.paymentDivider} />

            <TouchableOpacity
              style={[
                styles.paymentOptionBtn,
                paymentModeSelected === 'CASH' && styles.paymentOptionSelected,
              ]}
              onPress={() => setPaymentModeSelected('CASH')}
              activeOpacity={0.8}
            >
              <View style={[styles.paymentOptionIcon, { backgroundColor: '#EAF3DE' }]}>
                <Text style={{ fontSize: 18 }}>💵</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentOptionLabel}>Cash</Text>
                <Text style={styles.paymentOptionDesc}>Physical cash payment received</Text>
              </View>
              {paymentModeSelected === 'CASH' && (
                <View style={styles.paymentOptionTick}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>✓</Text>
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.paymentOptionBtn,
                paymentModeSelected === 'PAYTM' && styles.paymentOptionSelected,
              ]}
              onPress={() => setPaymentModeSelected('PAYTM')}
              activeOpacity={0.8}
            >
              <View style={[styles.paymentOptionIcon, { backgroundColor: '#E6F1FB' }]}>
                <Text style={{ fontSize: 18 }}>📱</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentOptionLabel}>Paytm</Text>
                <Text style={styles.paymentOptionDesc}>Digital / UPI payment received</Text>
              </View>
              {paymentModeSelected === 'PAYTM' && (
                <View style={styles.paymentOptionTick}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>✓</Text>
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.paymentConfirmBtn,
                !paymentModeSelected && styles.paymentConfirmBtnDisabled,
              ]}
              onPress={handlePaymentModeConfirm}
              disabled={!paymentModeSelected}
              activeOpacity={0.8}
            >
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.paymentConfirmBtnText}>Confirm payment</Text>
              }
            </TouchableOpacity>

          </View>
        </View>
      </Modal>

      {/* ─── BOTTOM SHEET: Edit Ledger Entry ─── */}
      <BottomSheet
        ref={totalsBottomSheetRef}
        index={-1}
        snapPoints={totalsSnapPoints}
        enablePanDownToClose
        backgroundStyle={styles.bottomSheetBg}
        handleIndicatorStyle={styles.bottomSheetHandle}
        onClose={() => setEditingEntry(null)}
      >
        <BottomSheetScrollView
          contentContainerStyle={styles.bottomSheetContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>Edit Entry</Text>
              {editingEntry && (
                <Text style={styles.sheetSubtitle}>
                  ID #{editingEntry.id} ·{' '}
                  <Text style={editingEntry.transactions === 'CREDIT' ? styles.creditAmount : styles.debitAmount}>
                    {editingEntry.transactions}
                  </Text>
                  {editingEntry.category === 'COMMERCIAL PAYMENT' && (
                    <Text style={{ color: '#7b4f00' }}> · 🏢 Commercial</Text>
                  )}
                </Text>
              )}
              {editingEntry?.category === 'COMMERCIAL PAYMENT' && (
                <View style={styles.commercialEditWarning}>
                  <Ionicons name="warning-outline" size={14} color="#856404" />
                  <Text style={styles.commercialEditWarningText}>
                    Editing will revert old commercial record and re-apply with new values.
                  </Text>
                </View>
              )}
            </View>
            <TouchableOpacity onPress={handleEditClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color="#666" />
            </TouchableOpacity>
          </View>

          <View style={styles.editField}>
            <Text style={styles.editLabel}>Category *</Text>
            <TextInput
              style={styles.editInput}
              value={editCategory}
              onChangeText={setEditCategory}
              placeholder="Enter category"
            />
          </View>

          <View style={styles.rowInputs}>
            <View style={[styles.editField, { flex: 1 }]}>
              <Text style={styles.editLabel}>Rate (₹)</Text>
              <TextInput
                style={styles.editInput}
                value={editRate}
                onChangeText={handleEditRateChange}
                placeholder="0.00"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={[styles.editField, { flex: 1 }]}>
              <Text style={styles.editLabel}>Quantity</Text>
              <TextInput
                style={styles.editInput}
                value={editQuantity}
                onChangeText={handleEditQuantityChange}
                placeholder="0"
                keyboardType="numeric"
              />
            </View>
          </View>

          <View style={styles.editField}>
            <Text style={styles.editLabel}>Amount (₹) *</Text>
            <TextInput
              style={[styles.editInput, styles.editInputHighlight]}
              value={editAmount}
              onChangeText={setEditAmount}
              placeholder="0"
              keyboardType="numeric"
            />
            <Text style={styles.editHint}>Auto-calculated from Rate × Quantity</Text>
          </View>

          <View style={styles.editField}>
            <Text style={styles.editLabel}>Remarks</Text>
            <TextInput
              style={[styles.editInput, styles.editInputMultiline]}
              value={editRemarks}
              onChangeText={setEditRemarks}
              placeholder="Optional remarks..."
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
            {editingEntry?.category === 'COMMERCIAL PAYMENT' && (
              <Text style={styles.commercialRemarksHint}>
                ⚠️ Keep format: CUSTOMERNAME(YYYY-MM-DD) for commercial sync
              </Text>
            )}
          </View>

          {editingEntry && (
            <View style={styles.originalValues}>
              <Text style={styles.originalValuesTitle}>📌 Original Values</Text>
              {[
                { label: 'Category', value: editingEntry.category },
                { label: 'Rate',     value: `₹${editingEntry.rate}` },
                { label: 'Quantity', value: String(editingEntry.quantity) },
                { label: 'Amount',   value: `₹${editingEntry.amount}` },
                { label: 'Remarks',  value: editingEntry.remarks || '-' },
              ].map(({ label, value }) => (
                <View key={label} style={styles.originalRow}>
                  <Text style={styles.originalLabel}>{label}:</Text>
                  <Text style={styles.originalValue}>{value}</Text>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity
            style={[styles.saveButton, savingLedger && styles.buttonDisabled]}
            onPress={handleSaveEdit}
            disabled={savingLedger}
          >
            {savingLedger ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={22} color="#fff" />
                <Text style={styles.saveButtonText}>Save Changes</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </BottomSheetScrollView>
      </BottomSheet>

      {/* ══════════  BALANCE AMOUNT CONFIRMATION POPUP  ══════════ */}
      <Modal
        visible={balancePopupVisible}
        transparent
        animationType="fade"
        onRequestClose={handleBalancePopupCancel}
      >
        <View style={styles.popupOverlay}>
          <View style={styles.popupBox}>
            <TouchableOpacity style={styles.popupCloseBtn} onPress={handleBalancePopupCancel}>
              <Text style={styles.popupCloseBtnText}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.popupTitle}>Credit Amount</Text>
            {balancePopupItem && (
              <Text style={styles.popupSubtitle}>
                Balance: ₹{balancePopupItem.amount}  |  Date: {balancePopupItem.date}
              </Text>
            )}
            <Text style={styles.popupLabel}>How much to credit?</Text>
            <TextInput
              style={styles.popupInput}
              keyboardType="numeric"
              value={balancePopupTempAmount}
              onChangeText={setBalancePopupTempAmount}
              autoFocus
              selectTextOnFocus
            />
            <TouchableOpacity
              style={[styles.popupBtn, { backgroundColor: BPCL_BLUE }]}
              onPress={handleBalancePopupConfirm}
            >
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ══════════  DISTRIBUTOR TV TRANSACTION POPUP  ══════════ */}
      {showTvPopup && (
        <View style={styles.tvPopupOverlay}>
          <View style={styles.tvPopupBox}>
            <View style={styles.tvPopupHeader}>
              <Text style={styles.tvPopupTitle}>TV Transaction</Text>
              <TouchableOpacity onPress={() => { setShowTvPopup(false); setDistributorSub(''); }}>
                <Text style={styles.tvPopupCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Consumer Name *</Text>
            <TextInput
              style={[styles.input, { marginBottom: 14 }]}
              placeholder="Enter consumer name"
              value={tvConsumerName}
              onChangeText={(t) => setTvConsumerName(t.toUpperCase())}
              autoCorrect={false}
            />

            <Text style={styles.label}>No of Cylinders *</Text>
            <TextInput
              style={[styles.input, { marginBottom: 14 }]}
              placeholder="Enter quantity"
              keyboardType="numeric"
              value={tvCylinders}
              onChangeText={setTvCylinders}
            />

            <Text style={styles.label}>Amount *</Text>
            <TextInput
              style={[styles.input, { marginBottom: 20 }]}
              placeholder="Enter total amount"
              keyboardType="numeric"
              value={tvAmount}
              onChangeText={setTvAmount}
            />

            <TouchableOpacity
              style={styles.tvConfirmBtn}
              onPress={() => {
                const qty = parseInt(tvCylinders);
                const amt = parseFloat(tvAmount);
                if (!tvConsumerName.trim()) return Alert.alert('Error', 'Please enter consumer name');
                if (!qty || qty <= 0) return Alert.alert('Error', 'Please enter valid cylinder count');
                if (!amt || amt <= 0) return Alert.alert('Error', 'Please enter valid amount');

                const computedRate = Math.ceil(amt / qty);
                setShowTvPopup(false);

                const payload: any = {
                  date: selectedDate,
                  transactions: selectedType,
                  category: selectedCategory,
                  rate: computedRate,
                  quantity: qty,
                  amount: amt,
                  remarks: `TV - ${tvConsumerName.trim()}`,
                  paytm_transaction: false,
                  check_done: false,
                };

                setSubmitting(true);
                addTransaction(payload)
                  .then(() => {
                    Alert.alert('Success', 'TV Transaction saved successfully');
                    fetchTotals(selectedDate);
                    fetchLedgerData();
                    resetForm();
                  })
                  .catch(() => Alert.alert('Error', 'Failed to save transaction'))
                  .finally(() => setSubmitting(false));
              }}
            >
              <Text style={styles.tvConfirmBtnText}>CONFIRM</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#f5f5f5' },
  scrollView:  { flex: 1 },

  header: {
    backgroundColor: BPCL_BLUE,
    elevation: 5,
  },
  headerContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  headerDate:  { fontSize: 14, color: 'rgba(255,255,255,0.9)' },

  // ── View Totals nav button ─────────────────────────────────────────
  totalNavBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginLeft: 12,
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  totalNavBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },

  totalsCard: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  totalBox:     { flex: 1, alignItems: 'center' },
  totalLabel: {
    fontSize: 11,
    color: '#888',
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  totalValue:   { fontSize: 15, fontWeight: 'bold' },
  totalDivider: { width: 1, height: 36, backgroundColor: '#eee' },

  card:  { backgroundColor: '#fff', margin: 12, padding: 16, borderRadius: 12, elevation: 2 },
  label: { fontSize: 15, fontWeight: '600', color: '#444', marginBottom: 8 },

  radioGroup:        { flexDirection: 'row', gap: 12 },
  radioButton:       { flex: 1, padding: 14, borderRadius: 10, borderWidth: 2, borderColor: '#ddd', alignItems: 'center' },
  radioSelected:     { borderColor: BPCL_BLUE, backgroundColor: '#e8f4f8' },
  radioText:         { fontSize: 16, fontWeight: '600', color: '#666' },
  radioTextSelected: { color: BPCL_BLUE },

  categoryContainer:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip:         { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#f0f0f0', borderRadius: 20, borderWidth: 1, borderColor: '#ddd', marginBottom: 4, marginRight: 4 },
  categoryChipSelected: { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  categoryText:         { color: '#555', fontWeight: '500' },
  categoryTextSelected: { color: '#fff' },

  // ── Category dropdown button + modal ────────────────────────────────
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8f9fa',
    borderWidth: 1.5,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  dropdownButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
    flex: 1,
    marginRight: 8,
  },
  dropdownPlaceholder: {
    color: '#999',
    fontWeight: '400',
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dropdownModalBox: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 420,
    elevation: 10,
  },
  dropdownModalTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginBottom: 12,
  },
  dropdownSearchInput: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    marginBottom: 10,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  dropdownItemSelected: {
    backgroundColor: '#e8f4f8',
    borderRadius: 8,
  },
  dropdownItemText: {
    fontSize: 15,
    color: '#333',
    fontWeight: '500',
  },
  dropdownItemTextSelected: {
    color: BPCL_BLUE,
    fontWeight: '700',
  },
  dropdownItemBadge: {
    fontSize: 11,
    color: '#999',
    marginLeft: 8,
  },

  // ── Auto rate hint text ─────────────────────────────────────────────
  autoRateHint: {
    marginTop: 10,
    fontSize: 12,
    color: '#276749',
    fontStyle: 'italic',
  },

  // ── SV - NAME CHANGE amount buttons ─────────────────────────────────
  svAmountBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#ddd',
    backgroundColor: '#f8f9fa',
    alignItems: 'center',
  },
  svAmountBtnSelected: {
    borderColor: BPCL_BLUE,
    backgroundColor: '#e8f4f8',
  },
  svAmountBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#555',
  },
  svAmountBtnTextSelected: {
    color: BPCL_BLUE,
  },
  svClearBtn: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#e74c3c',
    backgroundColor: '#ffebee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  svClearBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#e74c3c',
  },

  // ── Named bonus checkbox row ─────────────────────────────────────────
  bonusCheckboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 10,
  },
  bonusCheckboxLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#444',
  },
  bonusAppliedTag: {
    marginLeft: 'auto',
    fontSize: 13,
    fontWeight: '700',
    color: '#27ae60',
    backgroundColor: '#e8f5e9',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },

  row:  { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },

  input:         { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16 },
  inputDisabled: { backgroundColor: '#eef', color: '#555' },
  remarksInput:  { height: 80, textAlignVertical: 'top' },

  amountBox:   { marginTop: 16, padding: 16, backgroundColor: '#e8f4f8', borderRadius: 10, alignItems: 'center' },
  amountLabel: { fontSize: 14, color: BPCL_BLUE, fontWeight: '600' },
  amountValue: { fontSize: 28, fontWeight: 'bold', color: BPCL_BLUE, marginTop: 4 },

  submitButton: { backgroundColor: BPCL_BLUE, margin: 16, padding: 18, borderRadius: 12, alignItems: 'center' },
  submitText:   { color: '#fff', fontSize: 18, fontWeight: 'bold' },

  // ── Weekly Salary day-wise delivery breakdown ───────────────────────────
  breakdownListContainer: { gap: 6, marginTop: 4 },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fafafa',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eee',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  breakdownDate: {
    fontSize: 13,
    color: '#555',
    fontWeight: '600',
  },
  breakdownQty: {
    fontSize: 14,
    color: BPCL_BLUE,
    fontWeight: '800',
  },
  breakdownTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1.5,
    borderTopColor: '#e8f4f8',
  },
  breakdownTotalLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#444',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  breakdownTotalValue: {
    fontSize: 18,
    fontWeight: '900',
    color: BPCL_BLUE,
  },

  infoBoxTitle: { fontSize: 14, fontWeight: 'bold', color: '#856404', marginBottom: 8 },
  noInfoText:   { fontSize: 13, color: '#888', fontStyle: 'italic', marginTop: 4 },

  balanceListContainer: { gap: 6, marginTop: 4 },
  balanceCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fafafa',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eee',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 10,
  },
  checkbox:        { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: '#bbb', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  checkboxChecked: { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  checkboxTick:    { color: '#fff', fontSize: 13, fontWeight: 'bold' },
  balanceCheckInfo:  { flex: 1 },
  balanceCheckDate:  { fontSize: 11, color: '#856404', fontWeight: '600' },
  balanceCheckAmt:   { fontSize: 13, color: '#333', fontWeight: '700', marginTop: 1 },
  balanceCheckRec:   { fontSize: 11, color: '#888', fontWeight: '400' },
  balanceCheckInput: {
    width: 90,
    backgroundColor: '#e8f4f8',
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 14,
    fontWeight: '700',
    color: BPCL_BLUE,
    textAlign: 'right',
  },

  deductionSummaryBox: {
    marginTop: 14,
    backgroundColor: '#fff3cd',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#ffc107',
    padding: 14,
    gap: 4,
  },
  deductionLabel:   { fontSize: 12, color: '#856404', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  deductionMinus:   { fontSize: 18, color: '#dc3545', fontWeight: '800' },
  deductionDivider: { height: 1, backgroundColor: '#ffc107', marginVertical: 6 },
  deductionFinal:   { fontSize: 22, color: '#27ae60', fontWeight: '900' },
  deductionNote:    { fontSize: 10, color: '#999', marginTop: 6, lineHeight: 14 },

  paymentPopupBox: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '88%',
    elevation: 10,
    position: 'relative',
  },
  paymentCloseBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  paymentCloseBtnText: { fontSize: 14, color: '#555', fontWeight: 'bold' },
  paymentIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E6F1FB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  paymentIconText:  { fontSize: 22 },
  paymentTitle:     { fontSize: 18, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 4 },
  paymentSubtitle:  { fontSize: 13, color: '#888', marginBottom: 18 },
  paymentDivider:   { height: 1, backgroundColor: '#eee', marginBottom: 16 },
  paymentOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    backgroundColor: '#fff',
    marginBottom: 10,
  },
  paymentOptionSelected: {
    borderColor: BPCL_BLUE,
    backgroundColor: '#E6F1FB',
  },
  paymentOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentOptionLabel: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginBottom: 2 },
  paymentOptionDesc:  { fontSize: 12, color: '#888' },
  paymentOptionTick: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: BPCL_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentConfirmBtn: {
    backgroundColor: BPCL_BLUE,
    padding: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  paymentConfirmBtnDisabled: {
    backgroundColor: '#a0c8e8',
  },
  paymentConfirmBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },

  popupOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999
  },
  popupBox: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '82%',
    elevation: 10,
    position: 'relative',
  },
  popupCloseBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  popupCloseBtnText: { fontSize: 13, color: '#555', fontWeight: 'bold' },
  popupTitle:        { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 4, marginTop: 4 },
  popupSubtitle:     { fontSize: 12, color: '#888', marginBottom: 16 },
  popupLabel:        { fontSize: 14, fontWeight: '600', color: '#444', marginBottom: 8 },
  popupInput: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
    fontWeight: '700',
    color: BPCL_BLUE,
    textAlign: 'center',
    marginBottom: 20,
  },
  popupBtn: {
    width: '100%',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },

  // ─── FILE 2 Tab Styles ─────────────────────────────────────────────────────
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#666',
    fontSize: 16,
  },
  summaryCard: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  summaryTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginBottom: 16,
  },
  totalCardsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  totalCard: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
    backgroundColor: '#fafafa',
    gap: 4,
  },
  totalCardSelected: {
    borderColor: BPCL_BLUE,
    borderWidth: 2,
    backgroundColor: '#e8f4f8',
  },
  creditCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#27ae60',
  },
  debitCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#e74c3c',
  },
  totalAmount: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  entryCount: {
    fontSize: 11,
    color: '#999',
  },
  creditAmount: {
    color: '#27ae60',
    fontWeight: 'bold',
  },
  debitAmount: {
    color: '#e74c3c',
    fontWeight: 'bold',
  },
  balanceBox: {
    marginTop: 16,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  balanceLabel: {
    fontSize: 13,
    color: '#555',
    fontWeight: '600',
  },
  balanceValue: {
    fontSize: 26,
    fontWeight: 'bold',
    marginTop: 4,
  },
  balancePositive: {
    color: '#27ae60',
  },
  balanceNegative: {
    color: '#e74c3c',
  },
  entriesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: '#e8e8e8',
    borderRadius: 20,
    padding: 3,
  },
  viewToggleBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 18,
  },
  viewToggleBtnActive: {
    backgroundColor: '#fff',
    elevation: 2,
  },
  viewToggleBtnText: {
    fontSize: 13,
    color: '#888',
    fontWeight: '600',
  },
  viewToggleBtnTextActive: {
    color: BPCL_BLUE,
  },
  sectionTotal: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  entryCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  commercialBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff8e1',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: BPCL_YELLOW,
  },
  commercialBannerText: {
    fontSize: 11,
    color: '#7b4f00',
    fontWeight: '600',
    flex: 1,
  },
  entryTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  entryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  entryIndexBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  entryIndex: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  entryCategory: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#333',
  },
  entrySource: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  entryAmount: {
    fontSize: 18,
    fontWeight: 'bold',
    marginLeft: 8,
  },
  entryDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  detailCol: {
    flex: 1,
  },
  detailLabel: {
    fontSize: 11,
    color: '#999',
    marginBottom: 3,
  },
  detailValue: {
    fontSize: 13,
    color: '#333',
    fontWeight: '600',
  },
  paytmBadge: {
    backgroundColor: '#e3f2fd',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  paytmText: {
    fontSize: 11,
    color: BPCL_BLUE,
    fontWeight: 'bold',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  editButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: BPCL_BLUE,
    backgroundColor: '#e8f4f8',
  },
  editButtonText: {
    color: BPCL_BLUE,
    fontWeight: '600',
    fontSize: 14,
  },
  deleteButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e74c3c',
    backgroundColor: '#ffebee',
  },
  deleteButtonText: {
    color: '#e74c3c',
    fontWeight: '600',
    fontSize: 14,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    color: '#ccc',
    fontWeight: '600',
  },

  // Edit sheet styles
  bottomSheetBg: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    elevation: 10,
  },
  bottomSheetHandle: {
    backgroundColor: '#ddd',
    width: 40,
    height: 4,
  },
  bottomSheetContent: {
    padding: 20,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#888',
    marginTop: 4,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  commercialEditWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#fff3cd',
    padding: 10,
    borderRadius: 8,
    marginTop: 8,
    borderLeftWidth: 3,
    borderLeftColor: BPCL_YELLOW,
  },
  commercialEditWarningText: {
    fontSize: 12,
    color: '#856404',
    flex: 1,
    lineHeight: 18,
  },
  editField: {
    marginBottom: 16,
  },
  editLabel: {
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
    marginBottom: 8,
  },
  editInput: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#333',
  },
  editInputHighlight: {
    borderColor: BPCL_BLUE,
    borderWidth: 2,
    backgroundColor: '#e8f4f8',
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  editInputMultiline: {
    height: 80,
    paddingTop: 12,
  },
  editHint: {
    fontSize: 11,
    color: '#999',
    marginTop: 4,
    fontStyle: 'italic',
  },
  commercialRemarksHint: {
    fontSize: 11,
    color: '#856404',
    marginTop: 4,
    fontStyle: 'italic',
  },
  rowInputs: {
    flexDirection: 'row',
    gap: 12,
  },
  originalValues: {
    backgroundColor: '#fff8e1',
    padding: 14,
    borderRadius: 10,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: BPCL_YELLOW,
  },
  originalValuesTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#856404',
    marginBottom: 10,
  },
  originalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 3,
  },
  originalLabel: {
    fontSize: 13,
    color: '#856404',
  },
  originalValue: {
    fontSize: 13,
    color: '#856404',
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
  },
  saveButton: {
    backgroundColor: BPCL_BLUE,
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },

  // ─── TAB NAVIGATION STYLING ────────────────────────────────────────────────
  innerTabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    elevation: 2,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  innerTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  innerTabActive: {
    backgroundColor: BPCL_BLUE,
  },
  innerTabText: {
    fontSize: 14,
    fontWeight: '600',
    color: BPCL_BLUE,
  },
  innerTabTextActive: {
    color: '#fff',
  },

  // ─── TV POPUP OVERLAYS ─────────────────────────────────────────────────────
  tvPopupOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  tvPopupBox: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    elevation: 10,
  },
  tvPopupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  tvPopupTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  tvPopupCloseText: {
    fontSize: 22,
    color: '#666',
    fontWeight: 'bold',
  },
  tvConfirmBtn: {
    backgroundColor: BPCL_BLUE,
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  tvConfirmBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
