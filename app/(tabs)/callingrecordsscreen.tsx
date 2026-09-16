import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, TextInput, Linking, Modal, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { format, subDays } from 'date-fns';
import { supabase } from '@/lib/supabase';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';

// ─── Constants ────────────────────────────────────────────────────────────────
const BPCL_BLUE     = '#017DC5';
const SUCCESS_GREEN = '#34C759';
const WARN_ORANGE   = '#FF9500';
const DANGER_RED    = '#FF3B30';

const CALLING_REASONS = [
  'DBC RESPONSE', 'NILL REFILL CONSUMER', 'PENDING BOOKING',
  'KYC PENDING', 'FOLLOW UP', 'NEW CONNECTION', 'COMPLAINT', 'OTHER',
];

// ─── Types ────────────────────────────────────────────────────────────────────
interface QueueRecord {
  id: number;           // dashboard_callingqueue.id
  consumer: string;
  consumer_name: string;
  address: string;
  area_code: string;
  mobile_no: string;
  is_done: boolean;
}

type PopupStep =
  | null
  | 'REASON' | 'KAYA_UTHAYA' | 'NOT_RECEIVED'
  | 'INTERESTED' | 'TENTATIVE_DATE' | 'REMARKS';

interface CallData {
  calling_reason: string;
  received: boolean;
  interested: boolean;
  not_received_reason: string;
  tentative_date: string;
  remarks: string;
}

