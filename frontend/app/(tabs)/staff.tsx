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
  useFocusEffect,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDataStore } from '../../store/dataStore';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

export default function StaffScreen() {
  const { employees, addEmployee, deleteEmployee, loadEmployees } = useDataStore();
  const [newEmployeeName, setNewEmployeeName] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // ✅ FIX 1: Use useFocusEffect to reload data every time user visits this screen
  useFocusEffect(
    React.useCallback(() => {
      loadEmployees();
    }, [loadEmployees])
  );

  const handleAddEmployee = async () => {
    if (!newEmployeeName.trim()) {
      Alert.alert('Error', 'Please enter employee name');
      return;
    }

    try {
      await addEmployee(newEmployeeName.trim());
      setNewEmployeeName('');
      setIsAdding(false);
      
      // ✅ FIX 2: Reload employees to show the new one immediately
      await loadEmployees();
      
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
              
              // ✅ FIX 3: Reload employees after deletion
              await loadEmployees();
              
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
            <Ionicons name="people-outline" size={48} color={BPCL_BLUE} />
            <Text style={styles.emptyStateText}>No staff members added yet</Text>
          </View>
        ) : (
          employees.map((employee) => (
            <View key={employee.id} style={styles.employeeCard}>
              <View style={styles.employeeInfo}>
                <Ionicons name="person-circle" size={40} color={BPCL_BLUE} />
                <View style={styles.employeeDetails}>
                  <Text style={styles.employeeName}>{employee.name}</Text>
                  <Text style={styles.employeeDate}>Added: {new Date(employee.created_at).toLocaleDateString()}</Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => handleDeleteEmployee(employee.id, employee.name)}
              >
                <Ionicons name="trash-outline" size={20} color="#E74C3C" />
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
    backgroundColor: '#F5F5F5',
  },
  header: {
    backgroundColor: BPCL_BLUE,
    paddingTop: 20,
    paddingBottom: 20,
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerSubtitle: {
    fontSize: 14,
    color: BPCL_YELLOW,
    marginTop: 4,
  },
  scrollView: {
    flex: 1,
    padding: 16,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 20,
    borderWidth: 2,
    borderColor: BPCL_BLUE,
    borderStyle: 'dashed',
  },
  addButtonText: {
    marginLeft: 8,
    fontSize: 16,
    fontWeight: '600',
    color: BPCL_BLUE,
  },
  addCard: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 8,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  addTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: BPCL_BLUE,
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    fontSize: 14,
  },
  addButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333333',
  },
  saveButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: BPCL_BLUE,
    alignItems: 'center',
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: BPCL_BLUE,
    marginBottom: 12,
    marginTop: 8,
  },
  employeeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderLeftWidth: 4,
    borderLeftColor: BPCL_BLUE,
  },
  employeeInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  employeeDetails: {
    marginLeft: 12,
    flex: 1,
  },
  employeeName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333333',
  },
  employeeDate: {
    fontSize: 12,
    color: '#999999',
    marginTop: 4,
  },
  deleteButton: {
    padding: 8,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyStateText: {
    marginTop: 12,
    fontSize: 16,
    color: '#999999',
    fontWeight: '500',
  },
});
