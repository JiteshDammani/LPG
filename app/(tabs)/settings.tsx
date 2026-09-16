import React, { useEffect, useState } from 'react';
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
  Switch,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDataStore } from '../../store/dataStore';
import { useRole } from '../../hooks/useRole';


const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

interface SettingsScreenProps {
  onLogout: () => void;
  currentUser?: {
    username: string;
    first_name?: string;
    last_name?: string;
  };
}

export default function SettingsScreen({ onLogout, currentUser }: SettingsScreenProps) {
    const {
    cylinderPrice,
    settings,
    updateCylinderPrice,
    discountEnabled,
    loadDiscountSetting,
    saveDiscountSetting,
    currentUser: storeUser,
    setCurrentUser,
  } = useDataStore();

  const [newPrice, setNewPrice] = useState(cylinderPrice.toString());
  const [isEditing, setIsEditing] = useState(false);
  const [savingDiscount, setSavingDiscount] = useState(false);

  useEffect(() => {
    loadDiscountSetting();
  }, []);

  const handleUpdatePrice = async () => {
    const price = parseFloat(newPrice);
    if (isNaN(price) || price <= 0) {
      Alert.alert('Error', 'Please enter a valid price');
      return;
    }
    await updateCylinderPrice(price);
    setIsEditing(false);
    Alert.alert('Success', `Cylinder price updated to ₹${price.toFixed(2)}`);
  };



  const handleDiscountToggle = async (val: boolean) => {
    setSavingDiscount(true);
    await saveDiscountSetting(val);
    setSavingDiscount(false);
    Alert.alert(
      'Updated',
      val
        ? 'Commercial discount is now enabled'
        : 'Commercial discount is now disabled'
    );
  };

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: () => {
            setCurrentUser(null);
            if (onLogout) onLogout();
          },
        },
      ],
      { cancelable: true }
    );
  };

  const activeUser = currentUser ?? storeUser;
  const displayName = activeUser?.first_name
    ? `${activeUser.first_name} ${activeUser.last_name || ''}`.trim()
    : activeUser?.username || 'User';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Settings</Text>
            <Text style={styles.headerSubtitle}>Configure app preferences</Text>
          </View>

          {/* ── Icon-only logout button in top-right ── */}
          <TouchableOpacity
            style={styles.logoutIconButton}
            onPress={handleLogout}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="log-out-outline" size={26} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* User Info Badge */}
        <View style={styles.userBadge}>
          <View style={styles.userIconContainer}>
            <Ionicons name="person" size={18} color={BPCL_BLUE} />
          </View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{displayName}</Text>
            <Text style={styles.userRole}>
              {currentUser?.username ? `@${currentUser.username}` : 'Staff Member'}
            </Text>
          </View>
        </View>
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
              <View style={styles.editButtons}>
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
              </View>
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

        {/* Commercial Discount Toggle */}
        <View style={styles.priceCard}>
          <View style={styles.priceHeader}>
            <Ionicons name="pricetag-outline" size={32} color={BPCL_BLUE} />
            <Text style={styles.priceTitle}>Commercial Discount</Text>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, color: '#333', fontWeight: '600' }}>
                Apply Discount on Commercial Rate
              </Text>
              <Text style={{ fontSize: 12, marginTop: 4, color: discountEnabled ? '#27ae60' : '#e74c3c' }}>
                {discountEnabled
                  ? '✅ Discount is currently being applied'
                  : '❌ Discount is currently disabled'}
              </Text>
            </View>

            {savingDiscount ? (
              <ActivityIndicator size="small" color={BPCL_BLUE} />
            ) : (
              <Switch
                value={discountEnabled}
                onValueChange={handleDiscountToggle}
                trackColor={{ false: '#ddd', true: '#b3d9f0' }}
                thumbColor={discountEnabled ? BPCL_BLUE : '#999'}
              />
            )}
          </View>
        </View>

        {/* Price History */}
        {settings?.price_history?.length > 0 && (
          <View style={styles.historyCard}>
            <Text style={styles.historyTitle}>Price History</Text>
            {settings.price_history
              .slice()
              .reverse()
              .slice(0, 10)
              .map(
                (item: { date: string | number | Date; price: number }, index: React.Key | null | undefined) => (
                  <View key={index} style={styles.historyItem}>
                    <Text style={styles.historyDate}>
                      {new Date(item.date).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </Text>
                    <Text style={styles.historyPrice}>₹{item.price.toFixed(2)}</Text>
                  </View>
                )
              )}
          </View>
        )}

        {/* App Info */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>About</Text>
          <View style={styles.infoRow}>
            <Ionicons name="business" size={20} color={BPCL_BLUE} />
            <Text style={styles.infoText}>Shreejee Gas Service</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="cube" size={20} color={BPCL_BLUE} />
            <Text style={styles.infoText}>LPG Management System</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="code-slash" size={20} color={BPCL_BLUE} />
            <Text style={styles.infoText}>Version 3.0.3</Text>
          </View>
        </View>

        {/* Instructions */}
        <View style={styles.instructionsCard}>
          <Text style={styles.instructionsTitle}>How to Use</Text>
          {[
            'Add delivery staff members in the Staff tab',
            "Record daily deliveries in the Delivery tab",
            "If empty cylinders don't match, provide reconciliation reasons",
            'View daily records and export data from Records tab',
            'Update cylinder price daily or as needed from Settings',
          ].map((text, i) => (
            <View key={i} style={styles.instruction}>
              <Text style={styles.instructionNumber}>{i + 1}</Text>
              <Text style={styles.instructionText}>{text}</Text>
            </View>
          ))}
        </View>

        {/* ── Full logout button at bottom ── */}
        <View style={styles.logoutSection}>
          <TouchableOpacity
            style={styles.logoutButtonBottom}
            onPress={handleLogout}
            activeOpacity={0.8}
          >
            <Ionicons name="log-out-outline" size={22} color="#e74c3c" />
            <Text style={styles.logoutTextBottom}>Logout</Text>
          </TouchableOpacity>
          <Text style={styles.logoutHint}>
            You can always sign back in with your credentials
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  header: {
    backgroundColor: BPCL_BLUE,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  headerLeft: { flex: 1 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 14, color: 'rgba(255,255,255,0.9)', marginTop: 4 },

  // Icon-only logout button (top right)
  logoutIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(231, 76, 60, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    marginLeft: 12,
  },

  // User Info Badge
  userBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  userIconContainer: {
    backgroundColor: '#fff',
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userInfo: { flex: 1 },
  userName: { fontSize: 15, fontWeight: '700', color: '#fff', letterSpacing: 0.3 },
  userRole: { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },

  scrollView: { flex: 1 },

  priceCard: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 20,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  priceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  priceTitle: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  priceDisplay: { alignItems: 'center' },
  currentPriceLabel: { fontSize: 14, color: '#666', marginBottom: 8 },
  currentPrice: { fontSize: 48, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 20 },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: BPCL_BLUE,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  editButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  editSection: { marginTop: 12 },
  label: { fontSize: 14, color: '#666', marginBottom: 8, fontWeight: '600' },
  input: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  editButtons: { flexDirection: 'row', gap: 12 },
  cancelButton: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButtonText: { color: '#666', fontSize: 16, fontWeight: '600' },
  saveButton: {
    flex: 1,
    backgroundColor: BPCL_BLUE,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  historyCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  historyTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 12 },
  historyItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  historyDate: { fontSize: 14, color: '#666' },
  historyPrice: { fontSize: 14, fontWeight: 'bold', color: BPCL_BLUE },

  infoCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  infoTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  infoText: { fontSize: 14, color: '#666' },

  instructionsCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  instructionsTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 16 },
  instruction: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  instructionNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: BPCL_BLUE,
    color: '#fff',
    textAlign: 'center',
    lineHeight: 24,
    fontSize: 14,
    fontWeight: 'bold',
    marginRight: 12,
  },
  instructionText: { flex: 1, fontSize: 14, color: '#666', lineHeight: 20 },

  // Logout section at bottom
  logoutSection: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 32,
    padding: 20,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
    alignItems: 'center',
  },
  logoutButtonBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff5f5',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#e74c3c',
    width: '100%',
    justifyContent: 'center',
  },
  logoutTextBottom: { color: '#e74c3c', fontSize: 16, fontWeight: '700' },
  logoutHint: { fontSize: 12, color: '#999', marginTop: 10, textAlign: 'center' },
});
