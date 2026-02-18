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
  cylinderPrice: number;
  settings: Settings | null;
  loadSettings: () => Promise<void>;
  updateCylinderPrice: (price: number) => Promise<void>;
  employees: Employee[];
  loadEmployees: () => Promise<void>;
  addEmployee: (name: string) => Promise<void>;
  deleteEmployee: (id: string) => Promise<void>;
  deliveries: Delivery[];
  loadDeliveriesByDate: (date: string) => Promise<void>;
  addDelivery: (delivery: Omit<Delivery, 'id' | 'created_at'>) => Promise<void>;
  updateDelivery: (id: string, delivery: Partial<Delivery>) => Promise<void>;
  dailySummary: any;
  loadDailySummary: (date: string) => Promise<void>;
}

const STORAGE_KEYS = {
  SETTINGS: 'lpg_settings',
  EMPLOYEES: 'lpg_employees',
  DELIVERIES_PREFIX: 'lpg_deliveries_',
};

export const useDataStore = create<DataStore>((set, get) => ({
  cylinderPrice: 877.5,
  settings: null,
  employees: [],
  deliveries: [],
  dailySummary: null,

  loadSettings: async () => {
    try {
      const localSettings = await AsyncStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (localSettings) {
        const data = JSON.parse(localSettings);
        set({ settings: data, cylinderPrice: data.cylinder_price });
      } else {
        const defaultSettings: Settings = {
          cylinder_price: 877.5,
          price_history: [{ date: new Date().toISOString(), price: 877.5 }],
          updated_at: new Date().toISOString(),
        };
        set({ settings: defaultSettings, cylinderPrice: 877.5 });
        await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(defaultSettings));
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      set({ cylinderPrice: 877.5 });
    }
  },

  updateCylinderPrice: async (price: number) => {
    try {
      const currentSettings = get().settings || {
        cylinder_price: price,
        price_history: [],
        updated_at: new Date().toISOString(),
      };
      const updatedSettings: Settings = {
        ...currentSettings,
        cylinder_price: price,
        price_history: [...currentSettings.price_history, { date: new Date().toISOString(), price }],
        updated_at: new Date().toISOString(),
      };
      set({ settings: updatedSettings, cylinderPrice: price });
      await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updatedSettings));
    } catch (error) {
      console.error('Error updating price:', error);
    }
  },

  loadEmployees: async () => {
    try {
      const localEmployees = await AsyncStorage.getItem(STORAGE_KEYS.EMPLOYEES);
      if (localEmployees) {
        const employees = JSON.parse(localEmployees);
        set({ employees: employees.filter((emp: Employee) => emp.active) });
      } else {
        set({ employees: [] });
      }
    } catch (error) {
      console.error('Error loading employees:', error);
      set({ employees: [] });
    }
  },

  addEmployee: async (name: string) => {
    try {
      const newEmployee: Employee = {
        id: Date.now().toString(),
        name,
        active: true,
        created_at: new Date().toISOString(),
      };
      const updatedEmployees = [...get().employees, newEmployee];
      set({ employees: updatedEmployees });
      await AsyncStorage.setItem(STORAGE_KEYS.EMPLOYEES, JSON.stringify(updatedEmployees));
    } catch (error) {
      console.error('Error adding employee:', error);
      throw error;
    }
  },

  deleteEmployee: async (id: string) => {
    try {
      const updatedEmployees = get().employees.map((emp) =>
        emp.id === id ? { ...emp, active: false } : emp
      );
      set({ employees: updatedEmployees.filter((emp) => emp.active) });
      await AsyncStorage.setItem(STORAGE_KEYS.EMPLOYEES, JSON.stringify(updatedEmployees));
    } catch (error) {
      console.error('Error deleting employee:', error);
      throw error;
    }
  },

  loadDeliveriesByDate: async (date: string) => {
    try {
      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${date}`;
      const localDeliveries = await AsyncStorage.getItem(localKey);
      if (localDeliveries) {
        set({ deliveries: JSON.parse(localDeliveries) });
      } else {
        set({ deliveries: [] });
      }
    } catch (error) {
      console.error('Error loading deliveries:', error);
      set({ deliveries: [] });
    }
  },

  addDelivery: async (delivery: Omit<Delivery, 'id' | 'created_at'>) => {
    try {
      const newDelivery: Delivery = {
        ...delivery,
        id: Date.now().toString(),
        created_at: new Date().toISOString(),
      };
      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${delivery.date}`;
      const existing = await AsyncStorage.getItem(localKey);
      const deliveries = existing ? JSON.parse(existing) : [];
      deliveries.push(newDelivery);
      await AsyncStorage.setItem(localKey, JSON.stringify(deliveries));
      set({ deliveries });
    } catch (error) {
      console.error('Error adding delivery:', error);
      throw error;
    }
  },

  updateDelivery: async (id: string, deliveryUpdate: Partial<Delivery>) => {
    try {
      const currentDelivery = get().deliveries.find((d) => d.id === id);
      if (!currentDelivery) return;
      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${currentDelivery.date}`;
      const existing = await AsyncStorage.getItem(localKey);
      if (existing) {
        const deliveries: Delivery[] = JSON.parse(existing);
        const updatedDeliveries = deliveries.map((d) =>
          d.id === id ? { ...d, ...deliveryUpdate } : d
        );
        await AsyncStorage.setItem(localKey, JSON.stringify(updatedDeliveries));
        set({ deliveries: updatedDeliveries });
      }
    } catch (error) {
      console.error('Error updating delivery:', error);
      throw error;
    }
  },

  loadDailySummary: async (date: string) => {
    try {
      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${date}`;
      const localDeliveries = await AsyncStorage.getItem(localKey);
      if (!localDeliveries) {
        set({
          dailySummary: {
            total_cylinders_delivered: 0,
            total_empty_received: 0,
            total_online_payments: 0,
            total_paytm_payments: 0,
            total_partial_digital: 0,
            total_cash_collected: 0,
          },
        });
        return;
      }
      const deliveries: Delivery[] = JSON.parse(localDeliveries);
      const summary = {
        total_cylinders_delivered: deliveries.reduce((sum, d) => sum + d.cylinders_delivered, 0),
        total_empty_received: deliveries.reduce((sum, d) => sum + d.empty_received, 0),
        total_online_payments: deliveries.reduce((sum, d) => sum + d.online_payments, 0),
        total_paytm_payments: deliveries.reduce((sum, d) => sum + d.paytm_payments, 0),
        total_partial_digital: deliveries.reduce((sum, d) => sum + d.partial_digital_amount, 0),
        total_cash_collected: deliveries.reduce((sum, d) => sum + d.cash_collected, 0),
      };
      set({ dailySummary: summary });
    } catch (error) {
      console.error('Error loading summary:', error);
      set({ dailySummary: null });
    }
  },
}));
