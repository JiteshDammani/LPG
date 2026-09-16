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
import { supabase } from '../../lib/supabase';

const BPCL_BLUE   = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

// ─── Types ──────────────────────────────────────────────────────────────────
// NOTE: Adjust 'id' / 'name' below if your dashboard_customername columns differ.

interface Customer {
  id: number;
  name: string;
}

interface ContactRow {
  id: string;
  customer_id: number;
  mobile: string;
  label: string;
  is_primary: boolean;
}

const LABEL_OPTIONS = ['Primary', 'Alternate', 'Shop', 'WhatsApp', 'Other'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidMobile(v: string) {
  // Accepts 10-digit Indian mobile, with or without +91 / 91 prefix
  const cleaned = v.replace(/[\s-]/g, '');
  return /^(\+?91)?[6-9]\d{9}$/.test(cleaned);
}

function normalizeMobile(v: string) {
  // Store as plain 10-digit number (strip +91/91 prefix and spaces)
  const cleaned = v.replace(/[\s-]/g, '');
  return cleaned.replace(/^(\+?91)/, '');
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function CustomerMobileScreen() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  // ── Add/Edit number modal ──────────────────────────────────────────────
  const [modalVisible, setModalVisible] = useState(false);
  const [activeCustomer, setActiveCustomer] = useState<Customer | null>(null);
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [mobileInput, setMobileInput] = useState('');
  const [labelInput, setLabelInput] = useState('Primary');
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Load customers + their contacts ────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [custRes, contactRes] = await Promise.all([
        supabase.from('dashboard_customername').select('id, name').order('name', { ascending: true }),
        supabase.from('dashboard_customer_contacts').select('*'),
      ]);

      if (custRes.error) throw custRes.error;
      if (contactRes.error) throw contactRes.error;

      setCustomers(custRes.data || []);
      setContacts(contactRes.data || []);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Filtered customer list with their contact counts ───────────────────

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? customers.filter(c => c.name.toLowerCase().includes(q)) : customers;
    return list.map(c => ({
      ...c,
      numbers: contacts.filter(ct => ct.customer_id === c.id),
    }));
  }, [customers, contacts, search]);

  // ── Open add-number modal ──────────────────────────────────────────────

  const openAddModal = (customer: Customer) => {
    setActiveCustomer(customer);
    setEditingContact(null);
    setMobileInput('');
    const existing = contacts.filter(c => c.customer_id === customer.id);
    setLabelInput(existing.length === 0 ? 'Primary' : 'Alternate');
    setModalVisible(true);
  };

  const openEditModal = (customer: Customer, contact: ContactRow) => {
    setActiveCustomer(customer);
    setEditingContact(contact);
    setMobileInput(contact.mobile);
    setLabelInput(contact.label);
    setModalVisible(true);
  };

  // ── Save (insert or update) ─────────────────────────────────────────────

  const handleSave = async () => {
    if (!activeCustomer) return;
    if (!mobileInput.trim()) {
      Alert.alert('Missing number', 'Please enter a mobile number');
      return;
    }
    if (!isValidMobile(mobileInput.trim())) {
      Alert.alert('Invalid number', 'Please enter a valid 10-digit mobile number');
      return;
    }

    const normalized = normalizeMobile(mobileInput.trim());

    setSaving(true);
    try {
      if (editingContact) {
        const { error } = await supabase
          .from('dashboard_customer_contacts')
          .update({ mobile: normalized, label: labelInput })
          .eq('id', editingContact.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('dashboard_customer_contacts')
          .insert({
            customer_id: activeCustomer.id,
            mobile: normalized,
            label: labelInput,
            is_primary: labelInput === 'Primary',
          });
        if (error) {
          // Friendlier message for the unique constraint (same number added twice)
          if (error.code === '23505') {
            throw new Error('This number is already saved for this customer');
          }
          throw error;
        }
      }
      setModalVisible(false);
      loadData();
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || 'Could not save number');
    } finally {
      setSaving(false);
    }
  };

  // ── Delete a number ─────────────────────────────────────────────────────

  const handleDelete = (contact: ContactRow) => {
    Alert.alert('Remove number', `Remove ${contact.mobile} (${contact.label})?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            const { error } = await supabase
              .from('dashboard_customer_contacts')
              .delete()
              .eq('id', contact.id);
            if (error) throw error;
            loadData();
          } catch (err: any) {
            Alert.alert('Delete failed', err?.message || 'Could not remove number');
          }
        },
      },
    ]);
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Customer numbers</Text>
          <Text style={styles.headerSub}>
            {customers.length} customer{customers.length !== 1 ? 's' : ''} ·{' '}
            {contacts.length} number{contacts.length !== 1 ? 's' : ''} saved
          </Text>

          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color="rgba(255,255,255,0.7)" />
            <TextInput
              style={styles.searchInput}
              placeholder="Search customer name"
              placeholderTextColor="rgba(255,255,255,0.6)"
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')}>
                <Ionicons name="close-circle" size={16} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadData} tintColor={BPCL_BLUE} />
        }
      >
        {loading && customers.length === 0 ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={BPCL_BLUE} />
            <Text style={styles.loadingText}>Loading customers…</Text>
          </View>
        ) : filteredCustomers.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="people-outline" size={40} color="#ccc" />
            <Text style={styles.emptyText}>
              {search ? 'No customers match your search' : 'No customers found'}
            </Text>
          </View>
        ) : (
          filteredCustomers.map(customer => (
            <View key={customer.id} style={styles.customerCard}>
              <View style={styles.customerHeadRow}>
                <View style={styles.customerAvatar}>
                  <Text style={styles.customerAvatarText}>
                    {customer.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.customerName} numberOfLines={1}>{customer.name}</Text>
                <TouchableOpacity style={styles.addNumBtn} onPress={() => openAddModal(customer)}>
                  <Ionicons name="add" size={16} color={BPCL_BLUE} />
                  <Text style={styles.addNumBtnText}>Add</Text>
                </TouchableOpacity>
              </View>

              {customer.numbers.length === 0 ? (
                <Text style={styles.noNumbersText}>No mobile numbers added yet</Text>
              ) : (
                <View style={styles.numbersList}>
                  {customer.numbers.map(contact => (
                    <View key={contact.id} style={styles.numberRow}>
                      <View style={styles.numberLeft}>
                        <Ionicons
                          name={contact.label === 'WhatsApp' ? 'logo-whatsapp' : 'call-outline'}
                          size={15}
                          color={contact.label === 'WhatsApp' ? '#25D366' : '#888'}
                        />
                        <Text style={styles.numberText}>{contact.mobile}</Text>
                        <View style={styles.labelChip}>
                          <Text style={styles.labelChipText}>{contact.label}</Text>
                        </View>
                      </View>
                      <View style={styles.numberActions}>
                        <TouchableOpacity
                          style={styles.numberActionBtn}
                          onPress={() => openEditModal(customer, contact)}
                        >
                          <Ionicons name="pencil-outline" size={15} color="#888" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.numberActionBtn}
                          onPress={() => handleDelete(contact)}
                        >
                          <Ionicons name="trash-outline" size={15} color="#e74c3c" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))
        )}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ════════ ADD / EDIT NUMBER MODAL ════════ */}
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
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingContact ? 'Edit number' : 'Add number'}
                {activeCustomer ? ` · ${activeCustomer.name}` : ''}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close-circle" size={26} color="#aaa" />
              </TouchableOpacity>
            </View>

            <View style={styles.modalFieldWrap}>
              <Text style={styles.modalFieldLabel}>Mobile number</Text>
              <TextInput
                style={styles.modalTextInput}
                placeholder="e.g. 9876543210"
                keyboardType="phone-pad"
                value={mobileInput}
                onChangeText={setMobileInput}
                maxLength={13}
              />
            </View>

            <View style={styles.modalFieldWrap}>
              <Text style={styles.modalFieldLabel}>Label</Text>
              <TouchableOpacity style={styles.typeSelectBox} onPress={() => setShowLabelPicker(true)}>
                <Text style={styles.typeSelectText}>{labelInput}</Text>
                <Ionicons name="chevron-down" size={16} color="#999" />
              </TouchableOpacity>
            </View>

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
                    <Text style={styles.modalSubmitBtnText}>{editingContact ? 'Save changes' : 'Add number'}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ════════ LABEL PICKER MODAL ════════ */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={showLabelPicker}
        onRequestClose={() => setShowLabelPicker(false)}
      >
        <TouchableOpacity
          style={styles.typeModalOverlay}
          activeOpacity={1}
          onPress={() => setShowLabelPicker(false)}
        >
          <View style={styles.typeModalBox}>
            <Text style={styles.typeModalTitle}>Select label</Text>
            {LABEL_OPTIONS.map(l => (
              <TouchableOpacity
                key={l}
                style={styles.typeOption}
                onPress={() => { setLabelInput(l); setShowLabelPicker(false); }}
              >
                <Text style={styles.typeOptionText}>{l}</Text>
                {labelInput === l && <Ionicons name="checkmark" size={17} color={BPCL_BLUE} />}
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

  header:         { backgroundColor: BPCL_BLUE },
  headerContent:  { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 },
  headerTitle:    { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  headerSub:      { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },

  searchWrap:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 10, marginTop: 14, paddingHorizontal: 12, height: 40 },
  searchInput:    { flex: 1, fontSize: 14, color: '#fff' },

  scroll:         { flex: 1 },
  scrollContent:  { padding: 14 },
  loadingBox:     { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  loadingText:    { color: '#888', fontSize: 15 },
  emptyBox:       { alignItems: 'center', justifyContent: 'center', paddingTop: 70, gap: 10, paddingHorizontal: 30 },
  emptyText:      { color: '#999', fontSize: 14, textAlign: 'center' },

  customerCard:   { backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.09)', padding: 12, marginBottom: 10 },
  customerHeadRow:{ flexDirection: 'row', alignItems: 'center', gap: 10 },
  customerAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E6F1FB', alignItems: 'center', justifyContent: 'center' },
  customerAvatarText: { fontSize: 14, fontWeight: '700', color: BPCL_BLUE },
  customerName:   { flex: 1, fontSize: 15, fontWeight: '700', color: '#222' },
  addNumBtn:      { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EEF3FA', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 },
  addNumBtnText:  { fontSize: 12, fontWeight: '600', color: BPCL_BLUE },

  noNumbersText:  { fontSize: 12.5, color: '#aaa', marginTop: 10, marginLeft: 2 },
  numbersList:    { marginTop: 10, gap: 8 },
  numberRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', borderRadius: 9, paddingVertical: 9, paddingHorizontal: 11 },
  numberLeft:     { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  numberText:     { fontSize: 14, fontWeight: '600', color: '#333' },
  labelChip:      { backgroundColor: '#EEF3FA', borderRadius: 20, paddingHorizontal: 7, paddingVertical: 2 },
  labelChipText:  { fontSize: 10.5, fontWeight: '600', color: BPCL_BLUE },
  numberActions:  { flexDirection: 'row', gap: 2 },
  numberActionBtn:{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },

  modalOverlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContainer: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  modalHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle:     { fontSize: 15, fontWeight: 'bold', color: '#333', flex: 1, marginRight: 10 },

  modalFieldWrap: { marginBottom: 14, gap: 6 },
  modalFieldLabel:{ fontSize: 11, color: '#888', fontWeight: '600', textTransform: 'uppercase' },
  modalTextInput: { backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 8, padding: 10, fontSize: 14, color: '#333' },

  typeSelectBox:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f6f7fb', borderWidth: 1, borderColor: '#e1e2e6', borderRadius: 8, padding: 11 },
  typeSelectText: { fontSize: 14, color: '#333' },

  modalFooter:    { flexDirection: 'row', gap: 10, marginTop: 6 },
  modalCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fafafa' },
  modalCancelBtnText: { color: '#666', fontSize: 14, fontWeight: '600' },
  modalSubmitBtn: { flex: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 8, backgroundColor: BPCL_BLUE },
  modalSubmitBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },

  typeModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 30 },
  typeModalBox:   { backgroundColor: '#fff', borderRadius: 14, padding: 14, width: '100%', maxWidth: 320 },
  typeModalTitle: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', marginBottom: 8, paddingHorizontal: 6 },
  typeOption:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: '#eee' },
  typeOptionText: { fontSize: 14.5, color: '#333' },
});
