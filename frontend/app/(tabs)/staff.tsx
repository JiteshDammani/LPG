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

export default function StaffScreen() {
  // Added loadEmployees to the destructuring
  const { employees, addEmployee, deleteEmployee, loadEmployees } = useDataStore();
  const [newEmployeeName, setNewEmployeeName] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // CRITICAL FIX: Load employees from local storage when the screen mounts
  useEffect(() => {
    loadEmployees();
  }, []);

  const handleAddEmployee = async () => {
    if (!newEmployeeName.trim()) {
      Alert.alert('Error', 'Please enter employee name');
      return;
    }

    try {
      await addEmployee(newEmployeeName.trim());
      setNewEmployeeName('');
      setIsAdding(false);
      Alert.alert('Success', 'Employee added successfully');
    } catch (error) {
      Alert.alert('Error', 'Failed to save employee to device storage');
    }
  };

  const handleDeleteEmployee = (id: string, name: string) => {
    Alert.alert(
      'Confirm Delete',
      `Are you sure you want to remove ${name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteEmployee(id);
              Alert.alert('Success', 'Employee removed successfully');
            } catch (error) {
              Alert.alert('Error', 'Failed to delete employee');
            }
          },
        },
      ]
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Delivery Staff</Text>
        <Text style={styles.headerSubtitle}>{employees.length} staff members</Text>
      </View>

      <ScrollView style={styles.scrollView}>
        {/* Add New Employee Card */}
        {isAdding ? (
          <View style={styles.addCard}>
            <Text style={styles.addTitle}>Add New Staff Member</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter staff name"
              value={newEmployeeName}
              onChangeText={setNewEmployeeName}
              autoFocus
            />
            <View style={styles.addButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setIsAdding(false);
                  setNewEmployeeName('');
                }}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveButton} onPress={handleAddEmployee}>
                <Text style={styles.saveButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => setIsAdding(true)}
          >
            <Ionicons name="add-circle" size={24} color={BPCL_BLUE} />
            <Text style={styles.addButtonText}>Add New Staff Member</Text>
          </TouchableOpacity>
        )}

        {/* Employee List */}
        <Text style={styles.sectionTitle}>Staff List</Text>

        {employees.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="people-outline" size={64} color="#ccc" />
            <Text style={styles.emptyText}>No staff members added yet</Text>
            <Text style={styles.emptySubtext}>Add delivery staff to start tracking</Text>
          </View>
        ) : (
          employees.map((employee) => (
            <View key={employee.id} style={styles.employeeCard}>
              <View style={styles.employeeInfo}>
                <View style={styles.employeeAvatar}>
                  <Ionicons name="person" size={24} color={BPCL_BLUE} />
                </View>
                <View style={styles.employeeDetails}>
                  <Text style={styles.employeeName}>{employee.name}</Text>
                  <Text style={styles.employeeDate}>
                    Added: {new Date(employee.created_at).toLocaleDateString()}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => handleDeleteEmployee(employee.id, employee.name)}
              >
                <Ionicons name="trash-outline" size={22} color="#e74c3c" />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </KeyboardAvoidingView>
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
  },
  headerSubtitle: {
    fontSize: 16,
    color: BPCL_YELLOW,
    marginTop: 8,
  },
  scrollView: {
    flex: 1,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: BPCL_BLUE,
    borderStyle: 'dashed',
  },
  addButtonText: {
    color: BPCL_BLUE,
    fontSize: 16,
    fontWeight: '600',
  },
  addCard: {
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
  addTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  input: {
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  addButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#666',
    fontSize: 16,
    fontWeight: '600',
  },
  saveButton: {
    flex: 1,
    backgroundColor: BPCL_BLUE,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
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
  emptySubtext: {
    fontSize: 14,
    color: '#ccc',
    marginTop: 8,
  },
  employeeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  employeeInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  employeeAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#e8f4f8',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  employeeDetails: {
    flex: 1,
  },
  employeeName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 4,
  },
  employeeDate: {
    fontSize: 12,
    color: '#999',
  },
  deleteButton: {
    padding: 8,
  },
});
