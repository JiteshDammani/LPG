import React, { useState, useEffect, useRef } from 'react';
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
import { useDataStore } from '@/store/dataStore';
import { Ionicons } from '@expo/vector-icons';

// Import Supabase and notification utilities
import { supabase } from '@/lib/supabase';
import { registerForPushNotificationsAsync } from '@/utils/notifications';

const BPCL_BLUE = '#017DC5';

const COMPLAINT_TYPES = [
  { value: 'REFILL_DELAY', label: 'Refill Delay', icon: '⏰' },
  { value: 'GAS_LEAKAGE', label: 'Gas Leakage / Safety Issue', icon: '⚠️' },
  { value: 'OVERCHARGING', label: 'Overcharging', icon: '💰' },
  { value: 'STAFF_BEHAVIOR', label: 'Staff Behavior', icon: '👤' },
  { value: 'OTHER', label: 'Other Issues', icon: '📝' },
];

export default function ComplaintRegisterScreen() {
  const {
    activeConsumers = [],
    searchActiveConsumers,
    loadingConsumers = false,
    addActiveConsumer,
    addComplaint,
  } = useDataStore() as any;

  // Search & Selector states
  const [consumerSearch, setCustomerSearch] = useState<string>('');
  const [consumerDropdownOpen, setConsumerDropdownOpen] = useState(false);
  const [selectedConsumer, setSelectedConsumer] = useState<any>(null);

  // Editable consumer details states
  const [origName, setOrigName] = useState<string>('');
  const [origMobile, setOrigMobile] = useState<string>('');
  const [origAddress, setOrigAddress] = useState<string>('');
  const [origConsumerNo, setOrigConsumerNo] = useState<string>('');

  const [editName, setEditName] = useState<string>('');
  const [editMobile, setEditMobile] = useState<string>('');
  const [editAddress, setEditAddress] = useState<string>('');
  const [editConsumerNo, setEditConsumerNo] = useState<string>('');

  // Complaint form states
  const [complaintType, setComplaintType] = useState<string>('');
  const [complaintTypeDropdownOpen, setComplaintTypeDropdownOpen] = useState(false);
  const [deliveryBoyName, setDeliveryBoyName] = useState<string>('');

  // Custom user remarks & system auto-remarks
  const [userRemarks, setUserRemarks] = useState<string>('');
  const [autoRemarks, setAutoRemarks] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);

  // Debounce timeout ref for server-side search
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial alphabetical list of 50 consumers on mount
  useEffect(() => {
    if (searchActiveConsumers) {
      searchActiveConsumers('');
    }
  }, []);

  // Monitor edits on existing fields to generate the remarks text automatically
  useEffect(() => {
    if (!selectedConsumer || selectedConsumer.isNew) {
      setAutoRemarks('');
      return;
    }

    const changes: string[] = [];
    if (editName.trim() !== origName.trim()) {
      changes.push(`Name changed from "${origName}" to "${editName}"`);
    }
    if (editMobile.trim() !== origMobile.trim()) {
      changes.push(`Mobile changed from "${origMobile}" to "${editMobile}"`);
    }
    if (editAddress.trim() !== origAddress.trim()) {
      changes.push(`Address changed from "${origAddress}" to "${editAddress}"`);
    }

    setAutoRemarks(changes.join(', '));
  }, [editName, editMobile, editAddress, origName, origMobile, origAddress, selectedConsumer]);

  // Handle typing inside the search input (Debounced to prevent excessive API calls)
  const handleSearchChange = (text: string) => {
    setCustomerSearch(text);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Debounce the fetch by 400ms to allow smooth typing
    searchTimeoutRef.current = setTimeout(() => {
      if (searchActiveConsumers) {
        searchActiveConsumers(text);
      }
    }, 400);
  };

  const handleConsumerSelect = (consumer: any) => {
    setSelectedConsumer(consumer);

    const initialName = consumer.consumer_name || '';
    const initialMobile = consumer.mobile_number ? consumer.mobile_number.toString() : '';
    const initialAddress = consumer.address || '';
    const initialConsumerNo = consumer.consumer ? consumer.consumer.toString() : '';

    setOrigName(initialName);
    setOrigMobile(initialMobile);
    setOrigAddress(initialAddress);
    setOrigConsumerNo(initialConsumerNo);

    // Initialize editable states
    setEditName(initialName);
    setEditMobile(initialMobile);
    setEditAddress(initialAddress);
    setEditConsumerNo(initialConsumerNo);

    setConsumerDropdownOpen(false);
    setCustomerSearch('');
    // Reset initial load state for subsequent uses
    if (searchActiveConsumers) {
      searchActiveConsumers('');
    }
  };

  const handleClearSelection = () => {
    setSelectedConsumer(null);
    setOrigName('');
    setOrigMobile('');
    setOrigAddress('');
    setOrigConsumerNo('');
    setEditName('');
    setEditMobile('');
    setEditAddress('');
    setEditConsumerNo('');
    setAutoRemarks('');
    if (searchActiveConsumers) {
      searchActiveConsumers('');
    }
  };

  const handleCreateNewConsumerOnTheFly = () => {
    const query = consumerSearch.trim();
    const isNumeric = /^\d+$/.test(query);

    const newDraftConsumer = {
      id: 'new-' + Date.now(),
      consumer: isNumeric && query.length < 10 ? parseInt(query, 10) : Math.floor(100000 + Math.random() * 900000),
      consumer_name: !isNumeric ? query : 'New Consumer',
      mobile_number: isNumeric && query.length >= 10 ? parseInt(query, 10) : 0,
      address: '',
      LPG_id: 0,
      no_of_cylinders: 1,
      isNew: true
    };

    handleConsumerSelect(newDraftConsumer);
  };

  const handleComplaintTypeSelect = (typeValue: string) => {
    setComplaintType(typeValue);
    setComplaintTypeDropdownOpen(false);
    if (typeValue !== 'REFILL_DELAY') {
      setDeliveryBoyName('');
    }
  };

  // Helper function to send the HTTP Post request directly to Expo's Push Gateway to ALL registered devices
  const triggerPushNotification = async (title: string, body: string) => {
    try {
      // 1. Fetch all registered push tokens from Supabase
      const { data, error } = await supabase
        .from('device_tokens')
        .select('token');

      if (error) {
        console.error('Error fetching device tokens from Supabase:', error);
        return;
      }

      if (!data || data.length === 0) {
        console.log('No registered devices found to notify.');
        return;
      }

      const allTokens = data.map((item: any) => item.token);
      console.log(`Broadcasting to ${allTokens.length} devices:`, allTokens);

      // 2. Broadcast to all tokens (Expo accepts an array of strings in the 'to' field)
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: allTokens, // <--- Array of all active device tokens
          title: title,
          body: body,
          sound: 'default',
          priority: 'high',
        }),
      });
      console.log('Push notification broadcasted successfully!');
    } catch (error) {
      console.error('Failed to trigger broadcast push notification API call:', error);
    }
  };

  const handleSubmit = async () => {
    if (!selectedConsumer) {
      Alert.alert('Error', 'Please select or add a consumer');
      return;
    }

    if (!editConsumerNo.trim()) {
      Alert.alert('Error', 'Consumer Number/ID is required');
      return;
    }

    if (!complaintType) {
      Alert.alert('Error', 'Please select a complaint type');
      return;
    }

    if (complaintType === 'REFILL_DELAY' && !deliveryBoyName.trim()) {
      Alert.alert('Error', 'Please enter the delivery boy name');
      return;
    }

    setSubmitting(true);
    try {
      let finalConsumerNo = parseInt(editConsumerNo.trim(), 10);

      // Step 1: If new, insert into 'dashboard_activeconsumer' first
      if (selectedConsumer.isNew) {
        if (!addActiveConsumer) {
          throw new Error('addActiveConsumer is missing from your data store implementation.');
        }

        await addActiveConsumer({
          consumer: finalConsumerNo,
          consumer_name: editName.trim() || 'New Consumer',
          mobile_number: parseInt(editMobile.trim(), 10) || 0,
          address: editAddress.trim(),
          LPG_id: 0,
          no_of_cylinders: 1,
        });
      }

      // Step 2: Insert into 'dashboard_complaintregister'
      const finalRemarks = [autoRemarks, userRemarks].filter(Boolean).join(' | ');

      const payload = {
        consumer_id: finalConsumerNo,
        complaint_type: COMPLAINT_TYPES.find(c => c.value === complaintType)?.label || complaintType,
        delivery_boy_name: complaintType === 'REFILL_DELAY' ? deliveryBoyName.trim() : null,
        remarks: finalRemarks || null,
        resolved: false,
      };

      await addComplaint(payload);

      // Step 3: Trigger the push notification
      let pushTitle = 'Complaint Registered Successfully';
      let pushBody = `Complaint Type: ${payload.complaint_type} has been successfully filed for Consumer ID ${finalConsumerNo}.`;

      // If Gas Leakage/Safety Issue is selected, construct the detailed emergency layout
      if (complaintType === 'GAS_LEAKAGE') {
        pushTitle = '⚠️ EMERGENCY: Gas Leakage Reported!';
        pushBody = `Consumer: ${editName.trim() || 'N/A'}\nMobile: ${editMobile.trim() || 'N/A'}\nAddress: ${editAddress.trim() || 'N/A'}`;
      }

      // Execute push dispatch in background
      triggerPushNotification(pushTitle, pushBody);

      Alert.alert('Success', 'Complaint registered successfully.');
      resetForm();
    } catch (error: any) {
      Alert.alert('Database Error', error.message || 'Failed to save record');
      console.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setSelectedConsumer(null);
    setComplaintType('');
    setDeliveryBoyName('');
    setUserRemarks('');
    setAutoRemarks('');
    setCustomerSearch('');
    setOrigName('');
    setOrigMobile('');
    setOrigAddress('');
    setOrigConsumerNo('');
    setEditName('');
    setEditMobile('');
    setEditAddress('');
    setEditConsumerNo('');
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Complaint Management</Text>
          <Text style={styles.headerSubtitle}>File consumer grievances & track modifications</Text>
        </View>

        {/* Consumer Search Dropdown */}
        <View style={styles.card}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Select Consumer *</Text>
            <Text style={styles.totalCountLabel}>Searching live database</Text>
          </View>

          <TouchableOpacity
            style={styles.dropdownButton}
            onPress={() => {
              setConsumerDropdownOpen(!consumerDropdownOpen);
              setCustomerSearch('');
              if (searchActiveConsumers) {
                searchActiveConsumers(''); // reset to top 50
              }
            }}
          >
            <Text style={[styles.dropdownButtonText, !selectedConsumer && styles.dropdownPlaceholder]}>
              {selectedConsumer
                ? `${selectedConsumer.consumer_name} (${selectedConsumer.consumer})`
                : 'Search by ID, Name, or Mobile...'}
            </Text>
            <Ionicons name={consumerDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
          </TouchableOpacity>

          {consumerDropdownOpen && (
            <View style={styles.dropdownList}>
              <View style={styles.searchHeader}>
                <Text style={styles.resultsCountText}>
                  {loadingConsumers ? 'Searching...' : `Found ${activeConsumers.length} matches`}
                </Text>
              </View>

              <TextInput
                style={styles.dropdownSearch}
                placeholder="Type Name, Consumer ID, or Mobile..."
                value={consumerSearch}
                onChangeText={handleSearchChange}
                autoCorrect={false}
              />
              <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {loadingConsumers ? (
                  <ActivityIndicator color={BPCL_BLUE} style={{ padding: 20 }} />
                ) : activeConsumers.length === 0 ? (
                  <View style={styles.noResultsBox}>
                    <Text style={styles.noResultsText}>No consumers found.</Text>
                    {consumerSearch.trim().length > 0 && (
                      <TouchableOpacity
                        style={styles.addInlineButton}
                        onPress={handleCreateNewConsumerOnTheFly}
                      >
                        <Ionicons name="person-add-outline" size={16} color="#fff" />
                        <Text style={styles.addInlineButtonText}>
                          Add &#34;{consumerSearch}&#34; as New Consumer
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ) : (
                  activeConsumers.map((item: any) => (
                    <TouchableOpacity
                      key={item.id}
                      style={[
                        styles.dropdownItem,
                        selectedConsumer?.id === item.id && styles.dropdownItemSelected
                      ]}
                      onPress={() => handleConsumerSelect(item)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[
                          styles.dropdownItemText,
                          selectedConsumer?.id === item.id && styles.dropdownItemTextSelected
                        ]}>
                          {item.consumer_name}
                        </Text>
                        <Text style={[
                          styles.subText,
                          selectedConsumer?.id === item.id && { color: 'rgba(255,255,255,0.8)' }
                        ]}>
                          ID: {item.consumer} | Mob: {item.mobile_number}
                        </Text>
                      </View>
                      {selectedConsumer?.id === item.id && (
                        <Ionicons name="checkmark" size={16} color="#fff" />
                      )}
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
          )}
        </View>

        {/* Selected Consumer Details Display Panel (EDITABLE) */}
        {selectedConsumer && (
          <View style={[styles.card, selectedConsumer.isNew ? styles.newConsumerCard : styles.infoCard]}>
            <View style={styles.infoTitleRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                <Ionicons
                  name={selectedConsumer.isNew ? "person-add" : "create-outline"}
                  size={24}
                  color={selectedConsumer.isNew ? '#9a3412' : '#166534'}
                />
                <Text style={[styles.infoCardTitle, selectedConsumer.isNew && { color: '#9a3412' }]}>
                  {selectedConsumer.isNew ? 'New Consumer Details (LPG ID: 0)' : 'Edit details if necessary'}
                </Text>
              </View>

              <TouchableOpacity style={styles.clearBadgeBtn} onPress={handleClearSelection}>
                <Ionicons name="close-circle" size={20} color="#dc2626" />
                <Text style={styles.clearBadgeText}>Clear</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.infoDivider, selectedConsumer.isNew && { backgroundColor: '#fed7aa' }]} />

            {/* Consumer ID Input */}
            <View style={styles.inputRow}>
              <Text style={[styles.editableFieldLabel, selectedConsumer.isNew && { color: '#9a3412' }]}>
                Consumer ID (No.) *
              </Text>
              <TextInput
                style={[styles.editableInput, selectedConsumer.isNew && { borderColor: '#fdba74', color: '#9a3412' }]}
                value={editConsumerNo}
                onChangeText={setEditConsumerNo}
                keyboardType="numeric"
                placeholder="Enter unique ID number"
              />
            </View>

            {/* Name Input */}
            <View style={styles.inputRow}>
              <Text style={[styles.editableFieldLabel, selectedConsumer.isNew && { color: '#9a3412' }]}>
                Consumer Name
              </Text>
              <TextInput
                style={[styles.editableInput, selectedConsumer.isNew && { borderColor: '#fdba74', color: '#9a3412' }]}
                value={editName}
                onChangeText={setEditName}
                placeholder="Enter full name"
              />
            </View>

            {/* Mobile Input */}
            <View style={styles.inputRow}>
              <Text style={[styles.editableFieldLabel, selectedConsumer.isNew && { color: '#9a3412' }]}>
                Mobile Number
              </Text>
              <TextInput
                style={[styles.editableInput, selectedConsumer.isNew && { borderColor: '#fdba74', color: '#9a3412' }]}
                value={editMobile}
                onChangeText={setEditMobile}
                keyboardType="numeric"
                placeholder="Enter 10 digit number"
              />
            </View>

            {/* Address Input */}
            <View style={[styles.inputRow, { flexDirection: 'column', alignItems: 'stretch' }]}>
              <Text style={[styles.editableFieldLabel, { marginBottom: 4 }, selectedConsumer.isNew && { color: '#9a3412' }]}>
                Address
              </Text>
              <TextInput
                style={[styles.editableInput, { textAlign: 'left', minHeight: 60 }, selectedConsumer.isNew && { borderColor: '#fdba74', color: '#9a3412' }]}
                value={editAddress}
                onChangeText={setEditAddress}
                multiline
                placeholder="Enter postal address"
              />
            </View>
          </View>
        )}

        {/* Complaint Fields */}
        <View style={styles.card}>
          <Text style={styles.label}>Type of Complaint *</Text>
          <TouchableOpacity
            style={styles.dropdownButton}
            onPress={() => setComplaintTypeDropdownOpen(!complaintTypeDropdownOpen)}
          >
            <Text style={[styles.dropdownButtonText, !complaintType && styles.dropdownPlaceholder]}>
              {complaintType
                ? COMPLAINT_TYPES.find(c => c.value === complaintType)?.label
                : 'Select complaint category...'}
            </Text>
            <Ionicons name={complaintTypeDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
          </TouchableOpacity>

          {complaintTypeDropdownOpen && (
            <View style={styles.dropdownList}>
              <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {COMPLAINT_TYPES.map((item) => (
                  <TouchableOpacity
                    key={item.value}
                    style={[
                      styles.dropdownItem,
                      complaintType === item.value && styles.dropdownItemSelected
                    ]}
                    onPress={() => handleComplaintTypeSelect(item.value)}
                  >
                    <Text style={{ fontSize: 18, marginRight: 10 }}>{item.icon}</Text>
                    <Text style={[
                      styles.dropdownItemText,
                      complaintType === item.value && styles.dropdownItemTextSelected
                    ]}>
                      {item.label}
                    </Text>
                    {complaintType === item.value && (
                      <Ionicons name="checkmark" size={16} color="#fff" />
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Conditional Delivery Boy Input Box */}
          {complaintType === 'REFILL_DELAY' && (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.label}>Delivery Boy Name *</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Enter delivery boy name to attend"
                value={deliveryBoyName}
                onChangeText={setDeliveryBoyName}
              />
            </View>
          )}

          {/* Auto Generated Change log (Read-only reference) */}
          {autoRemarks.length > 0 && (
            <View style={styles.autoRemarksContainer}>
              <Ionicons name="git-branch-outline" size={16} color="#92400e" />
              <Text style={styles.autoRemarksText}>
                <Text style={{ fontWeight: 'bold' }}>Auto Change Note: </Text>
                {autoRemarks}
              </Text>
            </View>
          )}

          {/* Optional Remarks Input Box */}
          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Remarks / Additional Details</Text>
            <TextInput
              style={[styles.textInput, styles.textArea]}
              placeholder="Provide context or complaint summary..."
              value={userRemarks}
              onChangeText={setUserRemarks}
              multiline
              numberOfLines={3}
            />
          </View>
        </View>

        {/* Submit Button */}
        <TouchableOpacity
          style={[
            styles.submitButton,
            (!selectedConsumer || !complaintType) && styles.submitButtonDisabled
          ]}
          onPress={handleSubmit}
          disabled={submitting || !selectedConsumer || !complaintType}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="warning-outline" size={22} color="#fff" />
              <Text style={styles.submitButtonText}>REGISTER COMPLAINT</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  scrollView: { flex: 1 },

  header: {
    backgroundColor: BPCL_BLUE,
    padding: 20,
    paddingTop: 60,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerSubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
    marginTop: 4,
  },

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

  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  totalCountLabel: {
    fontSize: 11,
    color: '#666',
    fontWeight: '600',
  },

  infoCard: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
    borderWidth: 1,
  },
  newConsumerCard: {
    backgroundColor: '#fff7ed',
    borderColor: '#fed7aa',
    borderWidth: 1,
  },
  infoTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  infoCardTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#166534',
    flex: 1,
  },
  clearBadgeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#fee2e2',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 16,
    borderColor: '#fca5a5',
    borderWidth: 1,
  },
  clearBadgeText: {
    fontSize: 11,
    color: '#b91c1c',
    fontWeight: '700',
  },
  infoDivider: {
    height: 1,
    backgroundColor: '#dcfce7',
    marginBottom: 12,
  },

  inputRow: {
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  editableFieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#14532d',
    width: 130,
  },
  editableInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#166534',
    textAlign: 'right',
  },

  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },

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
  dropdownButtonText: {
    fontSize: 15,
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
    borderRadius: 8,
    marginTop: 4,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  searchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  resultsCountText: {
    fontSize: 11,
    color: '#888',
    fontWeight: '600',
  },
  dropdownSearch: {
    padding: 10,
    fontSize: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#f8f9fa',
    marginTop: 4,
  },
  dropdownItem: {
    padding: 12,
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
    fontSize: 14,
    color: '#333',
  },
  dropdownItemTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  subText: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  noResultsBox: {
    alignItems: 'center',
    padding: 20,
  },
  noResultsText: {
    textAlign: 'center',
    color: '#666',
    fontSize: 13,
    marginBottom: 10,
  },
  addInlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: BPCL_BLUE,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  addInlineButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 13,
  },

  textInput: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#333',
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },

  autoRemarksContainer: {
    marginTop: 12,
    backgroundColor: '#fef3c7',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fde68a',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  autoRemarksText: {
    fontSize: 12,
    color: '#92400e',
    flex: 1,
  },

  submitButton: {
    backgroundColor: '#dc2626',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    elevation: 3,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});