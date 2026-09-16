import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { supabase } from '../../lib/supabase';
import { useRole } from '../../hooks/useRole';
import DateTimePicker from '@react-native-community/datetimepicker';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TotalsScreen() {
  // ── Date State ─────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [selectedView, setSelectedView] = useState<SelectedView>('CREDIT');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  const [creditEntries, setCreditEntries] = useState<Transaction[]>([]);
  const [debitEntries, setDebitEntries] = useState<Transaction[]>([]);
  const [creditTotal, setCreditTotal] = useState(0);
  const [debitTotal, setDebitTotal] = useState(0);

  // ── Edit State ─────────────────────────────────────────────────────────────
  const [editingEntry, setEditingEntry] = useState<Transaction | null>(null);
  const [editCategory, setEditCategory] = useState('');
  const [editRate, setEditRate] = useState('');
  const [editQuantity, setEditQuantity] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editRemarks, setEditRemarks] = useState('');
  

  // ── Bottom Sheet ───────────────────────────────────────────────────────────
  const bottomSheetRef = useRef<any>(null);
  const snapPoints = useMemo(() => ['80%'], []);

  const role = useRole();

  // ─── Fetch Data ────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_dailyrecord')
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
      Alert.alert('Error', err?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);



  // ─── Revert Commercial Records ─────────────────────────────────────────────



  // ─── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = (entry: Transaction) => {
    Alert.alert(
      'Delete Entry',
      `Are you sure you want to delete this entry?\n\n📌 ${entry.category}\n💰 ₹${entry.amount}\n📅 ${entry.date}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => confirmDelete(entry),
        },
      ]
    );
  };

  const confirmDelete = async (entry: Transaction) => {
    setDeleting(entry.id);
    try {
      const { error } = await supabase
        .from('dashboard_dailyrecord')
        .delete()
        .eq('id', entry.id);

      if (error) throw error;

      Alert.alert('Success', 'Entry deleted successfully');
      await fetchData();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to delete entry');
    } finally {
      setDeleting(null);
    }
  };

  // ─── Open Edit Sheet ───────────────────────────────────────────────────────

  const handleEdit = (entry: Transaction) => {
    setEditingEntry(entry);
    setEditCategory(entry.category || '');
    setEditRate(String(entry.rate ?? ''));
    setEditQuantity(String(entry.quantity ?? ''));
    setEditAmount(String(entry.amount ?? ''));
    setEditRemarks(entry.remarks || '');
    setTimeout(() => {
      bottomSheetRef.current?.snapToIndex(0);
    }, 50);
  };

  const handleEditClose = () => {
    bottomSheetRef.current?.close();
    setEditingEntry(null);
  };

  // ── Auto-calculate amount ──────────────────────────────────────────────────

  const handleRateChange = (val: string) => {
    setEditRate(val);
    const rate = parseFloat(val) || 0;
    const qty = parseInt(editQuantity, 10) || 0;
    if (rate > 0 && qty > 0) {
      setEditAmount(String(Math.round(rate * qty)));
    }
  };

  const handleQuantityChange = (val: string) => {
    setEditQuantity(val);
    const rate = parseFloat(editRate) || 0;
    const qty = parseInt(val, 10) || 0;
    if (rate > 0 && qty > 0) {
      setEditAmount(String(Math.round(rate * qty)));
    }
  };

  // ─── Core DB Update Function ───────────────────────────────────────────────

  const performDatabaseUpdate = async (entryId: number) => {
    const newRate     = parseFloat(editRate) || 0;
    const newQty      = parseInt(editQuantity, 10) || 0;
    const newAmount   = parseInt(editAmount, 10) || 0;
    const newCategory = editCategory.trim();
    const newRemarks  = editRemarks.trim();

    const { data, error } = await supabase
      .from('dashboard_dailyrecord')
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

  // ─── Re-apply Commercial Records ──────────────────────────────────────────



  // ─── Handle Save Edit ─────────────────────────────────────────────────────

  const handleSaveEdit = async () => {
    if (!editingEntry) return;

    if (!editCategory.trim()) {
      Alert.alert('Validation Error', 'Category cannot be empty');
      return;
    }

    const newAmount = parseInt(editAmount, 10);
    if (!editAmount || isNaN(newAmount) || newAmount <= 0) {
      Alert.alert('Validation Error', 'Amount must be greater than 0');
      return;
    }

    setSaving(true);
    try {
      await performDatabaseUpdate(editingEntry.id);
      Alert.alert('Success', 'Entry updated successfully');
      handleEditClose();
      await fetchData();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update entry');
    } finally {
      setSaving(false);
    }
  };

  // ─── Computed ──────────────────────────────────────────────────────────────

  const activeEntries = selectedView === 'CREDIT' ? creditEntries : debitEntries;
  const activeTotal   = selectedView === 'CREDIT' ? creditTotal   : debitTotal;
  const netBalance    = creditTotal - debitTotal;

  // ─── Render Entry Card ─────────────────────────────────────────────────────

  const renderEntryCard = (entry: Transaction, index: number) => {
    const isDeleting   = deleting === entry.id;
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
            onPress={() => handleEdit(entry)}
            disabled={isDeleting}
          >
            <Ionicons name="pencil" size={16} color={BPCL_BLUE} />
            <Text style={styles.editButtonText}>Edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.deleteButton, isDeleting && styles.buttonDisabled]}
            onPress={() => handleDelete(entry)}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <ActivityIndicator size="small" color="#e74c3c" />
            ) : (
              <>
                <Ionicons name="trash" size={16} color="#e74c3c" />
                <Text style={styles.deleteButtonText}>Delete</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Main Render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>

      {/* Header */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.headerTitle}>Daily Totals</Text>
              <TouchableOpacity
                onPress={() => setShowDatePicker(true)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}
              >
                <Ionicons name="calendar-outline" size={14} color="rgba(255,255,255,0.9)" />
                <Text style={styles.headerSubtitle}>
                  {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
                </Text>
                <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.9)" />
              </TouchableOpacity>

              {showDatePicker && (
                <DateTimePicker
                  value={new Date(selectedDate + 'T00:00:00')}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    setShowDatePicker(false);
                    if (event.type === 'set' && date) {
                      setSelectedDate(format(date, 'yyyy-MM-dd'));
                    }
                  }}
                />
              )}
            </View>

            <TouchableOpacity
              style={styles.refreshBtn}
              onPress={fetchData}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="refresh" size={22} color="#fff" />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {loading ? (
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
                <Ionicons name="arrow-up-circle" size={28} color="#e74c3c" />
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

      {/* Edit Bottom Sheet */}
      <BottomSheet
        ref={bottomSheetRef}
        index={-1}
        snapPoints={snapPoints}
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
                onChangeText={handleRateChange}
                placeholder="0.00"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={[styles.editField, { flex: 1 }]}>
              <Text style={styles.editLabel}>Quantity</Text>
              <TextInput
                style={styles.editInput}
                value={editQuantity}
                onChangeText={handleQuantityChange}
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
            style={[styles.saveButton, saving && styles.buttonDisabled]}
            onPress={handleSaveEdit}
            disabled={saving}
          >
            {saving ? (
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
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:                 { flex: 1, backgroundColor: '#f5f5f5' },
  header:                    { backgroundColor: BPCL_BLUE, elevation: 5 },
  headerContent:             { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  headerRow:                 { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle:               { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  headerSubtitle:            { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 4 },
  refreshBtn:                { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  loadingContainer:          { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText:               { color: '#666', fontSize: 16 },
  scrollView:                { flex: 1 },
  summaryCard:               { backgroundColor: '#fff', margin: 16, padding: 16, borderRadius: 12, elevation: 3 },
  summaryTitle:              { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 16 },
  totalCardsRow:             { flexDirection: 'row', gap: 12 },
  totalCard:                 { flex: 1, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#ddd', alignItems: 'center', backgroundColor: '#fafafa', gap: 4 },
  totalCardSelected:         { borderColor: BPCL_BLUE, borderWidth: 2, backgroundColor: '#e8f4f8' },
  creditCard:                { borderLeftWidth: 4, borderLeftColor: '#27ae60' },
  debitCard:                 { borderLeftWidth: 4, borderLeftColor: '#e74c3c' },
  totalLabel:                { fontSize: 13, color: '#666', fontWeight: '600' },
  totalAmount:               { fontSize: 18, fontWeight: 'bold' },
  entryCount:                { fontSize: 11, color: '#999' },
  creditAmount:              { color: '#27ae60', fontWeight: 'bold' },
  debitAmount:               { color: '#e74c3c', fontWeight: 'bold' },
  balanceBox:                { marginTop: 16, padding: 14, borderRadius: 10, alignItems: 'center' },
  balanceLabel:              { fontSize: 13, color: '#555', fontWeight: '600' },
  balanceValue:              { fontSize: 26, fontWeight: 'bold', marginTop: 4 },
  balancePositive:           { color: '#27ae60' },
  balanceNegative:           { color: '#e74c3c' },
  entriesHeader:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
  viewToggle:                { flexDirection: 'row', backgroundColor: '#e8e8e8', borderRadius: 20, padding: 3 },
  viewToggleBtn:             { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 18 },
  viewToggleBtnActive:       { backgroundColor: '#fff', elevation: 2 },
  viewToggleBtnText:         { fontSize: 13, color: '#888', fontWeight: '600' },
  viewToggleBtnTextActive:   { color: BPCL_BLUE },
  sectionTotal:              { fontSize: 18, fontWeight: 'bold' },
  entryCard:                 { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: 12, elevation: 2 },
  commercialBanner:          { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff8e1', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: BPCL_YELLOW },
  commercialBannerText:      { fontSize: 11, color: '#7b4f00', fontWeight: '600', flex: 1 },
  entryTopRow:               { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  entryLeft:                 { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
  entryIndexBadge:           { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  entryIndex:                { fontSize: 12, fontWeight: 'bold' },
  entryCategory:             { fontSize: 15, fontWeight: 'bold', color: '#333' },
  entrySource:               { fontSize: 12, color: '#999', marginTop: 2 },
  entryAmount:               { fontSize: 18, fontWeight: 'bold', marginLeft: 8 },
  entryDetails:              { flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  detailCol:                 { flex: 1 },
  detailLabel:               { fontSize: 11, color: '#999', marginBottom: 3 },
  detailValue:               { fontSize: 13, color: '#333', fontWeight: '600' },
  paytmBadge:                { backgroundColor: '#e3f2fd', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  paytmText:                 { fontSize: 11, color: BPCL_BLUE, fontWeight: 'bold' },
  actionRow:                 { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  editButton:                { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: BPCL_BLUE, backgroundColor: '#e8f4f8' },
  editButtonText:            { color: BPCL_BLUE, fontWeight: '600', fontSize: 14 },
  deleteButton:              { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#e74c3c', backgroundColor: '#ffebee' },
  deleteButtonText:          { color: '#e74c3c', fontWeight: '600', fontSize: 14 },
  buttonDisabled:            { opacity: 0.5 },
  emptyState:                { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText:                 { fontSize: 16, color: '#ccc', fontWeight: '600' },
  bottomSheetBg:             { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, elevation: 10 },
  bottomSheetHandle:         { backgroundColor: '#ddd', width: 40, height: 4 },
  bottomSheetContent:        { padding: 20 },
  sheetHeader:               { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  sheetTitle:                { fontSize: 22, fontWeight: 'bold', color: '#333' },
  sheetSubtitle:             { fontSize: 13, color: '#888', marginTop: 4 },
  closeButton:               { width: 36, height: 36, borderRadius: 18, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center', marginLeft: 12 },
  commercialEditWarning:     { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: '#fff3cd', padding: 10, borderRadius: 8, marginTop: 8, borderLeftWidth: 3, borderLeftColor: BPCL_YELLOW },
  commercialEditWarningText: { fontSize: 12, color: '#856404', flex: 1, lineHeight: 18 },
  editField:                 { marginBottom: 16 },
  editLabel:                 { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 8 },
  editInput:                 { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 15, color: '#333' },
  editInputHighlight:        { borderColor: BPCL_BLUE, borderWidth: 2, backgroundColor: '#e8f4f8', fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE },
  editInputMultiline:        { height: 80, paddingTop: 12 },
  editHint:                  { fontSize: 11, color: '#999', marginTop: 4, fontStyle: 'italic' },
  commercialRemarksHint:     { fontSize: 11, color: '#856404', marginTop: 4, fontStyle: 'italic' },
  rowInputs:                 { flexDirection: 'row', gap: 12 },
  originalValues:            { backgroundColor: '#fff8e1', padding: 14, borderRadius: 10, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: BPCL_YELLOW },
  originalValuesTitle:       { fontSize: 13, fontWeight: 'bold', color: '#856404', marginBottom: 10 },
  originalRow:               { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 3 },
  originalLabel:             { fontSize: 13, color: '#856404' },
  originalValue:             { fontSize: 13, color: '#856404', fontWeight: '600', flex: 1, textAlign: 'right' },
  saveButton:                { backgroundColor: BPCL_BLUE, padding: 16, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 },
  saveButtonText:            { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
