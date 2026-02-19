import React, { useState, useRef, useMemo } from 'react';
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
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDataStore, ReconciliationReason } from '../../store/dataStore';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { format } from 'date-fns';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

export default function DeliveryScreen() {
  const { cylinderPrice, employees, addDelivery } = useDataStore();

  // Form state
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [cylindersDelivered, setCylindersDelivered] = useState('');
  const [emptyReceived, setEmptyReceived] = useState('');
  const [onlinePayments, setOnlinePayments] = useState('');
  const [paytmPayments, setPatmPayments] = useState('');
  const [partialDigital, setPartialDigital] = useState('');
  const [cashCollected, setCashCollected] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reconciliation state
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [reconciliationReasons, setReconciliationReasons] = useState<ReconciliationReason[]>([]);
  const [pendingDelivery, setPendingDelivery] = useState<any>(null);

  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['85%'], []);

  // Calculations
  const delivered = parseInt(cylindersDelivered) || 0;
  const online = parseInt(onlinePayments) || 0;
  const paytm = parseInt(paytmPayments) || 0;
  const cashCylinders = Math.max(0, delivered - online - paytm);
  const cashAmount = cashCylinders * cylinderPrice;
  const partial = parseFloat(partialDigital) || 0;
  const totalPayable = cashAmount - partial; // Subtract partial digital since it's already paid
  const cashCollectedAmount = parseFloat(cashCollected) || 0;
  const difference = cashCollectedAmount - totalPayable;

  const handleSubmit = async () => {
    try {
      if (isSubmitting) {
        console.log('Already submitting, please wait...');
        return;
      }
      
      console.log('Submit clicked');
      setIsSubmitting(true);
      
      // Validation
      if (!selectedEmployee) {
        Alert.alert('Error', 'Please select delivery staff');
        setIsSubmitting(false);
        return;
      }
      if (delivered === 0) {
        Alert.alert('Error', 'Please enter cylinders delivered');
        setIsSubmitting(false);
        return;
      }
      if (online + paytm > delivered) {
        Alert.alert('Error', 'Online + Paytm payments cannot exceed total cylinders delivered');
        setIsSubmitting(false);
        return;
      }

      const empty = parseInt(emptyReceived) || 0;
      const mismatch = delivered - empty;

      const deliveryData = {
        date: format(new Date(), 'yyyy-MM-dd'),
        employee_name: selectedEmployee,
        cylinders_delivered: delivered,
        empty_received: empty,
        online_payments: online,
        paytm_payments: paytm,
        partial_digital_amount: partial,
        cash_collected: parseFloat(cashCollected) || 0,
        calculated_cash_cylinders: cashCylinders,
        calculated_cash_amount: cashAmount,
        calculated_total_payable: totalPayable,
        reconciliation_status: mismatch === 0 ? 'complete' : 'pending',
        reconciliation_reasons: [],
      };

      console.log('Delivery data:', deliveryData);
      console.log('Mismatch:', mismatch);

      if (mismatch === 0) {
        // No mismatch, save directly
        console.log('Saving delivery (no reconciliation needed)...');
        await addDelivery(deliveryData);
        Alert.alert('Success', 'Delivery record saved successfully');
        resetForm();
        setIsSubmitting(false);
      } else {
        // Show reconciliation
        console.log('Showing reconciliation modal - mismatch detected');
        setPendingDelivery(deliveryData);
        setReconciliationReasons([]);
        setShowReconciliation(true);
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error('Error in handleSubmit:', error);
      Alert.alert('Error', 'Failed to save delivery: ' + (error?.message || 'Unknown error'));
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setSelectedEmployee('');
    setCylindersDelivered('');
    setEmptyReceived('');
    setOnlinePayments('');
    setPatmPayments('');
    setPartialDigital('');
    setCashCollected('');
  };

  const handleReconciliationComplete = async () => {
    try {
      console.log('Reconciliation complete clicked');
      const delivered = parseInt(cylindersDelivered) || 0;
      const empty = parseInt(emptyReceived) || 0;
      const mismatch = Math.abs(delivered - empty);

      console.log('Mismatch:', mismatch, 'Reasons provided:', reconciliationReasons.length);

      if (reconciliationReasons.length !== mismatch) {
        Alert.alert('Error', `Please provide exactly ${mismatch} reconciliation reasons`);
        return;
      }

      // Validate consumer names for NC, DBC, TV
      for (const reason of reconciliationReasons) {
        if (['NC', 'DBC', 'TV'].includes(reason.reason) && !reason.consumer_name) {
          Alert.alert('Error', `Consumer name required for ${reason.reason}`);
          return;
        }
      }

      const finalDelivery = {
        ...pendingDelivery,
        reconciliation_status: 'complete',
        reconciliation_reasons: reconciliationReasons,
      };

      console.log('Saving delivery with reconciliation:', finalDelivery);
      await addDelivery(finalDelivery);
      Alert.alert('Success', 'Delivery record saved with reconciliation');
      resetForm();
      setShowReconciliation(false);
      bottomSheetRef.current?.close();
    } catch (error) {
      console.error('Error in handleReconciliationComplete:', error);
      Alert.alert('Error', 'Failed to save delivery with reconciliation: ' + (error?.message || 'Unknown error'));
    }
  };

  const addReconciliationReason = () => {
    const delivered = parseInt(cylindersDelivered) || 0;
    const empty = parseInt(emptyReceived) || 0;
    const mismatch = Math.abs(delivered - empty);

    if (reconciliationReasons.length >= mismatch) {
      Alert.alert('Error', 'All cylinders have been reconciled');
      return;
    }

    setReconciliationReasons([
      ...reconciliationReasons,
      {
        type: delivered > empty ? 'missing' : 'extra',
        reason: 'NC',
        consumer_name: '',
      },
    ]);
  };

  const updateReconciliationReason = (index: number, field: string, value: string) => {
    const updated = [...reconciliationReasons];
    updated[index] = { ...updated[index], [field]: value };
    setReconciliationReasons(updated);
  };

  const removeReconciliationReason = (index: number) => {
    setReconciliationReasons(reconciliationReasons.filter((_, i) => i !== index));
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Delivery Entry New</Text>
          <Text style={styles.priceTag}>₹{cylinderPrice.toFixed(2)} per cylinder</Text>
        </View>

        {/* Employee Selection */}
        <View style={styles.section}>
          <Text style={styles.label}>Delivery Staff *</Text>
          <View style={styles.pickerContainer}>
            {employees.map((emp) => (
              <TouchableOpacity
                key={emp.id}
                style={[
                  styles.employeeChip,
                  selectedEmployee === emp.name && styles.employeeChipSelected,
                ]}
                onPress={() => setSelectedEmployee(emp.name)}
              >
                <Text
                  style={[
                    styles.employeeChipText,
                    selectedEmployee === emp.name && styles.employeeChipTextSelected,
                  ]}
                >
                  {emp.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Cylinder Delivery */}
        <View style={styles.section}>
          <Text style={styles.label}>Cylinders Delivered *</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter number"
            keyboardType="numeric"
            value={cylindersDelivered}
            onChangeText={setCylindersDelivered}
          />
        </View>

        {/* Empty Received */}
        <View style={styles.section}>
          <Text style={styles.label}>Empty Cylinders Received *</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter number"
            keyboardType="numeric"
            value={emptyReceived}
            onChangeText={setEmptyReceived}
          />
        </View>

        {/* Payment Details */}
        <View style={styles.paymentCard}>
          <Text style={styles.sectionTitle}>Payment Details</Text>

          <View style={styles.row}>
            <View style={styles.halfInput}>
              <Text style={styles.label}>Online Payments</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                keyboardType="numeric"
                value={onlinePayments}
                onChangeText={setOnlinePayments}
              />
            </View>
            <View style={styles.halfInput}>
              <Text style={styles.label}>Paytm Payments</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                keyboardType="numeric"
                value={paytmPayments}
                onChangeText={setPatmPayments}
              />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Partial Digital Amount (₹)</Text>
            <TextInput
              style={styles.input}
              placeholder="0.00"
              keyboardType="decimal-pad"
              value={partialDigital}
              onChangeText={setPartialDigital}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Cash Collected (₹)</Text>
            <TextInput
              style={styles.input}
              placeholder="0.00"
              keyboardType="decimal-pad"
              value={cashCollected}
              onChangeText={setCashCollected}
            />
          </View>
        </View>

        {/* Calculations */}
        <View style={styles.calculationCard}>
          <Text style={styles.sectionTitle}>Auto Calculations</Text>
          <View style={styles.calcRow}>
            <Text style={styles.calcLabel}>Cash Cylinders:</Text>
            <Text style={styles.calcValue}>{cashCylinders}</Text>
          </View>
          <View style={styles.calcRow}>
            <Text style={styles.calcLabel}>Cash Amount:</Text>
            <Text style={styles.calcValue}>₹{cashAmount.toFixed(2)}</Text>
          </View>
          <View style={styles.calcRow}>
            <Text style={styles.calcLabel}>Less: Partial Digital:</Text>
            <Text style={styles.calcValue}>₹{partial.toFixed(2)}</Text>
          </View>
          <View style={styles.calcRow}>
            <Text style={styles.calcLabel}>Expected Cash to Collect:</Text>
            <Text style={styles.calcValueLarge}>₹{totalPayable.toFixed(2)}</Text>
          </View>
          
          {cashCollectedAmount > 0 && (
            <>
              <View style={styles.divider} />
              <View style={styles.calcRow}>
                <Text style={styles.calcLabel}>Actual Cash Collected:</Text>
                <Text style={styles.calcValue}>₹{cashCollectedAmount.toFixed(2)}</Text>
              </View>
              <View style={styles.calcRow}>
                <Text style={styles.calcLabel}>Difference:</Text>
                <Text style={[
                  styles.calcValueLarge,
                  difference > 0 ? styles.calcValuePositive : 
                  difference < 0 ? styles.calcValueNegative : styles.calcValueNeutral
                ]}>
                  {difference >= 0 ? '+' : ''}₹{difference.toFixed(2)}
                </Text>
              </View>
              {difference !== 0 && (
                <Text style={styles.differenceNote}>
                  {difference > 0 ? '⚠️ Extra cash collected' : '⚠️ Short cash collected'}
                </Text>
              )}
            </>
          )}
        </View>

        {/* Submit Button */}
        <TouchableOpacity 
          style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]} 
          onPress={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.submitButtonText}>Saving...</Text>
            </>
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={24} color="#fff" />
              <Text style={styles.submitButtonText}>Save Delivery Record</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Reconciliation Bottom Sheet */}
      {showReconciliation && (
        <BottomSheet
          ref={bottomSheetRef}
          index={0}
          snapPoints={snapPoints}
          enablePanDownToClose={false}
          backgroundStyle={styles.bottomSheet}
        >
          <BottomSheetScrollView style={styles.sheetContent}>
            <View style={styles.sheetHeader}>
              <Ionicons name="warning" size={32} color={BPCL_YELLOW} />
              <Text style={styles.sheetTitle}>Reconciliation Required</Text>
              <Text style={styles.sheetSubtitle}>
                Empty cylinders mismatch detected. Please explain each cylinder.
              </Text>
            </View>

            <View style={styles.mismatchInfo}>
              <Text style={styles.mismatchText}>
                Delivered: {cylindersDelivered} | Received: {emptyReceived}
              </Text>
              <Text style={styles.mismatchCount}>
                {Math.abs(
                  (parseInt(cylindersDelivered) || 0) - (parseInt(emptyReceived) || 0)
                )}{' '}
                cylinder(s) need explanation
              </Text>
            </View>

            {reconciliationReasons.map((reason, index) => (
              <View key={index} style={styles.reasonCard}>
                <View style={styles.reasonHeader}>
                  <Text style={styles.reasonNumber}>Cylinder {index + 1}</Text>
                  <TouchableOpacity onPress={() => removeReconciliationReason(index)}>
                    <Ionicons name="close-circle" size={24} color="#e74c3c" />
                  </TouchableOpacity>
                </View>

                <Text style={styles.reasonLabel}>Reason *</Text>
                <View style={styles.reasonButtons}>
                  {['NC', 'DBC', 'TV', 'Empty baki', 'Empty Return'].map((r) => (
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

                {['NC', 'DBC', 'TV'].includes(reason.reason) && (
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
              <Text style={styles.addReasonText}>Add Reconciliation Reason</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.completeButton}
              onPress={handleReconciliationComplete}
            >
              <Text style={styles.completeButtonText}>Complete & Save</Text>
            </TouchableOpacity>
          </BottomSheetScrollView>
        </BottomSheet>
      )}
    </KeyboardAvoidingView>
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
  priceTag: {
    fontSize: 16,
    color: BPCL_YELLOW,
    marginTop: 8,
  },
  section: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
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
  pickerContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfInput: {
    flex: 1,
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
  sheetSubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginTop: 8,
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
  completeButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
