import React, { useState, useEffect, useMemo } from 'react';
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
  // We only pull what we need for local storage
  const { deliveries, loadDeliveriesByDate } = useDataStore();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showCalendar, setShowCalendar] = useState(false);
  const [loading, setLoading] = useState(false);

  // CRITICAL CHANGE: Calculate the daily summary locally since there is no backend
  const dailySummary = useMemo(() => {
    if (!deliveries || deliveries.length === 0) return null;
    
    return {
      total_cylinders_delivered: deliveries.reduce((acc, d) => acc + d.cylinders_delivered, 0),
      total_empty_received: deliveries.reduce((acc, d) => acc + d.empty_received, 0),
      total_online_payments: deliveries.reduce((acc, d) => acc + d.online_payments, 0),
      total_paytm_payments: deliveries.reduce((acc, d) => acc + d.paytm_payments, 0),
      total_partial_digital: deliveries.reduce((acc, d) => acc + d.partial_digital_amount, 0),
      total_cash_collected: deliveries.reduce((acc, d) => acc + d.cash_collected, 0),
    };
  }, [deliveries]);

  useEffect(() => {
    loadData();
  }, [selectedDate]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Pulls directly from AsyncStorage key 'lpg_deliveries_YYYY-MM-DD'
      await loadDeliveriesByDate(selectedDate);
    } catch (error) {
      console.error("Local Load Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDateSelect = (date: any) => {
    setSelectedDate(date.dateString);
    setShowCalendar(false);
  };

  const formatReconciliation = (reasons: any[]) => {
    if (!reasons || reasons.length === 0) return 'No mismatch';
    return reasons
      .map((r) => (r.consumer_name ? `${r.reason}: ${r.consumer_name}` : r.reason))
      .join(', ');
  };

  const exportToExcel = async () => {
    try {
      if (deliveries.length === 0) {
        Alert.alert('No Data', 'No deliveries found for this date');
        return;
      }

      const excelData = deliveries.map((d, index) => ({
        'S.No': index + 1,
        'Staff Name': d.employee_name,
        'Cylinders': d.cylinders_delivered,
        'Empty': d.empty_received,
        'Online': d.online_payments,
        'Paytm': d.paytm_payments,
        'Partial(₹)': d.partial_digital_amount.toFixed(2),
        'Cash(₹)': d.cash_collected.toFixed(2),
        'Reconciliation': formatReconciliation(d.reconciliation_reasons),
      }));

      const ws = XLSX.utils.json_to_sheet(excelData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Deliveries');
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const fileUri = `${FileSystem.documentDirectory}deliveries_${selectedDate}.xlsx`;

      await FileSystem.writeAsStringAsync(fileUri, wbout, { encoding: FileSystem.EncodingType.Base64 });
      await Sharing.shareAsync(fileUri);
    } catch (error) {
      Alert.alert('Export Error', 'Could not generate Excel file');
    }
  };

  const exportToCSV = async () => {
    try {
      if (deliveries.length === 0) return;
      let csv = 'S.No,Staff,Delivered,Empty,Online,Paytm,Partial,Cash,Reconciliation\n';
      deliveries.forEach((d, i) => {
        csv += `${i + 1},${d.employee_name},${d.cylinders_delivered},${d.empty_received},${d.online_payments},${d.paytm_payments},${d.partial_digital_amount},${d.cash_collected},"${formatReconciliation(d.reconciliation_reasons)}"\n`;
      });
      const fileUri = `${FileSystem.documentDirectory}deliveries_${selectedDate}.csv`;
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(fileUri);
    } catch (error) {
      Alert.alert('Export Error', 'Could not generate CSV file');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Daily Records</Text>
        <TouchableOpacity style={styles.dateButton} onPress={() => setShowCalendar(!showCalendar)}>
          <Ionicons name="calendar" size={20} color="#fff" />
          <Text style={styles.dateButtonText}>{selectedDate}</Text>
        </TouchableOpacity>
      </View>

      {showCalendar && (
        <Calendar
          current={selectedDate}
          onDayPress={handleDateSelect}
          markedDates={{ [selectedDate]: { selected: true, selectedColor: BPCL_BLUE } }}
          theme={{ todayTextColor: BPCL_BLUE, selectedDayBackgroundColor: BPCL_BLUE }}
        />
      )}

      {loading ? (
        <View style={styles.loadingContainer}><ActivityIndicator size="large" color={BPCL_BLUE} /></View>
      ) : (
        <ScrollView style={styles.scrollView}>
          {dailySummary && (
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>Daily Summary</Text>
              <View style={styles.summaryGrid}>
                <View style={styles.summaryItem}>
                   <Text style={styles.summaryLabel}>Cylinders</Text>
                   <Text style={styles.summaryValue}>{dailySummary.total_cylinders_delivered}</Text>
                </View>
                <View style={styles.summaryItem}>
                   <Text style={styles.summaryLabel}>Empty</Text>
                   <Text style={styles.summaryValue}>{dailySummary.total_empty_received}</Text>
                </View>
              </View>
              <View style={styles.summaryRowHighlight}>
                <Text style={styles.summaryLabelHighlight}>Total Cash:</Text>
                <Text style={styles.summaryValueHighlight}>₹{dailySummary.total_cash_collected.toFixed(2)}</Text>
              </View>
            </View>
          )}

          <View style={styles.exportButtons}>
            <TouchableOpacity style={styles.exportButton} onPress={exportToExcel}>
              <Ionicons name="document" size={20} color="#fff" /><Text style={styles.exportButtonText}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.exportButton} onPress={exportToCSV}>
              <Ionicons name="document-text" size={20} color="#fff" /><Text style={styles.exportButtonText}>CSV</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionTitle}>Records ({deliveries.length})</Text>
          {deliveries.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="clipboard-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>No records for this date</Text>
            </View>
          ) : (
            deliveries.map((delivery, index) => (
              <View key={delivery.id} style={styles.deliveryCard}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardNumber}>#{index + 1}</Text>
                  <Text style={styles.cardEmployee}>{delivery.employee_name}</Text>
                </View>
                <View style={styles.cardRow}>
                  <View style={styles.cardCol}><Text style={styles.cardLabel}>Cylinders</Text><Text style={styles.cardValue}>{delivery.cylinders_delivered}</Text></View>
                  <View style={styles.cardCol}><Text style={styles.cardLabel}>Cash</Text><Text style={styles.cardValueHighlight}>₹{delivery.cash_collected}</Text></View>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { backgroundColor: BPCL_BLUE, padding: 20, paddingTop: 60 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#fff', marginBottom: 12 },
  dateButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.2)', padding: 12, borderRadius: 8, gap: 8 },
  dateButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scrollView: { flex: 1 },
  summaryCard: { backgroundColor: '#fff', margin: 16, padding: 16, borderRadius: 12, elevation: 3 },
  summaryTitle: { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 12 },
  summaryGrid: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryLabel: { fontSize: 12, color: '#666' },
  summaryValue: { fontSize: 16, fontWeight: 'bold' },
  summaryRowHighlight: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, backgroundColor: '#e8f4f8', borderRadius: 8 },
  summaryLabelHighlight: { fontWeight: 'bold', color: BPCL_BLUE },
  summaryValueHighlight: { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE },
  exportButtons: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginBottom: 16 },
  exportButton: { flex: 1, backgroundColor: BPCL_BLUE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 8, gap: 8 },
  exportButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', paddingHorizontal: 16, marginBottom: 12 },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 16, color: '#999', marginTop: 16 },
  deliveryCard: { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: 12, elevation: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', paddingBottom: 8 },
  cardNumber: { fontWeight: 'bold', color: BPCL_BLUE, marginRight: 8 },
  cardEmployee: { fontWeight: 'bold' },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between' },
  cardCol: { flex: 1 },
  cardLabel: { fontSize: 12, color: '#666' },
  cardValue: { fontWeight: 'bold' },
  cardValueHighlight: { fontWeight: 'bold', color: BPCL_BLUE },
});
