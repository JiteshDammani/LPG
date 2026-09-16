import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '@/lib/supabase';
import { format, isToday, parseISO } from 'date-fns';
import DateTimePicker from '@react-native-community/datetimepicker';

const BPCL_BLUE = '#017DC5';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DeliveryBoy {
  name: string;
}

interface DeliveryRecord {
  id: string;
  deliveryboyname: string;
  delivery_date: string;
  total_delivered: number;
  bills_given: number;
  operator_app_done: number;
  actual_operator_app: number | null;
  vip_quota: number;
  net_balance: number;
  remarks: string | null;
  created_at: string;
}

interface ManualBill {
  id: string;
  delivery_record_id: string;
  deliveryboyname: string;
  bill_no: string;
  status: 'pending_ledger' | 'operator_completed' | 'manual_completed';
  is_confirmed_operator: boolean;
  created_at: string;
}

// Bills marked "delivered" in the system (so the on-time rating doesn't drop)
// but not actually physically handed to the customer yet — e.g. customer was
// unavailable/unreachable at the premises. Tracked separately until resolved.
interface PseudoDelivery {
  id: string;
  bill_no: string;
  delivery_date: string;
  status: 'pending' | 'resolved';
  resolved_date: string | null;
  remarks: string | null;
  created_at: string;
}

interface SummaryStats {
  totalOperatorApp: number;
  totalDelivered: number;
  totalBillsGiven: number;
  totalVip: number;
  totalNetLedger: number;
  totalManual: number;
}

interface AggregatedLedger {
  boyName: string;
  cumulativeBalance: number;
  history: DeliveryRecord[];
}

// ─── Verification State Helper ──────────────────────────────────────────────

type VerificationState = 'unverified' | 'matched' | 'corrected';

const getVerificationState = (rec: DeliveryRecord, isDateToday: boolean): VerificationState => {
  if (isDateToday) return 'unverified';
  if (rec.actual_operator_app === null || rec.actual_operator_app === undefined) return 'unverified';
  if (rec.actual_operator_app === rec.operator_app_done) return 'matched';
  return 'corrected';
};

const effectiveNetBalance = (rec: DeliveryRecord): number => {
  if (rec.actual_operator_app === null || rec.actual_operator_app === undefined) return rec.net_balance;
  const delta = rec.operator_app_done - rec.actual_operator_app;
  return rec.net_balance - delta;
};

// ─── Circle Picker Helper ────────────────────────────────────────────────────
// Reused for: "Kitne bill kam hain?", "Kitne bill operator se hona baki hai?", "VIP entries hain kya?"

const getEffectiveCircleValue = (value: number | null, customText: string): number | null => {
  const trimmed = customText.trim();
  if (trimmed !== '') {
    const n = parseInt(trimmed, 10);
    return isNaN(n) ? null : n;
  }
  return value;
};

