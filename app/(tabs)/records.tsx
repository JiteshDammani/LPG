import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Calendar } from 'react-native-calendars';
import { useDataStore } from '@/store/dataStore';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';
import * as Sharing from 'expo-sharing';
import { useRole } from '../../hooks/useRole';

const FileSystem = require('expo-file-system');

const BPCL_BLUE = '#017DC5';

export default function RecordsScreen() {
  const {
    deliveries,
    loadDeliveriesByDate,
    loadDailySummary,
    loadEmployees,
    extraPaytmCreditAmount,
    cylinderPrice,
    deleteDelivery,
  } = useDataStore();

  const [selectedDate, setSelectedDate] = useState(
    format(new Date(), 'yyyy-MM-dd')
  );

  const [showCalendar, setShowCalendar] = useState(false);
  const [loading, setLoading] = useState(false);
  const role = useRole();

  // ─── LOAD DATA FUNCTION (Hoisted safely above potential returns) ───
  const loadData = async () => {
    try {
      setLoading(true);
      await loadDeliveriesByDate(selectedDate);
      await loadDailySummary(selectedDate);
      await loadEmployees();
    } catch (error) {
      Alert.alert('Error', 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (role !== 'viewer') {
      loadData();
      loadEmployees();
    }
  }, [selectedDate, role]);

  /* ================= DELETE HANDLER ================= */
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

  /* ================= SAFE SUMMARY ================= */
  const safeSummary = useMemo(() => {
    const totalDelivered = deliveries.reduce((a: number, b: any) => a + (b.cylinders_delivered || 0), 0);
    const totalEmpty = deliveries.reduce((a: number, b: any) => a + (b.empty_received || 0), 0);
    const totalOnlineQty = deliveries.reduce((a: number, b: any) => a + (b.online_payments || 0), 0);
    const totalCash = deliveries.reduce((a: number, b: any) => a + (b.cash_collected || 0), 0);
    const totalPaytmQty = deliveries.reduce((a: number, b: any) => a + (b.paytm_payments || 0), 0);
    const totalPartial = deliveries.reduce((a: number, b: any) => a + (b.partial_digital_amount || 0), 0);

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

  /* ================= DATE ================= */
  const handleDateSelect = (date: any) => {
    setSelectedDate(date.dateString);
    setShowCalendar(false);
  };

  /* ================= RECONCILIATION ================= */
  const formatReconciliation = (reasons: any[]) => {
    if (!reasons || reasons.length === 0) return '';
    return reasons
      .map(r => r.consumer_name ? `${r.reason}: ${r.consumer_name}` : r.reason)
      .join(', ');
  };

  /* ================= EXPORT ================= */
  const exportToExcel = async () => {
    if (deliveries.length === 0) {
      Alert.alert('No Data');
      return;
    }

    const excelData = deliveries.map((d: any, index: any) => ({
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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Daily Records</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={() => setShowCalendar(!showCalendar)}
          >
            <Ionicons name="calendar-outline" size={20} color="#fff" />
            <Text style={styles.dateButtonText}>{selectedDate}</Text>
          </TouchableOpacity>

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
        </View>
      </View>

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
            <Text style={styles.sectionTitle}>
              Delivery Records ({deliveries.length})
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

          {deliveries.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="clipboard-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>No deliveries for this date</Text>
            </View>
          ) : (
            deliveries.map((delivery: any, index: any) => (
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
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  deniedContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5'
  },
  deniedTitle: {
    fontSize: 20,
    color: '#e74c3c',
    fontWeight: 'bold'
  },
  deniedSubtitle: {
    color: '#999',
    marginTop: 8
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
    marginBottom: 12,
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
  scrollView: {
    flex: 1,
  },
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

  // Section Header Styles
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: {
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
});