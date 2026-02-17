import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Calendar } from 'react-native-calendars';
import { useDataStore } from '../../store/dataStore';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

export default function RecordsScreen() {
  const { deliveries, loadDeliveriesByDate, dailySummary, loadDailySummary } = useDataStore();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showCalendar, setShowCalendar] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, [selectedDate]);

  const loadData = async () => {
    setLoading(true);
    await loadDeliveriesByDate(selectedDate);
    await loadDailySummary(selectedDate);
    setLoading(false);
  };

  const handleDateSelect = (date: any) => {
    setSelectedDate(date.dateString);
    setShowCalendar(false);
  };

  const formatReconciliation = (reasons: any[]) => {
    if (!reasons || reasons.length === 0) return 'No mismatch';
    return reasons
      .map((r) => {
        if (r.consumer_name) {
          return `${r.reason}: ${r.consumer_name}`;
        }
        return r.reason;
      })
      .join(', ');
  };

  const exportToExcel = async () => {
    try {
      if (deliveries.length === 0) {
        Alert.alert('No Data', 'No deliveries found for this date');
        return;
      }

      // Prepare data for Excel
      const excelData = deliveries.map((d, index) => ({
        'S.No': index + 1,
        'Staff Name': d.employee_name,
        'Cylinders Delivered': d.cylinders_delivered,
        'Empty Received': d.empty_received,
        'Online Payments': d.online_payments,
        'Paytm Payments': d.paytm_payments,
        'Partial Digital (₹)': d.partial_digital_amount.toFixed(2),
        'Cash Collected (₹)': d.cash_collected.toFixed(2),
        'Reconciliation': formatReconciliation(d.reconciliation_reasons),
      }));

      // Add totals row
      if (dailySummary) {
        excelData.push({
          'S.No': 'TOTAL',
          'Staff Name': '',
          'Cylinders Delivered': dailySummary.total_cylinders_delivered,
          'Empty Received': dailySummary.total_empty_received,
          'Online Payments': dailySummary.total_online_payments,
          'Paytm Payments': dailySummary.total_paytm_payments,
          'Partial Digital (₹)': dailySummary.total_partial_digital.toFixed(2),
          'Cash Collected (₹)': dailySummary.total_cash_collected.toFixed(2),
          'Reconciliation': '',
        });
      }

      // Create worksheet and workbook
      const ws = XLSX.utils.json_to_sheet(excelData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Deliveries');

      // Generate Excel file
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const fileName = `deliveries_${selectedDate}.xlsx`;
      const fileUri = FileSystem.documentDirectory + fileName;

      await FileSystem.writeAsStringAsync(fileUri, wbout, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Share file
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri);
      } else {
        Alert.alert('Success', `File saved at ${fileUri}`);
      }
    } catch (error) {
      console.error('Export error:', error);
      Alert.alert('Error', 'Failed to export data');
    }
  };

  const exportToCSV = async () => {
    try {
      if (deliveries.length === 0) {
        Alert.alert('No Data', 'No deliveries found for this date');
        return;
      }

      // Create CSV content
      let csv = 'S.No,Staff Name,Cylinders Delivered,Empty Received,Online,Paytm,Partial Digital(₹),Cash(₹),Reconciliation\n';

      deliveries.forEach((d, index) => {
        csv += `${index + 1},${d.employee_name},${d.cylinders_delivered},${d.empty_received},${d.online_payments},${d.paytm_payments},${d.partial_digital_amount.toFixed(2)},${d.cash_collected.toFixed(2)},"${formatReconciliation(d.reconciliation_reasons)}"\n`;
      });

      // Add totals
      if (dailySummary) {
        csv += `TOTAL,,${dailySummary.total_cylinders_delivered},${dailySummary.total_empty_received},${dailySummary.total_online_payments},${dailySummary.total_paytm_payments},${dailySummary.total_partial_digital.toFixed(2)},${dailySummary.total_cash_collected.toFixed(2)},\n`;
      }

      const fileName = `deliveries_${selectedDate}.csv`;
      const fileUri = FileSystem.documentDirectory + fileName;

      await FileSystem.writeAsStringAsync(fileUri, csv, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri);
      } else {
        Alert.alert('Success', `File saved at ${fileUri}`);
      }
    } catch (error) {
      console.error('Export error:', error);
      Alert.alert('Error', 'Failed to export CSV');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Daily Records</Text>
        <TouchableOpacity
          style={styles.dateButton}
          onPress={() => setShowCalendar(!showCalendar)}
        >
          <Ionicons name="calendar" size={20} color="#fff" />
          <Text style={styles.dateButtonText}>{selectedDate}</Text>
        </TouchableOpacity>
      </View>

      {showCalendar && (
        <Calendar
          current={selectedDate}
          onDayPress={handleDateSelect}
          markedDates={{
            [selectedDate]: {
              selected: true,
              selectedColor: BPCL_BLUE,
            },
          }}
          theme={{
            todayTextColor: BPCL_BLUE,
            selectedDayBackgroundColor: BPCL_BLUE,
            selectedDayTextColor: '#fff',
          }}
        />
      )}

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={BPCL_BLUE} />
        </View>
      ) : (
        <ScrollView style={styles.scrollView}>
          {/* Summary Card */}
          {dailySummary && (
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>Daily Summary</Text>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Cylinders Delivered:</Text>
                <Text style={styles.summaryValue}>
                  {dailySummary.total_cylinders_delivered}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Empty Received:</Text>
                <Text style={styles.summaryValue}>{dailySummary.total_empty_received}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Online Payments:</Text>
                <Text style={styles.summaryValue}>{dailySummary.total_online_payments}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Paytm Payments:</Text>
                <Text style={styles.summaryValue}>{dailySummary.total_paytm_payments}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Total Partial Digital:</Text>
                <Text style={styles.summaryValue}>
                  ₹{dailySummary.total_partial_digital.toFixed(2)}
                </Text>
              </View>
              <View style={styles.summaryRowHighlight}>
                <Text style={styles.summaryLabelHighlight}>Total Cash Collected:</Text>
                <Text style={styles.summaryValueHighlight}>
                  ₹{dailySummary.total_cash_collected.toFixed(2)}
                </Text>
              </View>
            </View>
          )}

          {/* Export Buttons */}
          <View style={styles.exportButtons}>
            <TouchableOpacity style={styles.exportButton} onPress={exportToExcel}>
              <Ionicons name="document" size={20} color="#fff" />
              <Text style={styles.exportButtonText}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.exportButton} onPress={exportToCSV}>
              <Ionicons name="document-text" size={20} color="#fff" />
              <Text style={styles.exportButtonText}>CSV</Text>
            </TouchableOpacity>
          </View>

          {/* Delivery Records */}
          <Text style={styles.sectionTitle}>Delivery Records ({deliveries.length})</Text>

          {deliveries.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="clipboard-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>No deliveries for this date</Text>
            </View>
          ) : (
            deliveries.map((delivery, index) => (
              <View key={delivery.id} style={styles.deliveryCard}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardNumber}>#{index + 1}</Text>
                  <Text style={styles.cardEmployee}>{delivery.employee_name}</Text>
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
                      ₹{delivery.partial_digital_amount.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.cardCol}>
                    <Text style={styles.cardLabel}>Cash</Text>
                    <Text style={styles.cardValueHighlight}>
                      ₹{delivery.cash_collected.toFixed(2)}
                    </Text>
                  </View>
                </View>

                {delivery.reconciliation_reasons &&
                  delivery.reconciliation_reasons.length > 0 && (
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
  summaryLabel: {
    fontSize: 14,
    color: '#666',
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
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
  summaryLabelHighlight: {
    fontSize: 16,
    fontWeight: 'bold',
    color: BPCL_BLUE,
  },
  summaryValueHighlight: {
    fontSize: 18,
    fontWeight: 'bold',
    color: BPCL_BLUE,
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    paddingHorizontal: 16,
    marginBottom: 12,
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
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
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