const CirclePicker = ({
  value,
  customValue,
  onSelect,
  onCustomChange,
  accent = BPCL_BLUE,
}: {
  value: number | null;
  customValue: string;
  onSelect: (v: number) => void;
  onCustomChange: (v: string) => void;
  accent?: string;
}) => {
  const isCustomActive = customValue.trim() !== '';
  return (
    <View style={styles.circleRow}>
      {[0, 1, 2].map((n) => {
        const active = !isCustomActive && value === n;
        return (
          <TouchableOpacity
            key={n}
            style={[styles.circleBtn, active && { backgroundColor: accent, borderColor: accent }]}
            onPress={() => {
              onSelect(n);
              onCustomChange('');
            }}
          >
            <Text style={[styles.circleBtnText, active && { color: '#fff' }]}>{n}</Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        style={[styles.circleBtn, !isCustomActive && value === 3 && { backgroundColor: accent, borderColor: accent }]}
        onPress={() => {
          onSelect(3);
          onCustomChange('');
        }}
      >
        <Text style={[styles.circleBtnText, !isCustomActive && value === 3 && { color: '#fff' }]}>3</Text>
      </TouchableOpacity>
      <TextInput
        style={[
          styles.circleCustomInput,
          isCustomActive && { borderColor: accent, backgroundColor: accent + '15', color: accent },
        ]}
        placeholder="+"
        placeholderTextColor="#94a3b8"
        keyboardType="numeric"
        value={customValue}
        onChangeText={(t) => {
          onCustomChange(t);
          const n = parseInt(t, 10);
          if (!isNaN(n)) onSelect(n);
        }}
        maxLength={3}
      />
    </View>
  );
};

const QuestionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={styles.questionCard}>
    <View style={styles.questionCardHeader}>
      <Ionicons name="help-circle" size={16} color={BPCL_BLUE} />
      <Text style={styles.questionCardTitle}>{title}</Text>
    </View>
    {children}
  </View>
);

// ─── Sub Components ─────────────────────────────────────────────────────────

const SectionHeader = ({ title, icon }: { title: string; icon: string }) => (
  <View style={styles.sectionHeader}>
    <Ionicons name={icon as any} size={18} color={BPCL_BLUE} />
    <Text style={styles.sectionHeaderText}>{title}</Text>
  </View>
);

const SummaryCard = ({ stats, loading }: { stats: SummaryStats; loading: boolean }) => {
  const netVar = stats.totalNetLedger;
  const netLabel = netVar > 0 ? `+${netVar} Access` : netVar < 0 ? `${netVar} Pending` : 'Balanced';
  const netColor = netVar > 0 ? '#27ae60' : netVar < 0 ? '#c0392b' : '#334155';

  return (
    <View style={styles.summaryCard}>
      <View style={styles.summaryTitleRow}>
        <Ionicons name="bar-chart-outline" size={16} color="#fff" />
        <Text style={styles.summaryTitle}>Day Performance Summary</Text>
      </View>
      <View style={styles.summaryRow}>
        <View style={styles.summaryBox}>
          <View style={styles.summaryIconWrap}>
            <Ionicons name="layers-outline" size={16} color={BPCL_BLUE} />
          </View>
          {loading ? <ActivityIndicator size="small" color={BPCL_BLUE} style={{ marginVertical: 4 }} /> : (
            <Text style={styles.summaryCount}>{stats.totalDelivered}</Text>
          )}
          <Text style={styles.summaryLabel}>Delivered</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryBox}>
          <View style={[styles.summaryIconWrap, { backgroundColor: '#eafaf1' }]}>
            <Ionicons name="document-text-outline" size={16} color="#27ae60" />
          </View>
          {loading ? <ActivityIndicator size="small" color="#27ae60" style={{ marginVertical: 4 }} /> : (
            <Text style={[styles.summaryCount, { color: '#27ae60' }]}>{stats.totalManual}</Text>
          )}
          <Text style={styles.summaryLabel}>Manual</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryBox}>
          <View style={[styles.summaryIconWrap, { backgroundColor: '#e8f4fd' }]}>
            <Ionicons name="phone-portrait-outline" size={16} color={BPCL_BLUE} />
          </View>
          {loading ? <ActivityIndicator size="small" color={BPCL_BLUE} style={{ marginVertical: 4 }} /> : (
            <Text style={[styles.summaryCount, { color: BPCL_BLUE }]}>{stats.totalOperatorApp}</Text>
          )}
          <Text style={styles.summaryLabel}>App Done</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryBox}>
          <View style={[styles.summaryIconWrap, { backgroundColor: '#fde8e8' }]}>
            <Ionicons name="star-outline" size={16} color="#e74c3c" />
          </View>
          {loading ? <ActivityIndicator size="small" color="#e74c3c" style={{ marginVertical: 4 }} /> : (
            <Text style={[styles.summaryCount, { color: '#e74c3c' }]}>{stats.totalVip}</Text>
          )}
          <Text style={styles.summaryLabel}>VIP</Text>
        </View>
      </View>
      <View style={styles.summaryFooterRow}>
        <Text style={styles.footerStatLabel}>Today&apos;s Net Balance Variance:</Text>
        <Text style={[styles.footerStatValue, { color: netColor }]}>{netLabel}</Text>
      </View>
      <View style={[styles.summaryFooterRow, { marginTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', paddingTop: 8 }]}>
        <Text style={styles.footerStatLabel}>Today&apos;s Delivery:</Text>
        <Text style={[styles.footerStatValue, { color: '#fff', fontSize: 13, fontWeight: 'bold' }]}>
          {stats.totalDelivered} - {stats.totalVip} {netVar >= 0 ? ' + ' : ' '}{netVar} = {stats.totalDelivered - stats.totalVip + netVar}
        </Text>
      </View>
    </View>
  );
};

const DateSelector = ({
  selectedDate,
  onDateChange,
}: {
  selectedDate: string;
  onDateChange: (date: string) => void;
}) => {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <View style={styles.card}>
      <SectionHeader title="Delivery Date" icon="calendar-outline" />
      <TouchableOpacity style={styles.dateButton} onPress={() => setShowPicker(true)}>
        <Ionicons name="calendar" size={18} color={BPCL_BLUE} />
        <Text style={styles.dateButtonText}>
          {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
        </Text>
        <Ionicons name="chevron-down" size={16} color={BPCL_BLUE} />
      </TouchableOpacity>
      {showPicker && (
        <DateTimePicker
          value={new Date(selectedDate + 'T00:00:00')}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          maximumDate={new Date()}
          onChange={(_event: any, date?: Date) => {
            setShowPicker(false);
            if (date) onDateChange(format(date, 'yyyy-MM-dd'));
          }}
        />
      )}
    </View>
  );
};

// ─── Main Component ─────────────────────────────────────────────────────────

export default function DeliveryRecordsTab() {
  const [innerTab, setInnerTab] = useState<'entry' | 'pseudo' | 'ledger'>('entry');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const [deliveryBoys, setDeliveryBoys] = useState<DeliveryBoy[]>([]);
  const [boyDropdownOpen, setBoyDropdownOpen] = useState(false);
  const [selectedBoy, setSelectedBoy] = useState('');

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);

  // ── Inline Entry Flow State ──────────────────────────────────────────────
  // Step 1: Total Delivered
  const [totalDelivered, setTotalDelivered] = useState('');
  const [step1Confirmed, setStep1Confirmed] = useState(false);

  // "Kitne bill kam hain?"
  const [billsKamValue, setBillsKamValue] = useState<number | null>(null);
  const [billsKamCustom, setBillsKamCustom] = useState('');

  // Step 2: Bills Received (auto-filled = delivered - kam, editable)
  const [billsReceived, setBillsReceived] = useState('');
  const [step2Confirmed, setStep2Confirmed] = useState(false);

  // "Kitne bill operator se hona baki hai?"
  const [operatorPendingValue, setOperatorPendingValue] = useState<number | null>(null);
  const [operatorPendingCustom, setOperatorPendingCustom] = useState('');

  // Outstanding manual bill references (size = operator pending count)
  const [manualBillNumbers, setManualBillNumbers] = useState<string[]>([]);

  // "VIP entries hain kya?" (only asked if a shortfall exists)
  const [vipValue, setVipValue] = useState<number | null>(null);
  const [vipCustom, setVipCustom] = useState('');
  const [vipRemarks, setVipRemarks] = useState('');

  // "Operator booking kitna hua?" — final confirmation before submit,
  // auto-filled from the computed operator app done count but editable.
  const [operatorBookingDone, setOperatorBookingDone] = useState('');

  const [todayRecords, setTodayRecords] = useState<DeliveryRecord[]>([]);
  const [todayBills, setTodayBills] = useState<ManualBill[]>([]);
  const [allHistoricalRecords, setAllHistoricalRecords] = useState<DeliveryRecord[]>([]);
  const [expandedBoy, setExpandedBoy] = useState<string | null>(null);

  const [resolutionVisible, setResolutionVisible] = useState(false);
  const [resolvingBill, setResolvingBill] = useState<ManualBill | null>(null);
  const [resolvingState, setResolvingState] = useState(false);

  // ── Verification Modal State ─────────────────────────────────────────────
  const [verifyModalVisible, setVerifyModalVisible] = useState(false);
  const [verifyingRecord, setVerifyingRecord] = useState<DeliveryRecord | null>(null);
  const [verifyActualCount, setVerifyActualCount] = useState('');
  const [verifyCorrectionRefs, setVerifyCorrectionRefs] = useState<string[]>([]);
  const [verifySaving, setVerifySaving] = useState(false);

  // ── Pseudo Delivery State ("shown delivered" but not physically delivered) ─
  const [pseudoDeliveries, setPseudoDeliveries] = useState<PseudoDelivery[]>([]);
  const [pseudoBillNo, setPseudoBillNo] = useState('');
  const [pseudoRemarks, setPseudoRemarks] = useState('');
  const [pseudoSaving, setPseudoSaving] = useState(false);

  const [pseudoResolveVisible, setPseudoResolveVisible] = useState(false);
  const [pseudoResolving, setPseudoResolving] = useState<PseudoDelivery | null>(null);
  const [pseudoResolveDate, setPseudoResolveDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [pseudoResolveSaving, setPseudoResolveSaving] = useState(false);

  const [summaryStats, setSummaryStats] = useState<SummaryStats>({
    totalOperatorApp: 0,
    totalDelivered: 0,
    totalBillsGiven: 0,
    totalVip: 0,
    totalNetLedger: 0,
    totalManual: 0,
  });

  const scrollViewRef = useRef<ScrollView>(null);
  const totalDeliveredRef = useRef<TextInput>(null);

  // Effective (custom overrides selection) values for each circle-picker question
  const billsKamEffective = getEffectiveCircleValue(billsKamValue, billsKamCustom);
  const operatorPendingEffective = getEffectiveCircleValue(operatorPendingValue, operatorPendingCustom);
  const vipEffective = getEffectiveCircleValue(vipValue, vipCustom);

  const getFilteredDeliveryBoys = useCallback(() => {
    return deliveryBoys.filter((boy) => {
      if (boy.name.toLowerCase().includes('dba')) return false;
      return !todayRecords.some(
        (rec) => rec.deliveryboyname.toLowerCase() === boy.name.toLowerCase()
      );
    });
  }, [deliveryBoys, todayRecords]);

  useEffect(() => { void fetchDeliveryBoys(); }, []);
  useEffect(() => { void fetchTodayDataAndStats(); }, [selectedDate]);
  useEffect(() => { void fetchPseudoDeliveries(); }, []);
  useEffect(() => {
    if (innerTab === 'ledger') void fetchHistoricalLedgerData();
  }, [innerTab]);

  // Recalculate Step 2 (Bills Received) whenever Step 1 or the "kam" answer changes
  useEffect(() => {
    const delivered = parseInt(totalDelivered, 10);
    if (!isNaN(delivered) && billsKamEffective !== null) {
      const br = delivered - billsKamEffective;
      setBillsReceived(br >= 0 ? br.toString() : '0');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalDelivered, billsKamValue, billsKamCustom]);

  // Recalculate outstanding manual bill slots whenever Bills Received or the
  // "operator pending" answer changes, preserving whatever was already typed.
  useEffect(() => {
    if (operatorPendingEffective !== null && operatorPendingEffective >= 0) {
      setManualBillNumbers((prev) => {
        const next = new Array(operatorPendingEffective).fill('');
        for (let i = 0; i < Math.min(prev.length, operatorPendingEffective); i++) {
          next[i] = prev[i];
        }
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billsReceived, operatorPendingValue, operatorPendingCustom]);

  // Recalculate the suggested "Operator booking kitna hua?" value whenever
  // Bills Received or the operator-pending answer changes (still editable after).
  useEffect(() => {
    const br = parseInt(billsReceived, 10);
    if (!isNaN(br) && operatorPendingEffective !== null) {
      const suggested = Math.max(br - operatorPendingEffective, 0);
      setOperatorBookingDone(suggested.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billsReceived, operatorPendingValue, operatorPendingCustom]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        fetchDeliveryBoys(),
        fetchTodayDataAndStats(),
        fetchHistoricalLedgerData(),
        fetchPseudoDeliveries(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [selectedDate, innerTab]);

  const fetchDeliveryBoys = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_deliveryboyname')
        .select('name')
        .order('name', { ascending: true });
      if (error) throw error;
      setDeliveryBoys(data || []);
    } catch (err: any) {
      Alert.alert('Database Sync Error', err?.message || 'Failed to fetch delivery boys');
    } finally {
      setLoading(false);
    }
  };

  const fetchTodayDataAndStats = async () => {
    setLoadingStats(true);
    try {
      const { data: recs, error: recErr } = await supabase
        .from('delivery_records')
        .select('*')
        .eq('delivery_date', selectedDate)
        .order('created_at', { ascending: false });
      if (recErr) throw recErr;
      const recordsList: DeliveryRecord[] = recs || [];
      setTodayRecords(recordsList);

      let billsList: ManualBill[] = [];
      if (recordsList.length > 0) {
        const recordIds = recordsList.map((r) => r.id);
        const { data: bills, error: billsErr } = await supabase
          .from('manual_bill_nos')
          .select('*')
          .in('delivery_record_id', recordIds);
        if (!billsErr && bills) billsList = bills;
      }
      setTodayBills(billsList);

      const totalDeliveredVal = recordsList.reduce((s, r) => s + (r.total_delivered || 0), 0);
      const totalBillsGivenVal = recordsList.reduce((s, r) => s + (r.bills_given || 0), 0);
      const totalOperatorAppVal = recordsList.reduce(
        (s, r) => s + (r.actual_operator_app !== null && r.actual_operator_app !== undefined ? r.actual_operator_app : (r.operator_app_done || 0)),
        0
      );
      const totalVipVal = recordsList.reduce((s, r) => s + (r.vip_quota || 0), 0);
      const totalNetLedgerVal = recordsList.reduce((s, r) => s + effectiveNetBalance(r), 0);
      const totalManualVal = billsList.filter(b => b.status === 'manual_completed' || b.status === 'pending_ledger').length;

      setSummaryStats({
        totalDelivered: totalDeliveredVal,
        totalBillsGiven: totalBillsGivenVal,
        totalOperatorApp: totalOperatorAppVal,
        totalVip: totalVipVal,
        totalNetLedger: totalNetLedgerVal,
        totalManual: totalManualVal,
      });
    } catch (err: any) {
      console.error('Stats fetch error:', err?.message);
    } finally {
      setLoadingStats(false);
    }
  };

  const fetchHistoricalLedgerData = async () => {
    try {
      const { data, error } = await supabase
        .from('delivery_records')
        .select('*')
        .order('delivery_date', { ascending: false });
      if (error) throw error;
      setAllHistoricalRecords(data || []);
    } catch (err: any) {
      console.error('Historical data load error:', err?.message);
    }
  };

  const fetchPseudoDeliveries = async () => {
    try {
      const { data, error } = await supabase
        .from('pseudo_delivered_bills')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setPseudoDeliveries(data || []);
    } catch (err: any) {
      console.error('Pseudo delivery fetch error:', err?.message);
    }
  };

  const getPendingPseudoDeliveries = (): PseudoDelivery[] => {
    return pseudoDeliveries
      .filter((p) => p.status === 'pending')
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  };

  const handleAddPseudoDelivery = async () => {
    const billNo = pseudoBillNo.trim();
    if (!billNo) {
      Alert.alert('Validation', 'Please enter the bill / order No.');
      return;
    }
    if (pseudoDeliveries.some((p) => p.status === 'pending' && p.bill_no.toLowerCase() === billNo.toLowerCase())) {
      Alert.alert('Duplicate', `Bill No. ${billNo} is already pending in this list.`);
      return;
    }
    setPseudoSaving(true);
    try {
      const { error } = await supabase
        .from('pseudo_delivered_bills')
        .insert([{
          bill_no: billNo,
          delivery_date: selectedDate,
          status: 'pending',
          resolved_date: null,
          remarks: pseudoRemarks.trim() || null,
        }]);
      if (error) throw error;
      setPseudoBillNo('');
      setPseudoRemarks('');
      await fetchPseudoDeliveries();
    } catch (err: any) {
      Alert.alert('Database Sync Error', err?.message || 'Failed to save entry');
    } finally {
      setPseudoSaving(false);
    }
  };

  const handleDeletePseudoDelivery = (item: PseudoDelivery) => {
    Alert.alert('Delete Entry', `Remove Bill No. ${item.bill_no} from this list?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            const { error } = await supabase.from('pseudo_delivered_bills').delete().eq('id', item.id);
            if (error) throw error;
            await fetchPseudoDeliveries();
          } catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to delete entry');
          }
        },
      },
    ]);
  };

  const handleOpenPseudoResolve = (item: PseudoDelivery) => {
    setPseudoResolving(item);
    setPseudoResolveDate(format(new Date(), 'yyyy-MM-dd'));
    setPseudoResolveSaving(false);
    setPseudoResolveVisible(true);
  };

  const handleClosePseudoResolve = () => {
    setPseudoResolveVisible(false);
    setTimeout(() => setPseudoResolving(null), 400);
  };

  const handleCommitPseudoResolve = async () => {
    if (!pseudoResolving) return;
    setPseudoResolveSaving(true);
    try {
      const { error } = await supabase
        .from('pseudo_delivered_bills')
        .update({ status: 'resolved', resolved_date: pseudoResolveDate })
        .eq('id', pseudoResolving.id);
      if (error) throw error;
      handleClosePseudoResolve();
      setTimeout(async () => {
        await fetchPseudoDeliveries();
      }, 300);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to mark as physically delivered');
    } finally {
      setPseudoResolveSaving(false);
    }
  };

  const computeActiveLedger = (): AggregatedLedger[] => {
    const runningMap: Record<string, { balance: number; items: DeliveryRecord[] }> = {};
    allHistoricalRecords.forEach((rec) => {
      const boy = rec.deliveryboyname;
      if (!runningMap[boy]) runningMap[boy] = { balance: 0, items: [] };
      const eff = effectiveNetBalance(rec);
      runningMap[boy].balance += eff;
      if (eff !== 0) runningMap[boy].items.push(rec);
    });
    return Object.entries(runningMap)
      .map(([boyName, details]) => ({
        boyName,
        cumulativeBalance: details.balance,
        history: details.items.sort((a, b) => b.delivery_date.localeCompare(a.delivery_date)),
      }))
      .filter((item) => item.cumulativeBalance !== 0)
      .sort((a, b) => a.boyName.localeCompare(b.boyName));
  };

  const getHistoricalVipLedger = (): DeliveryRecord[] => {
    return allHistoricalRecords
      .filter((rec) => rec.vip_quota > 0)
      .sort((a, b) => b.delivery_date.localeCompare(a.delivery_date));
  };

  const getVerificationBannerState = (): { allSynced: boolean; unverifiedCount: number } | null => {
    const dateIsToday = isToday(parseISO(selectedDate));
    if (dateIsToday) return null;
    if (todayRecords.length === 0) return null;
    const unverifiedCount = todayRecords.filter(
      (r) => r.actual_operator_app === null || r.actual_operator_app === undefined
    ).length;
    return { allSynced: unverifiedCount === 0, unverifiedCount };
  };

  const handleOpenVerify = (rec: DeliveryRecord) => {
    const dateIsToday = isToday(parseISO(selectedDate));
    if (dateIsToday) return;
    const state = getVerificationState(rec, dateIsToday);
    if (state === 'matched') return;

    setVerifyingRecord(rec);
    setVerifyActualCount(rec.actual_operator_app?.toString() ?? '');
    setVerifyCorrectionRefs([]);
    setVerifySaving(false);
    setVerifyModalVisible(true);
  };

  const handleCloseVerifyModal = () => {
    setVerifyModalVisible(false);
    setTimeout(() => {
      setVerifyingRecord(null);
      setVerifyActualCount('');
      setVerifyCorrectionRefs([]);
    }, 400);
  };

  const handleVerifyCountChange = (val: string) => {
    setVerifyActualCount(val);
    const actual = parseInt(val, 10);
    const claimed = verifyingRecord?.operator_app_done ?? 0;
    if (!isNaN(actual) && actual < claimed) {
      const delta = claimed - actual;
      setVerifyCorrectionRefs(new Array(delta).fill(''));
    } else {
      setVerifyCorrectionRefs([]);
    }
  };

  const handleCommitVerification = async () => {
    if (!verifyingRecord) return;
    const actual = parseInt(verifyActualCount, 10);
    const claimed = verifyingRecord.operator_app_done;

    if (isNaN(actual) || actual < 0) {
      Alert.alert('Validation', 'Please enter a valid actual operator app count.');
      return;
    }
    if (actual > claimed) {
      Alert.alert('Validation', `Actual count (${actual}) cannot exceed claimed count (${claimed}).`);
      return;
    }

    const delta = claimed - actual;

    if (delta > 0) {
      const allFilled = verifyCorrectionRefs.every((r) => r.trim() !== '');
      if (!allFilled) {
        Alert.alert('Validation', `Please enter a bill reference for each of the ${delta} discrepant delivery(s).`);
        return;
      }
    }

    setVerifySaving(true);
    try {
      const correctionRemarksNote = delta > 0
        ? ` | Operator correction: claimed ${claimed}, actual ${actual}. Refs: ${verifyCorrectionRefs.join(', ')}`
        : '';
      const updatedRemarks = (verifyingRecord.remarks || '') + correctionRemarksNote;

      const { error: updateErr } = await supabase
        .from('delivery_records')
        .update({
          actual_operator_app: actual,
          remarks: updatedRemarks.trim() || null,
        })
        .eq('id', verifyingRecord.id);

      if (updateErr) throw updateErr;

      if (delta > 0 && verifyCorrectionRefs.length > 0) {
        const billRows = verifyCorrectionRefs.map((ref) => ({
          delivery_record_id: verifyingRecord.id,
          deliveryboyname: verifyingRecord.deliveryboyname,
          bill_no: ref.trim(),
          status: 'pending_ledger',
          is_confirmed_operator: false,
        }));
        const { error: billErr } = await supabase.from('manual_bill_nos').insert(billRows);
        if (billErr) throw billErr;
      }

      handleCloseVerifyModal();

      setTimeout(async () => {
        try {
          await fetchTodayDataAndStats();
          await fetchHistoricalLedgerData();
        } catch (e: any) {
          console.error('Post-verify fetch error:', e?.message);
        }
        if (delta === 0) {
          Alert.alert('Verified', `Operator app count matches actual. Entry marked as synced.`);
        } else {
          Alert.alert('Correction Saved', `Delta of ${delta} logged. Correction bill(s) added to pending ledger.`);
        }
      }, 400);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to save verification');
    } finally {
      setVerifySaving(false);
    }
  };

  const getSortedTodayRecords = (): DeliveryRecord[] => {
    const dateIsToday = isToday(parseISO(selectedDate));
    if (dateIsToday) return todayRecords;
    return [...todayRecords].sort((a, b) => {
      const stateA = getVerificationState(a, false);
      const stateB = getVerificationState(b, false);
      const order = { unverified: 0, corrected: 1, matched: 2 };
      return order[stateA] - order[stateB];
    });
  };

  // ── Inline Entry Flow Handlers ───────────────────────────────────────────

  const resetEntryFlow = () => {
    setTotalDelivered('');
    setStep1Confirmed(false);
    setBillsKamValue(null);
    setBillsKamCustom('');
    setBillsReceived('');
    setStep2Confirmed(false);
    setOperatorPendingValue(null);
    setOperatorPendingCustom('');
    setManualBillNumbers([]);
    setVipValue(null);
    setVipCustom('');
    setVipRemarks('');
    setOperatorBookingDone('');
  };

  const vipRemarksValid = (): boolean => {
    if (!vipEffective || vipEffective === 0) return true;
    const parts = vipRemarks.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length === vipEffective;
  };

  const canSaveEntry = (): boolean => {
    if (!selectedBoy || !totalDelivered || !step1Confirmed) return false;
    if (billsKamEffective === null) return false;
    if (!billsReceived || !step2Confirmed) return false;
    if (operatorPendingEffective === null) return false;
    if (operatorPendingEffective > 0 && !manualBillNumbers.every((b) => b.trim() !== '')) return false;
    if (billsKamEffective > 0) {
      if (vipEffective === null) return false;
      if (!vipRemarksValid()) return false;
    }
    if (!operatorBookingDone || isNaN(parseInt(operatorBookingDone, 10))) return false;
    return true;
  };

  const handleFinalSave = async () => {
    const delivered = parseInt(totalDelivered, 10);
    const received = parseInt(billsReceived, 10);
    const operatorPending = operatorPendingEffective ?? 0;
    const vip = vipEffective ?? 0;

    if (isNaN(delivered) || delivered < 0) {
      Alert.alert('Validation', 'Please enter a valid delivered count.');
      return;
    }
    if (isNaN(received) || received < 0) {
      Alert.alert('Validation', 'Please enter a valid bills received count.');
      return;
    }

    const operatorAppDone = parseInt(operatorBookingDone, 10);
    if (isNaN(operatorAppDone) || operatorAppDone < 0) {
      Alert.alert('Validation', 'Please enter a valid "Operator booking kitna hua?" count.');
      return;
    }
    const balance = received - delivered + vip;

    setSaving(true);
    try {
      const { data: record, error: recordError } = await supabase
        .from('delivery_records')
        .insert([{
          deliveryboyname: selectedBoy,
          delivery_date: selectedDate,
          total_delivered: delivered,
          bills_given: received,
          operator_app_done: operatorAppDone,
          actual_operator_app: null,
          vip_quota: vip,
          net_balance: balance,
          remarks: vipRemarks.trim() || null,
        }])
        .select()
        .single();

      if (recordError) throw recordError;

      if (operatorPending > 0 && record) {
        const billRows = manualBillNumbers.map((no) => ({
          delivery_record_id: record.id,
          deliveryboyname: selectedBoy,
          bill_no: no,
          status: 'pending_ledger',
          is_confirmed_operator: false,
        }));
        const { error: billsErr } = await supabase.from('manual_bill_nos').insert(billRows);
        if (billsErr) throw billsErr;
      }

      resetEntryFlow();
      setSelectedBoy('');

      setTimeout(async () => {
        try {
          await fetchTodayDataAndStats();
          await fetchHistoricalLedgerData();
        } catch (fetchErr: any) {
          console.error('Post-save fetch error:', fetchErr?.message);
        }
        Alert.alert('Success', 'Delivery configuration successfully saved to the ledger database.');
      }, 300);
    } catch (err: any) {
      Alert.alert('Database Sync Error', err?.message || 'Failed to submit records');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRecord = (recordId: string, boyName: string) => {
    Alert.alert('Delete Entry', `Delete entry for ${boyName}? Associated manual bills will also be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await supabase.from('manual_bill_nos').delete().eq('delivery_record_id', recordId);
            const { error = null } = await supabase.from('delivery_records').delete().eq('id', recordId);
            if (error) throw error;
            await fetchTodayDataAndStats();
            await fetchHistoricalLedgerData();
          } catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to erase record');
          }
        },
      },
    ]);
  };

  const handleOpenResolution = (bill: ManualBill) => {
    setResolvingBill(bill);
    setResolutionVisible(true);
  };

  const handleResolveState = async (resolvedStatus: 'operator_completed' | 'manual_completed') => {
    if (!resolvingBill) return;
    setResolvingState(true);
    try {
      const isOperator = resolvedStatus === 'operator_completed';
      const { error: updateErr } = await supabase
        .from('manual_bill_nos')
        .update({
          status: resolvedStatus,
          is_confirmed_operator: isOperator,
          confirmed_at: isOperator ? new Date().toISOString() : null,
        })
        .eq('id', resolvingBill.id);
      if (updateErr) throw updateErr;

      if (isOperator) {
        const { data: rec, error: getErr } = await supabase
          .from('delivery_records')
          .select('operator_app_done')
          .eq('id', resolvingBill.delivery_record_id)
          .single();
        if (getErr) throw getErr;
        await supabase
          .from('delivery_records')
          .update({ operator_app_done: (rec.operator_app_done || 0) + 1 })
          .eq('id', resolvingBill.delivery_record_id);
      }

      setResolutionVisible(false);
      setResolvingBill(null);
      Alert.alert('Updated', 'Ledger reference successfully reconciled.');
      await fetchTodayDataAndStats();
      await fetchHistoricalLedgerData();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update transaction status');
    } finally {
      setResolvingState(false);
    }
  };

  const toggleAccordion = (boyName: string) => {
    setExpandedBoy(expandedBoy === boyName ? null : boyName);
  };

  const handleScrollToInput = (yOffset: number) => {
    scrollViewRef.current?.scrollTo({ y: yOffset, animated: true });
  };

  // ─── Render: Entry Tab ────────────────────────────────────────────────────

  const renderEntryTab = () => {
    const filteredBoys = getFilteredDeliveryBoys();
    const bannerState = getVerificationBannerState();
    const sortedRecords = getSortedTodayRecords();
    const dateIsToday = isToday(parseISO(selectedDate));
    const showBillsKamQuestion = step1Confirmed;
    const showStep2 = billsKamEffective !== null;
    const showOperatorQuestion = step2Confirmed;
    const showManualBills = operatorPendingEffective !== null && operatorPendingEffective > 0;
    const showVipQuestion = billsKamEffective !== null && billsKamEffective > 0;
    const manualBillsSatisfied = operatorPendingEffective !== null &&
      (operatorPendingEffective === 0 || manualBillNumbers.every((b) => b.trim() !== ''));
    const vipSatisfied = billsKamEffective === 0 || (vipEffective !== null && vipRemarksValid());
    const showOperatorBookingQuestion = manualBillsSatisfied && vipSatisfied;
    const readyToSave = canSaveEntry();

    return (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <ScrollView
          ref={scrollViewRef}
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[BPCL_BLUE]} tintColor={BPCL_BLUE} />
          }
        >
          <SummaryCard stats={summaryStats} loading={loadingStats} />
          <DateSelector selectedDate={selectedDate} onDateChange={(date) => {
            setSelectedDate(date);
            setSelectedBoy('');
            resetEntryFlow();
          }} />

          {bannerState !== null && (
            <View style={[
              styles.syncBanner,
              bannerState.allSynced ? styles.syncBannerGreen : styles.syncBannerAmber,
            ]}>
              <Ionicons
                name={bannerState.allSynced ? 'checkmark-done-circle' : 'warning-outline'}
                size={18}
                color={bannerState.allSynced ? '#15803d' : '#92400e'}
              />
              <Text style={[
                styles.syncBannerText,
                { color: bannerState.allSynced ? '#15803d' : '#92400e' },
              ]}>
                {bannerState.allSynced
                  ? 'All rows synced — Operator delivery count matches actual operator delivery count'
                  : `${bannerState.unverifiedCount} ${bannerState.unverifiedCount === 1 ? 'entry' : 'entries'} pending operator verification — tap a card to verify`}
              </Text>
            </View>
          )}

          <View style={styles.card}>
            <SectionHeader title="Select Delivery Boy" icon="person-outline" />
            {loading ? (
              <ActivityIndicator color={BPCL_BLUE} style={{ marginVertical: 12 }} />
            ) : (
              <>
                <TouchableOpacity style={styles.dropdownButton} onPress={() => setBoyDropdownOpen((p) => !p)}>
                  <Text style={[styles.dropdownButtonText, !selectedBoy && styles.dropdownPlaceholder]}>
                    {selectedBoy || 'Select delivery boy...'}
                  </Text>
                  <Ionicons name={boyDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
                </TouchableOpacity>
                {boyDropdownOpen && (
                  <View style={styles.dropdownList}>
                    {filteredBoys.length === 0 ? (
                      <View style={{ padding: 16, alignItems: 'center' }}>
                        <Text style={{ color: '#94a3b8', fontSize: 14 }}>No delivery boys available</Text>
                      </View>
                    ) : (
                      filteredBoys.map((boy) => (
                        <TouchableOpacity
                          key={boy.name}
                          style={[styles.dropdownItem, selectedBoy === boy.name && styles.dropdownItemSelected]}
                          onPress={() => {
                            resetEntryFlow();
                            setSelectedBoy(boy.name);
                            setBoyDropdownOpen(false);
                            setTimeout(() => {
                              totalDeliveredRef.current?.focus();
                              handleScrollToInput(200);
                            }, 250);
                          }}
                        >
                          <Text style={[styles.dropdownItemText, selectedBoy === boy.name && styles.dropdownItemTextSelected]}>
                            {boy.name}
                          </Text>
                          {selectedBoy === boy.name && <Ionicons name="checkmark" size={18} color="#fff" />}
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}
              </>
            )}
          </View>

          <View style={styles.card}>
            <SectionHeader title="Daily Reconciliation" icon="clipboard-outline" />

            <Text style={styles.label}>Step 1: Total Cylinders Delivered</Text>
            <View style={styles.stepInputRow}>
              <TextInput
                ref={totalDeliveredRef}
                style={[styles.input, { flex: 1 }]}
                placeholder="e.g. 42"
                keyboardType="numeric"
                value={totalDelivered}
                onChangeText={(t) => {
                  setTotalDelivered(t);
                  if (step1Confirmed) setStep1Confirmed(false);
                }}
                editable={!!selectedBoy}
                onFocus={() => handleScrollToInput(280)}
              />
              <TouchableOpacity
                style={[styles.tickButton, (!selectedBoy || !totalDelivered) && styles.tickButtonDisabled]}
                disabled={!selectedBoy || !totalDelivered}
                onPress={() => setStep1Confirmed(true)}
              >
                <Ionicons name="checkmark" size={20} color="#fff" />
              </TouchableOpacity>
            </View>

            {showBillsKamQuestion && (
              <QuestionCard title="Kitne bill kam hain?">
                <CirclePicker
                  value={billsKamValue}
                  onSelect={setBillsKamValue}
                  customValue={billsKamCustom}
                  onCustomChange={setBillsKamCustom}
                />
              </QuestionCard>
            )}

            {showStep2 && (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Step 2: Bills Received</Text>
                <View style={styles.stepInputRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    keyboardType="numeric"
                    value={billsReceived}
                    onChangeText={(t) => {
                      setBillsReceived(t);
                      if (step2Confirmed) setStep2Confirmed(false);
                    }}
                    onFocus={() => handleScrollToInput(400)}
                  />
                  <TouchableOpacity
                    style={[styles.tickButton, !billsReceived && styles.tickButtonDisabled]}
                    disabled={!billsReceived}
                    onPress={() => setStep2Confirmed(true)}
                  >
                    <Ionicons name="checkmark" size={20} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {showOperatorQuestion && (
              <QuestionCard title="Kitne bill operator se hona baki hai?">
                <CirclePicker
                  value={operatorPendingValue}
                  onSelect={setOperatorPendingValue}
                  customValue={operatorPendingCustom}
                  onCustomChange={setOperatorPendingCustom}
                />
              </QuestionCard>
            )}

            {showManualBills && (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Outstanding Manual Bills ({operatorPendingEffective})</Text>
                {manualBillNumbers.map((val, idx) => (
                  <TextInput
                    key={idx}
                    style={[styles.input, { marginBottom: 8 }]}
                    placeholder={`Bill/Reference #${idx + 1}`}
                    value={val}
                    onChangeText={(t) => {
                      const updated = [...manualBillNumbers];
                      updated[idx] = t;
                      setManualBillNumbers(updated);
                    }}
                  />
                ))}
              </View>
            )}

            {showVipQuestion && (
              <QuestionCard title="VIP entries hain kya?">
                <CirclePicker
                  value={vipValue}
                  onSelect={setVipValue}
                  customValue={vipCustom}
                  onCustomChange={setVipCustom}
                  accent="#d97706"
                />
                {vipEffective !== null && (
                  <TextInput
                    style={[styles.input, { marginTop: 12, backgroundColor: '#fff' }]}
                    placeholder={
                      vipEffective > 0
                        ? `${vipEffective} naam comma se likhen (e.g. Ram, Shyam)`
                        : 'Remark (optional)'
                    }
                    value={vipRemarks}
                    onChangeText={setVipRemarks}
                  />
                )}
              </QuestionCard>
            )}

            {showOperatorBookingQuestion && (
              <QuestionCard title="Operator booking kitna hua?">
                <TextInput
                  style={[styles.input, { backgroundColor: '#fff' }]}
                  placeholder="e.g. 38"
                  keyboardType="numeric"
                  value={operatorBookingDone}
                  onChangeText={setOperatorBookingDone}
                />
              </QuestionCard>
            )}
          </View>

          {readyToSave && (
            <TouchableOpacity
              style={[styles.saveButton, saving && styles.buttonDisabled]}
              onPress={handleFinalSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                  <Text style={styles.saveButtonText}>Save to Ledger</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          <View style={[styles.sectionHeadingBox, { marginTop: 24 }]}>
            <Ionicons name="document-text-outline" size={18} color={BPCL_BLUE} />
            <Text style={styles.sectionHeadingText}>
              {dateIsToday ? "Today's Entries Summary" : `Entries for ${format(parseISO(selectedDate), 'dd MMM yyyy')}`}
            </Text>
          </View>

          {sortedRecords.length === 0 ? (
            <View style={styles.miniEmptyState}>
              <Text style={styles.miniEmptyStateText}>No entries processed yet for this date.</Text>
            </View>
          ) : (
            sortedRecords.map((rec) => {
              const vState = getVerificationState(rec, dateIsToday);
              const assocBills = todayBills.filter(b => b.delivery_record_id === rec.id);
              const effBalance = effectiveNetBalance(rec);
              const netColor = effBalance > 0 ? '#27ae60' : effBalance < 0 ? '#c0392b' : '#333';
              const netPrefix = effBalance > 0 ? '+' : '';

              let cardBorderColor = '#e2e8f0';
              let cardBg = '#fff';
              let verifyBadge = null;

              if (!dateIsToday) {
                if (vState === 'matched') {
                  cardBorderColor = '#86efac';
                  cardBg = '#f0fdf4';
                  verifyBadge = (
                    <View style={styles.verifyBadgeGreen}>
                      <Ionicons name="checkmark-circle" size={13} color="#15803d" />
                      <Text style={styles.verifyBadgeGreenText}>Operator count verified</Text>
                    </View>
                  );
                } else if (vState === 'unverified') {
                  cardBorderColor = '#fcd34d';
                  verifyBadge = (
                    <View style={styles.verifyBadgeAmber}>
                      <Ionicons name="time-outline" size={13} color="#92400e" />
                      <Text style={styles.verifyBadgeAmberText}>Tap to verify operator count</Text>
                      <Ionicons name="chevron-forward" size={12} color="#92400e" />
                    </View>
                  );
                } else if (vState === 'corrected') {
                  cardBorderColor = '#fca5a5';
                  cardBg = '#fff8f8';
                  verifyBadge = (
                    <View style={styles.verifyBadgeRed}>
                      <Ionicons name="alert-circle" size={13} color="#b91c1c" />
                      <Text style={styles.verifyBadgeRedText}>
                        Corrected: claimed {rec.operator_app_done} → actual {rec.actual_operator_app}
                      </Text>
                    </View>
                  );
                }
              }

              const isTappable = !dateIsToday && vState !== 'matched';

              return (
                <TouchableOpacity
                  key={rec.id}
                  activeOpacity={isTappable ? 0.7 : 1}
                  onPress={() => isTappable && handleOpenVerify(rec)}
                  style={[styles.todayEntryCard, { borderColor: cardBorderColor, borderWidth: 1.5, backgroundColor: cardBg }]}
                >
                  {verifyBadge}

                  <View style={styles.todayHeader}>
                    <Text style={styles.todayBoyName}>{rec.deliveryboyname}</Text>
                    <TouchableOpacity onPress={() => handleDeleteRecord(rec.id, rec.deliveryboyname)}>
                      <Ionicons name="trash-outline" size={18} color="#e74c3c" />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.todayStatsGrid}>
                    <Text style={styles.todayStatText}>Delivered: <Text style={{ fontWeight: '700' }}>{rec.total_delivered}</Text></Text>
                    <Text style={styles.todayStatText}>Bills: <Text style={{ fontWeight: '700' }}>{rec.bills_given}</Text></Text>
                    <Text style={styles.todayStatText}>
                      OTP App: <Text style={{ fontWeight: '700' }}>{rec.operator_app_done}</Text>
                      {rec.actual_operator_app !== null && rec.actual_operator_app !== undefined && rec.actual_operator_app !== rec.operator_app_done && (
                        <Text style={{ color: '#b91c1c', fontWeight: '700' }}> → {rec.actual_operator_app}</Text>
                      )}
                    </Text>
                    <Text style={styles.todayStatText}>VIP: <Text style={{ fontWeight: '700' }}>{rec.vip_quota}</Text></Text>
                  </View>

                  <View style={styles.todayFooter}>
                    <Text style={[styles.todayNetText, { color: netColor }]}>
                      Ledger Variance: {netPrefix}{effBalance}
                      {vState === 'corrected' && (
                        <Text style={{ fontSize: 10, color: '#94a3b8' }}>  (adjusted)</Text>
                      )}
                    </Text>
                    {rec.remarks && <Text style={styles.todayRemarks} numberOfLines={1}>*{rec.remarks}</Text>}
                  </View>

                  {assocBills.length > 0 && (
                    <View style={styles.todayBillsSection}>
                      <Text style={styles.todayBillsHeader}>Outstanding Manual Bills (Click to Resolve):</Text>
                      <View style={styles.todayBillsRow}>
                        {assocBills.map((bill) => {
                          const isPending = bill.status === 'pending_ledger';
                          let bg = '#fff', border = '#cbd5e1', textCol = '#475569';
                          if (isPending) { bg = '#fefdeb'; border = '#f1c40f'; textCol = '#b7950b'; }
                          else if (bill.status === 'operator_completed') { bg = '#eafaf1'; border = '#27ae60'; textCol = '#27ae60'; }
                          else if (bill.status === 'manual_completed') { bg = '#f1f5f9'; border = '#64748b'; textCol = '#64748b'; }
                          return (
                            <TouchableOpacity
                              key={bill.id}
                              style={[styles.miniBillChip, { backgroundColor: bg, borderColor: border }]}
                              onPress={() => isPending && handleOpenResolution(bill)}
                            >
                              <Text style={[styles.miniBillText, { color: textCol }]}>{bill.bill_no}</Text>
                              {isPending && <Ionicons name="chevron-forward-circle-outline" size={12} color="#b7950b" />}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  };

  // ─── Render: Pseudo Delivery Tab ("Marked Delivered") ─────────────────────

  const renderPseudoTab = () => {
    const pending = getPendingPseudoDeliveries();

    return (
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[BPCL_BLUE]} tintColor={BPCL_BLUE} />
        }
      >
        <View style={styles.manualHeader}>
          <Ionicons name="information-circle-outline" size={16} color="#ea580c" />
          <Text style={[styles.manualHeaderText, { color: '#9a3412' }]}>
            Use this when a cylinder is actually deliverable but the customer isn't at the premises / not reachable.
            Mark the bill No. here so it counts as delivered in the system (rating stays safe) — it stays flagged
            here until you actually hand it over, at which point you resolve it and the pending count goes down.
          </Text>
        </View>

        <View style={styles.pseudoTotalBanner}>
          <View style={styles.pseudoTotalIconWrap}>
            <Ionicons name="cube-outline" size={18} color="#ea580c" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.pseudoTotalCount}>{pending.length}</Text>
            <Text style={styles.pseudoTotalLabel}>
              {pending.length === 1 ? 'bill has' : 'bills have'} been marked delivered in system but not physically delivered
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <SectionHeader title="Mark a Bill as System-Delivered" icon="cube-outline" />
          <Text style={styles.label}>Bill / Order No.</Text>
          <TextInput
            style={[styles.input, { marginBottom: 12 }]}
            placeholder="e.g. 10234 or BILL-4521"
            value={pseudoBillNo}
            onChangeText={setPseudoBillNo}
            autoCapitalize="characters"
          />
          <Text style={styles.label}>Remark (optional — e.g. why customer unavailable)</Text>
          <TextInput
            style={[styles.input, { marginBottom: 14 }]}
            placeholder="e.g. Customer not reachable, will deliver next visit"
            value={pseudoRemarks}
            onChangeText={setPseudoRemarks}
          />
          <TouchableOpacity
            style={[styles.saveButton, { backgroundColor: '#ea580c', marginBottom: 0 }, (!pseudoBillNo.trim() || pseudoSaving) && styles.buttonDisabled]}
            onPress={handleAddPseudoDelivery}
            disabled={!pseudoBillNo.trim() || pseudoSaving}
          >
            {pseudoSaving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="add-circle-outline" size={20} color="#fff" />
                <Text style={styles.saveButtonText}>Mark as Delivered (System Only)</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.sectionHeadingBox, { marginTop: 8 }]}>
          <Ionicons name="hourglass-outline" size={18} color="#ea580c" />
          <Text style={styles.sectionHeadingText}>Pending Physical Delivery ({pending.length})</Text>
        </View>

        {pending.length === 0 ? (
          <View style={styles.miniEmptyState}>
            <Text style={styles.miniEmptyStateText}>Nothing pending — every system-marked bill has been physically delivered.</Text>
          </View>
        ) : (
          <View style={styles.pseudoChipsWrap}>
            {pending.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.pseudoChip}
                onPress={() => handleOpenPseudoResolve(item)}
                onLongPress={() => handleDeletePseudoDelivery(item)}
              >
                <Ionicons name="cube-outline" size={13} color="#ea580c" />
                <Text style={styles.pseudoChipText}>{item.bill_no}</Text>
                <Ionicons name="chevron-forward-circle-outline" size={13} color="#ea580c" />
              </TouchableOpacity>
            ))}
          </View>
        )}
        {pending.length > 0 && (
          <Text style={styles.pseudoHintText}>Tap a No. to confirm physical delivery · Long-press to delete a mistaken entry</Text>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    );
  };

  // ─── Render: Ledger Tab ───────────────────────────────────────────────────

  const renderLedgerTab = () => {
    const ledgerData = computeActiveLedger();
    const vipLedgerData = getHistoricalVipLedger();

    return (
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[BPCL_BLUE]} tintColor={BPCL_BLUE} />
        }
      >
        <View style={styles.manualHeader}>
          <Ionicons name="information-circle-outline" size={16} color={BPCL_BLUE} />
          <Text style={styles.manualHeaderText}>
            Displays boys with non-zero running ledger balances. Effective balance accounts for operator corrections. Click row to expand.
          </Text>
        </View>

        <View style={styles.sectionHeadingBox}>
          <Ionicons name="people-outline" size={18} color={BPCL_BLUE} />
          <Text style={styles.sectionHeadingText}>Delivery Associate Balances</Text>
        </View>

        {ledgerData.length === 0 ? (
          <View style={[styles.card, { padding: 24, alignItems: 'center', marginBottom: 20 }]}>
            <Ionicons name="checkmark-done-circle-outline" size={48} color="#27ae60" />
            <Text style={[styles.emptyStateText, { marginTop: 8 }]}>All Accounts Balanced</Text>
            <Text style={[styles.emptyStateSubText, { paddingHorizontal: 0 }]}>No delivery boys currently show a mismatch.</Text>
          </View>
        ) : (
          ledgerData.map((item) => {
            const isExpanded = expandedBoy === item.boyName;
            const balColor = item.cumulativeBalance > 0 ? '#27ae60' : '#e74c3c';
            const balLabel = item.cumulativeBalance > 0 ? `+${item.cumulativeBalance}` : `${item.cumulativeBalance}`;

            return (
              <View key={item.boyName} style={styles.ledgerBoyContainer}>
                <TouchableOpacity
                  style={[styles.ledgerBoyRow, isExpanded && styles.ledgerBoyRowExpanded]}
                  onPress={() => toggleAccordion(item.boyName)}
                >
                  <View style={styles.ledgerBoyProfile}>
                    <View style={styles.boyAvatar}>
                      <Text style={styles.boyAvatarText}>{item.boyName.charAt(0).toUpperCase()}</Text>
                    </View>
                    <Text style={styles.ledgerBoyName}>{item.boyName}</Text>
                  </View>
                  <View style={styles.ledgerRight}>
                    <View style={[styles.ledgerBalanceBadge, { backgroundColor: item.cumulativeBalance > 0 ? '#eafaf1' : '#fde8e8' }]}>
                      <Text style={[styles.ledgerBalanceText, { color: balColor }]}>{balLabel}</Text>
                    </View>
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color="#64748b" />
                  </View>
                </TouchableOpacity>

                {isExpanded && (
                  <View style={styles.ledgerHistoryContainer}>
                    <Text style={styles.historyHeading}>Discrepancies Ledger Log</Text>
                    {item.history.map((hist) => {
                      const eff = effectiveNetBalance(hist);
                      const itemBalColor = eff > 0 ? '#27ae60' : eff < 0 ? '#e74c3c' : '#333';
                      const itemBalLabel = eff > 0 ? `+${eff}` : `${eff}`;
                      const hasCorrectionDelta = hist.actual_operator_app !== null &&
                        hist.actual_operator_app !== undefined &&
                        hist.actual_operator_app !== hist.operator_app_done;

                      return (
                        <View key={hist.id} style={styles.historyRow}>
                          <View style={{ flex: 1.5 }}>
                            <Text style={styles.historyDate}>
                              {format(new Date(hist.delivery_date + 'T00:00:00'), 'dd MMM yyyy')}
                            </Text>
                            {hasCorrectionDelta && (
                              <Text style={[styles.historyRemarks, { color: '#b91c1c' }]}>
                                ⚠ Op correction: {hist.operator_app_done}→{hist.actual_operator_app}
                              </Text>
                            )}
                            {hist.remarks && <Text style={styles.historyRemarks} numberOfLines={2}>*{hist.remarks}</Text>}
                          </View>
                          <View style={styles.historyGrid}>
                            <Text style={styles.historyStatText}>D:{hist.total_delivered}</Text>
                            <Text style={styles.historyStatText}>B:{hist.bills_given}</Text>
                            {hist.vip_quota > 0 && <Text style={[styles.historyStatText, { color: '#d97706' }]}>V:{hist.vip_quota}</Text>}
                          </View>
                          <View style={{ flex: 1, alignItems: 'flex-end' }}>
                            <Text style={[styles.historyRowBalance, { color: itemBalColor }]}>{itemBalLabel}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })
        )}

        <View style={[styles.sectionHeadingBox, { marginTop: 24 }]}>
          <Ionicons name="cube-outline" size={18} color="#ea580c" />
          <Text style={styles.sectionHeadingText}>System-Delivered, Not Physically Delivered</Text>
        </View>

        {(() => {
          const pendingPseudo = getPendingPseudoDeliveries();
          return (
            <View style={[styles.card, { borderWidth: 1, borderColor: '#fed7aa', backgroundColor: '#fff7ed' }]}>
              <Text style={styles.pseudoLedgerSummaryText}>
                <Text style={{ fontWeight: '800', color: '#ea580c' }}>{pendingPseudo.length}</Text>
                {pendingPseudo.length === 1 ? ' bill has' : ' bills have'} been marked delivered in the system but not
                physically delivered yet. Tap a No. below once it's actually handed over.
              </Text>
              {pendingPseudo.length === 0 ? (
                <Text style={[styles.miniEmptyStateText, { marginTop: 8 }]}>All caught up — nothing pending.</Text>
              ) : (
                <View style={[styles.pseudoChipsWrap, { marginTop: 12 }]}>
                  {pendingPseudo.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.pseudoChip}
                      onPress={() => handleOpenPseudoResolve(item)}
                    >
                      <Ionicons name="cube-outline" size={13} color="#ea580c" />
                      <Text style={styles.pseudoChipText}>{item.bill_no}</Text>
                      <Ionicons name="chevron-forward-circle-outline" size={13} color="#ea580c" />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          );
        })()}

        <View style={[styles.sectionHeadingBox, { marginTop: 24 }]}>
          <Ionicons name="star" size={18} color="#d97706" />
          <Text style={styles.sectionHeadingText}>VIP & Distributor Quota Ledger</Text>
        </View>

        {vipLedgerData.length === 0 ? (
          <View style={[styles.card, { padding: 20, alignItems: 'center' }]}>
            <Text style={styles.miniEmptyStateText}>No VIP distributions logged in history.</Text>
          </View>
        ) : (
          <View style={styles.card}>
            {vipLedgerData.map((vip) => (
              <View key={vip.id} style={styles.vipLedgerRow}>
                <View style={{ flex: 1.5 }}>
                  <Text style={styles.vipLedgerDate}>
                    {format(new Date(vip.delivery_date + 'T00:00:00'), 'dd MMM yyyy')}
                  </Text>
                  <Text style={styles.vipLedgerAssociate}>Boy: {vip.deliveryboyname}</Text>
                </View>
                <View style={{ flex: 2, paddingHorizontal: 8 }}>
                  <Text style={styles.vipLedgerDesc} numberOfLines={2}>
                    {vip.remarks || 'Direct VIP Order'}
                  </Text>
                </View>
                <View style={styles.vipLedgerQtyBox}>
                  <Text style={styles.vipLedgerQtyText}>{vip.vip_quota} Qty</Text>
                </View>
              </View>
            ))}
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    );
  };

  // ─── Render: Verify Modal ─────────────────────────────────────────────────

  const renderVerifyModal = () => {
    const claimed = verifyingRecord?.operator_app_done ?? 0;
    const actual = parseInt(verifyActualCount, 10);
    const delta = isNaN(actual) ? 0 : claimed - actual;
    const isMatch = !isNaN(actual) && actual === claimed;

    return (
      <Modal
        visible={verifyModalVisible}
        transparent
        animationType="slide"
        onRequestClose={handleCloseVerifyModal}
      >
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.beautifiedModalOverlay}>
            {verifyingRecord ? (
              <View style={styles.beautifiedModalCard}>
                <View style={styles.modalDragHandle} />

                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <View style={styles.beautifiedModalHeader}>
                    <View style={[styles.modalIconContainer, { backgroundColor: '#e0f2fe' }]}>
                      <Ionicons name="shield-checkmark-outline" size={24} color={BPCL_BLUE} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.beautifiedModalTitle}>Verify Operator Count</Text>
                      <Text style={styles.beautifiedModalSubtitle}>
                        {verifyingRecord.deliveryboyname} · {format(parseISO(verifyingRecord.delivery_date), 'dd MMM yyyy')}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.verifyInfoRow}>
                    <View style={styles.verifyInfoBox}>
                      <Text style={styles.verifyInfoLabel}>Claimed (App)</Text>
                      <Text style={[styles.verifyInfoValue, { color: BPCL_BLUE }]}>{claimed}</Text>
                    </View>
                    <Ionicons name="arrow-forward" size={20} color="#94a3b8" />
                    <View style={styles.verifyInfoBox}>
                      <Text style={styles.verifyInfoLabel}>Actual (System)</Text>
                      <Text style={[styles.verifyInfoValue, {
                        color: isMatch ? '#15803d' : delta > 0 ? '#b91c1c' : '#0f172a'
                      }]}>
                        {isNaN(actual) ? '—' : actual}
                      </Text>
                    </View>
                    {delta > 0 && !isNaN(actual) && (
                      <>
                        <Ionicons name="arrow-forward" size={20} color="#94a3b8" />
                        <View style={[styles.verifyInfoBox, { backgroundColor: '#fef2f2', borderRadius: 8, padding: 8 }]}>
                          <Text style={styles.verifyInfoLabel}>Δ Delta</Text>
                          <Text style={[styles.verifyInfoValue, { color: '#b91c1c' }]}>-{delta}</Text>
                        </View>
                      </>
                    )}
                  </View>

                  <Text style={styles.label}>Actual Operator App Count (from system)</Text>
                  <TextInput
                    style={styles.beautifiedInput}
                    placeholder={`Claimed was ${claimed} — enter actual`}
                    keyboardType="numeric"
                    value={verifyActualCount}
                    onChangeText={handleVerifyCountChange}
                    autoFocus
                  />

                  {isMatch && (
                    <View style={styles.verifyMatchBanner}>
                      <Ionicons name="checkmark-circle" size={18} color="#15803d" />
                      <Text style={styles.verifyMatchText}>Count matches — this entry will be marked verified.</Text>
                    </View>
                  )}

                  {delta > 0 && !isNaN(actual) && (
                    <View style={styles.verifyCorrectionBox}>
                      <View style={styles.verifyCorrectionHeader}>
                        <Ionicons name="alert-circle-outline" size={16} color="#92400e" />
                        <Text style={styles.verifyCorrectionHeaderText}>
                          {delta} discrepant {delta === 1 ? 'delivery' : 'deliveries'} found — enter bill reference{delta > 1 ? 's' : ''}
                        </Text>
                      </View>
                      <Text style={[styles.beautifiedModalDesc, { marginBottom: 12, color: '#78350f' }]}>
                        These will be added to the boy's pending ledger as unresolved bills (same as manual bill flow).
                      </Text>
                      {Array.from({ length: delta }).map((_, idx) => (
                        <View key={idx} style={{ marginBottom: 10 }}>
                          <Text style={styles.label}>Reference #{idx + 1} (Bill No / Customer Name)</Text>
                          <TextInput
                            style={styles.beautifiedInput}
                            placeholder={`e.g. BILL-2024 or Customer Name`}
                            value={verifyCorrectionRefs[idx] || ''}
                            onChangeText={(text) => {
                              const updated = [...verifyCorrectionRefs];
                              updated[idx] = text;
                              setVerifyCorrectionRefs(updated);
                            }}
                          />
                        </View>
                      ))}
                    </View>
                  )}

                  <View style={[styles.beautifiedModalButtons, { marginTop: 8 }]}>
                    <TouchableOpacity
                      style={styles.beautifiedCancelButton}
                      onPress={handleCloseVerifyModal}
                    >
                      <Text style={styles.beautifiedCancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.beautifiedConfirmButton, verifySaving && styles.buttonDisabled]}
                      onPress={handleCommitVerification}
                      disabled={verifySaving}
                    >
                      {verifySaving ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <>
                          <Text style={styles.beautifiedConfirmText}>
                            {isMatch ? 'Mark Verified' : delta > 0 ? 'Save Correction' : 'Confirm'}
                          </Text>
                          <Ionicons name="checkmark-circle-outline" size={16} color="#fff" style={{ marginLeft: 6 }} />
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              </View>
            ) : (
              <View style={[styles.beautifiedModalCard, { paddingVertical: 40, alignItems: 'center' }]}>
                <ActivityIndicator size="large" color={BPCL_BLUE} />
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  };

  // ─── Render: Resolution Modal ─────────────────────────────────────────────

  const renderResolutionModal = () => (
    <Modal visible={resolutionVisible} transparent animationType="fade" onRequestClose={() => setResolutionVisible(false)}>
      <View style={styles.beautifiedModalOverlayCenter}>
        <View style={styles.centerModalCard}>
          <View style={[styles.modalIconContainerCenter, { backgroundColor: '#e0f2fe' }]}>
            <Ionicons name="help-circle" size={36} color={BPCL_BLUE} />
          </View>
          <Text style={styles.centerModalTitle}>Reconcile Outstanding Bill</Text>
          <Text style={styles.centerModalDesc}>
            Verify if manual bill <Text style={{ fontWeight: 'bold', color: BPCL_BLUE }}>{resolvingBill?.bill_no}</Text> for{' '}
            <Text style={{ fontWeight: '600' }}>{resolvingBill?.deliveryboyname}</Text> has now been processed.
          </Text>
          <View style={{ flexDirection: 'column', gap: 10, width: '100%' }}>
            <TouchableOpacity
              style={[styles.centerModalConfirmButton, resolvingState && styles.buttonDisabled]}
              onPress={() => handleResolveState('operator_completed')}
              disabled={resolvingState}
            >
              <Ionicons name="phone-portrait-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.centerModalConfirmText}>Operator App (OTP) Done</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.centerModalConfirmButton, { backgroundColor: '#64748b' }, resolvingState && styles.buttonDisabled]}
              onPress={() => handleResolveState('manual_completed')}
              disabled={resolvingState}
            >
              <Ionicons name="document-text-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.centerModalConfirmText}>Permanent Manual Only</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.centerModalCancelButton}
              onPress={() => { setResolutionVisible(false); setResolvingBill(null); }}
            >
              <Text style={styles.centerModalCancelText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ─── Render: Pseudo Resolve Modal ─────────────────────────────────────────

  const renderPseudoResolveModal = () => (
    <Modal visible={pseudoResolveVisible} transparent animationType="fade" onRequestClose={handleClosePseudoResolve}>
      <View style={styles.beautifiedModalOverlayCenter}>
        <View style={styles.centerModalCard}>
          <View style={[styles.modalIconContainerCenter, { backgroundColor: '#ffedd5' }]}>
            <Ionicons name="cube" size={32} color="#ea580c" />
          </View>
          <Text style={styles.centerModalTitle}>Confirm Physical Delivery</Text>
          <Text style={styles.centerModalDesc}>
            Confirm bill No. <Text style={{ fontWeight: 'bold', color: '#ea580c' }}>{pseudoResolving?.bill_no}</Text> has now
            actually been handed over to the customer. This will remove it from the pending list and reduce the count by 1.
          </Text>
          <View style={{ width: '100%', marginBottom: 16 }}>
            <Text style={styles.label}>Actual Delivery Date</Text>
            <TextInput
              style={styles.beautifiedInput}
              value={pseudoResolveDate}
              onChangeText={setPseudoResolveDate}
              placeholder="yyyy-MM-dd"
            />
          </View>
          <View style={{ flexDirection: 'column', gap: 10, width: '100%' }}>
            <TouchableOpacity
              style={[styles.centerModalConfirmButton, { backgroundColor: '#ea580c' }, pseudoResolveSaving && styles.buttonDisabled]}
              onPress={handleCommitPseudoResolve}
              disabled={pseudoResolveSaving}
            >
              {pseudoResolveSaving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={styles.centerModalConfirmText}>Confirm Delivered</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.centerModalCancelButton} onPress={handleClosePseudoResolve}>
              <Text style={styles.centerModalCancelText}>Not Yet — Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ─── Root Render ──────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Delivery Records</Text>
          <Text style={styles.headerSubtitle}>Operator balance ledgering dashboard</Text>
        </View>
      </SafeAreaView>

      <View style={styles.innerTabBar}>
        <TouchableOpacity
          style={[styles.innerTab, innerTab === 'entry' && styles.innerTabActive]}
          onPress={() => setInnerTab('entry')}
        >
          <Ionicons name="add-circle-outline" size={16} color={innerTab === 'entry' ? '#fff' : BPCL_BLUE} />
          <Text style={[styles.innerTabText, innerTab === 'entry' && styles.innerTabTextActive]}>New Entry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.innerTab, innerTab === 'pseudo' && { backgroundColor: '#ea580c' }]}
          onPress={() => { setInnerTab('pseudo'); void fetchPseudoDeliveries(); }}
        >
          <Ionicons name="cube-outline" size={16} color={innerTab === 'pseudo' ? '#fff' : '#ea580c'} />
          <Text style={[styles.innerTabText, innerTab === 'pseudo' && styles.innerTabTextActive, innerTab === 'pseudo' ? null : { color: '#ea580c' }]}>
            Marked Delivered
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.innerTab, innerTab === 'ledger' && styles.innerTabActive]}
          onPress={() => { setInnerTab('ledger'); void fetchHistoricalLedgerData(); }}
        >
          <Ionicons name="list-outline" size={16} color={innerTab === 'ledger' ? '#fff' : BPCL_BLUE} />
          <Text style={[styles.innerTabText, innerTab === 'ledger' && styles.innerTabTextActive]}>Active Ledger</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
        {innerTab === 'entry' ? renderEntryTab() : innerTab === 'pseudo' ? renderPseudoTab() : renderLedgerTab()}
      </View>

      {renderResolutionModal()}
      {renderVerifyModal()}
      {renderPseudoResolveModal()}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },

  header: {
    backgroundColor: BPCL_BLUE,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 5,
  },
  headerContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 2 },

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
      flexDirection: 'column',   // was 'row'
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,                    // was 6
      paddingVertical: 8,        // was 10
      borderRadius: 8,
  },
  innerTabActive: { backgroundColor: BPCL_BLUE },
  innerTabText: {
      fontSize: 11,              // was 14 — 14 is too big for 3-across on narrow screens
      fontWeight: '600',
      color: BPCL_BLUE,
      textAlign: 'center',
  },
  innerTabTextActive: { color: '#fff' },

  summaryCard: {
    backgroundColor: BPCL_BLUE, borderRadius: 14, padding: 14, marginBottom: 12,
    elevation: 4, shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6,
  },
  summaryTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  summaryTitle: {
    fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.9)',
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  summaryRow: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 10, overflow: 'hidden' },
  summaryBox: { flex: 1, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4 },
  summaryIconWrap: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: '#e8f4fd',
    alignItems: 'center', justifyContent: 'center', marginBottom: 6,
  },
  summaryCount: { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 2 },
  summaryLabel: {
    fontSize: 9, color: '#888', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.3,
  },
  summaryDivider: { width: 1, backgroundColor: '#eee', marginVertical: 8 },
  summaryFooterRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: 12, paddingHorizontal: 4,
  },
  footerStatLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' },
  footerStatValue: { fontWeight: '800' },

  syncBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1,
  },
  syncBannerGreen: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  syncBannerAmber: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  syncBannerText: { flex: 1, fontSize: 12, fontWeight: '600', lineHeight: 18 },

  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 12,
    elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 3,
  },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionHeaderText: { fontSize: 15, fontWeight: 'bold', color: '#1e293b' },

  dateButton: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f0f8ff', borderWidth: 1, borderColor: BPCL_BLUE,
    borderRadius: 8, padding: 12,
  },
  dateButtonText: { flex: 1, fontSize: 15, fontWeight: '600', color: BPCL_BLUE },

  dropdownButton: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: BPCL_BLUE,
    borderRadius: 10, padding: 14, flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center',
  },
  dropdownButtonText: { fontSize: 15, color: '#333', fontWeight: '600' },
  dropdownPlaceholder: { color: '#aaa', fontWeight: '400' },
  dropdownList: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd',
    borderRadius: 10, marginTop: 4, overflow: 'hidden',
    elevation: 4, shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4,
  },
  dropdownItem: {
    padding: 14, flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  dropdownItemSelected: { backgroundColor: BPCL_BLUE },
  dropdownItemText: { fontSize: 15, color: '#333' },
  dropdownItemTextSelected: { color: '#fff', fontWeight: 'bold' },

  label: { fontSize: 13, color: '#475569', marginBottom: 6, fontWeight: '600' },
  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#cbd5e1',
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 15, color: '#0f172a',
  },

  stepInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tickButton: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: BPCL_BLUE,
    alignItems: 'center', justifyContent: 'center',
  },
  tickButtonDisabled: { backgroundColor: '#cbd5e1' },

  questionCard: {
    backgroundColor: '#f0f8ff', borderRadius: 14, borderWidth: 1, borderColor: '#bfe0f5',
    padding: 14, marginTop: 14,
  },
  questionCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  questionCardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a' },

  circleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  circleBtn: {
    width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: '#cbd5e1',
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
  },
  circleBtnText: { fontSize: 15, fontWeight: '700', color: '#334155' },
  circleCustomInput: {
    width: 46, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: '#cbd5e1',
    textAlign: 'center', fontSize: 13, fontWeight: '700', color: '#334155', backgroundColor: '#fff',
  },

  saveButton: {
    backgroundColor: BPCL_BLUE, padding: 16, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginBottom: 8, elevation: 3, shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
  },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  buttonDisabled: { opacity: 0.6 },

  manualHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#e0f2fe', padding: 10, borderRadius: 8, marginBottom: 12,
  },
  manualHeaderText: { flex: 1, fontSize: 11, color: BPCL_BLUE, fontStyle: 'italic' },

  sectionHeadingBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  sectionHeadingText: { fontSize: 15, fontWeight: 'bold', color: '#1e293b' },

  miniEmptyState: { backgroundColor: '#f1f5f9', borderRadius: 10, padding: 20, alignItems: 'center' },
  miniEmptyStateText: { color: '#64748b', fontSize: 13 },

  verifyBadgeGreen: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#dcfce7', borderRadius: 6, paddingHorizontal: 10,
    paddingVertical: 5, marginBottom: 10, alignSelf: 'flex-start',
  },
  verifyBadgeGreenText: { fontSize: 11, fontWeight: '700', color: '#15803d' },

  verifyBadgeAmber: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fef9c3', borderRadius: 6, paddingHorizontal: 10,
    paddingVertical: 5, marginBottom: 10, alignSelf: 'flex-start',
  },
  verifyBadgeAmberText: { fontSize: 11, fontWeight: '700', color: '#92400e' },

  verifyBadgeRed: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fee2e2', borderRadius: 6, paddingHorizontal: 10,
    paddingVertical: 5, marginBottom: 10, alignSelf: 'flex-start',
  },
  verifyBadgeRedText: { fontSize: 11, fontWeight: '700', color: '#b91c1c' },

  todayEntryCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10,
    elevation: 1, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2,
  },
  todayHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 8,
  },
  todayBoyName: { fontSize: 15, fontWeight: 'bold', color: '#0f172a' },
  todayStatsGrid: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: '#f8fafc', borderRadius: 8, padding: 10, marginBottom: 8,
  },
  todayStatText: { fontSize: 12, color: '#475569' },
  todayFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  todayNetText: { fontSize: 13, fontWeight: 'bold' },
  todayRemarks: {
    fontSize: 11, color: '#64748b', fontStyle: 'italic',
    flex: 1, textAlign: 'right', marginLeft: 10,
  },

  todayBillsSection: {
    marginTop: 12, borderTopWidth: 1,
    borderTopColor: '#f1f5f9', paddingTop: 10,
  },
  todayBillsHeader: {
    fontSize: 11, fontWeight: '700', color: '#94a3b8',
    marginBottom: 6, textTransform: 'uppercase',
  },
  todayBillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  miniBillChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5,
  },
  miniBillText: { fontSize: 12, fontWeight: '600' },

  emptyStateText: { fontSize: 16, color: '#94a3b8', fontWeight: '600', marginTop: 12 },
  emptyStateSubText: {
    fontSize: 13, color: '#cbd5e1', marginTop: 4,
    textAlign: 'center', paddingHorizontal: 20,
  },

  ledgerBoyContainer: {
    backgroundColor: '#fff', borderRadius: 12, marginBottom: 10,
    overflow: 'hidden', elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 3,
  },
  ledgerBoyRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', padding: 14, backgroundColor: '#fff',
  },
  ledgerBoyRowExpanded: { borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  ledgerBoyProfile: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  boyAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: BPCL_BLUE, alignItems: 'center', justifyContent: 'center',
  },
  boyAvatarText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
  ledgerBoyName: { fontSize: 15, fontWeight: 'bold', color: '#1e293b' },
  ledgerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ledgerBalanceBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  ledgerBalanceText: { fontSize: 13, fontWeight: 'bold' },

  ledgerHistoryContainer: { backgroundColor: '#fafbfc', paddingHorizontal: 14, paddingBottom: 12 },
  historyHeading: {
    fontSize: 11, fontWeight: '700', color: '#94a3b8',
    textTransform: 'uppercase', letterSpacing: 0.5, marginVertical: 10,
  },
  historyRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  historyDate: { fontSize: 13, fontWeight: '600', color: '#334155' },
  historyRemarks: { fontSize: 11, color: '#64748b', fontStyle: 'italic', marginTop: 2 },
  historyGrid: {
    flex: 2, flexDirection: 'row',
    justifyContent: 'space-around', paddingHorizontal: 10,
  },
  historyStatText: { fontSize: 11, color: '#475569', fontWeight: '500' },
  historyRowBalance: { fontSize: 14, fontWeight: 'bold' },

  vipLedgerRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  vipLedgerDate: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  vipLedgerAssociate: { fontSize: 11, color: '#64748b', marginTop: 2 },
  vipLedgerDesc: { fontSize: 12, color: '#475569', fontStyle: 'italic' },
  vipLedgerQtyBox: {
    backgroundColor: '#fff3cd', borderColor: '#fcd34d',
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  vipLedgerQtyText: { fontSize: 12, fontWeight: '700', color: '#b45309' },

  beautifiedModalOverlay: {
    flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.6)', justifyContent: 'flex-end',
  },
  beautifiedModalOverlayCenter: {
    flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  beautifiedModalCard: {
    backgroundColor: '#ffffff', borderTopLeftRadius: 32, borderTopRightRadius: 32,
    paddingHorizontal: 24, paddingTop: 12, paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    maxHeight: '88%', shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: -10 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 24,
  },
  centerModalCard: {
    backgroundColor: '#ffffff', borderRadius: 24, padding: 24,
    width: '100%', maxWidth: 340, alignItems: 'center',
    shadowColor: '#0f172a', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2, shadowRadius: 16, elevation: 12,
  },
  modalDragHandle: {
    width: 38, height: 5, backgroundColor: '#e2e8f0',
    borderRadius: 3, alignSelf: 'center', marginBottom: 20,
  },
  beautifiedModalHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  modalIconContainer: {
    width: 48, height: 48, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
  },
  modalIconContainerCenter: {
    width: 64, height: 64, borderRadius: 32,
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
  },
  beautifiedModalTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a', letterSpacing: -0.3 },
  beautifiedModalSubtitle: { fontSize: 13, color: '#64748b', marginTop: 2, lineHeight: 18 },
  beautifiedModalDesc: { fontSize: 13, color: '#475569', lineHeight: 20, marginBottom: 16 },
  beautifiedInput: {
    backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0',
    borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 15, color: '#0f172a', marginBottom: 16,
  },
  beautifiedModalButtons: { flexDirection: 'row', gap: 12, marginTop: 16 },
  beautifiedCancelButton: {
    flex: 1, paddingVertical: 14, borderRadius: 14,
    borderWidth: 1.5, borderColor: '#e2e8f0', backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  beautifiedCancelText: { fontSize: 15, color: '#64748b', fontWeight: '600' },
  beautifiedConfirmButton: {
    flex: 2, paddingVertical: 14, borderRadius: 14, backgroundColor: BPCL_BLUE,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    shadowColor: BPCL_BLUE, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 8, elevation: 4,
  },
  beautifiedConfirmText: { fontSize: 15, color: '#fff', fontWeight: '700' },

  beautifiedConfirmContainer: {
    backgroundColor: '#f8fafc', borderRadius: 16,
    borderWidth: 1, borderColor: '#e2e8f0', padding: 16, marginTop: 8,
  },
  beautifiedConfirmRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  beautifiedConfirmLabel: { fontSize: 14, color: '#64748b', fontWeight: '500' },
  beautifiedConfirmValue: { fontSize: 14, color: '#0f172a', fontWeight: '600' },
  boldValue: { fontSize: 16 },
  beautifiedBlockSeparator: { height: 1, backgroundColor: '#e2e8f0', marginVertical: 6 },

  centerModalTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a', marginBottom: 8 },
  centerModalDesc: {
    fontSize: 14, color: '#475569', textAlign: 'center',
    lineHeight: 22, marginBottom: 24,
  },
  centerModalCancelButton: {
    width: '100%', paddingVertical: 12, borderRadius: 12,
    backgroundColor: '#f1f5f9', alignItems: 'center', marginTop: 6,
  },
  centerModalCancelText: { fontSize: 14, color: '#475569', fontWeight: '600' },
  centerModalConfirmButton: {
    width: '100%', paddingVertical: 12, borderRadius: 12,
    backgroundColor: BPCL_BLUE, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
  },
  centerModalConfirmText: { fontSize: 14, color: '#fff', fontWeight: '600' },

  verifyInfoRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 12, backgroundColor: '#f8fafc', borderRadius: 12,
    padding: 14, marginBottom: 20,
  },
  verifyInfoBox: { alignItems: 'center', minWidth: 60 },
  verifyInfoLabel: { fontSize: 10, color: '#94a3b8', fontWeight: '600', textTransform: 'uppercase', marginBottom: 4 },
  verifyInfoValue: { fontSize: 24, fontWeight: '800', color: '#0f172a' },

  verifyMatchBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f0fdf4', borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: '#86efac', marginBottom: 16,
  },
  verifyMatchText: { flex: 1, fontSize: 13, color: '#15803d', fontWeight: '600' },

  verifyCorrectionBox: {
    backgroundColor: '#fffbeb', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#fcd34d', marginBottom: 8,
  },
  verifyCorrectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  verifyCorrectionHeaderText: { flex: 1, fontSize: 13, fontWeight: '700', color: '#92400e' },

  // ── Pseudo Delivery ("Marked Delivered") styles ──────────────────────────
  pseudoTotalBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff7ed', borderWidth: 1, borderColor: '#fed7aa',
    borderRadius: 12, padding: 14, marginBottom: 12,
  },
  pseudoTotalIconWrap: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: '#ffedd5',
    alignItems: 'center', justifyContent: 'center',
  },
  pseudoTotalCount: { fontSize: 22, fontWeight: '800', color: '#ea580c' },
  pseudoTotalLabel: { fontSize: 12, color: '#9a3412', fontWeight: '600', marginTop: 2, lineHeight: 16 },

  pseudoChipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pseudoChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fff7ed', borderWidth: 1.5, borderColor: '#fdba74',
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7,
  },
  pseudoChipText: { fontSize: 13, fontWeight: '700', color: '#ea580c' },
  pseudoHintText: { fontSize: 11, color: '#94a3b8', marginTop: 10, textAlign: 'center' },
  pseudoLedgerSummaryText: { fontSize: 12, color: '#9a3412', lineHeight: 18 },
});
