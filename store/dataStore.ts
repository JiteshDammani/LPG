import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ReconciliationReason {
  type: 'missing' | 'extra';
  reason: 'NC' | 'DBC' | 'TV' | 'Empty baki' | 'Empty Return';
  consumer_name?: string;
}

export interface Delivery {
  id: string;
  date: string;
  employee_name: string;
  cylinders_delivered: number;
  empty_received: number;
  online_payments: number;
  paytm_payments: number;
  partial_digital_amount: number;
  cash_collected: number;
  calculated_cash_cylinders: number;
  calculated_cash_amount: number;
  calculated_total_payable: number;
  reconciliation_status: 'pending' | 'complete';
  reconciliation_reasons: ReconciliationReason[];
  created_at: string;
}

export interface Employee {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
}

export interface Settings {
  cylinder_price: number;
  price_history: Array<{ date: string; price: number }>;
  updated_at: string;
}

interface DataStore {
  // Settings
  cylinderPrice: number;
  settings: Settings | null;
  loadSettings: () => Promise<void>;
  updateCylinderPrice: (price: number) => Promise<void>;

  // Employees
  employees: Employee[];
  loadEmployees: () => Promise<void>;
  addEmployee: (name: string) => Promise<void>;
  deleteEmployee: (id: string) => Promise<void>;

  // Deliveries
  deliveries: Delivery[];
  loadDeliveriesByDate: (date: string) => Promise<void>;
  addDelivery: (delivery: Omit<Delivery, 'id' | 'created_at'>) => Promise<void>;
  updateDelivery: (id: string, delivery: Partial<Delivery>) => Promise<void>;

  // Daily Summary
  dailySummary: any;
  loadDailySummary: (date: string) => Promise<void>;
}

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

