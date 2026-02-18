import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDataStore } from '../../store/dataStore';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

export default function SettingsScreen() {
  const { cylinderPrice, settings, updateCylinderPrice } = useDataStore();
  const [newPrice, setNewPrice] = useState(cylinderPrice.toString());
  const [isEditing, setIsEditing] = useState(false);

  // Sync the local state with the store whenever the store finishes loading from disk
  useEffect(() => {
    setNewPrice(cylinderPrice.toString());
  }, [cylinderPrice]);

  const handleUpdatePrice = async () => {
    const price = parseFloat(newPrice);
    if (isNaN(price) || price <= 0) {
      Alert.alert('Error', 'Please enter a valid price');
      return;
    }

    try {
      // Save to AsyncStorage via Zustand
      await updateCylinderPrice(price);
      setIsEditing(false);
      Alert.alert('Success', `Cylinder price updated to ₹${price.toFixed(2)}`);
    } catch (error) {
      Alert.alert('Error', 'Failed to save settings locally.');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
        <Text style={styles.headerSubtitle}>Configure app preferences</Text>
      </View>

      <ScrollView style={styles.scrollView}>
        {/* Current Price Card */}
        <View style={styles.priceCard}>
          <View style={styles.priceHeader}>
            <Ionicons name="pricetag" size={32} color={BPCL_BLUE} />
            <Text style={styles.priceTitle}>Cylinder Price</Text>
          </View>

          {isEditing ? (
            <View style={styles.editSection}>
              <Text style={styles.label}>New Price (₹)</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter price"
                keyboardType="decimal-pad"
                value={newPrice}
                onChangeText={setNewPrice}
                autoFocus
              />
              <div style={styles.editButtons}>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => {
                    setIsEditing(false);
                    setNewPrice(cylinderPrice.toString());
                  }}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveButton} onPress={handleUpdatePrice}>
                  <Text style={styles.saveButtonText}>Save Price</Text>
                </TouchableOpacity>
              </div>
            </View>
          ) : (
            <View style={styles.priceDisplay}>
              <Text style={styles.currentPriceLabel}>Current Price</Text>
              <Text style={styles.currentPrice}>₹{cylinderPrice.toFixed(2)}</Text>
              <TouchableOpacity
                style={styles.editButton}
                onPress={() => setIsEditing(true)}
              >
                <Ionicons name="pencil" size={18} color="#fff" />
                <Text style={styles.editButtonText}>Update Price</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Price History */}
        {settings?.price_history && settings.price_history.length > 0 && (
          <View style={styles.historyCard}>
            <Text style={styles.historyTitle}>Price History</Text>
            {settings.price_history
              .slice()
              .reverse()
              .slice(0, 5) // Show last 5 changes
              .map((item: any, index: number) => (
                <View key={index} style={styles.historyItem}>
                  <Text style={styles.historyDate}>
                    {new Date(item.date).toLocaleDateString('en-IN')}
                  </Text>
                  <Text style={styles.historyPrice}>₹{item.price.toFixed(2)}</Text>
                </View>
              ))}
          </View>
        )}

        {/* App Info */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>About</Text>
          <View style={styles.infoRow}>
            <Ionicons name="business" size={20} color={BPCL_BLUE} />
            <Text style={styles.infoText}>Bharat Petroleum (Local Tracker)</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="code-slash" size={20} color={BPCL_BLUE} />
            <Text style={styles.infoText}>Version 1.1.0 (Standalone APK)</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { backgroundColor: BPCL_BLUE, padding: 20, paddingTop: 60 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 16, color: BPCL_YELLOW, marginTop: 8 },
  scrollView: { flex: 1 },
  priceCard: { backgroundColor: '#fff', margin: 16, padding: 20, borderRadius: 12, elevation: 3 },
  priceHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  priceTitle: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  priceDisplay: { alignItems: 'center' },
  currentPriceLabel: { fontSize: 14, color: '#666', marginBottom: 8 },
  currentPrice: { fontSize: 48, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 20 },
  editButton: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: BPCL_BLUE, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  editButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  editSection: { marginTop: 12 },
  label: { fontSize: 14, color: '#666', marginBottom: 8, fontWeight: '600' },
  input: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 16 },
  editButtons: { flexDirection: 'row', gap: 12 },
  cancelButton: { flex: 1, backgroundColor: '#f8f9fa', padding: 12, borderRadius: 8, alignItems: 'center' },
  cancelButtonText: { color: '#666', fontSize: 16, fontWeight: '600' },
  saveButton: { flex: 1, backgroundColor: BPCL_BLUE, padding: 12, borderRadius: 8, alignItems: 'center' },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  historyCard: { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: 12, elevation: 2 },
  historyTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 12 },
  historyItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  historyDate: { fontSize: 14, color: '#666' },
  historyPrice: { fontSize: 14, fontWeight: 'bold', color: BPCL_BLUE },
  infoCard: { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: 12, elevation: 2 },
  infoTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  infoText: { fontSize: 14, color: '#666' },
});
