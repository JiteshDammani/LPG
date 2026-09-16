import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import {
  listPairedDevices,
  connectAndSavePrinter,
  BluetoothDevice,
} from '../lib/thermalPrinter';

const BPCL_BLUE = '#017DC5';

interface Props {
  visible: boolean;
  onClose: () => void;
  onConnected: (device: BluetoothDevice) => void;
}

// Pair your roll printer with the phone ONCE in Android Bluetooth settings
// first (like pairing headphones) — this screen only lists already-paired
// devices and connects the app to whichever one you tap.
export default function PrinterPickerModal({ visible, onClose, onConnected }: Props) {
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [connectingAddress, setConnectingAddress] = useState<string | null>(null);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const list = await listPairedDevices();
      setDevices(list);
    } catch (err: any) {
      Alert.alert(
        'Bluetooth error',
        err?.message || 'Could not scan for devices. Make sure Bluetooth is on and the printer is paired in your phone settings.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async (device: BluetoothDevice) => {
    setConnectingAddress(device.address);
    try {
      await connectAndSavePrinter(device);
      onConnected(device);
      onClose();
    } catch (err: any) {
      Alert.alert('Connection failed', err?.message || `Could not connect to ${device.name}`);
    } finally {
      setConnectingAddress(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onShow={loadDevices}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>🖨️ Select Printer</Text>
          <Text style={styles.subtitle}>Pair the printer in Android Bluetooth settings first, then pick it here.</Text>

          {loading ? (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <ActivityIndicator color={BPCL_BLUE} />
            </View>
          ) : devices.length === 0 ? (
            <Text style={styles.empty}>No paired devices found.</Text>
          ) : (
            devices.map((d) => (
              <TouchableOpacity key={d.address} style={styles.deviceRow} onPress={() => handleSelect(d)}>
                <Text style={styles.deviceName}>{d.name}</Text>
                {connectingAddress === d.address ? (
                  <ActivityIndicator size="small" color={BPCL_BLUE} />
                ) : (
                  <Text style={styles.connectText}>Connect</Text>
                )}
              </TouchableOpacity>
            ))
          )}

          <TouchableOpacity style={styles.refreshBtn} onPress={loadDevices}>
            <Text style={styles.refreshText}>Refresh list</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 },
  title: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  subtitle: { fontSize: 12, color: '#888', marginBottom: 16 },
  empty: { fontSize: 13, color: '#999', fontStyle: 'italic', paddingVertical: 16, textAlign: 'center' },
  deviceRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#eee', marginBottom: 8,
  },
  deviceName: { fontSize: 14, fontWeight: '600', color: '#333' },
  connectText: { fontSize: 13, color: BPCL_BLUE, fontWeight: '700' },
  refreshBtn: { padding: 12, alignItems: 'center' },
  refreshText: { color: BPCL_BLUE, fontWeight: '600' },
  closeBtn: { padding: 12, alignItems: 'center' },
  closeText: { color: '#999' },
});
