import React, { useState } from 'react';
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
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';

const BPCL_BLUE = '#017DC5';

interface FastagTransaction {
  time: string;
  nature: string;
  amount: number;
  closingBalance: string;
  description: string;
  truckNo: string;
  transactionId: string;
}

export default function FastagReimbursementScreen() {
  const [loading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<FastagTransaction[]>([]);
  const [truckGroups, setTruckGroups] = useState<{ [key: string]: FastagTransaction[] }>({});

  // Clean and parse cell values safely
  const cleanVal = (val: any): string => {
    if (val === null || val === undefined) return '';
    return val.toString().trim();
  };

  const handleFileUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv',
          'text/comma-separated-values'
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      setLoading(true);
      const fileUri = result.assets[0].uri;
      const base64Content = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const workbook = XLSX.read(base64Content, { type: 'base64' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });

      if (rows.length === 0) {
        Alert.alert('Error', 'The uploaded file appears to be empty.');
        setLoading(false);
        return;
      }

      // Identify header indexes dynamically
      let headerRowIdx = -1;
      let natureIdx = -1, amtIdx = -1, descIdx = -1, truckIdx = -1, timeIdx = -1, closeBalIdx = -1, txIdIdx = -1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i].map((c: any) => cleanVal(c).toLowerCase());
        if (row.includes('amount') && (row.includes('truck no') || row.includes('vehicle') || row.includes('nature') || row.includes('description'))) {
          headerRowIdx = i;
          natureIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase().includes('nature') || cleanVal(c).toLowerCase() === 'c/d');
          amtIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase() === 'amount');
          descIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase().includes('description'));
          truckIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase().includes('truck') || cleanVal(c).toLowerCase().includes('vehicle'));
          timeIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase().includes('time') || cleanVal(c).toLowerCase().includes('date'));
          closeBalIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase().includes('closing') || cleanVal(c).toLowerCase().includes('balance'));
          txIdIdx = rows[i].findIndex((c: any) => cleanVal(c).toLowerCase().includes('transaction id') || cleanVal(c).toLowerCase().includes('tx id'));
          break;
        }
      }

      // Use column mapping fallbacks if formal headers are missing
      if (headerRowIdx === -1) {
        natureIdx = 1;
        amtIdx = 2;
        closeBalIdx = 3;
        descIdx = 4;
        truckIdx = 5;
        txIdIdx = 6;
        timeIdx = 0;
        headerRowIdx = 5; // Assumed start based on template defaults
      }

      const parsedTransactions: FastagTransaction[] = [];
      const grouped: { [key: string]: FastagTransaction[] } = {};

      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 3) continue;

        const nature = cleanVal(row[natureIdx]).toUpperCase();
        const description = cleanVal(row[descIdx]);
        const truckNo = cleanVal(row[truckIdx]).toUpperCase();
        const rawAmount = cleanVal(row[amtIdx]);

        // Filter: Keep only Debit entries and exclude "Nashirabad Toll Plaza"
        const isDebit = nature.includes('DEBIT') || nature === 'D';
        const isNashirabad = description.toLowerCase().includes('nashirabad');

        if (isDebit && !isNashirabad && rawAmount && truckNo) {
          const amount = parseFloat(rawAmount.replace(/[^0-9.]/g, '')) || 0;
          const transaction: FastagTransaction = {
            time: cleanVal(row[timeIdx]),
            nature: 'Debit',
            amount: amount,
            closingBalance: cleanVal(row[closeBalIdx]),
            description: description,
            truckNo: truckNo,
            transactionId: cleanVal(row[txIdIdx]),
          };

          parsedTransactions.push(transaction);

          if (!grouped[truckNo]) {
            grouped[truckNo] = [];
          }
          grouped[truckNo].push(transaction);
        }
      }

      if (parsedTransactions.length === 0) {
        Alert.alert('No Records Found', 'No valid Debit entries (excluding Nashirabad Toll Plaza) were identified.');
      } else {
        setTransactions(parsedTransactions);
        setTruckGroups(grouped);
      }
    } catch (error: any) {
      Alert.alert('Parsing Error', error?.message || 'Could not process the uploaded file.');
    } finally {
      setLoading(false);
    }
  };

  const handleExportExcel = async () => {
    if (Object.keys(truckGroups).length === 0) {
      Alert.alert('No Data', 'Please upload and parse a valid file first.');
      return;
    }

    try {
      setLoading(true);
      const wb = XLSX.utils.book_new();
      const summaryData: { truckNo: string; amount: number }[] = [];

      // 1. Create Detailed Sheet for each parsed Truck Number
      Object.keys(truckGroups).forEach((truckNo) => {
        const list = truckGroups[truckNo];
        const sheetData: any[][] = [
          ['Transaction Time', 'Nature', 'Amount', 'Closing Balance', 'Description', 'Truck No', 'Transaction ID']
        ];

        let totalAmount = 0;
        list.forEach((item) => {
          sheetData.push([
            item.time,
            item.nature,
            item.amount,
            item.closingBalance,
            item.description,
            item.truckNo,
            item.transactionId
          ]);
          totalAmount += item.amount;
        });

        // Add calculated total bottom row
        sheetData.push(['Total Amount', '', totalAmount, '', '', '', '']);
        summaryData.push({ truckNo, amount: totalAmount });

        const ws = XLSX.utils.aoa_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(wb, ws, truckNo.substring(0, 31)); // sheet names truncated safely
      });

      // 2. Generate Consolidated Summary Sheet
      const summaryRows: any[][] = [
        ['SHREEJEE GAS SERVICE', '', ''],
        ['Toll Reimbursement Sheet', '', ''],
        [], // blank spacer
        ['Sr No.', 'Truck No', 'Amount']
      ];

      let grandTotal = 0;
      summaryData.forEach((item, index) => {
        summaryRows.push([index + 1, item.truckNo, item.amount]);
        grandTotal += item.amount;
      });

      summaryRows.push(['Total Reimbursement', '', grandTotal]);

      const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);

      // Define cells to merge dynamically
      summarySheet['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }, // Merges 'SHREEJEE GAS SERVICE'
        { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }  // Merges 'Toll Reimbursement Sheet'
      ];

      XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary Report');

      // 3. Write, save, and invoke native sharing
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const filename = `Toll_Reimbursement_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const fileUri = `${FileSystem.cacheDirectory}${filename}`;

      await FileSystem.writeAsStringAsync(fileUri, wbout, {
        encoding: FileSystem.EncodingType.Base64,
      });

      await Sharing.shareAsync(fileUri, {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dialogTitle: 'Share Fastag Toll Reimbursement Statement',
      });
    } catch (error: any) {
      Alert.alert('Export Error', error?.message || 'Could not assemble and share the spreadsheet.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* HEADER SECTION */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Fastag Reimbursement</Text>
        <Text style={styles.headerSubtitle}>Toll Reconciliation Utility</Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={BPCL_BLUE} />
          <Text style={styles.loaderText}>Processing fastag operations...</Text>
        </View>
      ) : (
        <ScrollView style={styles.scroll}>
          {/* UPLOAD & PROCESS CONTAINER */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="cloud-upload" size={24} color={BPCL_BLUE} />
              <Text style={styles.cardTitle}>Import Summary Document</Text>
            </View>
            <Text style={styles.cardText}>
              Select the downloaded Excel or CSV statement from your Fastag portal to parse debit balances.
            </Text>

            <TouchableOpacity style={styles.uploadButton} onPress={handleFileUpload}>
              <Ionicons name="document-attach" size={18} color="#fff" />
              <Text style={styles.buttonText}>Upload Statement</Text>
            </TouchableOpacity>
          </View>

          {/* PARSED PREVIEW SECTION */}
          {transactions.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Reconciliation Preview</Text>

              {Object.keys(truckGroups).map((truckNo) => {
                const list = truckGroups[truckNo];
                const sum = list.reduce((acc, curr) => acc + curr.amount, 0);
                return (
                  <View key={truckNo} style={styles.infoRow}>
                    <View>
                      <Text style={styles.truckTitle}>{truckNo}</Text>
                      <Text style={styles.truckSub}>{list.length} Valid Debits</Text>
                    </View>
                    <Text style={styles.truckAmount}>₹{sum.toFixed(2)}</Text>
                  </View>
                );
              })}

              <TouchableOpacity style={styles.exportButton} onPress={handleExportExcel}>
                <Ionicons name="share-social-outline" size={18} color="#fff" />
                <Text style={styles.buttonText}>Generate & Share Excel</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    backgroundColor: BPCL_BLUE,
    padding: 20,
    paddingTop: 60,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 4 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loaderText: { marginTop: 12, fontSize: 14, color: '#666', fontWeight: '500' },
  scroll: { flex: 1, paddingHorizontal: 12, paddingTop: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  cardText: { fontSize: 13, color: '#666', lineHeight: 18, marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 12 },
  uploadButton: {
    backgroundColor: BPCL_BLUE,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  exportButton: {
    backgroundColor: '#15803d',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
    marginTop: 16,
  },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  truckTitle: { fontSize: 14, fontWeight: '700', color: '#374151' },
  truckSub: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  truckAmount: { fontSize: 15, fontWeight: 'bold', color: BPCL_BLUE },
});