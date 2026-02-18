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

  // ============= SETTINGS =============
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

  // ============= EMPLOYEES (Fixed for APK) =============
  loadEmployees: async () => {
    try {
      const localData = await AsyncStorage.getItem(STORAGE_KEYS.EMPLOYEES);
      const allEmployees: Employee[] = localData ? JSON.parse(localData) : [];
      // Only show active employees in the UI state
      set({ employees: allEmployees.filter((emp) => emp.active) });
    } catch (error) {
      console.error('Error loading employees:', error);
      set({ employees: [] });
    }
  },

  addEmployee: async (name: string) => {
    try {
      // 1. Get current FULL list from storage (disk) to prevent overwriting
      const localData = await AsyncStorage.getItem(STORAGE_KEYS.EMPLOYEES);
      const fullList: Employee[] = localData ? JSON.parse(localData) : [];

      const newEmployee: Employee = {
        id: Date.now().toString(),
        name,
        active: true,
        created_at: new Date().toISOString(),
      };

      const updatedFullList = [...fullList, newEmployee];

      // 2. Persist the full master list to disk
      await AsyncStorage.setItem(STORAGE_KEYS.EMPLOYEES, JSON.stringify(updatedFullList));

      // 3. Update state with only active members for the UI
      set({ employees: updatedFullList.filter((emp) => emp.active) });
    } catch (error) {
      console.error('Error adding employee:', error);
      throw error;
    }
  },

  deleteEmployee: async (id: string) => {
    try {
      const localData = await AsyncStorage.getItem(STORAGE_KEYS.EMPLOYEES);
      const fullList: Employee[] = localData ? JSON.parse(localData) : [];

      // Soft delete: Mark as inactive in the master list
      const updatedFullList = fullList.map((emp) =>
        emp.id === id ? { ...emp, active: false } : emp
      );

      await AsyncStorage.setItem(STORAGE_KEYS.EMPLOYEES, JSON.stringify(updatedFullList));
      
      // Update UI state
      set({ employees: updatedFullList.filter((emp) => emp.active) });
    } catch (error) {
      console.error('Error deleting employee:', error);
      throw error;
    }
  },

  // ============= DELIVERIES =============
  loadDeliveriesByDate: async (date: string) => {
    try {
      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${date}`;
      const localDeliveries = await AsyncStorage.getItem(localKey);
      set({ deliveries: localDeliveries ? JSON.parse(localDeliveries) : [] });
    } catch (error) {
      console.error('Error loading deliveries:', error);
      set({ deliveries: [] });
    }
  },

  addDelivery: async (delivery: Omit<Delivery, 'id' | 'created_at'>) => {
    try {
      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${delivery.date}`;
      const existing = await AsyncStorage.getItem(localKey);
      const deliveries: Delivery[] = existing ? JSON.parse(existing) : [];

      const newDelivery: Delivery = {
        ...delivery,
        id: Date.now().toString(),
        created_at: new Date().toISOString(),
      };

      const updatedDeliveries = [...deliveries, newDelivery];
      await AsyncStorage.setItem(localKey, JSON.stringify(updatedDeliveries));
      set({ deliveries: updatedDeliveries });
    } catch (error) {
      console.error('Error adding delivery:', error);
      throw error;
    }
  },

  updateDelivery: async (id: string, deliveryUpdate: Partial<Delivery>) => {
    try {
      // Find the date of the delivery we want to update
      const currentDeliveries = get().deliveries;
      const target = currentDeliveries.find((d) => d.id === id);
      if (!target) return;

      const localKey = `${STORAGE_KEYS.DELIVERIES_PREFIX}${target.date}`;
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
      set({
        dailySummary: {
          total_cylinders_delivered: deliveries.reduce((sum, d) => sum + d.cylinders_delivered, 0),
          total_empty_received: deliveries.reduce((sum, d) => sum + d.empty_received, 0),
          total_online_payments: deliveries.reduce((sum, d) => sum + d.online_payments, 0),
          total_paytm_payments: deliveries.reduce((sum, d) => sum + d.paytm_payments, 0),
          total_partial_digital: deliveries.reduce((sum, d) => sum + d.partial_digital_amount, 0),
          total_cash_collected: deliveries.reduce((sum, d) => sum + d.cash_collected, 0),
        },
      });
    } catch (error) {
      console.error('Error loading summary:', error);
      set({ dailySummary: null });
    }
  },
}));