const EMPTY_CALL_DATA: CallData = {
  calling_reason: '', received: false, interested: false,
  not_received_reason: '', tentative_date: '', remarks: '',
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function CallingRecordsScreen() {

  // ── Queue state ──
  const [allRecords, setAllRecords]       = useState<QueueRecord[]>([]);
  const [skippedCount, setSkippedCount]   = useState(0);
  const [retryCount, setRetryCount]       = useState(0);
  const [currentIndex, setCurrentIndex]   = useState(0);
  const [uploading, setUploading]         = useState(false);
  const [loadingQueue, setLoadingQueue]   = useState(false);

  // ── Call data ──
  const [callDataMap, setCallDataMap]   = useState<Record<number, CallData>>({});
  const [callData, setCallDataRaw]      = useState<CallData>(EMPTY_CALL_DATA);
  const callDataRef                     = useRef<CallData>(EMPTY_CALL_DATA);
  const [popupStep, setPopupStep]       = useState<PopupStep>(null);
  const [submitting, setSubmitting]     = useState(false);
  const [savedIds, setSavedIds]         = useState<Set<number>>(new Set()); // tracks index in allRecords

  // ── Temp popup inputs ──
  const [tempReason, setTempReason]   = useState('');
  const [tempDate, setTempDate]       = useState('');
  const [tempRemarks, setTempRemarks] = useState('');

  // ── Animation ──
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const currentRecord = allRecords[currentIndex] ?? null;
  const isSaved       = savedIds.has(currentIndex);
  const doneCount     = allRecords.filter(r => r.is_done).length;
  const pendingCount  = allRecords.filter(r => !r.is_done).length;
  const progress      = allRecords.length ? ((currentIndex + 1) / allRecords.length) * 100 : 0;

  // ── On mount: auto-load queue from DB ───────────────────────────────────────
  useEffect(() => {
    loadQueueFromDB();
  }, []);

  // ── Load queue from dashboard_callingqueue ──────────────────────────────────
  const loadQueueFromDB = async () => {
    setLoadingQueue(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_callingqueue')
        .select('id, consumer, consumer_name, address, area_code, mobile_no, is_done')
        .order('id', { ascending: true })
        .limit(10000);

      if (error) throw error;
      if (!data?.length) return; // no queue yet, show empty state

      await applyFilterToQueue(data as QueueRecord[]);
    } catch (err: any) {
      Alert.alert('त्रुटि', err.message || 'Queue लोड नहीं हो सकी');
    } finally {
      setLoadingQueue(false);
    }
  };

  // ── Upload CSV → delete old queue → insert new ──────────────────────────────
  const handleUploadCSV = async () => {
    try {
      setUploading(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const content = await FileSystem.readAsStringAsync(result.assets[0].uri);

      Papa.parse(content, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_'),
        complete: async (parsed: any) => {
          const firstKey = parsed.meta?.fields?.[0] || '';
          const rows = parsed.data.map((row: any) => ({
            consumer:      row['consumer_number'] || row['consumer_id'] || row['id'] || (firstKey ? row[firstKey] : '') || '',
            consumer_name: row['consumer_name'] || row['name'] || row['customer_name'] || '',
            address:       row['address'] || row['addr'] || '',
            area_code:     row['area_code'] || row['areacode'] || row['pincode'] || row['area'] || '',
            mobile_no:     row['mobile_no'] || row['mobile'] || row['phone'] || row['contact'] || row['mobile_number'] || '',
          }));

          const valid = rows.filter((r: any) => r.consumer_name || r.mobile_no);
          if (!valid.length) {
            Alert.alert('त्रुटि', 'कोई वैध रिकॉर्ड नहीं मिला। कॉलम हेडर जांचें।');
            return;
          }

          Alert.alert(
            'नई फ़ाइल अपलोड',
            `${valid.length} रिकॉर्ड मिले। पुरानी queue हटाकर नई लोड करें?`,
            [
              { text: 'रद्द करें', style: 'cancel' },
              {
                text: 'हाँ, बदलें',
                onPress: () => replaceQueue(valid),
              },
            ]
          );
        },
        error: (err: any) => Alert.alert('Parse Error', err.message),
      });
    } catch (err: any) {
      Alert.alert('त्रुटि', err.message || 'फ़ाइल पढ़ने में समस्या');
    } finally {
      setUploading(false);
    }
  };

  // ── Delete old queue + insert new in batches ────────────────────────────────
  const replaceQueue = async (rows: any[]) => {
    setLoadingQueue(true);
    try {
      // Step 1: Delete all existing queue records
      const { error: delError } = await supabase
        .from('dashboard_callingqueue')
        .delete()
        .neq('id', 0); // delete all rows

      if (delError) throw delError;

      // Step 2: Insert new records in batches of 500
      const today = format(new Date(), 'yyyy-MM-dd');
      const batchSize = 500;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize).map((r: any) => ({
          consumer:      r.consumer?.toString().trim() || null,
          consumer_name: r.consumer_name?.trim() || null,
          address:       r.address?.trim() || null,
          area_code:     r.area_code?.trim() || null,
          mobile_no:     r.mobile_no?.toString().trim() || null,
          queue_date:    today,
          is_done:       false,
          done_at:       null,
        }));

        const { error: insError } = await supabase
          .from('dashboard_callingqueue')
          .insert(batch);

        if (insError) throw insError;
      }

      // Step 3: Reload and apply filter
      const { data: freshQueue, error: fetchError } = await supabase
        .from('dashboard_callingqueue')
        .select('id, consumer, consumer_name, address, area_code, mobile_no, is_done')
        .order('id', { ascending: true })
        .limit(10000);

      if (fetchError) throw fetchError;

      // Reset all local state
      setCallDataMap({});
      setSavedIds(new Set());
      callDataRef.current = EMPTY_CALL_DATA;
      setCallDataRaw(EMPTY_CALL_DATA);

      await applyFilterToQueue(freshQueue as QueueRecord[]);
    } catch (err: any) {
      Alert.alert('त्रुटि', err.message || JSON.stringify(err));
    } finally {
      setLoadingQueue(false);
    }
  };

  // ── 15-day filter applied to queue records ──────────────────────────────────
  const applyFilterToQueue = async (queueRows: QueueRecord[]) => {
    try {
      const since = format(subDays(new Date(), 15), 'yyyy-MM-dd');

      // Fetch recently called with received=true
      const { data: recentCalls } = await supabase
        .from('dashboard_callingrecords')
        .select('consumer, mobile_no')
        .gte('date', since)
        .eq('received', true);

      const calledSet = new Set<string>(
        (recentCalls || []).map((r: any) =>
          `${String(r.consumer ?? '').trim()}::${String(r.mobile_no ?? '').trim()}`
        )
      );

      // Fetch recently called with received=false (retry candidates)
      const { data: notReceivedCalls } = await supabase
        .from('dashboard_callingrecords')
        .select('consumer, mobile_no')
        .gte('date', since)
        .eq('received', false);

      const notReceivedSet = new Set<string>(
        (notReceivedCalls || []).map((r: any) =>
          `${String(r.consumer ?? '').trim()}::${String(r.mobile_no ?? '').trim()}`
        )
      );

      let skipped = 0;
      let retry   = 0;

      const filtered = queueRows.filter(row => {
        const key = `${String(row.consumer ?? '').trim()}::${String(row.mobile_no ?? '').trim()}`;
        if (calledSet.has(key)) {
          skipped++;
          return false; // called + received → skip
        }
        return true;
      });

      filtered.forEach(row => {
        const key = `${String(row.consumer ?? '').trim()}::${String(row.mobile_no ?? '').trim()}`;
        if (notReceivedSet.has(key)) retry++;
      });

      // Find first pending (not done) record to start from
      const firstPendingIndex = filtered.findIndex(r => !r.is_done);
      const startIndex = firstPendingIndex >= 0 ? firstPendingIndex : 0;

      // Pre-populate savedIds for already-done records
      const doneset = new Set<number>();
      filtered.forEach((r, i) => { if (r.is_done) doneset.add(i); });

      setAllRecords(filtered);
      setSkippedCount(skipped);
      setRetryCount(retry);
      setCurrentIndex(startIndex);
      setSavedIds(doneset);
      setPopupStep(null);

      if (filtered.length > 0) {
        Alert.alert(
          'रिकॉर्ड लोड हो गए',
          `✅ ${filtered.length} कॉल के लिए\n✔️ ${doneset.size} पहले से हो गए\n⏭ ${skipped} छोड़े गए (15 दिन में कॉल)\n🔄 ${retry} पुनः प्रयास`
        );
      }
    } catch (err: any) {
      Alert.alert('फ़िल्टर में त्रुटि', err.message || JSON.stringify(err));
    }
  };

  // ── setCallData helper (state + ref) ────────────────────────────────────────
  const setCallData = useCallback((updater: CallData | ((prev: CallData) => CallData)) => {
    setCallDataRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      callDataRef.current = next;
      return next;
    });
  }, []);

  // ── Navigate ─────────────────────────────────────────────────────────────────
  const navigateTo = useCallback((index: number) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 110, useNativeDriver: true }).start(() => {
      setCurrentIndex(index);
      const restored = callDataMap[index] ?? EMPTY_CALL_DATA;
      callDataRef.current = restored;
      setCallDataRaw(restored);
      setPopupStep(null);
      Animated.timing(fadeAnim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    });
  }, [fadeAnim, callDataMap]);

  // ── Popup chain handlers ─────────────────────────────────────────────────────
  const handleStartCall = () => {
    setTempReason(callData.calling_reason || CALLING_REASONS[0]);
    setPopupStep('REASON');
  };

  const handleReasonConfirm = async () => {
    if (!tempReason) return Alert.alert('त्रुटि', 'कारण चुनें');
    const withReason = { ...callDataRef.current, calling_reason: tempReason };
    callDataRef.current = withReason;
    setCallDataRaw(withReason);
    setPopupStep(null);

    const phone = currentRecord?.mobile_no?.replace(/\D/g, '') ?? '';
    if (!phone) return Alert.alert('त्रुटि', 'मोबाइल नंबर नहीं है');
    const url = `tel:${phone}`;
    if (!(await Linking.canOpenURL(url))) return Alert.alert('त्रुटि', 'डायलर नहीं खुल सकता');
    await Linking.openURL(url);
    setTimeout(() => setPopupStep('KAYA_UTHAYA'), 1200);
  };

  const handleCallReceived = () => {
    const next = { ...callDataRef.current, received: true };
    callDataRef.current = next; setCallDataRaw(next);
    setPopupStep('INTERESTED');
  };

  const handleCallNotReceived = () => {
    const next = { ...callDataRef.current, received: false, interested: false };
    callDataRef.current = next; setCallDataRaw(next);
    setPopupStep('NOT_RECEIVED');
  };

  const handleNotReceivedReason = (reason: string) => {
    const next = { ...callDataRef.current, not_received_reason: reason };
    callDataRef.current = next; setCallDataRaw(next);
    setTempRemarks('');
    setPopupStep('REMARKS');
  };

  const handleInterested = () => {
    const next = { ...callDataRef.current, interested: true };
    callDataRef.current = next; setCallDataRaw(next);
    setTempDate('');
    setPopupStep('TENTATIVE_DATE');
  };

  const handleNotInterested = () => {
    const next = { ...callDataRef.current, interested: false };
    callDataRef.current = next; setCallDataRaw(next);
    setTempRemarks('');
    setPopupStep('REMARKS');
  };

  const handleDateConfirm = () => {
    const next = { ...callDataRef.current, tentative_date: tempDate };
    callDataRef.current = next; setCallDataRaw(next);
    setTempRemarks('');
    setPopupStep('REMARKS');
  };

  const handleRemarksConfirm = async () => {
    if (submitting) return;
    const finalData: CallData = { ...callDataRef.current, remarks: tempRemarks };
    callDataRef.current = finalData;
    setCallDataRaw(finalData);
    setCallDataMap(prev => ({ ...prev, [currentIndex]: finalData }));
    setPopupStep(null);
    await saveRecord(finalData);
  };

  // ── Save to callingrecords + mark queue done ──────────────────────────────────
  const saveRecord = async (data: CallData) => {
    if (!currentRecord) return;
    setSubmitting(true);
    try {
      const tentative = data.tentative_date
        ? data.tentative_date
        : data.interested
          ? format(new Date(Date.now() + 7 * 86400000), 'yyyy-MM-dd')
          : '1990-01-01';

      const finalRemarks = [data.not_received_reason, data.remarks]
        .filter(Boolean).join(' | ') || null;

      // 1. Insert into dashboard_callingrecords
      const { error: recErr } = await supabase
        .from('dashboard_callingrecords')
        .insert({
          consumer:       currentRecord.consumer?.trim() || currentRecord.mobile_no?.trim() || '0',
          consumer_name:  currentRecord.consumer_name || null,
          address:        currentRecord.address || null,
          area_code:      currentRecord.area_code || null,
          mobile_no:      currentRecord.mobile_no || null,
          calling_reason: data.calling_reason,
          received:       data.received,
          interested:     data.interested,
          tentative_date: tentative,
          date:           format(new Date(), 'yyyy-MM-dd'),
          remarks:        finalRemarks,
        });

      if (recErr) throw recErr;

      // 2. Mark queue record as done
      const { error: qErr } = await supabase
        .from('dashboard_callingqueue')
        .update({ is_done: true, done_at: format(new Date(), 'yyyy-MM-dd') })
        .eq('id', currentRecord.id);

      if (qErr) throw qErr;

      // 3. Update local state
      setAllRecords(prev =>
        prev.map((r, i) => i === currentIndex ? { ...r, is_done: true } : r)
      );
      setCallDataMap(prev => ({ ...prev, [currentIndex]: data }));
      setSavedIds(prev => new Set([...prev, currentIndex]));

      Alert.alert('सहेजा ✓', `${currentRecord.consumer_name} का रिकॉर्ड सहेज लिया गया!`, [
        {
          text: 'अगला →',
          onPress: () => {
            if (currentIndex < allRecords.length - 1) navigateTo(currentIndex + 1);
          },
        },
        { text: 'रुकें', style: 'cancel' },
      ]);
    } catch (err: any) {
      Alert.alert('सहेजने में त्रुटि', err?.message || JSON.stringify(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* HEADER */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>कॉलिंग रिकॉर्ड</Text>
          <Text style={styles.headerSubtitle}>
            {allRecords.length
              ? `${currentIndex + 1} / ${allRecords.length} रिकॉर्ड`
              : loadingQueue ? 'लोड हो रहा है...' : 'CSV अपलोड करें'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.uploadBtn}
          onPress={handleUploadCSV}
          disabled={uploading || loadingQueue}
        >
          {uploading || loadingQueue
            ? <ActivityIndicator size="small" color="#fff" />
            : <>
                <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                <Text style={styles.uploadBtnText}>CSV अपलोड करें</Text>
              </>
          }
        </TouchableOpacity>
      </View>

      {/* STATS BAR */}
      {allRecords.length > 0 && (
        <View style={styles.statsBar}>
          <View style={styles.statItem}>
            <Text style={styles.statNum}>{allRecords.length}</Text>
            <Text style={styles.statLabel}>कुल</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNum, { color: SUCCESS_GREEN }]}>{doneCount}</Text>
            <Text style={styles.statLabel}>हो गया</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNum, { color: WARN_ORANGE }]}>{pendingCount}</Text>
            <Text style={styles.statLabel}>बाकी</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNum, { color: '#aaa' }]}>{skippedCount}</Text>
            <Text style={styles.statLabel}>छोड़े गए</Text>
          </View>
        </View>
      )}

      {/* PROGRESS BAR */}
      {allRecords.length > 0 && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` as any }]} />
        </View>
      )}

      {/* EMPTY / LOADING STATE */}
      {loadingQueue && !allRecords.length ? (
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color={BPCL_BLUE} />
          <Text style={styles.emptyTitle}>Queue लोड हो रही है...</Text>
        </View>

      ) : !allRecords.length ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="call-outline" size={52} color={BPCL_BLUE} />
          </View>
          <Text style={styles.emptyTitle}>कोई रिकॉर्ड नहीं</Text>
          <Text style={styles.emptySubtitle}>
            CSV अपलोड करें, जिसमें यह कॉलम हों:{'\n'}
            consumer, consumer_name, address,{'\n'}
            area_code, mobile_no
          </Text>
          <TouchableOpacity
            style={styles.emptyUploadBtn}
            onPress={handleUploadCSV}
            disabled={uploading}
          >
            {uploading
              ? <ActivityIndicator color="#fff" />
              : <>
                  <Ionicons name="cloud-upload" size={20} color="#fff" />
                  <Text style={styles.uploadBtnText}>CSV अपलोड करें</Text>
                </>
            }
          </TouchableOpacity>
        </View>

      ) : (
        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>

          {/* NAV ROW */}
          <View style={styles.navRow}>
            <TouchableOpacity
              style={[styles.navBtn, currentIndex === 0 && styles.navBtnDisabled]}
              onPress={() => navigateTo(currentIndex - 1)}
              disabled={currentIndex === 0}
            >
              <Ionicons name="chevron-back" size={20} color={currentIndex === 0 ? '#ccc' : BPCL_BLUE} />
              <Text style={[styles.navBtnText, currentIndex === 0 && { color: '#ccc' }]}>पिछला</Text>
            </TouchableOpacity>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
              <View style={styles.dotsRow}>
                {allRecords.map((r, i) => (
                  <TouchableOpacity key={i} onPress={() => navigateTo(i)}>
                    <View style={[
                      styles.dot,
                      i === currentIndex && styles.dotActive,
                      r.is_done && styles.dotSaved,
                    ]} />
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.navBtn, currentIndex === allRecords.length - 1 && styles.navBtnDisabled]}
              onPress={() => navigateTo(currentIndex + 1)}
              disabled={currentIndex === allRecords.length - 1}
            >
              <Text style={[styles.navBtnText, currentIndex === allRecords.length - 1 && { color: '#ccc' }]}>अगला</Text>
              <Ionicons name="chevron-forward" size={20} color={currentIndex === allRecords.length - 1 ? '#ccc' : BPCL_BLUE} />
            </TouchableOpacity>
          </View>

          <Animated.View style={{ opacity: fadeAnim }}>

            {/* CONSUMER CARD */}
            <View style={[styles.card, isSaved && styles.cardSaved]}>
              {isSaved && (
                <View style={styles.savedBadge}>
                  <Ionicons name="checkmark-circle" size={13} color="#fff" />
                  <Text style={styles.savedBadgeText}>हो गया</Text>
                </View>
              )}

              <View style={styles.cardTitleRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {currentRecord?.consumer_name?.charAt(0)?.toUpperCase() || '?'}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.consumerName}>{currentRecord?.consumer_name || '—'}</Text>
                  {currentRecord?.consumer
                    ? <Text style={styles.consumerId}>आईडी: {currentRecord.consumer}</Text>
                    : null}
                </View>
              </View>

              {currentRecord?.address ? (
                <View style={styles.infoRow}>
                  <Ionicons name="location-outline" size={15} color="#999" />
                  <Text style={styles.infoText}>{currentRecord.address}</Text>
                </View>
              ) : null}

              {currentRecord?.area_code ? (
                <View style={styles.infoRow}>
                  <Ionicons name="map-outline" size={15} color="#999" />
                  <Text style={styles.infoText}>क्षेत्र/पिन: {currentRecord.area_code}</Text>
                </View>
              ) : null}

              <View style={styles.mobileRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="call-outline" size={15} color="#999" />
                  <Text style={styles.mobileText}>{currentRecord?.mobile_no || '—'}</Text>
                </View>
                <TouchableOpacity
                  style={[styles.callBtn, isSaved && { backgroundColor: '#aaa' }]}
                  onPress={handleStartCall}
                  disabled={isSaved || submitting}
                >
                  {submitting
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <>
                        <Ionicons name="call" size={17} color="#fff" />
                        <Text style={styles.callBtnText}>{isSaved ? 'हो गया' : 'कॉल करें'}</Text>
                      </>
                  }
                </TouchableOpacity>
              </View>
            </View>

            {/* SUMMARY after save */}
            {isSaved && (() => {
              const saved = callDataMap[currentIndex] ?? callData;
              return (
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryTitle}>📋 कॉल सारांश</Text>
                  <SummaryRow label="कारण"    value={saved.calling_reason || '—'} />
                  <SummaryRow label="उठाया"   value={saved.received   ? '✅ हाँ' : '❌ नहीं'} />
                  <SummaryRow label="इच्छुक"  value={saved.interested ? '✅ हाँ' : '❌ नहीं'} />
                  {saved.not_received_reason ? <SummaryRow label="स्थिति"   value={saved.not_received_reason} /> : null}
                  {saved.tentative_date      ? <SummaryRow label="तारीख"    value={saved.tentative_date} />      : null}
                  {saved.remarks             ? <SummaryRow label="टिप्पणी"  value={saved.remarks} />             : null}
                </View>
              );
            })()}

            <View style={{ height: 40 }} />
          </Animated.View>
        </ScrollView>
      )}

      {/* ── POPUP CHAIN ── */}

      {/* STEP 0: Reason */}
      <BottomModal visible={popupStep === 'REASON'}>
        <View style={styles.popupHandle} />
        <Text style={styles.popupTitle}>कॉलिंग का कारण चुनें</Text>
        <Text style={styles.popupSub}>{currentRecord?.consumer_name}</Text>
        <View style={styles.reasonList}>
          {CALLING_REASONS.map(r => (
            <TouchableOpacity
              key={r}
              style={[styles.reasonItem, tempReason === r && styles.reasonItemActive]}
              onPress={() => setTempReason(r)}
            >
              <Text style={[styles.reasonText, tempReason === r && styles.reasonTextActive]}>{r}</Text>
              {tempReason === r && <Ionicons name="checkmark-circle" size={18} color={BPCL_BLUE} />}
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.popupBtn} onPress={handleReasonConfirm}>
          <Ionicons name="call" size={18} color="#fff" />
          <Text style={styles.popupBtnText}>कॉल करें</Text>
        </TouchableOpacity>
      </BottomModal>

      {/* STEP 1: Kya uthaya? */}
      <BottomModal visible={popupStep === 'KAYA_UTHAYA'}>
        <View style={styles.popupHandle} />
        <Text style={styles.popupEmoji}>📞</Text>
        <Text style={styles.popupTitle}>क्या कॉल उठाया?</Text>
        <Text style={styles.popupSub}>{currentRecord?.consumer_name}</Text>
        <View style={styles.bigBtnRow}>
          <TouchableOpacity style={[styles.bigBtn, { backgroundColor: SUCCESS_GREEN }]} onPress={handleCallReceived}>
            <Ionicons name="checkmark-circle" size={28} color="#fff" />
            <Text style={styles.bigBtnText}>हाँ</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.bigBtn, { backgroundColor: DANGER_RED }]} onPress={handleCallNotReceived}>
            <Ionicons name="close-circle" size={28} color="#fff" />
            <Text style={styles.bigBtnText}>नहीं</Text>
          </TouchableOpacity>
        </View>
      </BottomModal>

      {/* STEP 2a: Not received reason */}
      <BottomModal visible={popupStep === 'NOT_RECEIVED'}>
        <View style={styles.popupHandle} />
        <Text style={styles.popupEmoji}>📵</Text>
        <Text style={styles.popupTitle}>कॉल क्यों नहीं उठाया?</Text>
        <Text style={styles.popupSub}>{currentRecord?.consumer_name}</Text>
        <View style={styles.optionList}>
          {['कॉल नहीं उठाया', 'बंद है', 'संपर्क में नहीं'].map(opt => (
            <TouchableOpacity key={opt} style={styles.optionBtn} onPress={() => handleNotReceivedReason(opt)}>
              <Ionicons
                name={opt === 'कॉल नहीं उठाया' ? 'call-outline' : opt === 'बंद है' ? 'power-outline' : 'cellular-outline'}
                size={22} color={WARN_ORANGE}
              />
              <Text style={styles.optionBtnText}>{opt}</Text>
              <Ionicons name="chevron-forward" size={16} color="#ccc" />
            </TouchableOpacity>
          ))}
        </View>
      </BottomModal>

      {/* STEP 2b: Interested? */}
      <BottomModal visible={popupStep === 'INTERESTED'}>
        <View style={styles.popupHandle} />
        <Text style={styles.popupEmoji}>🤔</Text>
        <Text style={styles.popupTitle}>क्या आप इच्छुक हैं?</Text>
        <Text style={styles.popupSub}>{currentRecord?.consumer_name}</Text>
        <View style={styles.bigBtnRow}>
          <TouchableOpacity style={[styles.bigBtn, { backgroundColor: SUCCESS_GREEN }]} onPress={handleInterested}>
            <Ionicons name="thumbs-up" size={28} color="#fff" />
            <Text style={styles.bigBtnText}>हाँ</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.bigBtn, { backgroundColor: DANGER_RED }]} onPress={handleNotInterested}>
            <Ionicons name="thumbs-down" size={28} color="#fff" />
            <Text style={styles.bigBtnText}>नहीं</Text>
          </TouchableOpacity>
        </View>
      </BottomModal>

      {/* STEP 3: Tentative date */}
      <BottomModal visible={popupStep === 'TENTATIVE_DATE'}>
        <View style={styles.popupHandle} />
        <Text style={styles.popupEmoji}>📅</Text>
        <Text style={styles.popupTitle}>संभावित तारीख</Text>
        <Text style={styles.popupSub}>डिलीवरी कब चाहिए? (वैकल्पिक)</Text>
        <TextInput
          style={styles.popupInput}
          placeholder="YYYY-MM-DD (जैसे 2025-07-15)"
          value={tempDate}
          onChangeText={setTempDate}
          keyboardType="numeric"
          maxLength={10}
          placeholderTextColor="#bbb"
        />
        <Text style={styles.inputHint}>खाली छोड़ने पर स्वचालित रूप से +7 दिन सेट होगा</Text>
        <TouchableOpacity style={styles.popupBtn} onPress={handleDateConfirm}>
          <Text style={styles.popupBtnText}>आगे बढ़ें →</Text>
        </TouchableOpacity>
      </BottomModal>

      {/* STEP 4: Remarks */}
      <BottomModal visible={popupStep === 'REMARKS'}>
        <View style={styles.popupHandle} />
        <Text style={styles.popupEmoji}>📝</Text>
        <Text style={styles.popupTitle}>कोई टिप्पणी?</Text>
        <Text style={styles.popupSub}>{currentRecord?.consumer_name}</Text>
        <TextInput
          style={[styles.popupInput, styles.popupInputMulti]}
          placeholder="टिप्पणी लिखें... (वैकल्पिक)"
          value={tempRemarks}
          onChangeText={t => setTempRemarks(t.toUpperCase())}
          multiline numberOfLines={4}
          textAlignVertical="top"
          autoCorrect={false}
          placeholderTextColor="#bbb"
        />
        <TouchableOpacity style={[styles.popupBtn, { backgroundColor: SUCCESS_GREEN }]} onPress={handleRemarksConfirm}>
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="save" size={18} color="#fff" /><Text style={styles.popupBtnText}>सहेजें</Text></>
          }
        </TouchableOpacity>
      </BottomModal>

    </View>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function BottomModal({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>{children}</View>
      </View>
    </Modal>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryKey}>{label}</Text>
      <Text style={styles.summaryVal}>{value}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f4f8' },
  header: {
    backgroundColor: BPCL_BLUE, paddingTop: 60, paddingBottom: 20,
    paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
  uploadBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, gap: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
  },
  uploadBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  statsBar: { backgroundColor: '#fff', flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#eee' },
  statItem: { flex: 1, alignItems: 'center' },
  statNum: { fontSize: 18, fontWeight: '800', color: BPCL_BLUE },
  statLabel: { fontSize: 10, color: '#999', fontWeight: '600', marginTop: 1 },
  statDivider: { width: 1, backgroundColor: '#eee', marginVertical: 4 },
  progressTrack: { height: 4, backgroundColor: '#e0e0e0' },
  progressFill: { height: 4, backgroundColor: SUCCESS_GREEN },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40, gap: 12 },
  emptyIconWrap: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#e8f4fd', justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  emptySubtitle: { fontSize: 13, color: '#888', textAlign: 'center', lineHeight: 20 },
  emptyUploadBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: BPCL_BLUE,
    paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, gap: 8, marginTop: 8,
    elevation: 3, shadowColor: BPCL_BLUE, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
  },
  scroll: { flex: 1 },
  navRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  navBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, gap: 4, elevation: 1, borderWidth: 1, borderColor: '#e0e0e0' },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { fontSize: 13, fontWeight: '600', color: BPCL_BLUE },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ccc' },
  dotActive: { backgroundColor: BPCL_BLUE, width: 12, height: 12, borderRadius: 6 },
  dotSaved: { backgroundColor: SUCCESS_GREEN },
  card: { backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 12, padding: 18, borderRadius: 16, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  cardSaved: { borderWidth: 2, borderColor: SUCCESS_GREEN },
  savedBadge: { position: 'absolute', top: 14, right: 14, backgroundColor: SUCCESS_GREEN, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, gap: 4, zIndex: 1 },
  savedBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: BPCL_BLUE, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  consumerName: { fontSize: 17, fontWeight: '700', color: '#1a1a1a' },
  consumerId: { fontSize: 11, color: '#aaa', marginTop: 2 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  infoText: { flex: 1, fontSize: 13, color: '#555', lineHeight: 18 },
  mobileRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, marginTop: 4 },
  mobileText: { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  callBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: SUCCESS_GREEN, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12, gap: 7, elevation: 3, shadowColor: SUCCESS_GREEN, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 5 },
  callBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  summaryCard: { backgroundColor: '#f0f8ff', marginHorizontal: 12, marginBottom: 12, padding: 16, borderRadius: 14, borderWidth: 1.5, borderColor: '#c8e6f8' },
  summaryTitle: { fontSize: 13, fontWeight: '700', color: BPCL_BLUE, marginBottom: 10 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#ddeefa' },
  summaryKey: { fontSize: 12, color: '#888' },
  summaryVal: { fontSize: 12, fontWeight: '700', color: '#333', maxWidth: '60%', textAlign: 'right' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 44, elevation: 20 },
  popupHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#ddd', alignSelf: 'center', marginBottom: 16 },
  popupEmoji: { fontSize: 36, textAlign: 'center', marginBottom: 8 },
  popupTitle: { fontSize: 20, fontWeight: '800', color: '#1a1a1a', textAlign: 'center', marginBottom: 4 },
  popupSub: { fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 20 },
  reasonList: { gap: 6, marginBottom: 20 },
  reasonItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderRadius: 10, backgroundColor: '#f8f9fa', borderWidth: 1.5, borderColor: '#eee' },
  reasonItemActive: { backgroundColor: '#e8f4fd', borderColor: BPCL_BLUE },
  reasonText: { fontSize: 14, color: '#555', fontWeight: '500' },
  reasonTextActive: { color: BPCL_BLUE, fontWeight: '700' },
  bigBtnRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  bigBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 20, borderRadius: 16, gap: 8, elevation: 3, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 5 },
  bigBtnText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  optionList: { gap: 10, marginBottom: 8 },
  optionBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff8f0', borderWidth: 1.5, borderColor: '#ffe0b0', padding: 16, borderRadius: 12, gap: 12 },
  optionBtnText: { flex: 1, fontSize: 15, fontWeight: '600', color: '#444' },
  popupInput: { backgroundColor: '#f8f9fa', borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 12, padding: 14, fontSize: 15, color: '#333', marginBottom: 8 },
  popupInputMulti: { minHeight: 100, textAlignVertical: 'top' },
  inputHint: { fontSize: 11, color: '#bbb', marginBottom: 16, textAlign: 'center' },
  popupBtn: { backgroundColor: BPCL_BLUE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16, borderRadius: 14, gap: 8, marginTop: 4, elevation: 3, shadowColor: BPCL_BLUE, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6 },
  popupBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
