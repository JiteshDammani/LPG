import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchPendingSachinRecord,
  fetchCategoryOptions,
  fetchPreviewData,
  fetchBalanceReportRow,
  approveSachinRecord,
  rejectSachinRecord,
  SachinRecord,
  PreviewData,
  fetchTotalAhdData,
  TotalAhdData,
} from '@/lib/sachinReviewStore';

const BPCL_BLUE = '#017DC5';

export default function ReviewSachinScreen() {
  // ── Record + list state ──────────────────────────────────────────────
  const [record, setRecord] = useState<SachinRecord | null>(null);
  const [totalPending, setTotalPending] = useState(0);
  const [loadingRecord, setLoadingRecord] = useState(true);

  // ── Category dropdown ────────────────────────────────────────────────
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);

  // ── Editable fields ───────────────────────────────────────────────────
  const [category, setCategory] = useState('');
  const [remarks, setRemarks] = useState('');
  const [rate, setRate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');

  // Originals, to detect "changed" state
  const [origCategory, setOrigCategory] = useState('');
  const [origRemarks, setOrigRemarks] = useState('');
  const [origRate, setOrigRate] = useState('');
  const [origQuantity, setOrigQuantity] = useState('');
  const [origAmount, setOrigAmount] = useState('');

  // ── Preview ───────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Balance Report lookup (for BALANCE category) ─────────────────────
  const [balanceReportRow, setBalanceReportRow] = useState<Record<string, any> | null>(null);
  const [balanceReportLoading, setBalanceReportLoading] = useState(false);

  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);

  // ── Total AHD lookup (for TOTAL AHD category) ─────────────────────────
  const [totalAhdData, setTotalAhdData] = useState<TotalAhdData | null>(null);
  const [totalAhdLoading, setTotalAhdLoading] = useState(false);

  // ── Auto-calculate amount = rate × quantity ──────────────────────────
  // Called whenever rate or quantity changes. Updates amount state and
  // also triggers a preview refresh with the new computed amount.
  const recalcAmount = useCallback(
    (nextRate: string, nextQty: string): string => {
      const r = parseFloat(nextRate);
      const q = parseInt(nextQty, 10);
      if (Number.isFinite(r) && Number.isFinite(q) && r > 0 && q > 0) {
        return String(Math.round(r * q * 100) / 100); // round to 2 dp
      }
      return amount; // keep existing if either value isn't valid yet
    },
    [amount]
  );

  // ── Load pending record + categories on mount ───────────────────────
  const loadRecord = useCallback(async () => {
    setLoadingRecord(true);
    try {
      const { record: rec, totalPending: total } = await fetchPendingSachinRecord();
      setRecord(rec);
      setTotalPending(total);

      if (rec) {
        setCategory(rec.category);
        setRemarks(rec.remarks);
        setRate(String(rec.rate));
        setQuantity(String(rec.quantity));
        setAmount(String(rec.amount));

        setOrigCategory(rec.category);
        setOrigRemarks(rec.remarks);
        setOrigRate(String(rec.rate));
        setOrigQuantity(String(rec.quantity));
        setOrigAmount(String(rec.amount));

        const pd = await fetchPreviewData(
          rec.category,
          rec.remarks,
          rec.date,
          rec.quantity,
          rec.transactions,
          rec.amount
        );
        setPreview(pd);
      } else {
        setPreview(null);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to load pending record');
    } finally {
      setLoadingRecord(false);
    }
  }, []);

  useEffect(() => {
    loadRecord();
    fetchCategoryOptions()
      .then(setCategories)
      .catch((e) => console.error('Failed to load categories:', e.message));
  }, [loadRecord]);

  // ── Debounced live preview ────────────────────────────────────────────
  const schedulePreview = useCallback(
    (
      nextCategory: string,
      nextRemarks: string,
      nextQuantity: string,
      nextAmount: string
    ) => {
      if (!record) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setPreviewLoading(true);
        try {
          const qty = parseInt(nextQuantity, 10);
          const amt = parseFloat(nextAmount);
          const pd = await fetchPreviewData(
            nextCategory,
            nextRemarks,
            record.date,
            Number.isFinite(qty) ? qty : record.quantity,
            record.transactions,
            Number.isFinite(amt) ? amt : record.amount
          );
          setPreview(pd);
        } catch {
          setPreview({ title: 'Preview failed to load.', headers: [], rows: [] });
        } finally {
          setPreviewLoading(false);
        }
      }, 450);
    },
    [record]
  );

  const handleCategorySelect = (val: string) => {
    setCategory(val);
    setCategoryDropdownOpen(false);
    schedulePreview(val, remarks, quantity, amount);
  };

  const handleRemarksChange = (val: string) => {
    setRemarks(val);
    schedulePreview(category, val, quantity, amount);
  };

  // ── Rate change: recalc amount, then preview with new amount ─────────
  const handleRateChange = (val: string) => {
    setRate(val);
    const newAmount = recalcAmount(val, quantity);
    setAmount(newAmount);
    schedulePreview(category, remarks, quantity, newAmount);
  };

  // ── Quantity change: recalc amount, then preview with new amount ──────
  const handleQuantityChange = (val: string) => {
    setQuantity(val);
    const newAmount = recalcAmount(rate, val);
    setAmount(newAmount);
    schedulePreview(category, remarks, val, newAmount);
  };

  const isChanged = (current: string, orig: string) => current.trim() !== orig.trim();

  // ── Commercial Payment match check: does the quantity match the number
  // of matching entries found in the Commercial Records preview? ──────────
  const isCommercialCategory = category.toUpperCase().replace(/[_\s]/g, '').includes('COMMERCIAL');
  const qtyNum = parseInt(quantity, 10);
  const amtNum = parseFloat(amount);

  const commercialMatchStatus: 'match' | 'mismatch' | null =
    isCommercialCategory && preview && !previewLoading && Number.isFinite(qtyNum) && qtyNum > 0
      ? (preview.rows.length === qtyNum ? 'match' : 'mismatch')
      : null;

  // ── Closing Balance category: checked FIRST and excluded from the
  // generic BALANCE match below, since "CLOSING BALANCE" also contains
  // the substring "BALANCE" and would otherwise wrongly trigger the
  // Balance Report lookup box. ───────────────────────────────────────────
  const isClosingBalanceCategory = category.toUpperCase().trim() === 'CLOSING BALANCE';

  // ── Balance category: does record.debit_balance_report_id point to a
  // real row in the DebitBalanceReport table? There is only ever this
  // one id column on the Sachin record — it applies regardless of
  // whether the transaction itself is DEBIT or CREDIT. Explicitly
  // excludes Closing Balance (see above). ────────────────────────────────
  const isBalanceCategory =
    category.toUpperCase().replace(/[_\s]/g, '').includes('BALANCE') && !isClosingBalanceCategory;

  const isWeeklySalaryCategory = category.toUpperCase().trim() === 'WEEKLY SALARY';
  // ── Closing Balance: reuse the Side Table Preview's own numbers
  // instead of running a second, separate query. The preview already
  // computes Total Debit / Total Credit / Closing Balance (Credit − Debit)
  // for the correct previous business day, so pulling from there
  // guarantees this always agrees with what's shown below — no drift,
  // no separate date-math bugs. ──────────────────────────────────────────
  // preview.rows is a list of [fieldName, fieldValue] pairs (e.g. ['Total Debit', '640051']),
  // not one row with multiple columns — so we scan rows for the field name, not headers.
  const closingBalanceRow = preview?.rows.find((row) =>
    String(row[0]).toLowerCase().includes('closing balance')
  );

  const closingBalanceFromPreview: number | null =
    isClosingBalanceCategory && closingBalanceRow
      ? parseFloat(String(closingBalanceRow[1]).replace(/,/g, ''))
      : null;

  const closingBalanceMatchStatus: 'match' | 'mismatch' | null = isClosingBalanceCategory
    ? previewLoading || closingBalanceFromPreview === null || !Number.isFinite(closingBalanceFromPreview)
      ? null
      : (Number.isFinite(amtNum) && Math.abs(closingBalanceFromPreview - amtNum) <= 10 ? 'match' : 'mismatch')
    : null;

  const isTotalAhdCategory = category.toUpperCase().trim() === 'TOTAL AHD';

  const totalAhdMatchStatus: 'match' | 'mismatch' | null = isTotalAhdCategory
    ? totalAhdLoading
      ? null
      : (totalAhdData && Number.isFinite(qtyNum) && totalAhdData.sumNumber === qtyNum ? 'match' : 'mismatch')
    : null;

  const balanceReportId = record ? (record as any).debit_balance_report_id : null;

  const balanceMatchStatus: 'match' | 'mismatch' | null = isBalanceCategory
    ? balanceReportLoading
      ? null
      : (balanceReportRow ? 'match' : 'mismatch')
    : null;

  const cylinderColIndex = preview?.headers.findIndex((h) => h.toLowerCase().includes('cylinder')) ?? -1;

  const weeklySalaryFromPreview: number | null =
    isWeeklySalaryCategory && preview && cylinderColIndex >= 0 && preview.rows[0]
      ? parseFloat(String(preview.rows[0][cylinderColIndex]).replace(/,/g, ''))
      : null;

  const weeklySalaryMatchStatus: 'match' | 'mismatch' | null = isWeeklySalaryCategory
    ? previewLoading || weeklySalaryFromPreview === null || !Number.isFinite(weeklySalaryFromPreview)
      ? null
      : (Number.isFinite(qtyNum) && weeklySalaryFromPreview === qtyNum ? 'match' : 'mismatch')
    : null;

  const amountStatus: 'match' | 'mismatch' | null =
  commercialMatchStatus ?? balanceMatchStatus ?? totalAhdMatchStatus ?? closingBalanceMatchStatus ?? weeklySalaryMatchStatus;

  // ── Fetch Total AHD delivery-record sums whenever the record or
  // category changes into TOTAL AHD ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!record || !isTotalAhdCategory) {
        if (!cancelled) {
          setTotalAhdData(null);
          setTotalAhdLoading(false);
        }
        return;
      }
      if (!cancelled) setTotalAhdLoading(true);
      try {
        const result = await fetchTotalAhdData(record.date);
        if (!cancelled) setTotalAhdData(result);
      } catch (err) {
        console.error('fetchTotalAhdData failed:', err);
        if (!cancelled) setTotalAhdData(null);
      } finally {
        if (!cancelled) setTotalAhdLoading(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, isTotalAhdCategory, record?.date]);

  // ── Fetch the actual Balance Report row whenever the record or
  // category changes into BALANCE ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!record || !isBalanceCategory || !balanceReportId) {
        if (!cancelled) {
          setBalanceReportRow(null);
          setBalanceReportLoading(false);
        }
        return;
      }
      if (!cancelled) setBalanceReportLoading(true);
      try {
        const row = await fetchBalanceReportRow(balanceReportId);
        if (!cancelled) setBalanceReportRow(row);
      } catch {
        if (!cancelled) setBalanceReportRow(null);
      } finally {
        if (!cancelled) setBalanceReportLoading(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, isBalanceCategory, balanceReportId]);

  // ── Approve / Reject ─────────────────────────────────────────────────

  const handleApprove = () => {
    if (!record) return;
    Alert.alert('Approve record?', 'This will save the record and apply it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: async () => {
          setSubmitting('approve');
          try {
            await approveSachinRecord(record, {
              category: category.toUpperCase().trim(),
              remarks,
              rate: parseFloat(rate) || record.rate,
              quantity: parseInt(quantity, 10) || record.quantity,
              amount: parseFloat(amount) || record.amount,
            });
            await loadRecord();
          } catch (e: any) {
            Alert.alert('Error', e.message || 'Failed to approve record');
          } finally {
            setSubmitting(null);
          }
        },
      },
    ]);
  };

  const handleReject = () => {
    if (!record) return;
    Alert.alert('Reject record?', 'This record will be skipped.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: async () => {
          setSubmitting('reject');
          try {
            await rejectSachinRecord(record.id);
            await loadRecord();
          } catch (e: any) {
            Alert.alert('Error', e.message || 'Failed to reject record');
          } finally {
            setSubmitting(null);
          }
        },
      },
    ]);
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (loadingRecord) {
    return (
      <View style={styles.centerFill}>
        <ActivityIndicator color={BPCL_BLUE} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Review Sachin's Records</Text>
              <Text style={styles.headerSubtitle}>Edit if needed, then approve or reject</Text>
            </View>
            {totalPending > 0 && (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingBadgeText}>{totalPending} pending</Text>
              </View>
            )}
          </View>
        </View>

        {!record ? (
          // ── Empty state ──
          <View style={[styles.card, styles.emptyState]}>
            <Ionicons name="checkmark-done-circle" size={64} color="#2dce89" />
            <Text style={styles.emptyTitle}>All Caught Up!</Text>
            <Text style={styles.emptySubtitle}>No pending records from Sachin to review.</Text>
          </View>
        ) : (
          <>
            {/* ── Edit card ── */}
            <View style={[styles.card, styles.editCard]}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>Sachin's Entry</Text>
                <View
                  style={[
                    styles.txBadge,
                    { backgroundColor: record.transactions === 'CREDIT' ? '#2dce89' : '#f5365c' },
                  ]}
                >
                  <Text style={styles.txBadgeText}>{record.transactions}</Text>
                </View>
              </View>
              <Text style={styles.recordMeta}>
                Record ID: #{record.id}  ·  Date: {record.date}
              </Text>

              {/* Category dropdown */}
              <View style={{ marginTop: 16 }}>
                <Text style={styles.fieldLabel}>Category</Text>
                <TouchableOpacity
                  style={[styles.dropdownButton, isChanged(category, origCategory) && styles.inputChanged]}
                  onPress={() => setCategoryDropdownOpen(!categoryDropdownOpen)}
                >
                  <Text style={styles.dropdownButtonText}>{category || 'Select category...'}</Text>
                  <Ionicons
                    name={categoryDropdownOpen ? 'chevron-up' : 'chevron-down'}
                    size={20}
                    color={BPCL_BLUE}
                  />
                </TouchableOpacity>

                {categoryDropdownOpen && (
                  <View style={styles.dropdownList}>
                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                      {categories.map((cat) => (
                        <TouchableOpacity
                          key={cat}
                          style={[styles.dropdownItem, category === cat && styles.dropdownItemSelected]}
                          onPress={() => handleCategorySelect(cat)}
                        >
                          <Text
                            style={[
                              styles.dropdownItemText,
                              category === cat && styles.dropdownItemTextSelected,
                            ]}
                          >
                            {cat}
                          </Text>
                          {category === cat && <Ionicons name="checkmark" size={16} color="#fff" />}
                        </TouchableOpacity>
                      ))}
                      {!!record.category && !categories.includes(record.category) && (
                        <TouchableOpacity
                          style={[styles.dropdownItem, category === record.category && styles.dropdownItemSelected]}
                          onPress={() => handleCategorySelect(record.category)}
                        >
                          <Text style={styles.dropdownItemText}>
                            {record.category} ⚠️ (not in table)
                          </Text>
                        </TouchableOpacity>
                      )}
                    </ScrollView>
                  </View>
                )}
              </View>

              {/* Remarks */}
              <View style={{ marginTop: 16 }}>
                <Text style={styles.fieldLabel}>Remarks</Text>
                <TextInput
                  style={[
                    styles.textInput,
                    styles.textArea,
                    isChanged(remarks, origRemarks) && styles.inputChanged,
                  ]}
                  value={remarks}
                  onChangeText={handleRemarksChange}
                  multiline
                  numberOfLines={3}
                  placeholder="Remarks"
                />
              </View>

              {/* Rate / Qty */}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <View style={[styles.statBox, { flex: 2 }]}>
                  <Text style={styles.statLabel}>Rate</Text>
                  <TextInput
                    style={[
                      styles.statInput,
                      isChanged(rate, origRate) && styles.inputChanged,
                    ]}
                    value={rate}
                    onChangeText={handleRateChange}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={[styles.statBox, { flex: 1 }]}>
                  <Text style={styles.statLabel}>Qty</Text>
                  <TextInput
                    style={[
                      styles.statInput,
                      isChanged(quantity, origQuantity) && styles.inputChanged,
                    ]}
                    value={quantity}
                    onChangeText={handleQuantityChange}
                    keyboardType="number-pad"
                  />
                </View>
              </View>

              {/* Amount — read-only, auto-calculated */}
              <View
                style={[
                  styles.statBox,
                  styles.amountBox,
                  { marginTop: 10 },
                  amountStatus === 'match' && styles.amountBoxMatch,
                  amountStatus === 'mismatch' && styles.amountBoxMismatch,
                ]}
              >
                <View style={styles.amountLabelRow}>
                  <Text style={styles.statLabel}>Amount</Text>
                  <View style={styles.autoCalcBadge}>
                    <Ionicons name="calculator-outline" size={11} color={BPCL_BLUE} />
                    <Text style={styles.autoCalcText}>Rate × Qty</Text>
                  </View>
                </View>
                <Text
                  style={[
                    styles.statInput,
                    styles.amountValue,
                    isChanged(amount, origAmount) && styles.amountValueChanged,
                    amountStatus === 'match' && styles.amountValueMatch,
                    amountStatus === 'mismatch' && styles.amountValueMismatch,
                  ]}
                >
                  {amount || '—'}
                </Text>

                {isCommercialCategory && (
                  <View style={styles.commercialCheckRow}>
                    {previewLoading ? (
                      <ActivityIndicator size="small" color="#8898aa" />
                    ) : commercialMatchStatus === 'match' ? (
                      <>
                        <Ionicons name="checkmark-circle" size={13} color="#2dce89" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextOk]}>
                          {preview?.rows.length} of {quantity} commercial entries matched
                        </Text>
                      </>
                    ) : commercialMatchStatus === 'mismatch' ? (
                      <>
                        <Ionicons name="close-circle" size={13} color="#f5365c" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextBad]}>
                          Only {preview?.rows.length ?? 0} of {quantity} commercial entries found
                        </Text>
                      </>
                    ) : null}
                  </View>
                )}

                {isWeeklySalaryCategory && (
                <View style={styles.commercialCheckRow}>
                  {previewLoading ? (
                    <ActivityIndicator size="small" color="#8898aa" />
                  ) : weeklySalaryMatchStatus === 'match' ? (
                    <>
                      <Ionicons name="checkmark-circle" size={13} color="#2dce89" />
                      <Text style={[styles.commercialCheckText, styles.commercialCheckTextOk]}>
                        Qty matches Week 1 cylinders ({weeklySalaryFromPreview})
                      </Text>
                    </>
                  ) : weeklySalaryMatchStatus === 'mismatch' ? (
                    <>
                      <Ionicons name="close-circle" size={13} color="#f5365c" />
                      <Text style={[styles.commercialCheckText, styles.commercialCheckTextBad]}>
                        Qty {quantity} ≠ Week 1 cylinders ({weeklySalaryFromPreview ?? '—'})
                      </Text>
                    </>
                  ) : null}
                </View>
              )}

                {isClosingBalanceCategory && (
                  <View style={styles.commercialCheckRow}>
                    {previewLoading ? (
                      <ActivityIndicator size="small" color="#8898aa" />
                    ) : closingBalanceMatchStatus === 'match' ? (
                      <>
                        <Ionicons name="checkmark-circle" size={13} color="#2dce89" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextOk]}>
                          Prev. day net ₹{closingBalanceFromPreview} within ±10 of ₹{amount}
                        </Text>
                      </>
                    ) : closingBalanceMatchStatus === 'mismatch' ? (
                      <>
                        <Ionicons name="close-circle" size={13} color="#f5365c" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextBad]}>
                          Prev. day net ₹{closingBalanceFromPreview ?? '—'} vs ₹{amount} — diff too large
                        </Text>
                      </>
                    ) : null}
                  </View>
                )}
              </View>

              {isTotalAhdCategory && (
                <View
                  style={[
                    styles.balanceReportBox,
                    !totalAhdLoading &&
                      (totalAhdMatchStatus === 'match' ? styles.balanceReportBoxMatch : styles.balanceReportBoxMismatch),
                  ]}
                >
                  <View style={styles.commercialCheckRow}>
                    {totalAhdLoading ? (
                      <>
                        <ActivityIndicator size="small" color="#8898aa" />
                        <Text style={styles.commercialCheckText}>Checking Delivery Records…</Text>
                      </>
                    ) : totalAhdMatchStatus === 'match' ? (
                      <>
                        <Ionicons name="checkmark-circle" size={13} color="#2dce89" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextOk]}>
                          Sum matches quantity ({totalAhdData?.sumNumber})
                        </Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="close-circle" size={13} color="#f5365c" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextBad]}>
                          Sum of number ({totalAhdData?.sumNumber ?? 0}) ≠ quantity ({quantity})
                        </Text>
                      </>
                    )}
                  </View>

                  {totalAhdData && (
                    <View style={styles.balanceReportRowDetails}>
                      <View style={styles.previewFieldRow}>
                        <Text style={styles.previewFieldLabel}>Sum of number</Text>
                        <Text style={styles.previewFieldValue}>{totalAhdData.sumNumber}</Text>
                      </View>
                      <View style={styles.previewFieldRow}>
                        <Text style={styles.previewFieldLabel}>Sum of empty_received</Text>
                        <Text style={styles.previewFieldValue}>{totalAhdData.sumEmptyReceived}</Text>
                      </View>
                    </View>
                  )}
                </View>
              )}

              {/* ── Balance Report lookup result — shown below Amount ── */}
              {isBalanceCategory && (
                <View
                  style={[
                    styles.balanceReportBox,
                    !balanceReportLoading &&
                      (balanceReportRow ? styles.balanceReportBoxMatch : styles.balanceReportBoxMismatch),
                  ]}
                >
                  <View style={styles.commercialCheckRow}>
                    {balanceReportLoading ? (
                      <>
                        <ActivityIndicator size="small" color="#8898aa" />
                        <Text style={styles.commercialCheckText}>Checking Balance Report…</Text>
                      </>
                    ) : balanceReportRow ? (
                      <>
                        <Ionicons name="checkmark-circle" size={13} color="#2dce89" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextOk]}>
                          Found in Balance Report (#{balanceReportId})
                        </Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="close-circle" size={13} color="#f5365c" />
                        <Text style={[styles.commercialCheckText, styles.commercialCheckTextBad]}>
                          {balanceReportId
                            ? `No matching row in Balance Report for #${balanceReportId}`
                            : 'No debit_balance_report_id on this record'}
                        </Text>
                      </>
                    )}
                  </View>

                  {balanceReportRow && (
                    <View style={styles.balanceReportRowDetails}>
                      {Object.entries(balanceReportRow)
                        .filter(([key]) => key !== 'idx')
                        .map(([key, value]) => (
                          <View key={key} style={styles.previewFieldRow}>
                            <Text style={styles.previewFieldLabel}>{key}</Text>
                            <Text style={styles.previewFieldValue} numberOfLines={2}>
                              {value === null || value === undefined ? '—' : String(value)}
                            </Text>
                          </View>
                        ))}
                    </View>
                  )}
                </View>
              )}

              {record.paytm_transaction && (
                <View style={styles.paytmBadgeWrap}>
                  <View style={styles.paytmBadge}>
                    <Text style={styles.paytmBadgeText}>📱 Paytm Transaction</Text>
                  </View>
                </View>
              )}

              {/* Approve / Reject */}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                <TouchableOpacity
                  style={[styles.actionButton, styles.approveButton]}
                  onPress={handleApprove}
                  disabled={submitting !== null}
                >
                  {submitting === 'approve' ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="checkmark" size={18} color="#fff" />
                      <Text style={styles.actionButtonText}>Approve</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionButton, styles.rejectButton]}
                  onPress={handleReject}
                  disabled={submitting !== null}
                >
                  {submitting === 'reject' ? (
                    <ActivityIndicator color="#e35d6a" />
                  ) : (
                    <>
                      <Ionicons name="close" size={18} color="#e35d6a" />
                      <Text style={styles.rejectButtonText}>Reject</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {/* ── Preview card ── */}
            <View style={[styles.card, styles.previewCard]}>
              <View style={styles.cardHeaderRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="search-outline" size={18} color="#fb6340" />
                  <Text style={styles.cardTitle}>Side Table Preview</Text>
                </View>
                {previewLoading && <ActivityIndicator size="small" color="#8898aa" />}
              </View>
              {!!preview?.title && <Text style={styles.previewTitle}>{preview.title}</Text>}

              {preview && preview.rows.length > 0 ? (
                <View style={{ gap: 10 }}>
                  {preview.rows.map((row, i) => {
                    const rowText = row.join(' ');
                    const isPaid = rowText.includes('✅');
                    const isUnpaid = rowText.includes('⏳');
                    const isWarning = rowText.includes('⚠️');
                    return (
                      <View
                        key={i}
                        style={[
                          styles.previewRowCard,
                          isPaid && styles.previewRowCardPaid,
                          isUnpaid && styles.previewRowCardUnpaid,
                          isWarning && styles.previewRowCardWarning,
                        ]}
                      >
                        {row.map((cell, j) => (
                          <View key={j} style={styles.previewFieldRow}>
                            <Text style={styles.previewFieldLabel}>{preview.headers[j]}</Text>
                            <Text style={styles.previewFieldValue} numberOfLines={2}>
                              {cell}
                            </Text>
                          </View>
                        ))}
                      </View>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.previewEmpty}>
                  <Ionicons name="close-circle-outline" size={36} color="#fb6340" />
                  <Text style={styles.previewEmptyText}>
                    {preview?.title ? preview.title : 'No preview available.'}
                  </Text>
                </View>
              )}
            </View>
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  scrollView: { flex: 1 },
  centerFill: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f5f5' },

  header: {
    backgroundColor: BPCL_BLUE,
    padding: 20,
    paddingTop: 60,
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.9)', marginTop: 4 },
  pendingBadge: {
    backgroundColor: '#f5365c',
    borderRadius: 50,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pendingBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  card: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  editCard: { borderLeftWidth: 5, borderLeftColor: '#5e72e4' },
  previewCard: { borderLeftWidth: 5, borderLeftColor: '#fb6340', marginTop: -4 },

  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#32325d' },
  recordMeta: { fontSize: 12, color: '#8898aa', marginTop: 4 },

  txBadge: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  txBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  fieldLabel: {
    fontSize: 11,
    color: '#8898aa',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '600',
    marginBottom: 6,
  },

  dropdownButton: {
    backgroundColor: '#f8f9fe',
    borderWidth: 1,
    borderColor: '#dee2e6',
    borderRadius: 6,
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dropdownButtonText: { fontSize: 14, fontWeight: '600', color: '#32325d' },
  dropdownList: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    marginTop: 4,
    elevation: 4,
  },
  dropdownItem: {
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  dropdownItemSelected: { backgroundColor: BPCL_BLUE },
  dropdownItemText: { fontSize: 14, color: '#333' },
  dropdownItemTextSelected: { color: '#fff', fontWeight: 'bold' },

  textInput: {
    backgroundColor: '#f8f9fe',
    borderWidth: 1,
    borderColor: '#dee2e6',
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#32325d',
  },
  textArea: { minHeight: 70, textAlignVertical: 'top' },
  inputChanged: { borderColor: '#fb6340', backgroundColor: '#fff9f5' },

  statBox: {
    backgroundColor: '#f8f9fe',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e9ecef',
  },
  statLabel: {
    fontSize: 11,
    color: '#8898aa',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  statInput: {
    fontSize: 18,
    fontWeight: '700',
    color: '#32325d',
    textAlign: 'center',
    width: '100%',
    padding: 0,
  },

  // Amount box — read-only display
  amountBox: {
    borderColor: BPCL_BLUE,
    borderWidth: 1.5,
    backgroundColor: '#f0f8ff',
  },
  amountLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  autoCalcBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#e8f4fd',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  autoCalcText: {
    fontSize: 10,
    color: BPCL_BLUE,
    fontWeight: '600',
  },
  amountValue: {
    color: BPCL_BLUE,
    fontSize: 22,
  },
  amountValueChanged: {
    color: '#fb6340',
  },

  // ── Commercial Payment / Balance category match indicator ──
  amountBoxMatch: {
    borderColor: '#2dce89',
    borderWidth: 1.5,
    backgroundColor: '#f0fdf6',
  },
  amountBoxMismatch: {
    borderColor: '#f5365c',
    borderWidth: 1.5,
    backgroundColor: '#fff5f6',
  },
  amountValueMatch: {
    color: '#2dce89',
  },
  amountValueMismatch: {
    color: '#f5365c',
  },
  commercialCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  commercialCheckText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8898aa',
  },
  commercialCheckTextOk: {
    color: '#2dce89',
  },
  commercialCheckTextBad: {
    color: '#f5365c',
  },

  // ── Balance Report lookup result box ──
  balanceReportBox: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#e9ecef',
    backgroundColor: '#f8f9fe',
    padding: 10,
  },
  balanceReportBoxMatch: {
    borderColor: '#2dce89',
    backgroundColor: '#f0fdf6',
  },
  balanceReportBoxMismatch: {
    borderColor: '#f5365c',
    backgroundColor: '#fff5f6',
  },
  balanceReportRowDetails: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
    paddingTop: 8,
    gap: 2,
  },

  paytmBadgeWrap: { alignItems: 'center', marginTop: 14 },
  paytmBadge: {
    backgroundColor: '#fb6340',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  paytmBadgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  actionButton: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveButton: { backgroundColor: '#1f7a5c' },
  rejectButton: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#e35d6a',
  },
  actionButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  rejectButtonText: { color: '#e35d6a', fontSize: 15, fontWeight: '700' },

  emptyState: { alignItems: 'center', paddingVertical: 50 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', color: '#32325d', marginTop: 16 },
  emptySubtitle: { fontSize: 13, color: '#8898aa', marginTop: 4 },

  previewTitle: { fontSize: 12, color: '#8898aa', marginTop: 6, marginBottom: 10, lineHeight: 18 },

  previewRowCard: {
    backgroundColor: '#f8f9fe',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e9ecef',
    borderLeftWidth: 4,
    borderLeftColor: '#cbd5e0',
    padding: 10,
  },
  previewRowCardPaid: { borderLeftColor: '#2dce89', backgroundColor: '#f3fdf8' },
  previewRowCardUnpaid: { borderLeftColor: '#fb6340', backgroundColor: '#fff8f5' },
  previewRowCardWarning: { borderLeftColor: '#ffc107', backgroundColor: '#fffdf0' },

  previewFieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 3,
    gap: 10,
  },
  previewFieldLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: '#8898aa',
    fontWeight: '700',
    flex: 1,
  },
  previewFieldValue: {
    fontSize: 13,
    color: '#32325d',
    fontWeight: '600',
    flex: 1.4,
    textAlign: 'right',
  },

  previewEmpty: { alignItems: 'center', paddingVertical: 30 },
  previewEmptyText: { fontSize: 13, color: '#8898aa', marginTop: 8, textAlign: 'center' },
});
