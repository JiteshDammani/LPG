import React, { useState, useCallback, useEffect, useMemo } from 'react';
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
import { format, differenceInCalendarDays, parseISO } from 'date-fns';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';

const BPCL_BLUE   = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

const STORAGE_BUCKET = 'documents';

type InnerTab = 'all' | 'expiring';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocRecord {
  id: string;
  doc_name: string;
  doc_type: string | null;
  remarks: string | null;
  file_path: string;
  file_name: string;
  file_ext: string;
  file_size_kb: number | null;
  expiry_date: string | null; // yyyy-MM-dd
  uploaded_by: string | null;
  created_at: string;
}

const DOC_TYPES = [
  'GST Certificate',
  'Partnership Deed',
  'Trade License',
  'Fire NOC',
  'Explosive License',
  'Insurance',
  'PAN Card',
  'Other',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function extOf(name: string) {
  const m = name.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function iconForExt(ext: string): keyof typeof Ionicons.glyphMap {
  if (ext === 'pdf') return 'document-text';
  if (['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(ext)) return 'image';
  if (['doc', 'docx'].includes(ext)) return 'document';
  return 'attach';
}

function colorForExt(ext: string) {
  if (ext === 'pdf') return { color: '#C0392B', bg: '#FBEAEA' };
  if (['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(ext)) return { color: '#1F8A70', bg: '#E7F5EF' };
  if (['doc', 'docx'].includes(ext)) return { color: '#185FA5', bg: '#E6F1FB' };
  return { color: '#7a7a7a', bg: '#F0F0F0' };
}

// Returns { label, color, bg } describing urgency of expiry
function expiryBadge(expiry: string | null): { label: string; color: string; bg: string } | null {
  if (!expiry) return null;
  const days = differenceInCalendarDays(parseISO(expiry), new Date());
  if (days < 0) return { label: 'Expired', color: '#fff', bg: '#C0392B' };
  if (days <= 7) return { label: `${days}d left`, color: '#fff', bg: '#E74C3C' };
  if (days <= 30) return { label: `${days}d left`, color: '#7a6100', bg: BPCL_YELLOW };
  return { label: format(parseISO(expiry), 'dd MMM yyyy'), color: '#27ae60', bg: '#E8F8EF' };
}

// ─── Reusable: Document card ───────────────────────────────────────────────

function DocCard({
  doc, onDownload, onEdit, onDelete, downloading,
}: {
  doc: DocRecord;
  onDownload: (doc: DocRecord) => void;
  onEdit: (doc: DocRecord) => void;
  onDelete: (doc: DocRecord) => void;
  downloading: boolean;
}) {
  const iconMeta = colorForExt(doc.file_ext);
  const badge = expiryBadge(doc.expiry_date);

  return (
    <View style={styles.docCard}>
      <View style={[styles.docIconBox, { backgroundColor: iconMeta.bg }]}>
        <Ionicons name={iconForExt(doc.file_ext)} size={20} color={iconMeta.color} />
      </View>

      <View style={styles.docInfo}>
        <View style={styles.docTitleRow}>
          <Text style={styles.docName} numberOfLines={1}>{doc.doc_name}</Text>
          {doc.doc_type ? (
            <View style={styles.docTypeChip}>
              <Text style={styles.docTypeChipText} numberOfLines={1}>{doc.doc_type}</Text>
            </View>
          ) : null}
        </View>

        {doc.remarks ? (
          <Text style={styles.docRemarks} numberOfLines={2}>{doc.remarks}</Text>
        ) : null}

        <View style={styles.docMetaRow}>
          <Text style={styles.docFileName} numberOfLines={1}>
            {doc.file_name}{doc.file_size_kb ? ` · ${Math.round(doc.file_size_kb)} KB` : ''}
          </Text>
        </View>

        <View style={styles.docFooterRow}>
          {badge ? (
            <View style={[styles.expiryBadge, { backgroundColor: badge.bg }]}>
              <Ionicons
                name={badge.label === 'Expired' ? 'alert-circle' : 'time-outline'}
                size={11}
                color={badge.color}
              />
              <Text style={[styles.expiryBadgeText, { color: badge.color }]}>{badge.label}</Text>
            </View>
          ) : (
            <View style={[styles.expiryBadge, { backgroundColor: '#F0F0F0' }]}>
              <Text style={[styles.expiryBadgeText, { color: '#999' }]}>No expiry</Text>
            </View>
          )}

          <View style={styles.docActions}>
            <TouchableOpacity style={styles.docActionBtn} onPress={() => onDownload(doc)} disabled={downloading}>
              {downloading
                ? <ActivityIndicator size="small" color={BPCL_BLUE} />
                : <Ionicons name="download-outline" size={18} color={BPCL_BLUE} />}
            </TouchableOpacity>
            <TouchableOpacity style={styles.docActionBtn} onPress={() => onEdit(doc)}>
              <Ionicons name="pencil-outline" size={17} color="#888" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.docActionBtn} onPress={() => onDelete(doc)}>
              <Ionicons name="trash-outline" size={17} color="#e74c3c" />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────

export default function DocumentsScreen() {
  const [innerTab, setInnerTab] = useState<InnerTab>('all');
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // ── Upload / Edit modal state ──────────────────────────────────────────
  const [modalVisible, setModalVisible] = useState(false);
  const [editingDoc, setEditingDoc] = useState<DocRecord | null>(null);
  const [pickedFile, setPickedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [docName, setDocName] = useState('');
  const [docType, setDocType] = useState('');
  const [remarks, setRemarks] = useState('');
  const [hasExpiry, setHasExpiry] = useState(false);
  const [expiryDate, setExpiryDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Load documents ─────────────────────────────────────────────────────

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('dashboard_documents')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setDocs(data || []);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  // ── Derived lists ──────────────────────────────────────────────────────

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(d =>
      d.doc_name.toLowerCase().includes(q) ||
      (d.doc_type || '').toLowerCase().includes(q) ||
      (d.remarks || '').toLowerCase().includes(q));
  }, [docs, search]);

  const expiringDocs = useMemo(() => {
    return docs
      .filter(d => !!d.expiry_date)
      .slice()
      .sort((a, b) => {
        // Soonest expiry first (expired items first of all, most overdue first)
        const da = differenceInCalendarDays(parseISO(a.expiry_date as string), new Date());
        const db = differenceInCalendarDays(parseISO(b.expiry_date as string), new Date());
        return da - db;
      });
  }, [docs]);

  // ── Open Upload modal (fresh) ──────────────────────────────────────────

  const openUploadModal = () => {
    setEditingDoc(null);
    setPickedFile(null);
    setDocName('');
    setDocType('');
    setRemarks('');
    setHasExpiry(false);
    setExpiryDate(format(new Date(), 'yyyy-MM-dd'));
    setModalVisible(true);
  };

  // ── Open Edit modal (metadata only — file isn't re-uploaded) ──────────

  const openEditModal = (doc: DocRecord) => {
    setEditingDoc(doc);
    setPickedFile(null);
    setDocName(doc.doc_name);
    setDocType(doc.doc_type || '');
    setRemarks(doc.remarks || '');
    setHasExpiry(!!doc.expiry_date);
    setExpiryDate(doc.expiry_date || format(new Date(), 'yyyy-MM-dd'));
    setModalVisible(true);
  };

  // ── Pick file from device ──────────────────────────────────────────────

  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      setPickedFile(asset);
      if (!docName) {
        // Pre-fill doc name from file name (without extension) as a convenience
        const base = asset.name.replace(/\.[a-zA-Z0-9]+$/, '');
        setDocName(base);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not pick file');
    }
  };

  // ── Save (upload new OR update metadata) ───────────────────────────────

  const handleSave = async () => {
    if (!docName.trim()) {
      Alert.alert('Missing info', 'Please enter a document name');
      return;
    }
    if (!editingDoc && !pickedFile) {
      Alert.alert('Missing file', 'Please choose a file to upload');
      return;
    }

    setSaving(true);
    try {
      if (editingDoc) {
        // Metadata-only update
        const { error } = await supabase
          .from('dashboard_documents')
          .update({
            doc_name: docName.trim(),
            doc_type: docType || null,
            remarks: remarks.trim() || null,
            expiry_date: hasExpiry ? expiryDate : null,
          })
          .eq('id', editingDoc.id);
        if (error) throw error;
      } else if (pickedFile) {
        // New upload: push file to Storage, then insert metadata row
        const ext = extOf(pickedFile.name);
        const safeBase = docName.trim().replace(/[^a-zA-Z0-9-_]+/g, '_');
        const filePath = `${Date.now()}_${safeBase}.${ext}`;

        const fileInfo = await FileSystem.getInfoAsync(pickedFile.uri);
        const sizeKb = fileInfo.exists && 'size' in fileInfo ? fileInfo.size / 1024 : null;

        // Read file as base64 then convert to ArrayBuffer for upload
        const base64 = await FileSystem.readAsStringAsync(pickedFile.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(filePath, binary, {
            contentType: pickedFile.mimeType || 'application/octet-stream',
            upsert: false,
          });
        if (uploadError) throw uploadError;

        const { error: insertError } = await supabase
          .from('dashboard_documents')
          .insert({
            doc_name: docName.trim(),
            doc_type: docType || null,
            remarks: remarks.trim() || null,
            file_path: filePath,
            file_name: pickedFile.name,
            file_ext: ext,
            file_size_kb: sizeKb,
            expiry_date: hasExpiry ? expiryDate : null,
          });
        if (insertError) throw insertError;
      }

      setModalVisible(false);
      loadDocs();
      Alert.alert('Success', editingDoc ? 'Document updated' : 'Document uploaded');
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || 'Could not save document');
    } finally {
      setSaving(false);
    }
  };

  // ── Download / open file ────────────────────────────────────────────────

  const handleDownload = async (doc: DocRecord) => {
    setDownloadingId(doc.id);
    try {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(doc.file_path, 60 * 5); // valid 5 minutes

      if (error || !data?.signedUrl) throw error || new Error('Could not get file URL');

      const localUri = `${FileSystem.cacheDirectory}${doc.file_name}`;
      const downloadRes = await FileSystem.downloadAsync(data.signedUrl, localUri);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(downloadRes.uri);
      } else {
        Alert.alert('Downloaded', `Saved to ${downloadRes.uri}`);
      }
    } catch (err: any) {
      Alert.alert('Download failed', err?.message || 'Could not download file');
    } finally {
      setDownloadingId(null);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────

  const handleDelete = (doc: DocRecord) => {
    Alert.alert('Delete document', `Remove "${doc.doc_name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await supabase.storage.from(STORAGE_BUCKET).remove([doc.file_path]);
            const { error } = await supabase.from('dashboard_documents').delete().eq('id', doc.id);
            if (error) throw error;
            loadDocs();
          } catch (err: any) {
            Alert.alert('Delete failed', err?.message || 'Could not delete document');
          }
        },
      },
    ]);
  };

  // ── Render ──────────────────────────────────────────────────────────────

  const expiringSoonCount = expiringDocs.filter(d => {
    const days = differenceInCalendarDays(parseISO(d.expiry_date as string), new Date());
    return days <= 30;
  }).length;

  const listToRender = innerTab === 'all' ? filteredDocs : expiringDocs;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Documents</Text>
              <Text style={styles.headerSub}>
                {docs.length} document{docs.length !== 1 ? 's' : ''} stored
                {expiringSoonCount > 0 ? ` · ${expiringSoonCount} expiring soon` : ''}
              </Text>
            </View>
            <TouchableOpacity style={styles.uploadFab} onPress={openUploadModal}>
              <Ionicons name="add" size={22} color={BPCL_BLUE} />
            </TouchableOpacity>
          </View>

          {/* Inner segmented control */}
          <View style={styles.segControl}>
            <TouchableOpacity
              style={[styles.segBtn, innerTab === 'all' && styles.segBtnActive]}
              onPress={() => setInnerTab('all')}
            >
              <Ionicons
                name="folder-outline"
                size={14}
                color={innerTab === 'all' ? BPCL_BLUE : 'rgba(255,255,255,0.7)'}
              />
              <Text style={[styles.segBtnText, innerTab === 'all' && styles.segBtnTextActive]}>
                All docs
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segBtn, innerTab === 'expiring' && styles.segBtnActive]}
              onPress={() => setInnerTab('expiring')}
            >
              <Ionicons
                name="alert-circle-outline"
                size={14}
                color={innerTab === 'expiring' ? BPCL_BLUE : 'rgba(255,255,255,0.7)'}
              />
              <Text style={[styles.segBtnText, innerTab === 'expiring' && styles.segBtnTextActive]}>
                Expiring soon
              </Text>
              {expiringSoonCount > 0 && (
                <View style={styles.tabCountBadge}>
                  <Text style={styles.tabCountBadgeText}>{expiringSoonCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {/* Search bar — only on All docs tab */}
      {innerTab === 'all' && (
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color="#999" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, type or remarks"
            value={search}
            onChangeText={setSearch}
            placeholderTextColor="#aaa"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={16} color="#bbb" />
            </TouchableOpacity>
          )}
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadDocs} tintColor={BPCL_BLUE} />
        }
      >
        {loading && docs.length === 0 ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={BPCL_BLUE} />
            <Text style={styles.loadingText}>Loading documents…</Text>
          </View>
        ) : listToRender.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons
              name={innerTab === 'all' ? 'folder-open-outline' : 'checkmark-circle-outline'}
              size={40}
              color="#ccc"
            />
            <Text style={styles.emptyText}>
              {innerTab === 'all'
                ? (search ? 'No documents match your search' : 'No documents uploaded yet')
                : 'No documents with an expiry date set'}
            </Text>
            {innerTab === 'all' && !search && (
              <TouchableOpacity style={styles.emptyUploadBtn} onPress={openUploadModal}>
                <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
                <Text style={styles.emptyUploadBtnText}>Upload first document</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          listToRender.map(doc => (
            <DocCard
              key={doc.id}
              doc={doc}
              onDownload={handleDownload}
              onEdit={openEditModal}
              onDelete={handleDelete}
              downloading={downloadingId === doc.id}
            />
          ))
        )}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ════════ UPLOAD / EDIT MODAL ════════ */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <ScrollView
            style={styles.modalContainer}
            contentContainerStyle={{ paddingBottom: 6 }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingDoc ? 'Edit document' : 'Upload document'}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close-circle" size={26} color="#aaa" />
              </TouchableOpacity>
            </View>

            {/* File picker — only when uploading new */}
            {!editingDoc && (
              <TouchableOpacity style={styles.filePickBox} onPress={handlePickFile}>
                {pickedFile ? (
                  <>
                    <Ionicons name={iconForExt(extOf(pickedFile.name))} size={26} color={BPCL_BLUE} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.filePickName} numberOfLines={1}>{pickedFile.name}</Text>
                      <Text style={styles.filePickHint}>Tap to change file</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <Ionicons name="cloud-upload-outline" size={26} color="#999" />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.filePickName}>Choose file to upload</Text>
                      <Text style={styles.filePickHint}>PDF, image, or Word document</Text>
                    </View>
                  </>
                )}
              </TouchableOpacity>
            )}

            {editingDoc && (
              <View style={styles.filePickBoxStatic}>
                <Ionicons name={iconForExt(editingDoc.file_ext)} size={26} color={BPCL_BLUE} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.filePickName} numberOfLines={1}>{editingDoc.file_name}</Text>
                  <Text style={styles.filePickHint}>File can't be replaced — delete &amp; re-upload instead</Text>
                </View>
              </View>
            )}

            {/* Doc name */}
            <View style={styles.modalFieldWrap}>
              <Text style={styles.modalFieldLabel}>Document name</Text>
              <TextInput
                style={styles.modalTextInput}
                placeholder="e.g. GST Certificate 2026"
                value={docName}
                onChangeText={setDocName}
              />
            </View>

            {/* Doc type picker */}
            <View style={styles.modalFieldWrap}>
              <Text style={styles.modalFieldLabel}>Document type</Text>
              <TouchableOpacity style={styles.typeSelectBox} onPress={() => setShowTypePicker(true)}>
                <Text style={[styles.typeSelectText, !docType && { color: '#aaa' }]}>
                  {docType || 'Select a type (optional)'}
                </Text>
                <Ionicons name="chevron-down" size={16} color="#999" />
              </TouchableOpacity>
            </View>

            {/* Remarks */}
            <View style={styles.modalFieldWrap}>
              <Text style={styles.modalFieldLabel}>Remarks</Text>
              <TextInput
                style={[styles.modalTextInput, { height: 70, textAlignVertical: 'top' }]}
                placeholder="Any notes about this document"
                value={remarks}
                onChangeText={setRemarks}
                multiline
              />
            </View>

            {/* Expiry toggle + date */}
            <View style={styles.modalFieldWrap}>
              <View style={styles.expiryToggleRow}>
                <Text style={styles.modalFieldLabel}>Has expiry date</Text>
                <TouchableOpacity
                  style={[styles.toggleTrack, hasExpiry && styles.toggleTrackOn]}
                  onPress={() => setHasExpiry(!hasExpiry)}
                >
                  <View style={[styles.toggleThumb, hasExpiry && styles.toggleThumbOn]} />
                </TouchableOpacity>
              </View>

              {hasExpiry && (
                <TouchableOpacity style={styles.typeSelectBox} onPress={() => setShowDatePicker(true)}>
                  <Ionicons name="calendar-outline" size={16} color={BPCL_BLUE} />
                  <Text style={[styles.typeSelectText, { marginLeft: 8 }]}>
                    {format(parseISO(expiryDate), 'dd MMM yyyy')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {showDatePicker && (
              <DateTimePicker
                value={parseISO(expiryDate)}
                mode="date"
                display="default"
                onChange={(evt, d) => {
                  setShowDatePicker(false);
                  if (evt.type === 'set' && d) setExpiryDate(format(d, 'yyyy-MM-dd'));
                }}
              />
            )}

            {/* Footer actions */}
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setModalVisible(false)}>
                <Text style={styles.modalCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, saving && { opacity: 0.6 }]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={16} color="#fff" />
                    <Text style={styles.modalSubmitBtnText}>{editingDoc ? 'Save changes' : 'Upload'}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ TYPE PICKER MODAL ════════ */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={showTypePicker}
        onRequestClose={() => setShowTypePicker(false)}
      >
        <TouchableOpacity
          style={styles.typeModalOverlay}
          activeOpacity={1}
          onPress={() => setShowTypePicker(false)}
        >
          <View style={styles.typeModalBox}>
            <Text style={styles.typeModalTitle}>Select document type</Text>
            {DOC_TYPES.map(t => (
              <TouchableOpacity
                key={t}
                style={styles.typeOption}
                onPress={() => { setDocType(t); setShowTypePicker(false); }}
              >
                <Text style={styles.typeOptionText}>{t}</Text>
                {docType === t && <Ionicons name="checkmark" size={17} color={BPCL_BLUE} />}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#f5f5f5' },

  // Header
  header:         { backgroundColor: BPCL_BLUE },
  headerContent:  { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 },
  headerTopRow:   { flexDirection: 'row', alignItems: 'flex-start' },
  headerTitle:    { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  headerSub:      { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  uploadFab:      { width: 38, height: 38, borderRadius: 19, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginLeft: 10 },

  // Segmented control
  segControl:     { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 10, padding: 3, marginTop: 14 },
  segBtn:         { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: 8 },
  segBtnActive:   { backgroundColor: '#fff' },
  segBtnText:     { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.75)' },
  segBtnTextActive:{ color: BPCL_BLUE },
  tabCountBadge:  { backgroundColor: '#E74C3C', borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, marginLeft: 2 },
  tabCountBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },

  // Search
  searchWrap:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 10, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.1)', marginHorizontal: 14, marginTop: 12, paddingHorizontal: 12, height: 40 },
  searchInput:    { flex: 1, fontSize: 14, color: '#333' },

  // Scroll
  scroll:         { flex: 1 },
  scrollContent:  { padding: 14 },
  loadingBox:     { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  loadingText:    { color: '#888', fontSize: 15 },
  emptyBox:       { alignItems: 'center', justifyContent: 'center', paddingTop: 70, gap: 10, paddingHorizontal: 30 },
  emptyText:      { color: '#999', fontSize: 14, textAlign: 'center' },
  emptyUploadBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: BPCL_BLUE, borderRadius: 9, paddingVertical: 10, paddingHorizontal: 16, marginTop: 8 },
  emptyUploadBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  // Document card
  docCard:        { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.09)', padding: 12, marginBottom: 10, gap: 10 },
  docIconBox:     { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  docInfo:        { flex: 1 },
  docTitleRow:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  docName:        { fontSize: 14.5, fontWeight: '700', color: '#222', flexShrink: 1 },
  docTypeChip:    { backgroundColor: '#EEF3FA', borderRadius: 20, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 110 },
  docTypeChipText:{ fontSize: 10, fontWeight: '600', color: BPCL_BLUE },
  docRemarks:     { fontSize: 12, color: '#888', marginTop: 3, lineHeight: 16 },
  docMetaRow:     { marginTop: 4 },
  docFileName:    { fontSize: 11, color: '#aaa' },
  docFooterRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  expiryBadge:    { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  expiryBadgeText:{ fontSize: 10.5, fontWeight: '700' },
  docActions:     { flexDirection: 'row', gap: 4 },
  docActionBtn:   { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },

  // Upload/Edit modal
  modalOverlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContainer: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, maxHeight: '88%' },
  modalHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle:     { fontSize: 16, fontWeight: 'bold', color: '#333' },

  filePickBox:    { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderStyle: 'dashed', borderRadius: 10, padding: 14, marginBottom: 14 },
  filePickBoxStatic: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 10, padding: 14, marginBottom: 14 },
  filePickName:   { fontSize: 13.5, fontWeight: '600', color: '#333' },
  filePickHint:   { fontSize: 11, color: '#999', marginTop: 2 },

  modalFieldWrap: { marginBottom: 14, gap: 6 },
  modalFieldLabel:{ fontSize: 11, color: '#888', fontWeight: '600', textTransform: 'uppercase' },
  modalTextInput: { backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 8, padding: 10, fontSize: 14, color: '#333' },

  typeSelectBox:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 8, padding: 11 },
  typeSelectText: { fontSize: 14, color: '#333' },

  expiryToggleRow:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  toggleTrack:    { width: 44, height: 26, borderRadius: 13, backgroundColor: '#ddd', padding: 2 },
  toggleTrackOn:  { backgroundColor: BPCL_BLUE },
  toggleThumb:    { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  toggleThumbOn:  { transform: [{ translateX: 18 }] },

  modalFooter:    { flexDirection: 'row', gap: 10, marginTop: 6 },
  modalCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fafafa' },
  modalCancelBtnText: { color: '#666', fontSize: 14, fontWeight: '600' },
  modalSubmitBtn: { flex: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 8, backgroundColor: BPCL_BLUE },
  modalSubmitBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },

  // Type picker modal
  typeModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 30 },
  typeModalBox:   { backgroundColor: '#fff', borderRadius: 14, padding: 14, width: '100%', maxWidth: 320 },
  typeModalTitle: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', marginBottom: 8, paddingHorizontal: 6 },
  typeOption:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: '#eee' },
  typeOptionText: { fontSize: 14.5, color: '#333' },
});
