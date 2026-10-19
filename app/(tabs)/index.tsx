import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  ActivityIndicator
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Calendar } from 'react-native-calendars';
import { useDataStore, ReconciliationReason } from '@/store/dataStore';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';
import * as Sharing from 'expo-sharing';
import { useRole } from '../../hooks/useRole';
import { supabase } from "@/lib/supabase";
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';

const FileSystem = require('expo-file-system');

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

// Reasons that require a manually typed consumer/party name
const NAMED_INPUT_REASONS = ['NC', 'DBC', 'TV', 'Office'];
// Reasons that are auto-attributed to the delivery staff selected for this entry
const STAFF_AUTO_REASONS = ['Empty Baki', 'Empty Return'];

export default function CombinedDeliveryRecordsScreen() {
  const [activeTab, setActiveTab] = useState<'entry' | 'records'>('entry');
  const role = useRole();

  // ─── Unified Date State ───────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false); // New Entry Tab date picker
  const [showCalendar, setShowCalendar] = useState(false);     // Daily Records Tab calendar

  // ─── useDataStore Extraction ──────────────────────────────────────────────
  const {
    cylinderPrice,
    employees = [],
    addTransaction,
    addDelivery,
    loadEmployees,
    loadingEmployees,
    deliveries = [],
    loadDeliveriesByDate,
    loadDailySummary,
    deleteDelivery,
    extraPaytmCreditAmount,
  } = useDataStore() as any;

  // Refs for keyboard navigation
  const emptyRef = useRef<TextInput>(null);
  const onlineRef = useRef<TextInput>(null);
  const paytmRef = useRef<TextInput>(null);
  const partialRef = useRef<TextInput>(null);
  const cashRef = useRef<TextInput>(null);

  const [activeField, setActiveField] = useState<string | null>(null);
  const [showDBA, setShowDBA] = useState(false);
  const [submittedNames, setSubmittedNames] = useState<string[]>([]);

  // Delivery Form Inputs
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [cylindersDelivered, setCylindersDelivered] = useState('');
  const [emptyReceived, setEmptyReceived] = useState('');
  const [onlinePayments, setOnlinePayments] = useState('');
  const [paytmPayments, setPaytmPayments] = useState('');
  const [partialDigital, setPartialDigital] = useState('');
  const [cashCollected, setCashCollected] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emptyManuallyEdited, setEmptyManuallyEdited] = useState(false);

  // Delivery Reconciliation Bottom Sheet
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [reconciliationReasons, setReconciliationReasons] = useState<ReconciliationReason[]>([]);
  const [pendingDelivery, setPendingDelivery] = useState<any>(null);

  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['85%'], []);

  const [loading, setLoading] = useState(false);

  // ─── UNIFIED LOAD DATA FUNCTION (Fetches state for both tabs simultaneously) ───
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      await Promise.all([
        loadDeliveriesByDate(selectedDate),
        loadDailySummary(selectedDate),
        loadEmployees()
      ]);

      const { data } = await supabase
        .from('dashboard_deliveryrecords')
        .select('name')
        .eq('date', selectedDate);
      if (data) {
        setSubmittedNames(data.map((r: any) => r.name));
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to load date-specific data');
    } finally {
      setLoading(false);
    }
  }, [selectedDate, loadDeliveriesByDate, loadDailySummary, loadEmployees]);

  useEffect(() => {
    if (role !== 'viewer') {
      loadData();
    }
  }, [selectedDate, role, loadData]);

  useEffect(() => {
    return () => {
      bottomSheetRef.current?.close();
    };
  }, []);

  // ─── NEW ENTRY: CALCULATIONS ──────────────────────────────────────────────

  const totalDeliveredSum = useMemo(() => {
    return (deliveries || []).reduce((sum: number, item: any) => sum + (item.cylinders_delivered || 0), 0);
  }, [deliveries]);

  const totalEmptySum = useMemo(() => {
    return (deliveries || []).reduce((sum: number, item: any) => sum + (item.empty_received || 0), 0);
  }, [deliveries]);

  const delivered = parseInt(cylindersDelivered, 10) || 0;
  const empty = parseInt(emptyReceived, 10) || 0;
  const online = parseInt(onlinePayments, 10) || 0;
  const paytm = parseInt(paytmPayments, 10) || 0;

  const cashCylinders = Math.max(0, delivered - online - paytm);
  const cashAmount = cashCylinders * cylinderPrice;

  const partial = parseFloat(partialDigital) || 0;
  const totalPayable = cashAmount - partial;

  const cashCollectedAmount = cashCollected.trim() === '' ? totalPayable : (parseFloat(cashCollected) || 0);
  const difference = cashCollectedAmount - totalPayable;

  const buildReconciliationRemarks = (reasons: ReconciliationReason[]) => {
    if (!reasons || reasons.length === 0) return '';
    return reasons
      .map((r) => {
        if (r.consumer_name && r.consumer_name.trim()) {
          return `${r.reason}: ${r.consumer_name.trim()}`;
        }
        return r.reason;
      })
      .join(', ');
  };

  const resetForm = () => {
    setSelectedEmployee('');
    setCylindersDelivered('');
    setEmptyReceived('');
    setOnlinePayments('');
    setPaytmPayments('');
    setPartialDigital('');
    setCashCollected('');
    setPendingDelivery(null);
    setReconciliationReasons([]);
    setShowReconciliation(false);
  };

  const handleCashShortage = async () => {
    const shortage = totalPayable - cashCollectedAmount;
    if (shortage <= 10) return;

    return new Promise<void>((resolve) => {
      Alert.alert(
        'कम नकद जमा',
        `${selectedEmployee} का ₹${Math.round(shortage)} कम जमा हुआ है।\nक्या यह राशि उनके नाम बाकी रखें?`,
        [
          {
            text: 'हाँ, बाकी रखें',
            onPress: async () => {
              try {
                await addTransaction({
                  date: selectedDate,
                  transactions: 'DEBIT',
                  category: 'BALANCE',
                  rate: Math.round(shortage),
                  quantity: 1,
                  amount: Math.round(shortage),
                  remarks: selectedEmployee,
                  paytm_transaction: false,
                  check_done: false,
                });
                Alert.alert('दर्ज हो गया', `₹${Math.round(shortage)} ${selectedEmployee} के नाम बाकी दर्ज किया गया।`);
              } catch (err) {
                Alert.alert('Error', 'Balance entry failed');
              }
              resolve();
            },
          },
          {
            text: 'नहीं',
            style: 'cancel',
            onPress: () => resolve(),
          },
        ]
      );
    });
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      if (!selectedEmployee) {
        Alert.alert('Error', 'Please select delivery staff');
        return;
      }
      if (delivered === 0) {
        Alert.alert('Error', 'Please enter cylinders delivered');
        return;
      }
      if (online + paytm > delivered) {
        Alert.alert('Error', 'Online + Paytm payments cannot exceed total cylinders delivered');
        return;
      }

      const mismatch = delivered - empty;

      const deliveryData = {
        date: selectedDate,
        employee_name: selectedEmployee,
        cylinders_delivered: delivered,
        empty_received: empty,
        online_payments: online,
        paytm_payments: paytm,
        partial_digital_amount: partial,
        cash_collected: cashCollectedAmount,
        calculated_cash_cylinders: cashCylinders,
        calculated_cash_amount: cashAmount,
        calculated_total_payable: totalPayable,
        reconciliation_status: mismatch === 0 ? 'complete' : 'pending',
        reconciliation_reasons: [],
        remarks: '',
      };

      if (mismatch === 0) {
        await addDelivery(deliveryData);
        await handleCashShortage();
        setSubmittedNames(prev => [...prev, selectedEmployee]);
        Alert.alert('Success', 'Delivery record saved successfully');
        resetForm();
        await loadData();
      } else {
        setPendingDelivery(deliveryData);
        setReconciliationReasons([]);
        setShowReconciliation(true);
      }
    } catch (error: any) {
      console.error('Save delivery error:', error);
      Alert.alert('Error', error?.message || 'Failed to save delivery');
    } finally {
      setIsSubmitting(false);
    }
  };

  const addReconciliationReason = () => {
    const mismatch = Math.abs(delivered - empty);

    if (mismatch === 0) {
      Alert.alert('No Mismatch', 'Delivered and empty received are already matching');
      return;
    }
    if (reconciliationReasons.length >= mismatch) {
      Alert.alert('Error', 'All cylinders have been reconciled');
      return;
    }

    const defaultReason = delivered > empty ? 'NC' : 'Empty Return';

    const newReason: ReconciliationReason = {
      type: delivered > empty ? 'missing' : 'extra',
      reason: defaultReason,
      // Empty Baki / Empty Return are always attributed to the delivery staff for this entry
      consumer_name: STAFF_AUTO_REASONS.includes(defaultReason) ? selectedEmployee : '',
    };

    setReconciliationReasons((prev) => [...prev, newReason]);
  };

  const updateReconciliationReason = (index: number, field: keyof ReconciliationReason, value: any) => {
    setReconciliationReasons((prev) => {
      const updated = [...prev];
      const updatedReason: ReconciliationReason = {
        ...updated[index],
        [field]: value,
      };

      // Whenever the reason type changes, resolve consumer_name accordingly:
      // - Empty Baki / Empty Return -> auto-filled with delivery staff name (no manual input shown)
      // - NC / DBC / TV / Office -> cleared so the user re-enters the correct name
      if (field === 'reason') {
        if (STAFF_AUTO_REASONS.includes(value)) {
          updatedReason.consumer_name = selectedEmployee;
        } else {
          updatedReason.consumer_name = '';
        }
      }

      updated[index] = updatedReason;
      return updated;
    });
  };

  const removeReconciliationReason = (index: number) => {
    setReconciliationReasons((prev) => prev.filter((_, i) => i !== index));
  };

  const validateReconciliationReasons = () => {
    const mismatch = Math.abs(delivered - empty);

    if (reconciliationReasons.length !== mismatch) {
      Alert.alert('Error', `Please provide exactly ${mismatch} reconciliation reason(s)`);
      return false;
    }

    for (let i = 0; i < reconciliationReasons.length; i++) {
      const reason = reconciliationReasons[i];

      if (!reason.reason) {
        Alert.alert('Error', `Please select reason for Cylinder ${i + 1}`);
        return false;
      }

      if (
        NAMED_INPUT_REASONS.includes(reason.reason) &&
        (!reason.consumer_name || !reason.consumer_name.trim())
      ) {
        Alert.alert('Error', `Please enter consumer name for Cylinder ${i + 1}`);
        return false;
      }
    }

    return true;
  };

  const handleReconciliationComplete = async () => {
    try {
      if (!pendingDelivery) {
        Alert.alert('Error', 'No pending delivery found');
        return;
      }
      if (!validateReconciliationReasons()) return;

      const remarks = buildReconciliationRemarks(reconciliationReasons);
      const finalDelivery = {
        ...pendingDelivery,
        reconciliation_status: 'complete',
        reconciliation_reasons: reconciliationReasons,
        remarks,
      };

      await addDelivery(finalDelivery);
      await handleCashShortage();
      setSubmittedNames(prev => [...prev, selectedEmployee]);
      Alert.alert('Success', 'Delivery saved with reconciliation');
      resetForm();
      await loadData();
      bottomSheetRef.current?.close();
    } catch (error: any) {
      console.error('Reconciliation save error:', error);
      Alert.alert('Error', error?.message || 'Failed to save delivery');
    }
  };

  const filteredEmployees = employees.filter((emp: any) => {
    const name = typeof emp === 'string' ? emp : emp.name;
    const isDBA = name.toUpperCase().includes('DBA');
    const isSubmitted = submittedNames.includes(name);
    if (isSubmitted) return false;
    if (isDBA && !showDBA) return false;
    return true;
  });

  const dbaExists = employees.some((emp: any) => {
    const name = typeof emp === 'string' ? emp : emp.name;
    return name.toUpperCase().includes('DBA') && !submittedNames.includes(name);
  });

  const reasonOptions: ReconciliationReason['reason'][] = [
    'NC',
    'DBC',
    'TV',
    'Empty Baki',
    'Office',
    'Empty Return',
  ];

  // ─── DAILY RECORDS: DELETION AND LOGIC ────────────────────────────────────

  const handleDelete = (id: string) => {
    if (!deleteDelivery) {
      Alert.alert("Error", "Internal Error: deleteDelivery function not found in store.");
      return;
    }

    Alert.alert("Confirm Delete", "Delete this record?", [
      { text: "Cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteDelivery(id);
          await loadData();
          Alert.alert("Success", "Deleted");
        }
      }
    ]);
  };

  const safeSummary = useMemo(() => {
    const totalDelivered = (deliveries || []).reduce((a: number, b: any) => a + (b.cylinders_delivered || 0), 0);
    const totalEmpty = (deliveries || []).reduce((a: number, b: any) => a + (b.empty_received || 0), 0);
    const totalOnlineQty = (deliveries || []).reduce((a: number, b: any) => a + (b.online_payments || 0), 0);
    const totalCash = (deliveries || []).reduce((a: number, b: any) => a + (b.cash_collected || 0), 0);
    const totalPaytmQty = (deliveries || []).reduce((a: number, b: any) => a + (b.paytm_payments || 0), 0);
    const totalPartial = (deliveries || []).reduce((a: number, b: any) => a + (b.partial_digital_amount || 0), 0);

    const onlineAmount = totalOnlineQty * cylinderPrice;
    const paytmAmount = (totalPaytmQty * cylinderPrice) + totalPartial + extraPaytmCreditAmount;

    return {
      totalDelivered,
      totalEmpty,
      totalOnlineQty,
      totalPaytmQty,
      totalCash,
      onlineAmount,
      paytmAmount,
    };
  }, [deliveries, cylinderPrice, extraPaytmCreditAmount]);

  const handleDateSelect = (date: any) => {
    setSelectedDate(date.dateString);
    setShowCalendar(false);
  };

  const formatReconciliation = (reasons: any[]) => {
    if (!reasons || reasons.length === 0) return '';
    return reasons
      .map(r => r.consumer_name ? `${r.reason}: ${r.consumer_name}` : r.reason)
      .join(', ');
  };

  const exportToExcel = async () => {
    if ((deliveries || []).length === 0) {
      Alert.alert('No Data');
      return;
    }

    const excelData = (deliveries || []).map((d: any, index: any) => ({
      'S.No': index + 1,
      'Staff Name': d.employee_name,
      'Delivered': d.cylinders_delivered || 0,
      'Empty': d.empty_received || 0,
      'Online Qty': d.online_payments || 0,
      'Paytm Qty': d.paytm_payments || 0,
      'Partial Digital': d.partial_digital_amount || 0,
      'Cash': d.cash_collected || 0,
    }));

    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Deliveries');

    if (Platform.OS === 'web') {
      const blob = new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `deliveries_${selectedDate}.xlsx`;
      a.click();
      return;
    }

    const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const fileUri = FileSystem.documentDirectory + `deliveries_${selectedDate}.xlsx`;

    await FileSystem.writeAsStringAsync(fileUri, wbout, {
      encoding: FileSystem.EncodingType.Base64,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(fileUri);
    }
  };

  // ─── RENDERS ───────────────────────────────────────────────────────────────

  const renderNewEntryTab = () => {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
          <View style={styles.section}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={[styles.label, { marginBottom: 0 }]}>Delivery Staff *</Text>
              <TouchableOpacity
                onPress={async () => {
                  await loadEmployees();
                  const { data } = await supabase
                    .from('dashboard_deliveryrecords')
                    .select('name')
                    .eq('date', selectedDate);
                  if (data) setSubmittedNames(data.map((r: any) => r.name));
                }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, borderRadius: 8, backgroundColor: '#e8f4f8' }}
              >
                <Ionicons name="refresh" size={16} color={BPCL_BLUE} />
                <Text style={{ color: BPCL_BLUE, fontSize: 13, fontWeight: '600' }}>Refresh</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.pickerContainer}>
              {loadingEmployees ? (
                <View style={styles.inlineLoading}>
                  <ActivityIndicator size="small" color={BPCL_BLUE} style={{ marginRight: 8 }} />
                  <Text style={styles.loadingText}>Fetching names...</Text>
                </View>
              ) : (employees || []).length === 0 ? (
                <View style={styles.noStaffBox}>
                  <Text style={styles.noStaffText}>No staff found!</Text>
                </View>
              ) : (
                <>
                  {filteredEmployees.map((emp: any, index: number) => {
                    const name = typeof emp === 'string' ? emp : emp.name;
                    const key = typeof emp === 'string' ? `${emp}-${index}` : `${emp.id || name}-${index}`;
                    return (
                      <TouchableOpacity
                        key={key}
                        style={[styles.employeeChip, selectedEmployee === name && styles.employeeChipSelected]}
                        onPress={() => setSelectedEmployee(name)}
                      >
                        <Text style={[styles.employeeChipText, selectedEmployee === name && styles.employeeChipTextSelected]}>
                          {name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}

                  {dbaExists && (
                    <TouchableOpacity
                      style={[styles.employeeChip, { borderColor: '#999', borderStyle: 'dashed' }]}
                      onPress={() => setShowDBA(!showDBA)}
                    >
                      <Text style={styles.employeeChipText}>{showDBA ? '▲ Less' : '▼ More'}</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Cylinders Delivered *</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter number"
              keyboardType="numeric"
              value={cylindersDelivered}
              onChangeText={(text) => {
                setCylindersDelivered(text);
                if (!emptyManuallyEdited) {
                  setEmptyReceived(text);   // ← auto-fill only if user hasn't manually changed Empty
                }
              }}
              onFocus={() => setActiveField('delivered')}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Empty Cylinders Received *</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter number"
              keyboardType="numeric"
              ref={emptyRef}
              value={emptyReceived}
              onChangeText={setEmptyReceived}
              onFocus={() => setActiveField('empty')}
            />
          </View>

          <View style={styles.paymentCard}>
            <Text style={styles.sectionTitle}>Payment Details</Text>

            <View style={styles.row}>
              <View style={styles.halfInput}>
                <Text style={styles.label}>Zero Bill Payments</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0"
                  keyboardType="numeric"
                  value={onlinePayments}
                  ref={onlineRef}
                  onChangeText={setOnlinePayments}
                  onFocus={() => setActiveField('online')}
                />
              </View>

              <View style={styles.halfInput}>
                <Text style={styles.label}>Paytm Payments</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0"
                  keyboardType="numeric"
                  value={paytmPayments}
                  ref={paytmRef}
                  onChangeText={setPaytmPayments}
                  onFocus={() => setActiveField('paytm')}
                />
              </View>
            </View>

            <View style={styles.sectionInner}>
              <Text style={styles.label}>Partial Digital Amount / Additional Paytm (₹)</Text>
              <TextInput
                style={styles.input}
                placeholder="0.00"
                keyboardType="decimal-pad"
                value={partialDigital}
                ref={partialRef}
                onChangeText={setPartialDigital}
                onFocus={() => setActiveField('partial')}
              />
            </View>

            <View style={styles.sectionInner}>
              <Text style={styles.label}>Cash Collected (₹)</Text>
              <TextInput
                style={styles.input}
                placeholder={totalPayable.toFixed(2)}
                keyboardType="decimal-pad"
                value={cashCollected}
                ref={cashRef}
                returnKeyType="done"
                onChangeText={setCashCollected}
                onFocus={() => setActiveField('cash')}
              />
            </View>
          </View>

          {/* DYNAMIC CALCULATION CARD */}
          <View style={styles.calculationCard}>
            <Text style={styles.sectionTitle}>Live Calculations</Text>

            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Cash Cylinders</Text>
              <Text style={styles.calcValue}>{cashCylinders}</Text>
            </View>

            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Cash Amount</Text>
              <Text style={styles.calcValue}>₹{cashAmount.toFixed(2)}</Text>
            </View>

            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Partial Digital</Text>
              <Text style={styles.calcValue}>- ₹{partial.toFixed(2)}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Total Payable</Text>
              <Text style={styles.calcValueLarge}>₹{totalPayable.toFixed(2)}</Text>
            </View>

            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Cash Collected</Text>
              <Text style={styles.calcValue}>₹{cashCollectedAmount.toFixed(2)}</Text>
            </View>

            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Difference</Text>
              <Text style={[
                styles.calcValue,
                difference > 0 ? styles.calcValuePositive : difference < 0 ? styles.calcValueNegative : styles.calcValueNeutral
              ]}>
                ₹{difference.toFixed(2)}
              </Text>
            </View>

            {difference !== 0 && (
              <Text style={styles.differenceNote}>
                {difference > 0 ? 'Excess Cash Collected' : 'Shortage of Cash Collected'}
              </Text>
            )}
          </View>

          <TouchableOpacity
            style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={24} color="#fff" />
                <Text style={styles.submitButtonText}>Save Delivery Record</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  };

  const renderDailyRecordsTab = () => {
    return (
      <View style={{ flex: 1 }}>
        {showCalendar && <Calendar current={selectedDate} onDayPress={handleDateSelect} />}

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={BPCL_BLUE} />
          </View>
        ) : (
          <ScrollView style={styles.scrollView}>
            {/* SUMMARY */}
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>Daily Summary</Text>

              <View style={styles.summaryRow}>
                <Text>Total Cylinders Delivered</Text>
                <Text>{safeSummary.totalDelivered}</Text>
              </View>

              <View style={styles.summaryRow}>
                <Text>Total Cylinders Received</Text>
                <Text>{safeSummary.totalEmpty}</Text>
              </View>

              <View style={styles.summaryRow}>
                <Text>Online Collection</Text>
                <Text>₹{safeSummary.onlineAmount} ({safeSummary.totalOnlineQty})</Text>
              </View>

              <View style={styles.summaryRow}>
                <Text>Paytm Collection</Text>
                <Text>₹{safeSummary.paytmAmount} ({safeSummary.totalPaytmQty})</Text>
              </View>

              <View style={styles.summaryRowHighlight}>
                <Text>Total Cash</Text>
                <Text>₹{safeSummary.totalCash}</Text>
              </View>
            </View>

            {/* EXPORT */}
            <View style={styles.exportButtons}>
              <TouchableOpacity style={styles.exportButton} onPress={exportToExcel}>
                <Ionicons name="document-text-outline" size={20} color="#fff" />
                <Text style={styles.exportButtonText}>Excel</Text>
              </TouchableOpacity>
            </View>

            {/* RECORDS HEADER WITH SUMMARY CHIPS */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.recordsSectionTitle}>
                Delivery Records ({(deliveries || []).length})
              </Text>
              <View style={styles.miniStatsContainer}>
                <View style={styles.miniStatItem}>
                  <Ionicons name="arrow-up-circle-outline" size={16} color={BPCL_BLUE} />
                  <Text style={styles.miniStatValue}>{safeSummary.totalDelivered}</Text>
                </View>
                <View style={styles.miniStatItem}>
                  <Ionicons name="arrow-down-circle-outline" size={16} color="#475569" />
                  <Text style={styles.miniStatValue}>{safeSummary.totalEmpty}</Text>
                </View>
              </View>
            </View>

            {(deliveries || []).length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="clipboard-outline" size={64} color="#ccc" />
                <Text style={styles.emptyText}>No deliveries for this date</Text>
              </View>
            ) : (
              (deliveries || []).map((delivery: any, index: any) => (
                <View key={delivery.id} style={styles.deliveryCard}>
                  <View style={styles.cardHeader}>
                    <View style={styles.headerInfo}>
                      <Text style={styles.cardNumber}>#{index + 1}</Text>
                      <Text style={styles.cardEmployee}>{delivery.employee_name}</Text>
                    </View>

                    <TouchableOpacity
                      onPress={() => handleDelete(delivery.id)}
                      style={styles.deleteButton}
                    >
                      <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.cardRow}>
                    <View style={styles.cardCol}>
                      <Text style={styles.cardLabel}>Delivered</Text>
                      <Text style={styles.cardValue}>{delivery.cylinders_delivered}</Text>
                    </View>

                    <View style={styles.cardCol}>
                      <Text style={styles.cardLabel}>Empty</Text>
                      <Text style={styles.cardValue}>{delivery.empty_received}</Text>
                    </View>

                    <View style={styles.cardCol}>
                      <Text style={styles.cardLabel}>Online</Text>
                      <Text style={styles.cardValue}>{delivery.online_payments}</Text>
                    </View>

                    <View style={styles.cardCol}>
                      <Text style={styles.cardLabel}>Paytm</Text>
                      <Text style={styles.cardValue}>{delivery.paytm_payments}</Text>
                    </View>
                  </View>

                  <View style={styles.cardRow}>
                    <View style={styles.cardCol}>
                      <Text style={styles.cardLabel}>Partial Digital</Text>
                      <Text style={styles.cardValue}>
                        ₹{Number(delivery.partial_digital_amount || 0).toFixed(2)}
                      </Text>
                    </View>

                    <View style={styles.cardCol}>
                      <Text style={styles.cardLabel}>Cash</Text>
                      <Text style={styles.cardValueHighlight}>
                        ₹{Number(delivery.cash_collected || 0).toFixed(2)}
                      </Text>
                    </View>
                  </View>

                  {delivery.reconciliation_reasons?.length > 0 && (
                    <View style={styles.reconciliationBox}>
                      <Text style={styles.reconciliationLabel}>Reconciliation:</Text>
                      <Text style={styles.reconciliationText}>
                        {formatReconciliation(delivery.reconciliation_reasons)}
                      </Text>
                    </View>
                  )}
                </View>
              ))
            )}
          </ScrollView>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Dynamic Header Box */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>
              {activeTab === 'entry' ? 'Delivery Details' : 'Daily Records'}
            </Text>
            <TouchableOpacity
              onPress={() => {
                if (activeTab === 'entry') {
                  setShowDatePicker(true);
                } else {
                  setShowCalendar(!showCalendar);
                }
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}
            >
              <Ionicons name="calendar-outline" size={14} color="rgba(255,255,255,0.9)" />
              <Text style={styles.headerDate}>
                {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
              </Text>
              <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.9)" />
            </TouchableOpacity>
          </View>

          {activeTab === 'entry' ? (
            /* Live Stats Display Container */
            <View style={styles.headerStatsContainer}>
              <View style={styles.headerStatItem}>
                <Ionicons name="arrow-up-circle-outline" size={16} color="#FFF" />
                <Text style={styles.headerStatValue}>{totalDeliveredSum}</Text>
              </View>
              <View style={styles.headerStatItem}>
                <Ionicons name="arrow-down-circle-outline" size={16} color="#FFF" />
                <Text style={styles.headerStatValue}>{totalEmptySum}</Text>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.dateButton, { paddingHorizontal: 14 }]}
              onPress={loadData}
              disabled={loading}
            >
              <Ionicons
                name="refresh-outline"
                size={20}
                color="#fff"
                style={loading ? { opacity: 0.5 } : {}}
              />
            </TouchableOpacity>
          )}
        </View>

        {showDatePicker && (
          <DateTimePicker
            value={new Date(selectedDate + 'T00:00:00')}
            mode="date"
            display="default"
            onChange={(event: DateTimePickerEvent, date?: Date) => {
              setShowDatePicker(false);
              if (event.type === 'set' && date) {
                setSelectedDate(format(date, 'yyyy-MM-dd'));
              }
            }}
          />
        )}
      </View>

      {/* Segmented Inner Tab Navigation */}
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
          style={[styles.innerTab, activeTab === 'records' && styles.innerTabActive]}
          onPress={() => setActiveTab('records')}
        >
          <Ionicons name="list-outline" size={16} color={activeTab === 'records' ? '#fff' : BPCL_BLUE} />
          <Text style={[styles.innerTabText, activeTab === 'records' && styles.innerTabTextActive]}>
            Daily Records
          </Text>
        </TouchableOpacity>
      </View>

      {/* Active Tab Screen Render */}
      <View style={{ flex: 1 }}>
        {activeTab === 'entry' ? renderNewEntryTab() : renderDailyRecordsTab()}
      </View>

      {/* Bottom Sheet Reconciliation */}
      {showReconciliation && (
        <BottomSheet
          ref={bottomSheetRef}
          index={0}
          snapPoints={snapPoints}
          enablePanDownToClose={true}
          onClose={() => {
            setShowReconciliation(false);
            setPendingDelivery(null);
            setReconciliationReasons([]);
          }}
          backgroundStyle={styles.bottomSheet}
        >
          <BottomSheetScrollView style={styles.sheetContent}>
            <View style={styles.sheetHeader}>
              <TouchableOpacity
                onPress={() => {
                  setShowReconciliation(false);
                  setPendingDelivery(null);
                  setReconciliationReasons([]);
                  bottomSheetRef.current?.close();
                }}
                style={{ position: 'absolute', right: 0, top: 0, padding: 4 }}
              >
                <Ionicons name="close-circle" size={30} color="#999" />
              </TouchableOpacity>

              <Ionicons name="warning" size={32} color={BPCL_YELLOW} />
              <Text style={styles.sheetTitle}>Reconciliation Required</Text>
            </View>

            <View style={styles.mismatchInfo}>
              <Text style={styles.mismatchText}>
                Delivered: {cylindersDelivered} | Received: {emptyReceived}
              </Text>
              <Text style={styles.mismatchCount}>
                {Math.abs(delivered - empty)} cylinder(s) need explanation
              </Text>
            </View>

            {reconciliationReasons.map((reason, index) => (
              <View key={`reason-${index}`} style={styles.reasonCard}>
                <View style={styles.reasonHeader}>
                  <Text style={styles.reasonNumber}>Cylinder {index + 1}</Text>
                  <TouchableOpacity onPress={() => removeReconciliationReason(index)}>
                    <Ionicons name="close-circle" size={24} color="#e74c3c" />
                  </TouchableOpacity>
                </View>

                <Text style={styles.reasonLabel}>Reason *</Text>

                <View style={styles.reasonButtons}>
                  {reasonOptions.map((r: any) => (
                    <TouchableOpacity
                      key={r}
                      style={[
                        styles.reasonButton,
                        reason.reason === r && styles.reasonButtonSelected,
                      ]}
                      onPress={() => updateReconciliationReason(index, 'reason', r)}
                    >
                      <Text
                        style={[
                          styles.reasonButtonText,
                          reason.reason === r && styles.reasonButtonTextSelected,
                        ]}
                      >
                        {r}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {NAMED_INPUT_REASONS.includes(reason.reason) && (
                  <View style={styles.consumerNameSection}>
                    <Text style={styles.reasonLabel}>Consumer Name *</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Enter consumer name"
                      value={reason.consumer_name || ''}
                      onChangeText={(text) =>
                        updateReconciliationReason(index, 'consumer_name', text)
                      }
                    />
                  </View>
                )}
              </View>
            ))}

            <TouchableOpacity style={styles.addReasonButton} onPress={addReconciliationReason}>
              <Ionicons name="add-circle-outline" size={24} color={BPCL_BLUE} />
              <Text style={styles.addReasonText}>Add Reason</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.completeButton} onPress={handleReconciliationComplete}>
              <Text style={styles.completeButtonText}>Complete & Save</Text>
            </TouchableOpacity>
          </BottomSheetScrollView>
        </BottomSheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollView: {
    flex: 1,
  },
  section: {
    padding: 16,
  },
  sectionInner: {
    marginTop: 16,
  },
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
  inlineLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
  },
  loadingText: {
    color: '#999',
    fontStyle: 'italic',
  },
  noStaffBox: {
    padding: 10,
    backgroundColor: '#ffebee',
    borderRadius: 8,
  },
  noStaffText: {
    color: '#c62828',
    fontWeight: 'bold',
  },
  pickerContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  employeeChip: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  employeeChipSelected: {
    backgroundColor: BPCL_BLUE,
    borderColor: BPCL_BLUE,
  },
  employeeChipText: {
    color: '#666',
    fontSize: 14,
  },
  employeeChipTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  paymentCard: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    elevation: 3,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfInput: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginBottom: 12,
  },
  submitButton: {
    backgroundColor: BPCL_BLUE,
    margin: 16,
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitButtonDisabled: {
    backgroundColor: '#95a5a6',
    opacity: 0.7,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  bottomSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetContent: {
    padding: 20,
  },
  sheetHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
    marginTop: 12,
  },
  mismatchInfo: {
    backgroundColor: '#fff3cd',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  mismatchText: {
    fontSize: 14,
    color: '#856404',
    fontWeight: '600',
  },
  mismatchCount: {
    fontSize: 16,
    color: '#856404',
    fontWeight: 'bold',
    marginTop: 4,
  },
  reasonCard: {
    backgroundColor: '#f8f9fa',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  reasonHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  reasonNumber: {
    fontSize: 16,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  reasonLabel: {
    fontSize: 14,
    color: '#666',
    marginBottom: 8,
    fontWeight: '600',
  },
  reasonButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  reasonButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  reasonButtonSelected: {
    backgroundColor: BPCL_BLUE,
    borderColor: BPCL_BLUE,
  },
  reasonButtonText: {
    color: '#666',
    fontSize: 13,
  },
  reasonButtonTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  consumerNameSection: {
    marginTop: 8,
  },
  addReasonButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
    borderWidth: 2,
    borderColor: BPCL_BLUE,
    borderStyle: 'dashed',
    borderRadius: 12,
    marginBottom: 16,
  },
  addReasonText: {
    color: BPCL_BLUE,
    fontSize: 16,
    fontWeight: '600',
  },
  completeButton: {
    backgroundColor: BPCL_BLUE,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 32,
  },

  // Header and live stats layout styling
  header: {
    backgroundColor: BPCL_BLUE,
    padding: 20,
    paddingTop: 60,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerDate: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
  },
  headerStatsContainer: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  headerStatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)', // Semi-transparent white
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  headerStatValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFF',
  },
  completeButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },

  // Tab navigation styling
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

  // Records View summary & list style additions
  summaryCard: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  summaryTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginBottom: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  summaryRowHighlight: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    marginTop: 8,
    backgroundColor: '#e8f4f8',
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  exportButtons: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  exportButton: {
    flex: 1,
    backgroundColor: BPCL_BLUE,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
    gap: 8,
  },
  exportButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  // UNIQUE RENAMED STYLE TO RESOLVE ESLINT / TS NO-DUPE-KEYS ERROR
  recordsSectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  miniStatsContainer: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  miniStatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 4,
  },
  miniStatValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 16,
    color: '#999',
    marginTop: 16,
  },
  deliveryCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  deleteButton: {
    padding: 4,
  },
  cardNumber: {
    fontSize: 16,
    fontWeight: 'bold',
    color: BPCL_BLUE,
    marginRight: 12,
  },
  cardEmployee: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  cardRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  cardCol: {
    flex: 1,
  },
  cardLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 4,
  },
  cardValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  cardValueHighlight: {
    fontSize: 16,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  reconciliationBox: {
    backgroundColor: '#fff3cd',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  reconciliationLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#856404',
    marginBottom: 4,
  },
  reconciliationText: {
    fontSize: 13,
    color: '#856404',
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    padding: 12,
    borderRadius: 8,
    gap: 8,
  },
  dateButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calculationCard: {
    backgroundColor: '#e8f4f8',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: BPCL_BLUE,
  },
  calcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 6,
  },
  calcLabel: {
    fontSize: 14,
    color: '#666',
  },
  calcValue: {
    fontSize: 16,
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
    marginVertical: 12,
  },
  calcValuePositive: {
    color: '#e74c3c',
  },
  calcValueNegative: {
    color: '#e67e22',
  },
  calcValueNeutral: {
    color: '#27ae60',
  },
  differenceNote: {
    fontSize: 12,
    color: '#e67e22',
    textAlign: 'center',
    marginTop: 8,
    fontWeight: '600',
  },
});