export const useDataStore = create<DataStore>((set, get) => ({
  // Initial state
  cylinderPrice: 877.5,
  settings: null,
  employees: [],
  deliveries: [],
  dailySummary: null,

  // Settings actions
  loadSettings: async () => {
    try {
      // Try backend first
      const response = await fetch(`${BACKEND_URL}/api/settings`);
      if (response.ok) {
        const data = await response.json();
        set({ settings: data, cylinderPrice: data.cylinder_price });
        await AsyncStorage.setItem('settings', JSON.stringify(data));
      } else {
        // Fallback to local storage
        const localSettings = await AsyncStorage.getItem('settings');
        if (localSettings) {
          const data = JSON.parse(localSettings);
          set({ settings: data, cylinderPrice: data.cylinder_price });
        }
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      // Load from local storage
      const localSettings = await AsyncStorage.getItem('settings');
      if (localSettings) {
        const data = JSON.parse(localSettings);
        set({ settings: data, cylinderPrice: data.cylinder_price });
      } else {
        // Default settings
        const defaultSettings: Settings = {
          cylinder_price: 877.5,
          price_history: [{ date: new Date().toISOString(), price: 877.5 }],
          updated_at: new Date().toISOString(),
        };
        set({ settings: defaultSettings, cylinderPrice: 877.5 });
        await AsyncStorage.setItem('settings', JSON.stringify(defaultSettings));
      }
    }
  },

  updateCylinderPrice: async (price: number) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cylinder_price: price }),
      });

      if (response.ok) {
        await get().loadSettings();
      } else {
        // Update local storage
        const currentSettings = get().settings || {
          cylinder_price: price,
          price_history: [],
          updated_at: new Date().toISOString(),
        };
        const updatedSettings = {
          ...currentSettings,
          cylinder_price: price,
          price_history: [
            ...currentSettings.price_history,
            { date: new Date().toISOString(), price },
          ],
          updated_at: new Date().toISOString(),
        };
        set({ settings: updatedSettings, cylinderPrice: price });
        await AsyncStorage.setItem('settings', JSON.stringify(updatedSettings));
      }
    } catch (error) {
      console.error('Error updating price:', error);
    }
  },

  // Employee actions
  loadEmployees: async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/employees`);
      if (response.ok) {
        const data = await response.json();
        set({ employees: data });
        await AsyncStorage.setItem('employees', JSON.stringify(data));
      } else {
        const localEmployees = await AsyncStorage.getItem('employees');
        if (localEmployees) {
          set({ employees: JSON.parse(localEmployees) });
        }
      }
    } catch (error) {
      console.error('Error loading employees:', error);
      const localEmployees = await AsyncStorage.getItem('employees');
      if (localEmployees) {
        set({ employees: JSON.parse(localEmployees) });
      }
    }
  },

  addEmployee: async (name: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/employees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (response.ok) {
        await get().loadEmployees();
      } else {
        // Add to local storage
        const newEmployee: Employee = {
          id: Date.now().toString(),
          name,
          active: true,
          created_at: new Date().toISOString(),
        };
        const updatedEmployees = [...get().employees, newEmployee];
        set({ employees: updatedEmployees });
        await AsyncStorage.setItem('employees', JSON.stringify(updatedEmployees));
      }
    } catch (error) {
      console.error('Error adding employee:', error);
    }
  },

  deleteEmployee: async (id: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/employees/${id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        await get().loadEmployees();
      } else {
        const updatedEmployees = get().employees.filter((emp) => emp.id !== id);
        set({ employees: updatedEmployees });
        await AsyncStorage.setItem('employees', JSON.stringify(updatedEmployees));
      }
    } catch (error) {
      console.error('Error deleting employee:', error);
    }
  },

  // Delivery actions
  loadDeliveriesByDate: async (date: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/deliveries/date/${date}`);
      if (response.ok) {
        const data = await response.json();
        set({ deliveries: data });
      } else {
        const localKey = `deliveries_${date}`;
        const localDeliveries = await AsyncStorage.getItem(localKey);
        if (localDeliveries) {
          set({ deliveries: JSON.parse(localDeliveries) });
        } else {
          set({ deliveries: [] });
        }
      }
    } catch (error) {
      console.error('Error loading deliveries:', error);
      const localKey = `deliveries_${date}`;
      const localDeliveries = await AsyncStorage.getItem(localKey);
      if (localDeliveries) {
        set({ deliveries: JSON.parse(localDeliveries) });
      } else {
        set({ deliveries: [] });
      }
    }
  },

  addDelivery: async (delivery: Omit<Delivery, 'id' | 'created_at'>) => {
    try {
      console.log('addDelivery called with:', delivery);
      const response = await fetch(`${BACKEND_URL}/api/deliveries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(delivery),
      });

      console.log('API response status:', response.status);
      
      if (response.ok) {
        const result = await response.json();
        console.log('Delivery created successfully:', result);
        await get().loadDeliveriesByDate(delivery.date);
      } else {
        const errorText = await response.text();
        console.error('API error response:', errorText);
        // Save to local storage
        const newDelivery: Delivery = {
          ...delivery,
          id: Date.now().toString(),
          created_at: new Date().toISOString(),
        };
        console.log('Saving to local storage:', newDelivery);
        const localKey = `deliveries_${delivery.date}`;
        const existing = await AsyncStorage.getItem(localKey);
        const deliveries = existing ? JSON.parse(existing) : [];
        deliveries.push(newDelivery);
        await AsyncStorage.setItem(localKey, JSON.stringify(deliveries));
        set({ deliveries });
      }
    } catch (error) {
      console.error('Error adding delivery:', error);
      throw error;
    }
  },

  updateDelivery: async (id: string, delivery: Partial<Delivery>) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/deliveries/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(delivery),
      });

      if (response.ok) {
        const currentDelivery = get().deliveries.find((d) => d.id === id);
        if (currentDelivery) {
          await get().loadDeliveriesByDate(currentDelivery.date);
        }
      }
    } catch (error) {
      console.error('Error updating delivery:', error);
    }
  },

  // Daily summary
  loadDailySummary: async (date: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/deliveries/summary/${date}`);
      if (response.ok) {
        const data = await response.json();
        set({ dailySummary: data });
      }
    } catch (error) {
      console.error('Error loading summary:', error);
    }
  },
}));
