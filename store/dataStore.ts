import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import { format } from 'date-fns';

// ====================== FORCE RELOAD CHECK ======================
console.log(
  '📦 dataStore.ts FILE HAS BEEN LOADED AT:',
  new Date().toISOString()
);
// ============================================================



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

/*export interface Employee {
  id: string;
  name: string;
  active: boolean;
  created_at?: string;
}*/

export interface Settings {
  cylinder_price: number;
  price_history: Array<{ date: string; price: number }>;
  updated_at: string;
}

/*export interface TransactionRecord {
  date: string;
  transactions: 'CREDIT' | 'DEBIT';
  category: string;
  rate: number;
  quantity: number;
  amount: number;
  remarks?: string;
  paytm_transaction: boolean;
}

interface DataStoreState {
  // ... your other state variables ...
  activeConsumers: any[];
  loadingConsumers: boolean;
  loadActiveConsumers: () => Promise<void>;
  addComplaint: (payload: {
    consumer_id: number; // Stored as dashboard_activeconsumer.consumer (bigint)
    complaint_type: string;
    delivery_boy_name: string | null;
    remarks: string | null;
    resolved: boolean;
  }) => Promise<void>;
}*/

export const useDataStore = create<any>((set, get) => ({
  // ─── Core State ───────────────────────────────────────────────
  cylinderPrice: 877.5,
  settings: null,
  employees: [],
  loadingEmployees: false,
  deliveries: [],
  dailySummary: null,

  currentUser: null as any,
  setCurrentUser: (user: any) => set({ currentUser: user }),

  allowedPages: [] as string[],
  setAllowedPages: (pages: string[]) => set({ allowedPages: pages }),

  pagePermissions: [] as import('../hooks/usePermissions').PagePermission[],
  setPagePermissions: (
    perms: import('../hooks/usePermissions').PagePermission[]
  ) => set({ pagePermissions: perms }),

  discountEnabled: true,
  extraPaytmCreditAmount: 0,

  // ─── Transaction State ────────────────────────────────────────
  categories: [],
  loadingCategories: false,
  balanceNames: [],
  loadingBalanceNames: false,
  balanceDetails: [],
  loadingBalanceDetails: false,

  // ─── Payroll State ────────────────────────────────────────────
  unpaidSalaryNames: [],
  loadingUnpaidSalaryNames: false,
  loadingSalaryDetails: false,

  // ─── Totals State ─────────────────────────────────────────────
  transactionCreditTotal: 0,
  transactionDebitTotal: 0,
  transactionCreditEntries: [],
  transactionDebitEntries: [],
  loadingTransactionTotals: false,

  // ─── Commercial Bank Payment State ────────────────────────────
  commercialCustomers: [],
  loadingCommercialCustomers: false,
  commercialRates: [],
  loadingCommercialRates: false,

  /* ================= SETTINGS ================= */
  loadSettings: async () => {
    const local = await AsyncStorage.getItem('settings');
    if (local) {
      const data = JSON.parse(local);
      set({ settings: data, cylinderPrice: data.cylinder_price });
    }
  },

  loadDiscountSetting: async () => {
    const val = await AsyncStorage.getItem('commercial_discount_enabled');
    if (val !== null) {
      set({ discountEnabled: val === 'true' });
    }
  },

  saveDiscountSetting: async (val: boolean) => {
    set({ discountEnabled: val });
    await AsyncStorage.setItem(
      'commercial_discount_enabled',
      val ? 'true' : 'false'
    );
  },

  updateCylinderPrice: async (price: number) => {
    const existing = await AsyncStorage.getItem('settings');
    const current = existing ? JSON.parse(existing) : { price_history: [] };

    const updated = {
      cylinder_price: price,
      price_history: [
        ...(current.price_history || []),
        { date: new Date().toISOString(), price },
      ],
      updated_at: new Date().toISOString(),
    };

    set({ settings: updated, cylinderPrice: price });
    await AsyncStorage.setItem('settings', JSON.stringify(updated));
  },

  /* ================= STAFF ================= */
  loadEmployees: async () => {
    set({ loadingEmployees: true });
    try {
      const { data, error } = await supabase
        .from('dashboard_deliveryboyname')
        .select('name')
        .order('name', { ascending: true });

      if (error) throw error;

      const staffNames = data?.map((item: any) => item.name) || [];
      set({ employees: staffNames, loadingEmployees: false });
      await AsyncStorage.setItem('employees', JSON.stringify(staffNames));
      console.log('✅ Loaded', staffNames.length, 'staff names');
    } catch (err) {
      console.error('Load employees failed:', err);
      set({ loadingEmployees: false });
    }
  },

  getUnprocessedBankEntries: async (category: string) => {
    const { data, error } = await supabase
      .from('dashboard_otherbankentries')
      .select('id, statement_date, amount, category, account_no, narration, is_processed')
      .eq('category', category)
      .eq('is_processed', false)
      .order('statement_date', { ascending: true });
    if (error) throw error;
    return (data || []).map((row: any) => ({ ...row, date: row.statement_date }));
  },

  markBankEntryProcessed: async (id: string) => {
    const { error } = await supabase
      .from('dashboard_otherbankentries')
      .update({ is_processed: true })
      .eq('id', id);
    if (error) throw error;
  },

  getCommercialPaymentsByDate: async (date: string) => {
    try {
      const { data, error } = await supabase
        .from('commercial_bank_payments')
        .select('id, transaction_date, customer_name, bank_name, quantity, amount, remarks')
        .eq('transaction_date', date)
        .order('id', { ascending: true });

      if (error) throw error;
      console.log(`✅ Loaded ${data?.length || 0} payments for date ${date}`);
      return data || [];
    } catch (err: any) {
      console.error('❌ Error fetching payments by date:', err.message);
      return [];
    }
  },

  checkCommercialBankPaymentExists: async (
    customerName: string,
    transactionDate: string,
    amount: number,
  ) => {
    const { data, error } = await supabase
      .from('commercial_bank_payments')
      .select('id')
      .eq('customer_name', customerName)
      .eq('transaction_date', transactionDate)
      .eq('amount', amount)
      .limit(1);
    if (error) throw error;
    return (data && data.length > 0);
  },


  /* ================= TRANSACTION FUNCTIONS ================= */
  loadTransactionCategories: async (type: 'CREDIT' | 'DEBIT') => {
    set({ loadingCategories: true, categories: [] });
    try {
      const { data, error } = await supabase
        .from('dashboard_transactionstables')
        .select('category')
        .eq('transaction', type)
        .order('category');

      if (error) throw error;
      const list = data?.map((item: any) => item.category) || [];
      set({ categories: list, loadingCategories: false });
    } catch (err) {
      console.error('Error loading categories:', err);
      set({ loadingCategories: false });
    }
  },

  /* ================= BALANCE DROPDOWNS ================= */
  loadBalanceNames: async (type: 'CREDIT' | 'DEBIT') => {
    set({ loadingBalanceNames: true, balanceNames: [] });
    try {
      if (type === 'DEBIT') {
        const { employees } = get() as any;
        set({ balanceNames: employees, loadingBalanceNames: false });
      } else {
        const today = new Date();
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(today.getDate() - 60);

        const fromDate = format(sixtyDaysAgo, 'yyyy-MM-dd');
        const toDate = format(today, 'yyyy-MM-dd');

        console.log(
          `🔍 CREDIT+BALANCE: Fetching closed names (status=true) from ${fromDate}`
        );

        const { data, error } = await supabase
          .from('dashboard_debitbalancereport')
          .select('name')
          .eq('status', false)
          .gte('date', fromDate)
          .lte('date', toDate)
          .limit(10000);

        if (error) throw error;

        const names = [
          ...new Set(
            data?.map((item: any) => item.name?.trim()) || []
          ),
        ]
          .filter(Boolean)
          .sort() as string[];

        console.log(`✅ Loaded ${names.length} closed balance names:`, names);
        set({ balanceNames: names, loadingBalanceNames: false });
      }
    } catch (err: any) {
      console.error('❌ Error loading balance names:', err.message);
      set({ loadingBalanceNames: false });
    }
  },

  loadBalanceDetails: async (
    name: string,
    type: 'CREDIT' | 'DEBIT' = 'DEBIT'
  ) => {
    set({ loadingBalanceDetails: true, balanceDetails: [] });
    try {
      const isCredit = type === 'CREDIT';
      console.log(`🔍 Fetching details for ${name} | isCredit: ${isCredit}`);
      console.log('🔍 loadBalanceDetails called with name:', JSON.stringify(name), 'type:', type);
      const lookupName = name.includes('NAMDEV') && name.includes('19KG') ? 'NAMDEV' : name;

      console.log('🔍 loadBalanceDetails lookupName:', lookupName);
      const { data, error } = await supabase
        .from('dashboard_debitbalancereport')
        .select('id, amount, date, amount_rec, date_received')
        .eq('name', lookupName)
        .eq('status', false)
        .order('date', { ascending: false })
        .limit(1000);

      if (error) throw error;

      console.log(`✅ Loaded details for ${name}:`, data);
      set({ balanceDetails: data || [], loadingBalanceDetails: false });
    } catch (err: any) {
      console.error('❌ Error loading balance details:', err.message);
      set({ loadingBalanceDetails: false });
    }
  },

  /* ================= WEEKLY SALARY AUTOMATION ================= */
  loadUnpaidSalaryNames: async () => {
    set({ loadingUnpaidSalaryNames: true, unpaidSalaryNames: [] });
    try {
      const { data: delData, error: delErr } = await supabase
        .from('dashboard_deliveryrecords')
        .select('name')
        .eq('commission_given', false)
        .order('date', { ascending: false })
        .limit(10000);

      if (delErr) throw delErr;

      const { data: commData, error: commErr } = await supabase
        .from('dashboard_commisionrate')
        .select('*');

      if (commErr)
        console.error(
          '❌ Error fetching commission rates for filter:',
          commErr.message
        );

      const commissionedStaff = new Set<string>();
      if (commData) {
        commData.forEach((row: any) => {
          const rawRate =
            row.commission ??
            row.Commission ??
            row.COMMISSION ??
            row.rate ??
            row.RATE ??
            0;
          if (Number(rawRate) > 0 && row.name) {
            commissionedStaff.add(row.name.trim());
          }
        });
      }

      const rawNames =
        delData?.map((item: any) => item.name?.trim()) || [];
      const filteredNames = rawNames.filter((name: string) =>
        commissionedStaff.has(name)
      );
      const uniqueNames = [...new Set(filteredNames)].sort() as string[];

      const { data: namdevData } = await supabase
        .from('dashboard_commercialrecords')
        .select('id')
        .eq('delivery_boy', 'NAMDEV')
        .eq('commision_given', false)
        .limit(1);
      console.log('🔍 NAMDEV commercial check:', namdevData, 'length:', namdevData?.length);

      if (namdevData && namdevData.length > 0) {
        uniqueNames.push('NAMDEV 19KG');
        uniqueNames.sort();
      }

      set({
        unpaidSalaryNames: uniqueNames,
        loadingUnpaidSalaryNames: false,
      });
      console.log(
        `✅ Dynamic Filter: Loaded ${uniqueNames.length} active commissioned delivery boys:`,
        uniqueNames
      );
    } catch (err: any) {
      console.error('💥 Error loadUnpaidSalaryNames:', err.message);
      set({ loadingUnpaidSalaryNames: false });
    }
  },

  loadSalaryDetails: async (name: string, upToDate?: string) => {
    set({ loadingSalaryDetails: true });
    try {
      console.log(`🔍 Calculating salary for: "${name}" up to date: ${upToDate || 'all'}`);

      let totalQty = 0;

      if (name === 'NAMDEV 19KG') {
        let commercialQuery = supabase
          .from('dashboard_commercialrecords')
          .select('id')
          .eq('delivery_boy', 'NAMDEV')
          .eq('commision_given', false)
          .limit(10000);

        if (upToDate) {
          commercialQuery = commercialQuery.lt('delivery_date', upToDate);
        }

        const { data: commercialData, error: commercialErr } = await commercialQuery;
        if (commercialErr) throw commercialErr;

        totalQty = commercialData?.length || 0;

      } else {
        let query = supabase
            .from('dashboard_deliveryrecords')
            .select('number')
            .eq('name', name)
            .eq('commission_given', false)
            .limit(10000);

        if (upToDate) {
          const upto = new Date(upToDate);
          upto.setDate(upto.getDate() - 1);
          const oneDayBefore = format(upto, 'yyyy-MM-dd');
          query = query.lte('date', oneDayBefore);
        }

        const {data: delData, error: delErr} = await query;
        if (delErr) throw delErr;

        totalQty =
            delData?.reduce(
                (sum: number, row: any) => sum + Number(row.number || 0),
                0
            ) || 0;
      }

      console.log(
        `🔍 Fetching commission rate for "${name}" from dashboard_commisionrate`
      );

      const commName = name === 'NAMDEV 19KG' ? 'NAMDEV 19KG' : name;
      const { data: commData, error: commErr } = await supabase
        .from('dashboard_commisionrate')
        .select('*')
        .eq('name', commName);

      if (commErr)
        console.error('❌ Commission rate fetch error:', commErr.message);

      console.log(`📊 Raw commission DB row for ${name}:`, commData);

      let rate = 0;
      if (commData && commData.length > 0) {
        const row = commData[0];
        const rawRate =
          row.commission ??
          row.Commission ??
          row.COMMISSION ??
          row.rate ??
          row.RATE ??
          0;
        rate = Number(rawRate);
      } else {
        console.warn(
          `⚠️ No commission rate row found for employee "${name}" in dashboard_commisionrate table.`
        );
      }

      console.log(
        `✅ Final Salary Calculated -> Name: ${name} | Qty: ${totalQty} | Rate: ${rate} | UpTo: ${upToDate}`
      );
      set({ loadingSalaryDetails: false });
      return { rate, quantity: totalQty };
    } catch (err: any) {
      console.error('💥 Error loadSalaryDetails:', err.message);
      set({ loadingSalaryDetails: false });
      return { rate: 0, quantity: 0 };
    }
  },

  deleteTransaction: async (transactionId: number) => {
    try {
      const { data: txn, error: fetchErr } = await supabase
        .from('dashboard_dailyrecordsachin')
        .select('*')
        .eq('id', transactionId)
        .single();

      if (fetchErr) throw fetchErr;

      // ── DEBIT + BALANCE: use debit_balance_report_id to delete directly ──
      if (txn.transactions === 'DEBIT' && txn.category === 'BALANCE') {
        if (txn.debit_balance_report_id && txn.debit_balance_report_id !== 0) {
          // Direct delete using the stored ID — fast and accurate
          const { error: delBalErr } = await supabase
            .from('dashboard_debitbalancereport')
            .delete()
            .eq('id', txn.debit_balance_report_id);

          if (delBalErr) throw delBalErr;
          console.log(`✅ Deleted debitbalancereport row id=${txn.debit_balance_report_id}`);
        } else {
          // Fallback: match by name + date + amount (old rows without the id)
          const { error: delBalErr } = await supabase
            .from('dashboard_debitbalancereport')
            .delete()
            .eq('name', txn.remarks)
            .eq('date', txn.date)
            .eq('amount', txn.amount);

          if (delBalErr) throw delBalErr;
        }
      }

      // ── CREDIT + BALANCE: use debit_balance_report_id to reverse directly ──
      if (txn.transactions === 'CREDIT' && txn.category === 'BALANCE') {
        let targetId: number | null = null;

        if (txn.debit_balance_report_id && txn.debit_balance_report_id !== 0) {
          // Direct lookup using the stored ID
          targetId = txn.debit_balance_report_id;
        } else {
          // Fallback: match by name from remarks (old rows without the id)
          const nameMatch = txn.remarks?.split('(')[0]?.trim();
          const { data: balRows, error: findErr } = await supabase
            .from('dashboard_debitbalancereport')
            .select('id, amount_rec, date_received, amount')
            .eq('name', nameMatch)
            .order('date', { ascending: false })
            .limit(10);

          if (findErr) throw findErr;

          const targetRow = balRows?.find((row: any) =>
            row.date_received?.includes(txn.date)
          );
          if (targetRow) targetId = targetRow.id;
        }

        if (targetId) {
          const { data: balRow, error: fetchBalErr } = await supabase
            .from('dashboard_debitbalancereport')
            .select('amount_rec, date_received, amount')
            .eq('id', targetId)
            .single();

          if (fetchBalErr) throw fetchBalErr;

          const newAmountRec = Math.max(0, Number(balRow.amount_rec || 0) - txn.amount);

          const dates = (balRow.date_received || '')
            .split(',')
            .map((d: string) => d.trim())
            .filter((d: string) => d !== txn.date);

          const newDateReceived = dates.length > 0 ? dates.join(', ') : null;
          const originalAmount = Number(balRow.amount || 0);

          const { error: reverseErr } = await supabase
            .from('dashboard_debitbalancereport')
            .update({
              amount_rec: newAmountRec,
              date_received: newDateReceived,
              status: newAmountRec >= originalAmount,
              approve_status: false,
            })
            .eq('id', targetId);

          if (reverseErr) throw reverseErr;
          console.log(`✅ Reversed credit on debitbalancereport row id=${targetId}`);
        }
      }

      // Finally delete from dailyrecordsachin
      const { error: delErr } = await supabase
        .from('dashboard_dailyrecordsachin')
        .delete()
        .eq('id', transactionId);

      if (delErr) throw delErr;

      return true;
    } catch (err) {
      console.error('deleteTransaction failed:', err);
      throw err;
    }
  },

  /* ================= SUBMIT TRANSACTION ================= */
  addTransaction: async (data: any) => {
    try {
      let debitBalanceReportId = 0;

      // ── DEBIT + BALANCE ──────────────────────────────────────────────
      // Step 1: Insert into debitbalancereport FIRST to get the new row ID
      if (data.transactions === 'DEBIT' && data.category === 'BALANCE') {
        const { data: newBalRow, error: balInsertError } = await supabase
          .from('dashboard_debitbalancereport')
          .insert({
            date: data.date,
            name: data.remarks,       // remarks = employee name
            amount: data.amount,
            status: false,
            date_received: null,
            amount_rec: null,
            approve_status: false,
          })
          .select('id')
          .single();

        if (balInsertError) throw balInsertError;

        // Capture the new debitbalancereport row ID
        debitBalanceReportId = newBalRow?.id ?? 0;
        console.log(`✅ Created debitbalancereport row id=${debitBalanceReportId} for DEBIT+BALANCE`);
      }

      // ── CREDIT + BALANCE ─────────────────────────────────────────────
      // The balanceId passed in IS the debitbalancereport row we're updating
      if (data.transactions === 'CREDIT' && data.category === 'BALANCE' && data.balanceId) {
        debitBalanceReportId = data.balanceId;

        // Fetch current row
        const { data: existingRow, error: fetchErr } = await supabase
          .from('dashboard_debitbalancereport')
          .select('amount_rec, date_received, amount')
          .eq('id', data.balanceId)
          .single();

        if (fetchErr) throw fetchErr;

        const currentAmountRec = Number(existingRow.amount_rec || 0);
        const newAmountRec = currentAmountRec + data.amount;
        const originalAmount = Number(existingRow.amount || 0);

        const existingDates = existingRow.date_received;
        const newDateReceived = existingDates
          ? `${existingDates}, ${data.date}`
          : data.date;

        const { error: updateErr } = await supabase
          .from('dashboard_debitbalancereport')
          .update({
            amount_rec: newAmountRec,
            date_received: newDateReceived,
            status: newAmountRec >= originalAmount,
            approve_status: false,
          })
          .eq('id', data.balanceId);

        if (updateErr) throw updateErr;
        console.log(`✅ Updated debitbalancereport row id=${debitBalanceReportId} for CREDIT+BALANCE`);
      }

      // ── INSERT into dailyrecordsachin with debit_balance_report_id ───
      // Step 2: Now insert the main transaction row, linking the balance report ID
      const { error: insertError } = await supabase
        .from('dashboard_dailyrecordsachin')
        .insert({
          date: data.date,
          transactions: data.transactions,
          category: data.category,
          rate: data.rate,
          quantity: data.quantity,
          amount: data.amount,
          remarks: data.remarks,
          paytm_transaction: data.paytm_transaction || false,
          check_done: false,
          debit_balance_report_id: debitBalanceReportId, // 0 for all non-BALANCE categories
        });

      if (insertError) throw insertError;

      // ── WEEKLY SALARY: mark deliveries as commission_given ───────────
      if (data.isSalaryUpdate && data.salaryName) {
        if (data.salaryName === 'NAMDEV 19KG') {
          const { error: salError } = await supabase
            .from('dashboard_commercialrecords')
            .update({ commision_given: true })
            .eq('delivery_boy', 'NAMDEV')
            .eq('commision_given', false)
            .lt('delivery_date', data.date);
          if (salError) throw salError;
        } else {
          const { error: salError } = await supabase
            .from('dashboard_deliveryrecords')
            .update({ commission_given: true })
            .eq('name', data.salaryName)
            .eq('commission_given', false)
            .lt('date', data.date);
          if (salError) throw salError;
        }
      }

      return true;
    } catch (err) {
      console.error('Add transaction failed:', err);
      throw err;
    }
  },

  addComplaint: async (payload: any) => {
  try {
    const { data, error } = await supabase
      .from('dashboard_complaintregister')
      .insert([{
        consumer_id: payload.consumer_id,
        complaint_type: payload.complaint_type,
        delivery_boy_name: payload.delivery_boy_name,
        remarks: payload.remarks,
        resolved: payload.resolved,
      }])
      .select();

    if (error) throw error;

    // ── Send push notification to all registered devices ──
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token');


    console.log('📲 Tokens found:', tokens);

    if (tokens && tokens.length > 0) {
      const messages = tokens.map((t: any) => ({
        to: t.token,
        sound: 'default',
        title: '🚨 New Complaint Registered',
        body: `${payload.complaint_type} — ${payload.remarks || 'No remarks'}`,
        data: { consumer_id: payload.consumer_id },
      }));

      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
    }

    console.log('✅ Complaint registered + notifications sent');
  } catch (err: any) {
    console.error('❌ Error registering complaint:', err.message);
    throw err;
  }
},

  /* ================= COMMERCIAL BANK PAYMENT FUNCTIONS ================= */
  loadCommercialCustomers: async () => {
    set({ loadingCommercialCustomers: true });
    try {
      const { data, error } = await supabase
        .from('dashboard_customername')
        .select('name, discount')
        .order('name');

      if (error) throw error;
      set({ commercialCustomers: data || [] });
      console.log('✅ Loaded', data?.length || 0, 'commercial customers');
    } catch (err: any) {
      console.error('❌ Error loading commercial customers:', err.message);
    } finally {
      set({ loadingCommercialCustomers: false });
    }
  },

  // State variables to initialize
  activeConsumers: [],
  loadingConsumers: false,

  // Replace or add this inside your useDataStore definition



  // inside store/dataStore.ts

  searchActiveConsumers: async (searchQuery: string) => {
    set({ loadingConsumers: true });
    try {
      let query = supabase
        .from('dashboard_activeconsumer')
        .select('id, consumer, consumer_name, no_of_cylinders, mobile_number, address, LPG_id');

      const cleanQuery = searchQuery.trim();

      if (cleanQuery.length > 0) {
        const isNumeric = /^\d+$/.test(cleanQuery);

        if (isNumeric) {
          const numericVal = parseInt(cleanQuery, 10);
          // Search names containing digits, OR check if consumer or mobile matches exactly
          query = query.or(
            `consumer_name.ilike.%${cleanQuery}%,consumer.eq.${numericVal},mobile_number.eq.${numericVal}`
          );
        } else {
          // If search is alphabetical, query consumer_name
          query = query.ilike('consumer_name', `%${cleanQuery}%`);
        }
      }

      const { data, error } = await query
        .order('consumer_name')
        .limit(50);

      if (error) throw error;
      set({ activeConsumers: data || [] });
    } catch (err: any) {
      console.error('❌ Error searching active consumers:', err.message);
    } finally {
      set({ loadingConsumers: false });
    }
  },

  // Add these to your useDataStore actions

  unresolvedComplaints: [],
  loadingComplaints: false,

  loadComplaints: async (showResolved: boolean, dateStr?: string) => {
    set({ loadingComplaints: true });
    try {
      let query = supabase
        .from('dashboard_complaintregister')
        .select('id, consumer_id, complaint_type, delivery_boy_name, complaint_date, resolved, resolved_date, remarks');

      if (showResolved) {
        query = query.eq('resolved', true);
        if (dateStr) {
          // Filter by date range (start of day to end of day in local ISO)
          const startOfDay = `${dateStr}T00:00:00.000Z`;
          const endOfDay = `${dateStr}T23:59:59.999Z`;
          query = query.gte('resolved_date', startOfDay).lte('resolved_date', endOfDay);
        }
      } else {
        query = query.eq('resolved', false);
      }

      // Fetch complaints
      const { data: complaints, error: compError } = await query
        .order('complaint_date', { ascending: false });

      if (compError) {
        console.error('❌ Error fetching complaints:', compError.message);
        throw compError;
      }

      // If there are no complaints, clear list and exit early
      if (!complaints || complaints.length === 0) {
        set({ unresolvedComplaints: [] });
        return;
      }

      // BATCH LOOKUP: Extract only the unique consumer IDs present in the fetched complaints
      const uniqueConsumerIds = Array.from(
        new Set(complaints.map((c: any) => Number(c.consumer_id)))
      );

      let consumers: any[] = [];

      // Only fetch the specific consumers we need from activeconsumers (extremely fast!)
      if (uniqueConsumerIds.length > 0) {
        const { data: fetchedConsumers, error: consError } = await supabase
          .from('dashboard_activeconsumer')
          .select('id, consumer, consumer_name, mobile_number, address, LPG_id')
          .in('consumer', uniqueConsumerIds);

        if (consError) {
          console.error('❌ Error fetching matched consumers:', consError.message);
          throw consError;
        }
        consumers = fetchedConsumers || [];
      }

      // Stitch complaints with their fetched consumers in memory
      const formatted = complaints.map((comp: any) => {
        const matchedConsumer = consumers.find((c: any) =>
          Number(c.consumer) === Number(comp.consumer_id)
        );

        return {
          ...comp,
          consumer_name: matchedConsumer?.consumer_name || 'अज्ञात उपभोक्ता (Unknown)',
          mobile_number: matchedConsumer?.mobile_number || 'N/A',
          address: matchedConsumer?.address || 'N/A',
          LPG_id: matchedConsumer?.LPG_id || '0',
        };
      });

      set({ unresolvedComplaints: formatted });
      console.log(`✅ Loaded ${formatted.length} complaints with matched consumer profiles`);

    } catch (err: any) {
      console.error('❌ Error loading complaints:', err.message || err);
      set({ unresolvedComplaints: [] });
    } finally {
      set({ loadingComplaints: false });
    }
  },

  // 2. Resolve a complaint and optionally spawn a new cylinder change request
  resolveAndSyncComplaint: async (
    complaintId: number,
    resolutionReason: string,
    shouldSpawnCylinderRequest: boolean,
    consumerId: number
  ) => {
    try {
      const now = new Date().toISOString();

      // Step A: Mark the current complaint as resolved
      const { error: resolveError } = await supabase
        .from('dashboard_complaintregister')
        .update({
          resolved: true,
          resolved_date: now,
          remarks: resolutionReason
        })
        .eq('id', complaintId);

      if (resolveError) throw resolveError;

      // Step B: Automatically create a new complaint with cylinder change request if triggered
      if (shouldSpawnCylinderRequest) {
        const { error: spawnError } = await supabase
          .from('dashboard_complaintregister')
          .insert([
            {
              consumer_id: consumerId,
              complaint_type: 'cylinder change request',
              remarks: `Auto-generated via resolved leakage complaint: ${resolutionReason}`,
              resolved: false
            }
          ]);

        if (spawnError) throw spawnError;
        console.log('✅ Spawner generated new cylinder change request');
      }

      // Refresh local list
      const store = get() as any;
      if (store.loadUnresolvedComplaints) {
        await store.loadUnresolvedComplaints();
      }
    } catch (err: any) {
      console.error('❌ Error updating and syncing complaint:', err.message);
      throw err;
    }
  },

  /* Action to insert a new complaint into 'dashboard_complaintregister'
  addComplaint: async (payload: any) => {
    try {
      const { data, error } = await supabase
        .from('dashboard_complaintregister')
        .insert([
          {
            consumer_id: payload.consumer_id,
            complaint_type: payload.complaint_type,
            delivery_boy_name: payload.delivery_boy_name,
            remarks: payload.remarks,
            resolved: payload.resolved,
          },
        ])
        .select();

      if (error) throw error;
      console.log('✅ Complaint registered successfully in Supabase');
    } catch (err: any) {
      console.error('❌ Error registering complaint:', err.message);
      throw err;
    }
  },

   */

  // Add this action to your useDataStore definition
  addActiveConsumer: async (newConsumer: {
    consumer: number;
    consumer_name: string;
    mobile_number: number;
    address: string;
    LPG_id: number;
    no_of_cylinders: number;
  }) => {
    try {
      const { data, error } = await supabase
        .from('dashboard_activeconsumer')
        .insert([newConsumer])
        .select();

      if (error) throw error;
      console.log('✅ New consumer added to Supabase:', data);

      // Refresh local list so the new customer is now searchable
      const store = get() as any;
      if (store.loadActiveConsumers) {
        await store.loadActiveConsumers();
      }
      return data;
    } catch (err: any) {
      console.error('❌ Error adding active consumer:', err.message);
      throw err;
    }
  },

  loadCommercialRates: async () => {
    set({ loadingCommercialRates: true });
    try {
      const { data, error } = await supabase
        .from('dashboard_commercialrate')
        .select('*')
        .order('start_date');

      if (error) throw error;
      set({ commercialRates: data || [] });
      console.log('✅ Loaded', data?.length || 0, 'commercial rate periods');
    } catch (err: any) {
      console.error('❌ Error loading commercial rates:', err.message);
    } finally {
      set({ loadingCommercialRates: false });
    }
  },

  getPendingCommercialRecords: async (customerName: string, startDate: string, endDate: string) => {
    try {
      const { data, error } = await supabase
        .from('dashboard_commercialrecords')
        .select('*')
        .eq('customer_name', customerName)
        .gte('delivery_date', startDate)
        .lte('delivery_date', endDate)
        .is('payment_date', null)
        .order('delivery_date');

      if (error) throw error;
      console.log(`✅ Found ${data?.length || 0} pending commercial records for ${customerName}`);
      return data || [];
    } catch (err: any) {
      console.error('❌ Error getting pending commercial records:', err.message);
      return [];
    }
  },

  addCommercialBankPayment: async (payment: any) => {
    try {
      const { error } = await supabase
        .from('commercial_bank_payments')
        .insert([payment]);

      if (error) throw error;
      console.log('✅ Commercial bank payment recorded successfully');
    } catch (err: any) {
      console.error('❌ Error adding commercial bank payment:', err.message);
      throw err;
    }
  },

  updateCommercialRecordsPayment: async (recordIds: number[], paymentDate: string, amount: number) => {
    try {
      const { error } = await supabase
        .from('dashboard_commercialrecords')
        .update({
          payment_date: paymentDate,
          amount: amount
        })
        .in('id', recordIds);

      if (error) throw error;
      console.log(`✅ Updated ${recordIds.length} commercial records with payment info`);
    } catch (err: any) {
      console.error('❌ Error updating commercial records:', err.message);
      throw err;
    }
  },

  updateBankBalance: async (bankName: string, date: string, creditAmount: number, remarks: string) => {
    try {
      let tableName = '';

      switch(bankName) {
        case 'AUB':
          tableName = 'dashboard_bankaub';
          break;
        case 'ARVIND':
          tableName = 'dashboard_bankarvind';
          break;
        case 'HDFC':
          tableName = 'dashboard_bankhdfc';
          break;
        case 'SBI':
          tableName = 'dashboard_banksbi';
          break;
        default:
          console.log('💰 Cash payment - no bank balance update needed');
          return; // Don't update bank for CASH
      }

      // Get latest bank record
      const { data: latestRecord, error: fetchError } = await supabase
        .from(tableName)
        .select('*')
        .order('transaction_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = no rows
        throw fetchError;
      }

      const openingBalance = latestRecord?.closing_balance || 0;
      const closingBalance = openingBalance + creditAmount;
      const currentDateTime = format(new Date(), 'yyyy-MM-dd');

      // Insert new bank record
      const { error: insertError } = await supabase
        .from(tableName)
        .insert([{
          date: date,
          opening_balance: openingBalance,
          debit_balance: 0,
          credit_balance: creditAmount,
          closing_balance: closingBalance,
          transaction_date: currentDateTime,
          remarks: remarks,
        }]);

      if (insertError) throw insertError;

      console.log(`✅ Updated ${bankName} bank balance: ₹${openingBalance} → ₹${closingBalance}`);
    } catch (err: any) {
      console.error('❌ Error updating bank balance:', err.message);
      throw err;
    }
  },

  /* ================= TOTALS PARSING LOGIC ================= */
  loadTransactionTotals: async (date: string) => {
    set({
      loadingTransactionTotals: true,
      transactionCreditTotal: 0,
      transactionDebitTotal: 0,
      transactionCreditEntries: [],
      transactionDebitEntries: [],
    });

    try {
      const cylinderPrice = Number((get() as any).cylinderPrice || 0);

      const { data: dailyRows, error: dailyError } = await supabase
        .from('dashboard_dailyrecordsachin')
        .select(
          'id, date, transactions, category, rate, quantity, amount, remarks, paytm_transaction, check_done'
        )
        .eq('date', date);

      if (dailyError) throw dailyError;

      const creditEntries =
        dailyRows
          ?.filter((row: any) => row.transactions === 'CREDIT')
          .map((row: any) => ({
            id: `daily-credit-${row.id}`,
            source: 'DAILY',
            date: row.date,
            transactions: row.transactions,
            category: row.category,
            rate: Number(row.rate || 0),
            quantity: Number(row.quantity || 0),
            amount: Math.ceil(Number(row.amount || 0)),
            remarks: row.remarks || '',
          })) || [];

      const debitEntries =
        dailyRows
          ?.filter((row: any) => row.transactions === 'DEBIT')
          .map((row: any) => ({
            id: `daily-debit-${row.id}`,
            source: 'DAILY',
            date: row.date,
            transactions: row.transactions,
            category: row.category,
            rate: Number(row.rate || 0),
            quantity: Number(row.quantity || 0),
            amount: Math.ceil(Number(row.amount || 0)),
            remarks: row.remarks || '',
          })) || [];

      const { data: deliveryRows, error: deliveryError } = await supabase
        .from('dashboard_deliveryrecords')
        .select(
          'id, date, name, amount, online_payment, paytm, additional_paytm'
        )
        .eq('date', date);

      if (deliveryError) throw deliveryError;

      const deliveryData = deliveryRows || [];

      const totalOnlinePaymentQty = deliveryData.reduce(
        (sum: number, row: any) => sum + Number(row.online_payment || 0),
        0
      );
      const onlinePaymentAmount = Math.ceil(
        totalOnlinePaymentQty * cylinderPrice
      );

      if (onlinePaymentAmount > 0) {
        debitEntries.unshift({
          id: 'delivery-online-payment-total',
          source: 'DELIVERY',
          date,
          transactions: 'DEBIT',
          category: 'ZERO BILL / ONLINE PAYMENT',
          rate: cylinderPrice,
          quantity: totalOnlinePaymentQty,
          amount: onlinePaymentAmount,
          remarks: `${totalOnlinePaymentQty} × ₹${cylinderPrice}`,
        });
      }

      const totalPaytmQty = deliveryData.reduce(
        (sum: number, row: any) => sum + Number(row.paytm || 0),
        0
      );
      const totalAdditionalPaytm = deliveryData.reduce(
        (sum: number, row: any) => sum + Number(row.additional_paytm || 0),
        0
      );

      const paytmCreditRecords =
        dailyRows?.filter(
          (row: any) =>
            row.transactions === 'CREDIT' &&
            row.paytm_transaction === true
        ) || [];
      const extraPaytmCreditAmount = paytmCreditRecords.reduce(
        (sum: number, row: any) => sum + Number(row.amount || 0),
        0
      );

      const extraRemarksFormatted = paytmCreditRecords.map((row: any) => {
        const cleanText =
          row.remarks?.replace('[PAYTM]', '').trim() || row.category;
        return `${cleanText}: ₹${Math.ceil(Number(row.amount || 0))}`;
      });

      const paytmAmount = Math.ceil(
        totalPaytmQty * cylinderPrice +
          totalAdditionalPaytm +
          extraPaytmCreditAmount
      );

      if (paytmAmount > 0) {
        let paytmRemarks = `Paytm: ${totalPaytmQty} × ₹${cylinderPrice}, Additional Paytm: ₹${totalAdditionalPaytm}`;
        if (extraRemarksFormatted.length > 0) {
          paytmRemarks += `\n\nOnline Paytm Credits Appended:\n${extraRemarksFormatted.join(
            '\n'
          )}`;
        }

        debitEntries.unshift({
          id: 'delivery-paytm-total',
          source: 'DELIVERY + ONLINE CREDITS',
          date,
          transactions: 'DEBIT',
          category: 'PAYTM + ADDITIONAL PAYTM',
          rate: cylinderPrice,
          quantity: totalPaytmQty,
          amount: paytmAmount,
          remarks: paytmRemarks,
        });
      }

      const creditTotal = creditEntries.reduce(
        (sum: number, row: any) => sum + Number(row.amount || 0),
        0
      );
      const debitTotal = debitEntries.reduce(
        (sum: number, row: any) => sum + Number(row.amount || 0),
        0
      );

      set({
        transactionCreditTotal: Math.ceil(creditTotal),
        transactionDebitTotal: Math.ceil(debitTotal),
        transactionCreditEntries: creditEntries,
        transactionDebitEntries: debitEntries,
        loadingTransactionTotals: false,
      });
    } catch (error) {
      console.error('❌ Error loading transaction totals:', error);
      set({
        transactionCreditTotal: 0,
        transactionDebitTotal: 0,
        transactionCreditEntries: [],
        transactionDebitEntries: [],
        loadingTransactionTotals: false,
      });
    }
  },

  /* ================= DELIVERY FUNCTIONS ================= */
  loadDeliveriesByDate: async (date: string) => {
    try {
      const { data, error } = await supabase
        .from('dashboard_deliveryrecords')
        .select(
          'id, date, name, number, paytm, empty_received, online_payment, amount, additional_paytm, remarks'
        )
        .eq('date', date)
        .order('id', { ascending: true });

      if (error) throw error;

      const { data: paytmCredits } = await supabase
        .from('dashboard_dailyrecordsachin')
        .select('amount')
        .eq('date', date)
        .eq('transactions', 'CREDIT')
        .eq('paytm_transaction', true);

      const extraPaytmAmount = (paytmCredits || []).reduce(
        (sum: number, row: any) => sum + Number(row.amount || 0),
        0
      );

      const mapped = (data || []).map((row: any) => ({
        id: String(row.id),
        date: row.date,
        employee_name: row.name,
        cylinders_delivered: row.number || 0,
        empty_received: row.empty_received || 0,
        online_payments: row.online_payment || 0,
        paytm_payments: row.paytm || 0,
        partial_digital_amount: row.additional_paytm || 0,
        cash_collected: row.amount || 0,
        remarks: row.remarks || '',
        reconciliation_reasons: [],
      }));

      await AsyncStorage.setItem(
        `deliveries_${date}`,
        JSON.stringify(mapped)
      );

      set({
        deliveries: mapped,
        extraPaytmCreditAmount: extraPaytmAmount,
      });
    } catch (err: any) {
      console.error('loadDeliveriesByDate failed:', err.message);
      const local = await AsyncStorage.getItem(`deliveries_${date}`);
      set({ deliveries: local ? JSON.parse(local) : [] });
    }
  },

  addDelivery: async (delivery: any) => {
    try {
      const payload = {
        date: delivery.date,
        name: delivery.employee_name,
        number: delivery.cylinders_delivered || 0,
        paytm: delivery.paytm_payments || 0,
        empty_received: delivery.empty_received || 0,
        online_payment: delivery.online_payments || 0,
        amount: Math.ceil(Number(delivery.calculated_total_payable || 0)),
        remarks: delivery.remarks || '',
        additional_paytm: Math.ceil(
          Number(delivery.partial_digital_amount || 0)
        ),
        commission_given: false,
        pf_given: false,
      };

      const { error } = await supabase
        .from('dashboard_deliveryrecords')
        .upsert(payload, { onConflict: 'date,name' });
      if (error) throw error;

      const newDelivery = {
        ...delivery,
        id: Date.now().toString(),
        created_at: new Date().toISOString(),
      };
      const key = `deliveries_${delivery.date}`;
      const existing = await AsyncStorage.getItem(key);
      const list = existing ? JSON.parse(existing) : [];
      const index = list.findIndex(
        (d: any) =>
          d.employee_name === delivery.employee_name &&
          d.date === delivery.date
      );

      if (index >= 0) list[index] = newDelivery;
      else list.push(newDelivery);

      await AsyncStorage.setItem(key, JSON.stringify(list));
      set({ deliveries: list });
    } catch (err) {
      console.error('Add delivery failed:', err);
      throw err;
    }
  },

  deleteDelivery: async (id: string) => {
    try {
      const currentDeliveries = (get() as any).deliveries;
      const itemToDelete = currentDeliveries.find((d: any) => d.id === id);
      if (!itemToDelete) return false;

      const { error } = await supabase
        .from('dashboard_deliveryrecords')
        .delete()
        .match({
          date: itemToDelete.date,
          name: itemToDelete.employee_name,
        });
      if (error) throw error;

      const key = `deliveries_${itemToDelete.date}`;
      const updatedList = currentDeliveries.filter(
        (d: any) => d.id !== id
      );
      await AsyncStorage.setItem(key, JSON.stringify(updatedList));
      set({ deliveries: updatedList });
      return true;
    } catch (err) {
      console.error('Delete operation failed:', err);
      throw err;
    }
  },

  loadDailySummary: async (date: string) => {
    await (get() as any).loadDeliveriesByDate(date);
  },

  deleteEmployee: async (id: string) => {
    const updated = (get() as any).employees.filter((e: any) =>
      e.id ? e.id !== id : e !== id
    );
    set({ employees: updated });
    await AsyncStorage.setItem('employees', JSON.stringify(updated));
  },
}));