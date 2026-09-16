import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '@/lib/supabase';
import { format } from 'date-fns';
import { useDataStore } from '@/store/dataStore';
import DateTimePicker from '@react-native-community/datetimepicker';
import PrinterPickerModal from '@/components/PrinterPickerModal';
import {
  printReceipt,
  connectToSavedPrinter,
  getSavedPrinter,
  BluetoothDevice,
} from '@/lib/thermalPrinter';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';
const EMPTY_DEFAULT = '1990-01-01';
const COUNTRY_CODE = '91'; // India only — auto-prefixed since stored numbers have no country code

// ─── Types ────────────────────────────────────────────────────────────────────

interface Customer {
  name: string;
  discount: number;
}

interface SummaryRecord {
  customer_name: string;
  is_paid: boolean;
  delivery_count: number;
  empty_received_count: number;
  delivery_boy: DeliveryBoy | null;
}

type DeliveryBoy = 'NAMDEV' | 'GODOWN' | 'OTHER';

function dlog(msg: string) {
  console.log(msg);
}

// ─── WhatsApp helper for Completed / Partial Payments ────────────────────────
async function sendWhatsAppForDelivery(params: {
  customerName: string;
  deliveryDate: string;
  quantity: number;
  amount: number;
}) {
  const { customerName, deliveryDate, quantity, amount } = params;
  dlog(`[WhatsApp] called: customer=${customerName} qty=${quantity} amount=${amount} date=${deliveryDate}`);

  try {
    // STEP 1: resolve customer name -> id & discount
    const { data: custRow, error: custErr } = await supabase
      .from('dashboard_customername')
      .select('id, discount')
      .eq('name', customerName)
      .maybeSingle();

    if (custErr || !custRow?.id) {
      dlog('[WhatsApp] STOPPED: customer not found in dashboard_customername');
      Alert.alert(
        'Customer not found',
        `Could not find "${customerName}" in the customer list, so no WhatsApp message could be sent.`
      );
      return;
    }

    // STEP 2: fetch mobile number
    const { data: contactRow, error: contactErr } = await supabase
      .from('dashboard_customer_contacts')
      .select('mobile, is_primary')
      .eq('customer_id', custRow.id)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (contactErr || !contactRow?.mobile) {
      dlog('[WhatsApp] STOPPED: no mobile number saved');
      Alert.alert(
        'No mobile number',
        `No saved mobile number found for ${customerName}.`
      );
      return;
    }

    // STEP 3: Find empty cylinders received on this delivery date
    const { count: emptyCount } = await supabase
      .from('dashboard_commercialrecords')
      .select('id', { count: 'exact', head: true })
      .eq('customer_name', customerName)
      .eq('empty_received', deliveryDate);

    const emptyReceived = emptyCount || 0;

    // STEP 4: Check if other deliveries on this date are still unpaid
    const { count: unpaidCount } = await supabase
      .from('dashboard_commercialrecords')
      .select('id', { count: 'exact', head: true })
      .eq('customer_name', customerName)
      .eq('delivery_date', deliveryDate)
      .is('payment_date', null);

    const remainingUnpaid = unpaidCount || 0;
    const rawMobile = String(contactRow.mobile).replace(/[\s-]/g, '');
    const fullNumber = `${COUNTRY_CODE}${rawMobile}`;

    const dateLabel = format(new Date(deliveryDate + 'T00:00:00'), 'dd MMM yyyy');
    const qrCodeImageLink = "https://i.postimg.cc/CxYCrZ93/QR.jpg";

    // Base paid message
    let message =
      `Dear ${customerName},\n\n` +
      `Your delivery on ${dateLabel} has been recorded. ` +
      `Payment of ₹${amount.toLocaleString('en-IN')} for ${quantity} cylinder(s) and ${emptyReceived} empty cylinder received has been received.`;

    // If partial payment (remaining unpaid cylinders exist), calculate balance and attach QR + UPI link
    if (remainingUnpaid > 0) {
      let estimatedUnpaidAmount = 0;
      const { data: rateData } = await supabase
        .from('dashboard_commercialrate')
        .select('actual_rate')
        .lte('start_date', deliveryDate)
        .gte('end_date', deliveryDate)
        .single();

      if (rateData) {
        const customerDiscount = custRow.discount || 0;
        const freshDiscountEnabled = useDataStore.getState().discountEnabled;
        const appliedDiscount = freshDiscountEnabled && customerDiscount > 0 ? customerDiscount : 0;
        const finalRate = Math.round(rateData.actual_rate - appliedDiscount);
        estimatedUnpaidAmount = Math.ceil(finalRate * remainingUnpaid);
      }

      const unpaidAmountText = estimatedUnpaidAmount > 0 ? `₹${estimatedUnpaidAmount.toLocaleString('en-IN')}` : "₹___";
      const upiPaymentLink = `upi://pay?pa=9133444342@hdfc&pn=Shreejee%20Gas%20Service&am=${estimatedUnpaidAmount}&cu=INR`;

      message +=
        `\n\nPayment for the remaining ${remainingUnpaid} cylinder(s) (${unpaidAmountText}) is pending. ` +
        `Kindly make the payment by scanning the QR code below:\n` +
        `${qrCodeImageLink}\n\n` +
        `Or click here to pay the remaining balance directly via any UPI app:\n` +
        `${upiPaymentLink}`;
    }

    message += `\n\nThank you!\nShreejee Gas Service`;

    const appUrl = `whatsapp://send?phone=${fullNumber}&text=${encodeURIComponent(message)}`;
    const webUrl = `https://wa.me/${fullNumber}?text=${encodeURIComponent(message)}`;

    const supported = await Linking.canOpenURL(appUrl);
    if (supported) {
      await Linking.openURL(appUrl);
    } else {
      await Linking.openURL(webUrl);
    }
  } catch (err: any) {
    dlog(`[WhatsApp] EXCEPTION: ${err?.message ?? String(err)}`);
    Alert.alert('WhatsApp error', err?.message || 'Could not open WhatsApp');
  }
}

// ─── WhatsApp helper for Delivery Only (Skipped Payment / Credit) ─────────────
async function sendWhatsAppForDeliveryOnly(params: {
  customerName: string;
  deliveryDate: string;
  quantity: number;
  emptyReceived?: number;
}) {
  const { customerName, deliveryDate, quantity } = params;
  let emptyReceived = params.emptyReceived;
  dlog(`[WhatsApp-DeliveryOnly] called: customer=${customerName} qty=${quantity} date=${deliveryDate}`);

  try {
    // STEP 1: Resolve customer name -> id & discount details
    const { data: custRow, error: custErr } = await supabase
      .from('dashboard_customername')
      .select('id, discount')
      .eq('name', customerName)
      .maybeSingle();

    if (custErr || !custRow?.id) {
      dlog('[WhatsApp-DeliveryOnly] STOPPED: customer not found');
      Alert.alert(
        'Customer not found',
        `Could not find "${customerName}" in the customer list.`
      );
      return;
    }

    // STEP 2: Fetch mobile number
    const { data: contactRow, error: contactErr } = await supabase
      .from('dashboard_customer_contacts')
      .select('mobile, is_primary')
      .eq('customer_id', custRow.id)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (contactErr || !contactRow?.mobile) {
      dlog('[WhatsApp-DeliveryOnly] STOPPED: no mobile number saved');
      Alert.alert(
        'No mobile number',
        `No saved mobile number found for ${customerName}.`
      );
      return;
    }

    // STEP 3: Fetch empty received from database if not explicitly passed
    if (emptyReceived === undefined) {
      const { count: emptyCount } = await supabase
        .from('dashboard_commercialrecords')
        .select('id', { count: 'exact', head: true })
        .eq('customer_name', customerName)
        .eq('empty_received', deliveryDate);
      emptyReceived = emptyCount || 0;
    }

    // STEP 4: Fetch active rate from database and calculate estimated amount
    let estimatedAmount = 0;
    const { data: rateData } = await supabase
      .from('dashboard_commercialrate')
      .select('actual_rate')
      .lte('start_date', deliveryDate)
      .gte('end_date', deliveryDate)
      .single();

    if (rateData) {
      const customerDiscount = custRow.discount || 0;
      const freshDiscountEnabled = useDataStore.getState().discountEnabled;
      const appliedDiscount = freshDiscountEnabled && customerDiscount > 0 ? customerDiscount : 0;
      const finalRate = Math.round(rateData.actual_rate - appliedDiscount);
      estimatedAmount = Math.ceil(finalRate * quantity);
    }

    const rawMobile = String(contactRow.mobile).replace(/[\s-]/g, '');
    const fullNumber = `${COUNTRY_CODE}${rawMobile}`;

    const dateLabel = format(new Date(deliveryDate + 'T00:00:00'), 'dd MMM yyyy');
    const amountText = estimatedAmount > 0 ? `₹${estimatedAmount.toLocaleString('en-IN')}` : "₹___";

    const qrCodeImageLink = "https://i.postimg.cc/CxYCrZ93/QR.jpg";
    const upiPaymentLink = `upi://pay?pa=9133444342@hdfc&pn=Shreejee%20Gas%20Service&am=${estimatedAmount}&cu=INR`;

    const message =
      `Dear ${customerName},\n\n` +
      `Your delivery of ${quantity} cylinder(s) on ${dateLabel} has been recorded and ${emptyReceived} empty cylinder received.\n\n` +
      `No payment has been received. Kindly make the payment of ${amountText} by scanning the QR code below:\n` +
      `${qrCodeImageLink}\n\n` +
      `Or click here to pay directly via any UPI app:\n` +
      `${upiPaymentLink}\n\n` +
      `Thank you!\n` +
      `Shreejee Gas Service`;

    const appUrl = `whatsapp://send?phone=${fullNumber}&text=${encodeURIComponent(message)}`;
    const webUrl = `https://wa.me/${fullNumber}?text=${encodeURIComponent(message)}`;

    const supported = await Linking.canOpenURL(appUrl);
    if (supported) {
      await Linking.openURL(appUrl);
    } else {
      await Linking.openURL(webUrl);
    }
  } catch (err: any) {
    dlog(`[WhatsApp-DeliveryOnly] EXCEPTION: ${err?.message ?? String(err)}`);
    Alert.alert('WhatsApp error', err?.message || 'Could not open WhatsApp');
  }
}

// ─── Fetch undiscounted actual rate for receipt printing ─────────────────────
// Used only for printing — ensures discounts never appear on the paper receipt.
async function fetchActualRate(date: string): Promise<number> {
  const { data } = await supabase
    .from('dashboard_commercialrate')
    .select('actual_rate')
    .lte('start_date', date)
    .gte('end_date', date)
    .single();
  return data?.actual_rate || 0;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CommercialScreen() {
  const { discountEnabled, loadDiscountSetting } = useDataStore();

  // ── Selected Date State ───────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  // ── State ──────────────────────────────────────────────────────────────────
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [deliveryBoy, setDeliveryBoy] = useState<DeliveryBoy>('OTHER');
  const [sent, setSent] = useState('');
  const [received, setReceived] = useState('');
  const [summaryRecords, setSummaryRecords] = useState<SummaryRecord[]>([]);
  const [totalDelivered, setTotalDelivered] = useState(0);
  const [totalReceived, setTotalReceived] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');

  // ── Printer State ──────────────────────────────────────────────────────────
  const [printerModalVisible, setPrinterModalVisible] = useState(false);
  const [connectedPrinter, setConnectedPrinter] = useState<BluetoothDevice | null>(null);

  // ── Payment Modal State ────────────────────────────────────────────────────
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentCustomerName, setPaymentCustomerName] = useState('');
  const [paymentPendingCount, setPaymentPendingCount] = useState(0);
  const [paymentRate, setPaymentRate] = useState(0);
  const [paymentDiscount, setPaymentDiscount] = useState(0);
  const [paymentDiscountApplied, setPaymentDiscountApplied] = useState(false);
  const [paymentQuantity, setPaymentQuantity] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentPendingDates, setPaymentPendingDates] = useState<
    { date: string; count: number }[]
  >([]);
  const [paymentSelectedDate, setPaymentSelectedDate] = useState('');

  const [showDatePicker, setShowDatePicker] = useState(false);

  // ── Cash / Paytm Payment Mode Popup State ─────────────────────────────────
  const [paymentModeVisible, setPaymentModeVisible] = useState(false);
  const [paymentModeSelected, setPaymentModeSelected] = useState<'CASH' | 'PAYTM' | null>(null);

  // ── Delivery Boy Inline Edit State ────────────────────────────────────────
  const [editingDeliveryBoyFor, setEditingDeliveryBoyFor] = useState<{
    customer: string;
    current: DeliveryBoy;
  } | null>(null);
  const [savingDeliveryBoy, setSavingDeliveryBoy] = useState(false);

  // ── Beautiful Result Popups ───────────────────────────────────────────────
  const [successModal, setSuccessModal] = useState<{
    visible: boolean;
    customer: string;
    date: string;
    sent: number;
    received: number;
  } | null>(null);

  const [paymentDoneModal, setPaymentDoneModal] = useState<{
    visible: boolean;
    customer: string;
    deliveryDate: string;
    paymentDate: string;
    qty: number;
    rate: number;
    amount: number;
    isPaytm: boolean;
  } | null>(null);

  // "Record Payment?" prompt
  const [offerPaymentModal, setOfferPaymentModal] = useState<{
    visible: boolean;
    customer: string;
    totalPending: number;
    dateList: { date: string; count: number }[];
    deliveredQty?: number;
    emptyReceivedQty?: number;
  } | null>(null);

  // Delete confirmation
  const [deleteModal, setDeleteModal] = useState<{
    visible: boolean;
    customer: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ─── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    initScreen();
  }, []);

  useEffect(() => {
    fetchSummary();
    autoDetectDeliveryBoy();
  }, [selectedDate]);

  const initScreen = async () => {
    setLoading(true);
    try {
      await Promise.all([
        fetchCustomers(),
        autoDetectDeliveryBoy(),
        fetchSummary(),
        loadDiscountSetting(),
        reconnectSavedPrinter(),
      ]);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // ─── Printer: silently reconnect to whichever printer was used last ───────

  const reconnectSavedPrinter = async () => {
    try {
      const ok = await connectToSavedPrinter();
      if (ok) {
        const saved = await getSavedPrinter();
        setConnectedPrinter(saved);
      }
    } catch {
      // Printer off / out of range — user can reconnect from the printer icon
    }
  };

  const handlePrintReceipt = async (data: Parameters<typeof printReceipt>[0]) => {
    if (!connectedPrinter) {
      Alert.alert(
        'No printer connected',
        'Tap the printer icon at the top to connect your Bluetooth printer first.'
      );
      return;
    }
    try {
      await printReceipt(data);
    } catch (err: any) {
      Alert.alert('Print failed', err?.message || 'Could not print receipt. Check the printer is on and in range.');
    }
  };

  // ─── Fetch Customers ───────────────────────────────────────────────────────

  const fetchCustomers = async () => {
    const { data, error } = await supabase
      .from('dashboard_customername')
      .select('name, discount')
      .order('name', { ascending: true });

    if (error) throw error;
    setCustomers(
      (data || []).map((c: any) => ({
        name: c.name,
        discount: c.discount || 0,
      }))
    );
  };

  // ─── Auto Detect Delivery Boy ──────────────────────────────────────────────

  const autoDetectDeliveryBoy = async () => {
    const { data, error } = await supabase
      .from('dashboard_deliveryrecords')
      .select('name')
      .eq('date', selectedDate)
      .limit(50);

    if (error) return;

    const records = data || [];
    const hasNamedev = records.some(
      (r: any) =>
        String(r.name || '')
          .trim()
          .toUpperCase() === 'NAMDEV'
    );

    setDeliveryBoy(hasNamedev ? 'NAMDEV' : 'OTHER');
  };

  // ─── Fetch Summary ─────────────────────────────────────────────────────────

  const fetchSummary = async () => {
    const { data, error } = await supabase
      .from('dashboard_commercialrecords')
      .select('customer_name, delivery_date, empty_received, payment_date, delivery_boy')
      .or(`delivery_date.eq.${selectedDate},empty_received.eq.${selectedDate}`);

    if (error) return;

    const records = data || [];

    const grouped: Record<
      string,
      {
        customer_name: string;
        is_paid: boolean;
        delivery_count: number;
        empty_received_count: number;
        delivery_boy: DeliveryBoy | null;
      }
    > = {};

    records.forEach((r: any) => {
      const name = r.customer_name;
      const isPaid = r.payment_date !== null;
      const key = `${name}_${isPaid ? 'PAID' : 'UNPAID'}`;

      if (!grouped[key]) {
        grouped[key] = {
          customer_name: name,
          is_paid: isPaid,
          delivery_count: 0,
          empty_received_count: 0,
          delivery_boy: null,
        };
      }
      if (r.delivery_date === selectedDate) {
        grouped[key].delivery_count += 1;
        // Only rows delivered TODAY carry a meaningful delivery boy for this summary line
        if (!grouped[key].delivery_boy && r.delivery_boy) {
          grouped[key].delivery_boy = r.delivery_boy as DeliveryBoy;
        }
      }
      if (r.empty_received === selectedDate) {
        grouped[key].empty_received_count += 1;
      }
    });

    const summaryList: SummaryRecord[] = Object.values(grouped);

    summaryList.sort((a, b) => {
      const nameComp = a.customer_name.localeCompare(b.customer_name);
      if (nameComp !== 0) return nameComp;
      return (a.is_paid ? 0 : 1) - (b.is_paid ? 0 : 1);
    });

    setSummaryRecords(summaryList);

    const totalDel = records.filter((r: any) => r.delivery_date === selectedDate).length;
    const totalRec = records.filter((r: any) => r.empty_received === selectedDate).length;
    setTotalDelivered(totalDel);
    setTotalReceived(totalRec);
  };

  // ─── Validate ──────────────────────────────────────────────────────────────

  const validate = (): boolean => {
    if (!selectedCustomer) {
      Alert.alert('Error', 'Please select a customer');
      return false;
    }
    const sentNum = parseInt(sent, 10) || 0;
    const receivedNum = parseInt(received, 10) || 0;
    if (sentNum === 0 && receivedNum === 0) {
      Alert.alert('Error', 'Please enter sent or received quantity');
      return false;
    }
    return true;
  };

  // ─── Handle Submit ─────────────────────────────────────────────────────────

  const handleSubmitPress = () => {
    if (!validate()) return;
    setShowConfirmModal(true);
  };

  const handleConfirmSubmit = async () => {
    setShowConfirmModal(false);
    setSubmitting(true);

    const sentNum = parseInt(sent, 10) || 0;
    const receivedNum = parseInt(received, 10) || 0;
    const customerName = selectedCustomer;

    try {
      // ── STEP 1: Insert delivered cylinders ────────────────────────────────
      if (sentNum > 0) {
        const rowsToInsert = Array.from({ length: sentNum }, () => ({
          customer_name: customerName,
          delivery_date: selectedDate,
          delivery_boy: deliveryBoy,
          empty_received: EMPTY_DEFAULT,
          commision_given: false,
          payment_date: null,
          amount: null,
        }));

        const { error: insertError } = await supabase
          .from('dashboard_commercialrecords')
          .insert(rowsToInsert);

        if (insertError) throw insertError;
      }

      // ── STEP 2: Update empty_received for returned cylinders ──────────────
      if (receivedNum > 0) {
        const { data: latestRecords, error: fetchError } = await supabase
          .from('dashboard_commercialrecords')
          .select('id')
          .eq('customer_name', customerName)
          .eq('empty_received', EMPTY_DEFAULT)
          .order('id', { ascending: false })
          .limit(receivedNum);

        if (fetchError) throw fetchError;

        const idsToUpdate = (latestRecords || []).map((r: any) => r.id);

        if (idsToUpdate.length > 0) {
          const { error: updateError } = await supabase
            .from('dashboard_commercialrecords')
            .update({ empty_received: selectedDate })
            .in('id', idsToUpdate);

          if (updateError) throw updateError;
        }

        if (idsToUpdate.length < receivedNum) {
          Alert.alert(
            'Warning',
            `Only ${idsToUpdate.length} records updated. Not enough pending empty cylinders for ${customerName}.`
          );
        }
      }

      // ── STEP 3: Refresh summary ───────────────────────────────────────────
      await fetchSummary();

      setSelectedCustomer('');
      setSent('');
      setReceived('');

      // ── STEP 4: Show success modal ────────────────────────────────────────
      setSuccessModal({
        visible: true,
        customer: customerName,
        date: selectedDate,
        sent: sentNum,
        received: receivedNum,
      });
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to save record');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Check Pending and Offer Payment ───────────────────────────────────────

  const checkAndOfferPayment = async (customerName: string, deliveredQty?: number, emptyReceivedQty?: number) => {
    try {
      const { data, error } = await supabase
        .from('dashboard_commercialrecords')
        .select('id, delivery_date')
        .eq('customer_name', customerName)
        .is('payment_date', null)
        .order('delivery_date', { ascending: false });

      if (error) throw error;
      if (!data || data.length === 0) return;

      const totalPending = data.length;
      const grouped: Record<string, number> = {};
      data.forEach((r: any) => {
        grouped[r.delivery_date] = (grouped[r.delivery_date] || 0) + 1;
      });
      const dateList = Object.entries(grouped).map(([date, count]) => ({ date, count }));

      setOfferPaymentModal({
        visible: true,
        customer: customerName,
        totalPending,
        dateList,
        deliveredQty,
        emptyReceivedQty
      });
    } catch (err: any) {
      // Don't block — delivery already saved
    }
  };

  // ─── Open Payment Modal ────────────────────────────────────────────────────

  const openPaymentModal = async (
    customerName: string,
    dateList: { date: string; count: number }[],
    totalPending: number
  ) => {
    setPaymentCustomerName(customerName);
    setPaymentPendingDates(dateList);
    setPaymentPendingCount(totalPending);
    setPaymentSelectedDate('');
    setPaymentRate(0);
    setPaymentDiscount(0);
    setPaymentDiscountApplied(false);
    setPaymentQuantity('');
    setPaymentAmount('');
    setShowPaymentModal(true);
  };

  // ─── Handle Payment Date Select ────────────────────────────────────────────

  const handlePaymentDateSelect = async (dateObj: { date: string; count: number }) => {
    setPaymentSelectedDate(dateObj.date);
    setPaymentLoading(true);

    try {
      await loadDiscountSetting();
      const freshDiscountEnabled = useDataStore.getState().discountEnabled;
      const customer = customers.find((c) => c.name === paymentCustomerName);
      const customerDiscount = customer?.discount || 0;

      const { data: rateData, error: rateError } = await supabase
        .from('dashboard_commercialrate')
        .select('actual_rate')
        .lte('start_date', dateObj.date)
        .gte('end_date', dateObj.date)
        .single();

      if (rateError || !rateData) {
        Alert.alert('Rate Not Found', 'No commercial rate found for this delivery date.');
        setPaymentLoading(false);
        return;
      }

      const actualRate = rateData.actual_rate || 0;
      const appliedDiscount = freshDiscountEnabled && customerDiscount > 0 ? customerDiscount : 0;
      const finalRate = Math.round(actualRate - appliedDiscount);

      setPaymentRate(finalRate);
      setPaymentDiscount(appliedDiscount);
      setPaymentDiscountApplied(appliedDiscount > 0);
      setPaymentQuantity(dateObj.count.toString());
      setPaymentAmount(Math.ceil(finalRate * dateObj.count).toString());
    } catch (err: any) {
      Alert.alert('Error', 'Failed to fetch rate');
    } finally {
      setPaymentLoading(false);
    }
  };

  // ─── Payment Quantity Change ───────────────────────────────────────────────

  const handlePaymentQuantityChange = (val: string) => {
    setPaymentQuantity(val);
    const qty = parseInt(val, 10) || 0;
    if (qty > 0 && paymentRate > 0) {
      setPaymentAmount(Math.ceil(paymentRate * qty).toString());
    }
  };

  // ─── Confirm Payment — opens Cash/Paytm popup first ───────────────────────

  const handleConfirmPayment = () => {
    const qty = parseInt(paymentQuantity, 10) || 0;
    const amt = parseInt(paymentAmount, 10) || 0;

    if (qty <= 0) { Alert.alert('Error', 'Quantity must be greater than 0'); return; }
    if (amt <= 0) { Alert.alert('Error', 'Amount must be greater than 0'); return; }
    if (!paymentSelectedDate) { Alert.alert('Error', 'Please select a delivery date'); return; }

    const selectedDateObj = paymentPendingDates.find((d) => d.date === paymentSelectedDate);
    if (selectedDateObj && qty > selectedDateObj.count) {
      Alert.alert('Error', `Only ${selectedDateObj.count} cylinders are pending for this date.`);
      return;
    }

    setPaymentModeSelected(null);
    setPaymentModeVisible(true);
  };

  // ─── After payment mode chosen — actually save the payment ───────────────

  const handlePaymentModeConfirm = async () => {
    if (!paymentModeSelected) return;
    const isPaytm = paymentModeSelected === 'PAYTM';
    setPaymentModeVisible(false);
    await savePayment(isPaytm);
  };

  const handlePaymentModeClose = () => {
    setPaymentModeVisible(false);
    setPaymentModeSelected(null);
  };

  // ─── Skip payment — closes modal and sends a delivery-only WhatsApp update
  const handleSkipPayment = () => {
    setShowPaymentModal(false);
    const qty = parseInt(paymentQuantity, 10) || 0;
    if (qty > 0 && paymentCustomerName && paymentSelectedDate) {
      sendWhatsAppForDeliveryOnly({
        customerName: paymentCustomerName,
        deliveryDate: paymentSelectedDate,
        quantity: qty
      }).catch((e) => dlog(`[Skip] sendWhatsAppForDeliveryOnly rejected: ${e?.message ?? e}`));
    }
  };

  // ─── Save Payment (called after payment mode is selected) ─────────────────

  const savePayment = async (isPaytm: boolean) => {
    const qty = parseInt(paymentQuantity, 10) || 0;
    const amt = parseInt(paymentAmount, 10) || 0;

    setPaymentSubmitting(true);

    try {
      // ── STEP 1: Update commercial records ─────────────────────────────────
      const { data: pendingRows, error: fetchErr } = await supabase
        .from('dashboard_commercialrecords')
        .select('id')
        .eq('customer_name', paymentCustomerName)
        .eq('delivery_date', paymentSelectedDate)
        .is('payment_date', null)
        .order('id')
        .limit(qty);

      if (fetchErr) throw fetchErr;
      if (!pendingRows || pendingRows.length === 0) {
        Alert.alert('Error', 'No pending records found to update');
        return;
      }

      const ids = pendingRows.map((r: any) => r.id);
      const { error: updateErr } = await supabase
        .from('dashboard_commercialrecords')
        .update({
          payment_date: selectedDate,
          amount: paymentRate,
        })
        .in('id', ids);

      if (updateErr) throw updateErr;

      // ── STEP 2: Insert into daily records ─────────────────────────────────
      const { error: insertErr } = await supabase
        .from('dashboard_dailyrecordsachin')
        .insert({
          date: selectedDate,
          transactions: 'CREDIT',
          category: 'COMMERCIAL PAYMENT',
          rate: paymentRate,
          quantity: qty,
          amount: amt,
          remarks: `${paymentCustomerName}(${paymentSelectedDate})`,
          paytm_transaction: isPaytm,
          check_done: false,
          debit_balance_report_id: 0,
        });

      if (insertErr) throw insertErr;

      await fetchSummary();
      setShowPaymentModal(false);

      // ── Beautiful payment done modal ──────────────────────────────────────
      setPaymentDoneModal({
        visible: true,
        customer: paymentCustomerName,
        deliveryDate: paymentSelectedDate,
        paymentDate: selectedDate,
        qty,
        rate: paymentRate,
        amount: amt,
        isPaytm,
      });

      // ── Send WhatsApp update for THIS delivery's payment ──────────────────
      dlog(`[Pay] confirming payment, sending WhatsApp for ${paymentCustomerName}`);
      sendWhatsAppForDelivery({
        customerName: paymentCustomerName,
        deliveryDate: paymentSelectedDate,
        quantity: qty,
        amount: amt,
      }).catch((e) => dlog(`[Pay] sendWhatsAppForDelivery rejected: ${e?.message ?? e}`));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to record payment');
    } finally {
      setPaymentSubmitting(false);
    }
  };

  // ─── Delete Customer Records for Selected Date ─────────────────────────────

  const handleDeleteRecords = async () => {
    if (!deleteModal) return;
    const customerName = deleteModal.customer;
    setDeleting(true);
    try {
      // STEP 1: Reset empties received TODAY back to default
      const { data: emptyRows } = await supabase
        .from('dashboard_commercialrecords')
        .select('id')
        .eq('customer_name', customerName)
        .eq('empty_received', selectedDate);

      const emptyIds = (emptyRows || []).map((r: any) => r.id);
      if (emptyIds.length > 0) {
        await supabase
          .from('dashboard_commercialrecords')
          .update({ empty_received: EMPTY_DEFAULT })
          .in('id', emptyIds);
      }

      // STEP 2: Delete records delivered on the selected date
      const { error: delErr } = await supabase
        .from('dashboard_commercialrecords')
        .delete()
        .eq('customer_name', customerName)
        .eq('delivery_date', selectedDate);

      if (delErr) throw delErr;

      await fetchSummary();
      setDeleteModal(null);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to delete records');
    } finally {
      setDeleting(false);
    }
  };

  // ─── Change Delivery Boy for a Customer's records on selectedDate ──────────

  const handleChangeDeliveryBoy = async (customerName: string, newBoy: DeliveryBoy) => {
    setSavingDeliveryBoy(true);
    try {
      const { error } = await supabase
        .from('dashboard_commercialrecords')
        .update({ delivery_boy: newBoy })
        .eq('customer_name', customerName)
        .eq('delivery_date', selectedDate);

      if (error) throw error;

      await fetchSummary();
      setEditingDeliveryBoyFor(null);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update delivery boy');
    } finally {
      setSavingDeliveryBoy(false);
    }
  };

  const deliveryBoyLetter = (boy: DeliveryBoy | null): string => {
    if (boy === 'NAMDEV') return 'N';
    if (boy === 'GODOWN') return 'G';
    if (boy === 'OTHER') return 'O';
    return '-';
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>

      {/* ── Blue Header ──────────────────────────────────────────────────── */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Commercial</Text>

              <TouchableOpacity
                onPress={() => setShowDatePicker(true)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}
              >
                <Ionicons name="calendar-outline" size={14} color="rgba(255,255,255,0.9)" />
                <Text style={styles.headerDate}>
                  {format(new Date(selectedDate + 'T00:00:00'), 'dd MMM yyyy')}
                </Text>
                <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.9)" />
              </TouchableOpacity>

              {showDatePicker && (
                <DateTimePicker
                  value={new Date(selectedDate + 'T00:00:00')}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    setShowDatePicker(false);
                    if (event.type === 'set' && date) {
                      setSelectedDate(format(date, 'yyyy-MM-dd'));
                      setSelectedCustomer('');
                      setSent('');
                      setReceived('');
                    }
                  }}
                />
              )}
            </View>

            <View style={styles.headerBadges}>
              <TouchableOpacity
                style={styles.printerIconBtn}
                onPress={() => setPrinterModalVisible(true)}
              >
                <Ionicons
                  name="print-outline"
                  size={20}
                  color={connectedPrinter ? '#fff' : 'rgba(255,255,255,0.5)'}
                />
              </TouchableOpacity>
              <View style={styles.headerBadge}>
                <Text style={styles.headerBadgeNum}>{totalDelivered}</Text>
                <Text style={styles.headerBadgeLabel}>Sent</Text>
              </View>
              <View style={[styles.headerBadge, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
                <Text style={styles.headerBadgeNum}>{totalReceived}</Text>
                <Text style={styles.headerBadgeLabel}>Received</Text>
              </View>
            </View>
          </View>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* ── Entry Form Card ───────────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>New Entry — {selectedDate}</Text>

            {/* Customer Dropdown */}
            <Text style={styles.label}>Select Customer *</Text>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => { setCustomerDropdownOpen((p) => !p); setCustomerSearch(''); }}
            >
              <Text style={[styles.dropdownButtonText, !selectedCustomer && styles.dropdownPlaceholder]}>
                {selectedCustomer || 'Select customer...'}
              </Text>
              <Ionicons name={customerDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={BPCL_BLUE} />
            </TouchableOpacity>

            {customerDropdownOpen && (
              <View style={styles.dropdownList}>
                <TextInput
                  style={styles.dropdownSearch}
                  placeholder="Search customer..."
                  value={customerSearch}
                  onChangeText={(text) => setCustomerSearch(text.toUpperCase())}
                  autoCorrect={false}
                />
                <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {customers
                    .filter((c) => c.name.toUpperCase().includes(customerSearch))
                    .map((c) => (
                      <TouchableOpacity
                        key={c.name}
                        style={[styles.dropdownItem, selectedCustomer === c.name && styles.dropdownItemSelected]}
                        onPress={() => { setSelectedCustomer(c.name); setCustomerDropdownOpen(false); setCustomerSearch(''); }}
                      >
                        <Text style={[styles.dropdownItemText, selectedCustomer === c.name && styles.dropdownItemTextSelected]}>
                          {c.name}
                        </Text>
                        {selectedCustomer === c.name && <Ionicons name="checkmark" size={16} color="#fff" />}
                      </TouchableOpacity>
                    ))}
                </ScrollView>
              </View>
            )}

            {/* Delivery Boy */}
            <Text style={[styles.label, { marginTop: 16 }]}>Delivery Boy *</Text>
            <View style={styles.toggleRow}>
              {(['NAMDEV', 'GODOWN', 'OTHER'] as DeliveryBoy[]).map((boy) => (
                <TouchableOpacity
                  key={boy}
                  style={[styles.toggleButton, deliveryBoy === boy && styles.toggleButtonSelected]}
                  onPress={() => setDeliveryBoy(boy)}
                >
                  <Text style={[styles.toggleButtonText, deliveryBoy === boy && styles.toggleButtonTextSelected]}>
                    {boy}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.autoDetectText}>🔍 Auto-detected from {selectedDate} delivery records</Text>

            {/* Sent & Received */}
            <View style={styles.row}>
              <View style={styles.halfInput}>
                <Text style={[styles.label, { marginTop: 16 }]}>Cylinders Sent</Text>
                <TextInput style={styles.input} placeholder="0" keyboardType="numeric" value={sent} onChangeText={setSent} />
                <Text style={styles.hintText}>Creates new records</Text>
              </View>
              <View style={styles.halfInput}>
                <Text style={[styles.label, { marginTop: 16 }]}>Empty Received</Text>
                <TextInput style={styles.input} placeholder="0" keyboardType="numeric" value={received} onChangeText={setReceived} />
                <Text style={styles.hintText}>Updates latest pending</Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.submitButton, submitting && styles.buttonDisabled]}
              onPress={handleSubmitPress}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={22} color="#fff" />
                  <Text style={styles.submitButtonText}>Submit</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* ── Summary Table ─────────────────────────────────────────────── */}
          <View style={styles.tableCard}>
            <View style={styles.tableHeader}>
              <Text style={styles.tableTitle}>Summary — {selectedDate}</Text>
              <TouchableOpacity onPress={fetchSummary} style={styles.refreshButton}>
                <Ionicons name="refresh" size={18} color={BPCL_BLUE} />
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="small" color={BPCL_BLUE} />
                <Text style={styles.loadingText}>Loading...</Text>
              </View>
            ) : summaryRecords.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="clipboard-outline" size={40} color="#ddd" />
                <Text style={styles.emptyText}>No records for {selectedDate}</Text>
              </View>
            ) : (
              <>
                <View style={styles.tableRow}>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 2.0 }]}>Customer</Text>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 0.6, textAlign: 'center' }]}>Boy</Text>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 1, textAlign: 'center' }]}>Status</Text>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 0.7, textAlign: 'center' }]}>Sent</Text>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 1, textAlign: 'center' }]}>Received</Text>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 0 }]}></Text>
                </View>

                {summaryRecords.map((record, index) => {
  return (
    <View key={`${record.customer_name}_${record.is_paid ? 'paid' : 'unpaid'}`} style={[styles.tableRow, index % 2 === 0 && styles.tableRowEven, { alignItems: 'flex-start' }]}>
      <Text style={[styles.tableCell, { flex: 2.2, flexWrap: 'wrap' }]}>{record.customer_name}</Text>

                      <View style={{ flex: 0.7, alignItems: 'center' }}>
                        {record.delivery_count > 0 ? (
                          <TouchableOpacity
                            style={styles.boyBadge}
                            onPress={() =>
                              setEditingDeliveryBoyFor({
                                customer: record.customer_name,
                                current: (record.delivery_boy || 'OTHER') as DeliveryBoy,
                              })
                            }
                          >
                            <Text style={styles.boyBadgeText}>{deliveryBoyLetter(record.delivery_boy)}</Text>
                          </TouchableOpacity>
                        ) : (
                          <Text style={{ color: '#ccc', fontSize: 13 }}>-</Text>
                        )}
                      </View>

                      <View style={{ flex: 1, alignItems: 'center' }}>
                        {record.is_paid ? (
                          <View style={styles.paidBadge}>
                            <Text style={styles.paidBadgeText}>PAID</Text>
                          </View>
                        ) : (
                          <View style={styles.unpaidBadge}>
                            <Text style={styles.unpaidBadgeText}>UNPAID</Text>
                          </View>
                        )}
                      </View>

                      <Text style={[styles.tableCell, { flex: 0.7 }, styles.tableCellCenter]}>{record.delivery_count}</Text>
                      <Text style={[styles.tableCell, { flex: 0.7 }, styles.tableCellCenter]}>{record.empty_received_count}</Text>
                      <TouchableOpacity
                        style={styles.deleteIconBtn}
                        onPress={() => setDeleteModal({ visible: true, customer: record.customer_name })}
                      >
                        <Ionicons name="trash-outline" size={18} color="#e74c3c" />
                      </TouchableOpacity>
                    </View>
                  );
                })}

                <View style={[styles.tableRow, styles.tableTotalRow]}>
                  <Text style={[styles.tableCell, styles.tableCellHeader, { flex: 2.2 }]}>TOTAL</Text>
                  <View style={{ flex: 0.6 }} />
                  <View style={{ flex: 1 }} />
                  <Text style={[styles.tableCell, { flex: 0.7 }, styles.tableCellHeader, styles.tableCellCenter]}>{totalDelivered}</Text>
                  <Text style={[styles.tableCell, { flex: 0.7 }, styles.tableCellHeader, styles.tableCellCenter]}>{totalReceived}</Text>
                  <Text style={[styles.tableCell, { flex: 0.5 }]}></Text>
                </View>
              </>
            )}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ══════════  🖨️ PRINTER PICKER MODAL  ══════════ */}
      <PrinterPickerModal
        visible={printerModalVisible}
        onClose={() => setPrinterModalVisible(false)}
        onConnected={setConnectedPrinter}
      />

      {/* ══════════  DELIVERY CONFIRM MODAL  ══════════ */}
      <Modal visible={showConfirmModal} transparent animationType="slide" onRequestClose={() => setShowConfirmModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Ionicons name="checkmark-circle" size={48} color={BPCL_BLUE} />
              <Text style={styles.modalTitle}>Confirm Entry</Text>
            </View>
            <View style={styles.modalSection}>
              <ModalRow label="Date:" value={selectedDate} />
              <ModalRow label="Customer:" value={selectedCustomer} />
              <ModalRow label="Delivery Boy:" value={deliveryBoy} />
              <View style={styles.modalDivider} />
              <ModalRow label="Cylinders Sent:" value={parseInt(sent, 10) || 0} color={BPCL_BLUE} bold />
              <ModalRow label="Empty Received:" value={parseInt(received, 10) || 0} color="#27ae60" bold />
            </View>
            <Text style={styles.modalNote}>
              {parseInt(sent, 10) > 0 ? `✓ Will create ${parseInt(sent, 10)} new delivery record(s)\n` : ''}
              {parseInt(received, 10) > 0 ? `✓ Will update ${parseInt(received, 10)} empty cylinder record(s)` : ''}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancelButton} onPress={() => setShowConfirmModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={handleConfirmSubmit}>
                <Text style={styles.modalConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══════════  PAYMENT MODAL  ══════════ */}
      <Modal visible={showPaymentModal} transparent animationType="slide" onRequestClose={() => setShowPaymentModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { maxHeight: '85%' }]}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.paymentModalHeader}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.paymentModalTitle}>💰 Record Payment</Text>
                    <Text style={styles.paymentModalSubtitle}>{paymentCustomerName}</Text>
                    <Text style={styles.paymentModalPending}>
                      {paymentPendingCount} total unpaid cylinder{paymentPendingCount > 1 ? 's' : ''}
                    </Text>
                  </View>
                  {/* ✕ close button */}
                  <TouchableOpacity onPress={() => setShowPaymentModal(false)} style={styles.modalCloseBtn}>
                    <Text style={styles.modalCloseBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={styles.paymentSectionLabel}>Select Delivery Date *</Text>

              {paymentPendingDates.length === 0 ? (
                <Text style={styles.paymentNoData}>No pending deliveries found</Text>
              ) : (
                <View style={{ gap: 8, marginBottom: 16 }}>
                  {paymentPendingDates.map((item) => (
                    <TouchableOpacity
                      key={item.date}
                      style={[styles.paymentDateChip, paymentSelectedDate === item.date && styles.paymentDateChipSelected]}
                      onPress={() => handlePaymentDateSelect(item)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.paymentDateText, paymentSelectedDate === item.date && styles.paymentDateTextSelected]}>
                          📅 {format(new Date(item.date), 'dd MMM yyyy')}
                        </Text>
                        <Text style={[styles.paymentDateCount, paymentSelectedDate === item.date && { color: 'rgba(255,255,255,0.8)' }]}>
                          {item.count} cylinder{item.count > 1 ? 's' : ''} pending
                        </Text>
                      </View>
                      {paymentSelectedDate === item.date && <Ionicons name="checkmark-circle" size={20} color="#fff" />}
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {paymentSelectedDate !== '' && (
                <>
                  {paymentLoading ? (
                    <View style={{ padding: 24, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color={BPCL_BLUE} />
                      <Text style={{ color: '#999', marginTop: 8 }}>Fetching rate...</Text>
                    </View>
                  ) : (
                    <>
                      {paymentDiscountApplied ? (
                        <View style={styles.paymentDiscountBanner}>
                          <Text style={styles.paymentDiscountText}>💡 Discount Applied: ₹{paymentDiscount}/cylinder</Text>
                        </View>
                      ) : (
                        <View style={styles.paymentNoDiscountBanner}>
                          <Text style={styles.paymentNoDiscountText}>✅ Full rate — no discount</Text>
                        </View>
                      )}

                      <View style={styles.paymentFieldRow}>
                        <Text style={styles.paymentFieldLabel}>Rate per Cylinder</Text>
                        <View style={[styles.paymentFieldInput, styles.paymentFieldReadonly]}>
                          <Text style={styles.paymentFieldReadonlyText}>₹{paymentRate}</Text>
                        </View>
                      </View>

                      <View style={styles.paymentFieldRow}>
                        <Text style={styles.paymentFieldLabel}>Quantity (Cylinders) *</Text>
                        <TextInput
                          style={styles.paymentFieldInput}
                          keyboardType="numeric"
                          value={paymentQuantity}
                          onChangeText={handlePaymentQuantityChange}
                          placeholder="0"
                        />
                        <Text style={styles.paymentFieldHint}>
                          Pending: {paymentPendingDates.find((d) => d.date === paymentSelectedDate)?.count || 0} — you can pay for fewer
                        </Text>
                      </View>

                      <View style={styles.paymentFieldRow}>
                        <Text style={styles.paymentFieldLabel}>Total Amount (₹) *</Text>
                        <TextInput
                          style={[styles.paymentFieldInput, styles.paymentAmountInput]}
                          keyboardType="numeric"
                          value={paymentAmount}
                          onChangeText={setPaymentAmount}
                          placeholder="0"
                        />
                        <Text style={styles.paymentFieldHint}>
                          Auto: ₹{paymentRate} × {parseInt(paymentQuantity, 10) || 0} = ₹{Math.ceil(paymentRate * (parseInt(paymentQuantity, 10) || 0))}. Edit if different.
                        </Text>
                      </View>

                      <View style={styles.paymentSummaryBox}>
                        <Text style={styles.paymentSummaryTitle}>Payment Summary</Text>
                        <View style={styles.paymentSummaryRow}>
                          <Text style={styles.paymentSummaryLabel}>Customer</Text>
                          <Text style={styles.paymentSummaryValue}>{paymentCustomerName}</Text>
                        </View>
                        <View style={styles.paymentSummaryRow}>
                          <Text style={styles.paymentSummaryLabel}>Delivery Date</Text>
                          <Text style={styles.paymentSummaryValue}>{paymentSelectedDate}</Text>
                        </View>
                        <View style={styles.paymentSummaryRow}>
                          <Text style={styles.paymentSummaryLabel}>Payment Date</Text>
                          <Text style={[styles.paymentSummaryValue, { color: BPCL_BLUE }]}>{selectedDate}</Text>
                        </View>
                        <View style={styles.paymentSummaryRow}>
                          <Text style={styles.paymentSummaryLabel}>Rate</Text>
                          <Text style={styles.paymentSummaryValue}>₹{paymentRate}/cyl</Text>
                        </View>
                        <View style={[styles.paymentSummaryRow, { borderTopWidth: 1, borderTopColor: '#ddd', paddingTop: 8, marginTop: 4 }]}>
                          <Text style={[styles.paymentSummaryLabel, { fontWeight: 'bold', color: '#333' }]}>
                            {paymentQuantity || 0} cyl × ₹{paymentRate}
                          </Text>
                          <Text style={[styles.paymentSummaryValue, { fontSize: 20, color: BPCL_BLUE }]}>
                            ₹{parseInt(paymentAmount, 10) || 0}
                          </Text>
                        </View>
                      </View>

                      {/* Confirm Payment — opens Cash/Paytm popup */}
                      <TouchableOpacity
                        style={[styles.paymentConfirmBtn, paymentSubmitting && styles.buttonDisabled]}
                        onPress={handleConfirmPayment}
                        disabled={paymentSubmitting}
                      >
                        {paymentSubmitting ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <>
                            <Ionicons name="checkmark-circle" size={22} color="#fff" />
                            <Text style={styles.paymentConfirmBtnText}>Confirm Payment</Text>
                          </>
                        )}
                      </TouchableOpacity>

                      {/* Skip — Record Later: triggers delivery-only WhatsApp update */}
                      <TouchableOpacity style={styles.paymentSkipBtn} onPress={handleSkipPayment}>
                        <Text style={styles.paymentSkipBtnText}>Skip — Record Later</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </>
              )}
              <View style={{ height: 24 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ─── CASH / PAYTM PAYMENT MODE MODAL ─── */}
      <Modal
        visible={paymentModeVisible}
        transparent
        animationType="fade"
        onRequestClose={handlePaymentModeClose}
      >
        <View style={styles.pmOverlay}>
          <View style={styles.pmBox}>

            {/* ✕ Close */}
            <TouchableOpacity style={styles.pmCloseBtn} onPress={handlePaymentModeClose}>
              <Text style={styles.pmCloseBtnText}>✕</Text>
            </TouchableOpacity>

            {/* Icon + Title */}
            <View style={styles.pmIconCircle}>
              <Text style={styles.pmIconText}>💳</Text>
            </View>
            <Text style={styles.pmTitle}>Payment mode</Text>
            <Text style={styles.pmSubtitle}>How was this credit received?</Text>

            <View style={styles.pmDivider} />

            {/* CASH option */}
            <TouchableOpacity
              style={[styles.pmOptionBtn, paymentModeSelected === 'CASH' && styles.pmOptionSelected]}
              onPress={() => setPaymentModeSelected('CASH')}
              activeOpacity={0.8}
            >
              <View style={[styles.pmOptionIcon, { backgroundColor: '#EAF3DE' }]}>
                <Text style={{ fontSize: 18 }}>💵</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.pmOptionLabel}>Cash</Text>
                <Text style={styles.pmOptionDesc}>Physical cash payment received</Text>
              </View>
              {paymentModeSelected === 'CASH' && (
                <View style={styles.pmOptionTick}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>✓</Text>
                </View>
              )}
            </TouchableOpacity>

            {/* PAYTM option */}
            <TouchableOpacity
              style={[styles.pmOptionBtn, paymentModeSelected === 'PAYTM' && styles.pmOptionSelected]}
              onPress={() => setPaymentModeSelected('PAYTM')}
              activeOpacity={0.8}
            >
              <View style={[styles.pmOptionIcon, { backgroundColor: '#E6F1FB' }]}>
                <Text style={{ fontSize: 18 }}>📱</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.pmOptionLabel}>Paytm</Text>
                <Text style={styles.pmOptionDesc}>Digital / UPI payment received</Text>
              </View>
              {paymentModeSelected === 'PAYTM' && (
                <View style={styles.pmOptionTick}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>✓</Text>
                </View>
              )}
            </TouchableOpacity>

            {/* Confirm — disabled until selection */}
            <TouchableOpacity
              style={[styles.pmConfirmBtn, !paymentModeSelected && styles.pmConfirmBtnDisabled]}
              onPress={handlePaymentModeConfirm}
              disabled={!paymentModeSelected}
              activeOpacity={0.8}
            >
              {paymentSubmitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.pmConfirmBtnText}>Confirm payment</Text>
              )}
            </TouchableOpacity>

          </View>
        </View>
      </Modal>

      {/* ══════════  🚚 DELIVERY BOY QUICK-EDIT MODAL  ══════════ */}
      <Modal
        visible={!!editingDeliveryBoyFor}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingDeliveryBoyFor(null)}
      >
        <View style={styles.pmOverlay}>
          <View style={styles.pmBox}>
            <TouchableOpacity style={styles.pmCloseBtn} onPress={() => setEditingDeliveryBoyFor(null)}>
              <Text style={styles.pmCloseBtnText}>✕</Text>
            </TouchableOpacity>

            <View style={styles.pmIconCircle}>
              <Text style={styles.pmIconText}>🚚</Text>
            </View>
            <Text style={styles.pmTitle}>Delivery Boy</Text>
            <Text style={styles.pmSubtitle}>{editingDeliveryBoyFor?.customer}</Text>

            <View style={styles.pmDivider} />

            {(['NAMDEV', 'GODOWN', 'OTHER'] as DeliveryBoy[]).map((boy) => {
              const isCurrent = editingDeliveryBoyFor?.current === boy;
              return (
                <TouchableOpacity
                  key={boy}
                  style={[styles.pmOptionBtn, isCurrent && styles.pmOptionSelected]}
                  activeOpacity={0.8}
                  disabled={savingDeliveryBoy}
                  onPress={() => {
                    if (!editingDeliveryBoyFor) return;
                    if (isCurrent) {
                      setEditingDeliveryBoyFor(null);
                      return;
                    }
                    handleChangeDeliveryBoy(editingDeliveryBoyFor.customer, boy);
                  }}
                >
                  <View style={[styles.pmOptionIcon, { backgroundColor: '#E6F1FB' }]}>
                    <Text style={{ fontSize: 16, fontWeight: 'bold', color: BPCL_BLUE }}>
                      {deliveryBoyLetter(boy)}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pmOptionLabel}>{boy}</Text>
                  </View>
                  {isCurrent && (
                    <View style={styles.pmOptionTick}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>✓</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            {savingDeliveryBoy && (
              <View style={{ marginTop: 8, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={BPCL_BLUE} />
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* ══════════  ✅ DELIVERY SUCCESS MODAL  ══════════ */}
      <Modal visible={!!successModal?.visible} transparent animationType="fade"
        onRequestClose={() => setSuccessModal(null)}>
        <View style={styles.resultOverlay}>
          <View style={styles.resultBox}>
            <View style={[styles.resultIconCircle, { backgroundColor: '#E9F8EF' }]}>
              <Ionicons name="checkmark-circle" size={44} color="#27ae60" />
            </View>
            <Text style={styles.resultTitle}>Delivery Recorded</Text>
            <Text style={styles.resultSubtitle}>Entry saved successfully</Text>

            <View style={styles.resultCard}>
              <ResultRow label="Customer" value={successModal?.customer || ''} />
              <ResultRow label="Date" value={successModal?.date || ''} />
              <View style={styles.resultDivider} />
              <ResultRow label="Cylinders Sent" value={successModal?.sent ?? 0} color={BPCL_BLUE} bold />
              <ResultRow label="Empty Received" value={successModal?.received ?? 0} color="#27ae60" bold />
            </View>

            {/* 🖨️ Print Receipt */}
            <TouchableOpacity
              style={styles.resultPrintBtn}
              onPress={async () => {
                if (!successModal) return;
                const rate = await fetchActualRate(successModal.date);
                const amountDue = Math.ceil(rate * successModal.sent);
                handlePrintReceipt({
                  type: 'DELIVERY',
                  customerName: successModal.customer,
                  date: successModal.date,
                  sent: successModal.sent,
                  received: successModal.received,
                  deliveryBoy: deliveryBoy,
                  rate,
                  amountDue,
                });
              }}
            >
              <Ionicons name="print-outline" size={18} color={BPCL_BLUE} />
              <Text style={styles.resultPrintBtnText}>Print Receipt</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.resultPrimaryBtn} onPress={() => {
              const cust = successModal?.customer;
              const sentQty = successModal?.sent || 0;
              const recQty = successModal?.received || 0;
              const hadSent = sentQty > 0;
              setSuccessModal(null);
              if (hadSent && cust) {
                checkAndOfferPayment(cust, sentQty, recQty);
              }
            }}>
              <Text style={styles.resultPrimaryBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ══════════  💰 OFFER PAYMENT MODAL  ══════════ */}
      <Modal visible={!!offerPaymentModal?.visible} transparent animationType="fade"
        onRequestClose={() => setOfferPaymentModal(null)}>
        <View style={styles.resultOverlay}>
          <View style={styles.resultBox}>
            <View style={[styles.resultIconCircle, { backgroundColor: '#FFF4D6' }]}>
              <Text style={{ fontSize: 30 }}>💰</Text>
            </View>
            <Text style={styles.resultTitle}>Record Payment?</Text>
            <Text style={styles.resultSubtitle}>
              {offerPaymentModal?.customer} has{' '}
              <Text style={{ color: '#e74c3c', fontWeight: 'bold' }}>
                {offerPaymentModal?.totalPending}
              </Text>{' '}
              unpaid cylinder{(offerPaymentModal?.totalPending || 0) > 1 ? 's' : ''}
            </Text>

            <View style={styles.resultBtnRow}>
              <TouchableOpacity style={styles.resultSkipBtn} onPress={() => {
                const m = offerPaymentModal;
                setOfferPaymentModal(null);
                if (m && m.deliveredQty && m.deliveredQty > 0) {
                  sendWhatsAppForDeliveryOnly({
                    customerName: m.customer,
                    deliveryDate: selectedDate,
                    quantity: m.deliveredQty,
                    emptyReceived: m.emptyReceivedQty,
                  });
                }
              }}>
                <Text style={styles.resultSkipBtnText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.resultRecordBtn}
                onPress={() => {
                  const m = offerPaymentModal;
                  setOfferPaymentModal(null);
                  if (m) openPaymentModal(m.customer, m.dateList, m.totalPending);
                }}
              >
                <Ionicons name="card-outline" size={18} color="#fff" />
                <Text style={styles.resultRecordBtnText}>Record Payment</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══════════  ✅ PAYMENT DONE MODAL  ══════════ */}
      <Modal visible={!!paymentDoneModal?.visible} transparent animationType="fade"
        onRequestClose={() => setPaymentDoneModal(null)}>
        <View style={styles.resultOverlay}>
          <View style={styles.resultBox}>
            <View style={[styles.resultIconCircle, { backgroundColor: '#E9F8EF' }]}>
              <Ionicons name="checkmark-done-circle" size={44} color="#27ae60" />
            </View>
            <Text style={styles.resultTitle}>Payment Recorded</Text>
            <Text style={styles.resultSubtitle}>Transaction saved successfully</Text>

            <View style={styles.resultCard}>
              <ResultRow label="Customer" value={paymentDoneModal?.customer || ''} />
              <ResultRow label="Delivery Date" value={paymentDoneModal?.deliveryDate || ''} />
              <ResultRow label="Payment Date" value={paymentDoneModal?.paymentDate || ''} color={BPCL_BLUE} />
              <ResultRow label="Cylinders" value={paymentDoneModal?.qty ?? 0} />
              <ResultRow label="Rate" value={`₹${paymentDoneModal?.rate ?? 0}/cyl`} />
              <View style={styles.resultDivider} />
              <ResultRow label="Total Paid" value={`₹${paymentDoneModal?.amount ?? 0}`} color="#27ae60" bold big />
              <View style={[styles.resultModePill,
                { backgroundColor: paymentDoneModal?.isPaytm ? '#E6F1FB' : '#EAF3DE' }]}>
                <Text style={{ fontSize: 14 }}>{paymentDoneModal?.isPaytm ? '📱' : '💵'}</Text>
                <Text style={[styles.resultModePillText,
                  { color: paymentDoneModal?.isPaytm ? BPCL_BLUE : '#5a7a2e' }]}>
                  {paymentDoneModal?.isPaytm ? 'Paytm' : 'Cash'}
                </Text>
              </View>
            </View>

            {/* 🖨️ Print Receipt */}
            <TouchableOpacity
              style={styles.resultPrintBtn}
              onPress={async () => {
                if (!paymentDoneModal) return;

                const rate = await fetchActualRate(paymentDoneModal.deliveryDate);

                const { count: pendingCount } = await supabase
                  .from('dashboard_commercialrecords')
                  .select('id', { count: 'exact', head: true })
                  .eq('customer_name', paymentDoneModal.customer)
                  .eq('delivery_date', paymentDoneModal.deliveryDate)
                  .is('payment_date', null);

                const pendingQty = pendingCount || 0;
                const pendingAmount = pendingQty > 0 ? Math.ceil(rate * pendingQty) : 0;

                handlePrintReceipt({
                  type: 'PAYMENT',
                  customerName: paymentDoneModal.customer,
                  deliveryDate: paymentDoneModal.deliveryDate,
                  paymentDate: paymentDoneModal.paymentDate,
                  quantity: paymentDoneModal.qty,
                  rate,
                  amount: paymentDoneModal.amount,
                  paymentMode: paymentDoneModal.isPaytm ? 'PAYTM' : 'CASH',
                  pendingQty,
                  pendingAmount,
                });
              }}
            >
              <Ionicons name="print-outline" size={18} color={BPCL_BLUE} />
              <Text style={styles.resultPrintBtnText}>Print Receipt</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.resultPrimaryBtn} onPress={() => setPaymentDoneModal(null)}>
              <Text style={styles.resultPrimaryBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ══════════  🗑️ DELETE CONFIRM MODAL  ══════════ */}
      <Modal visible={!!deleteModal?.visible} transparent animationType="fade"
        onRequestClose={() => setDeleteModal(null)}>
        <View style={styles.resultOverlay}>
          <View style={styles.resultBox}>
            <View style={[styles.resultIconCircle, { backgroundColor: '#FDECEA' }]}>
              <Ionicons name="trash" size={36} color="#e74c3c" />
            </View>
            <Text style={styles.resultTitle}>Delete Records?</Text>
            <Text style={styles.resultSubtitle}>
              This will reset empties received today and delete{'\n'}
              <Text style={{ fontWeight: 'bold', color: '#333' }}>{deleteModal?.customer}</Text>s
              deliveries for <Text style={{ fontWeight: 'bold', color: '#333' }}>{selectedDate}</Text>.
            </Text>

            <View style={styles.resultBtnRow}>
              <TouchableOpacity style={styles.resultSkipBtn} onPress={() => setDeleteModal(null)} disabled={deleting}>
                <Text style={styles.resultSkipBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resultDeleteBtn} onPress={handleDeleteRecords} disabled={deleting}>
                {deleting ? <ActivityIndicator size="small" color="#fff" /> : (
                  <>
                    <Ionicons name="trash-outline" size={18} color="#fff" />
                    <Text style={styles.resultDeleteBtnText}>Delete</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─── Modal Row Helper ─────────────────────────────────────────────────────────

const ModalRow = ({ label, value, color, bold }: { label: string; value: string | number; color?: string; bold?: boolean }) => (
  <View style={styles.modalRow}>
    <Text style={styles.modalLabel}>{label}</Text>
    <Text style={[styles.modalValue, bold && styles.modalValueBold, color ? { color } : {}]}>{value}</Text>
  </View>
);

// ─── Result Row Helper ────────────────────────────────────────────────────────

const ResultRow = ({ label, value, color, bold, big }: {
  label: string; value: string | number; color?: string; bold?: boolean; big?: boolean;
}) => (
  <View style={styles.resultRow}>
    <Text style={styles.resultRowLabel}>{label}</Text>
    <Text style={[
      styles.resultRowValue,
      bold && { fontWeight: 'bold' },
      big && { fontSize: 20 },
      color ? { color } : {},
    ]}>{value}</Text>
  </View>
);

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  // ── Header ──
  header: { backgroundColor: BPCL_BLUE, shadowColor: '#000', shadowOffset: { width: 0, height: 1.5 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 5 },
  headerContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  headerDate: { fontSize: 14, color: 'rgba(255,255,255,0.9)' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  headerBadges: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  printerIconBtn: { padding: 6, marginRight: 2 },
  headerBadge: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center' },
  headerBadgeNum: { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  headerBadgeLabel: { fontSize: 11, color: 'rgba(255,255,255,0.8)' },

  // ── Date controls ──
  dateEditRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  dateInput: { flex: 1, backgroundColor: 'rgba(255,255,255,0.2)', color: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  dateSaveBtn: { backgroundColor: 'rgba(255,255,255,0.3)', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  dateSaveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  datePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.18)', alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', marginTop: 6 },
  datePillText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  datePillEdit: { color: 'rgba(255,255,255,0.65)', fontSize: 12 },

  scrollView: { flex: 1 },

  // ── Card ──
  card: { backgroundColor: '#fff', margin: 16, padding: 16, borderRadius: 12, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4 },
  cardTitle: { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 16 },

  // ── Form ──
  label: { fontSize: 14, color: '#666', marginBottom: 8, fontWeight: '600' },
  input: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16 },
  hintText: { fontSize: 11, color: '#999', marginTop: 4, fontStyle: 'italic' },
  row: { flexDirection: 'row', gap: 12 },
  halfInput: { flex: 1 },
  autoDetectText: { fontSize: 11, color: '#999', marginTop: 6, fontStyle: 'italic' },

  // ── Dropdown ──
  dropdownButton: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: BPCL_BLUE, borderRadius: 8, padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dropdownButtonText: { fontSize: 15, color: '#333', fontWeight: '600' },
  dropdownPlaceholder: { color: '#aaa', fontWeight: '400' },
  dropdownList: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, marginTop: 4, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  dropdownSearch: { padding: 10, fontSize: 14, borderBottomWidth: 1, borderBottomColor: '#eee', backgroundColor: '#f8f9fa', borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  dropdownItem: { padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  dropdownItemSelected: { backgroundColor: BPCL_BLUE },
  dropdownItemText: { fontSize: 14, color: '#333' },
  dropdownItemTextSelected: { color: '#fff', fontWeight: 'bold' },

  // ── Toggle ──
  toggleRow: { flexDirection: 'row', gap: 8 },
  toggleButton: { flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', alignItems: 'center', backgroundColor: '#f8f9fa' },
  toggleButtonSelected: { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  toggleButtonText: { fontSize: 13, color: '#666', fontWeight: '600' },
  toggleButtonTextSelected: { color: '#fff' },

  // ── Submit ──
  submitButton: { backgroundColor: BPCL_BLUE, padding: 14, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20 },
  submitButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  buttonDisabled: { opacity: 0.6 },

  // ── Table ──
  tableCard: { backgroundColor: '#fff', margin: 16, marginTop: 0, borderRadius: 12, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4, overflow: 'hidden' },
  tableHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  tableTitle: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  refreshButton: { padding: 4 },
  tableRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f5f5f5', alignItems: 'center' },
  tableRowEven: { backgroundColor: '#fafafa' },
  tableTotalRow: { backgroundColor: '#e8f4f8', borderTopWidth: 2, borderTopColor: BPCL_BLUE },
  tableCell: { flex: 1, fontSize: 13, color: '#333' },
  tableCellHeader: { fontWeight: 'bold', color: '#333', fontSize: 11 },
  tableCellCenter: { textAlign: 'center' },
  deleteIconBtn: { flex: 0.5, alignItems: 'center', justifyContent: 'center' },

  // ── Delivery Boy Badge (in summary row) ──
  boyBadge: { width: 26, height: 26, borderRadius: 13, backgroundColor: BPCL_BLUE, alignItems: 'center', justifyContent: 'center' },
  boyBadgeText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },

  // ── Status Badges ──
  paidBadge: { backgroundColor: '#EAF3DE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: '#27ae60' },
  paidBadgeText: { color: '#27ae60', fontSize: 10, fontWeight: 'bold' },
  unpaidBadge: { backgroundColor: '#FDECEA', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: '#e74c3c' },
  unpaidBadgeText: { color: '#e74c3c', fontSize: 10, fontWeight: 'bold' },

  // ── Loading / Empty ──
  loadingBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  loadingText: { color: '#999', fontSize: 14 },
  emptyBox: { alignItems: 'center', padding: 32, gap: 8 },
  emptyText: { fontSize: 14, color: '#ccc', fontWeight: '600' },

  // ── Delivery Confirm Modal ──
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalHeader: { alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 22, fontWeight: 'bold', color: '#333', marginTop: 8 },
  modalSection: { backgroundColor: '#f8f9fa', padding: 16, borderRadius: 12, marginBottom: 12 },
  modalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  modalDivider: { height: 1, backgroundColor: '#eee', marginVertical: 8 },
  modalLabel: { fontSize: 14, color: '#666' },
  modalValue: { fontSize: 14, fontWeight: '600', color: '#333' },
  modalValueBold: { fontSize: 16, fontWeight: 'bold' },
  modalNote: { fontSize: 12, color: '#888', fontStyle: 'italic', marginBottom: 16, lineHeight: 18 },
  modalButtons: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  modalCancelButton: { flex: 1, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#ddd', alignItems: 'center' },
  modalCancelText: { fontSize: 16, color: '#666', fontWeight: '600' },
  modalConfirmButton: { flex: 2, padding: 14, borderRadius: 10, backgroundColor: BPCL_BLUE, alignItems: 'center' },
  modalConfirmText: { fontSize: 16, color: '#fff', fontWeight: 'bold' },

  // ── Payment Modal close button (✕ style) ──
  modalCloseBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#f0f0f0', alignItems: 'center', justifyContent: 'center' },
  modalCloseBtnText: { fontSize: 14, color: '#555', fontWeight: 'bold' },

  // ── Payment Modal ──
  paymentModalHeader: { marginBottom: 16 },
  paymentModalTitle: { fontSize: 22, fontWeight: 'bold', color: '#333' },
  paymentModalSubtitle: { fontSize: 16, fontWeight: '600', color: BPCL_BLUE, marginTop: 4 },
  paymentModalPending: { fontSize: 13, color: '#e74c3c', marginTop: 4, fontWeight: '500' },
  paymentSectionLabel: { fontSize: 14, fontWeight: '600', color: '#444', marginBottom: 10 },
  paymentNoData: { fontSize: 13, color: '#999', fontStyle: 'italic', marginBottom: 16 },
  paymentDateChip: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#f8f9fa' },
  paymentDateChipSelected: { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  paymentDateText: { fontSize: 14, fontWeight: '600', color: '#333' },
  paymentDateTextSelected: { color: '#fff' },
  paymentDateCount: { fontSize: 12, color: '#888', marginTop: 2 },
  paymentDiscountBanner: { backgroundColor: '#fff8e1', padding: 10, borderRadius: 8, marginBottom: 14, borderLeftWidth: 3, borderLeftColor: BPCL_YELLOW },
  paymentDiscountText: { fontSize: 12, color: '#856404', fontWeight: '600' },
  paymentNoDiscountBanner: { backgroundColor: '#f0fff4', padding: 10, borderRadius: 8, marginBottom: 14, borderLeftWidth: 3, borderLeftColor: '#27ae60' },
  paymentNoDiscountText: { fontSize: 12, color: '#276749', fontWeight: '600' },
  paymentFieldRow: { marginBottom: 14 },
  paymentFieldLabel: { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 6 },
  paymentFieldInput: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16, color: '#333' },
  paymentFieldReadonly: { backgroundColor: '#e8f4f8', borderColor: BPCL_BLUE },
  paymentFieldReadonlyText: { fontSize: 16, fontWeight: 'bold', color: BPCL_BLUE },
  paymentFieldHint: { fontSize: 11, color: '#999', marginTop: 4, fontStyle: 'italic' },
  paymentAmountInput: { borderColor: BPCL_BLUE, borderWidth: 2, fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, backgroundColor: '#e8f4f8' },
  paymentAmountInputError: { borderColor: '#e74c3c' },
  paymentSummaryBox: { backgroundColor: '#f8f9fa', padding: 14, borderRadius: 10, marginBottom: 16, borderWidth: 1, borderColor: '#eee' },
  paymentSummaryTitle: { fontSize: 14, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  paymentSummaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  paymentSummaryLabel: { fontSize: 13, color: '#666' },
  paymentSummaryValue: { fontSize: 13, fontWeight: '600', color: '#333' },
  paymentConfirmBtn: { backgroundColor: '#27ae60', padding: 16, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 },
  paymentConfirmBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  paymentSkipBtn: { padding: 12, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#ddd' },
  paymentSkipBtnText: { color: '#999', fontSize: 14, fontWeight: '600' },

  // ── Cash / Paytm Payment Mode Popup ──
  pmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  pmBox: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '88%', elevation: 10, position: 'relative' },
  pmCloseBtn: { position: 'absolute', top: 14, right: 14, width: 30, height: 30, borderRadius: 15, backgroundColor: '#f0f0f0', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  pmCloseBtnText: { fontSize: 14, color: '#555', fontWeight: 'bold' },
  pmIconCircle: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#E6F1FB', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  pmIconText:   { fontSize: 22 },
  pmTitle:      { fontSize: 18, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 4 },
  pmSubtitle:   { fontSize: 13, color: '#888', marginBottom: 18 },
  pmDivider:    { height: 1, backgroundColor: '#eee', marginBottom: 16 },
  pmOptionBtn: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#e0e0e0', backgroundColor: '#fff', marginBottom: 10 },
  pmOptionSelected: { borderColor: BPCL_BLUE, backgroundColor: '#E6F1FB' },
  pmOptionIcon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  pmOptionLabel: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginBottom: 2 },
  pmOptionDesc:  { fontSize: 12, color: '#888' },
  pmOptionTick: { width: 22, height: 22, borderRadius: 11, backgroundColor: BPCL_BLUE, alignItems: 'center', justifyContent: 'center' },
  pmConfirmBtn: { backgroundColor: BPCL_BLUE, padding: 15, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  pmConfirmBtnDisabled: { backgroundColor: '#a0c8e8' },
  pmConfirmBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },

  // ── Beautiful Result Popups ──
  resultOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  resultBox: { backgroundColor: '#fff', borderRadius: 22, padding: 24, width: '100%', maxWidth: 380, alignItems: 'center', elevation: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 12 },
  resultIconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  resultTitle: { fontSize: 21, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 6, textAlign: 'center' },
  resultSubtitle: { fontSize: 14, color: '#888', textAlign: 'center', lineHeight: 20, marginBottom: 18 },
  resultCard: { width: '100%', backgroundColor: '#f8f9fb', borderRadius: 14, padding: 16, marginBottom: 20 },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  resultRowLabel: { fontSize: 14, color: '#777' },
  resultRowValue: { fontSize: 15, fontWeight: '600', color: '#333', maxWidth: '60%', textAlign: 'right' },
  resultDivider: { height: 1, backgroundColor: '#e8e8e8', marginVertical: 8 },
  resultModePill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, marginTop: 10 },
  resultModePillText: { fontSize: 13, fontWeight: 'bold' },
  resultPrintBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: BPCL_BLUE, width: '100%', marginBottom: 10 },
  resultPrintBtnText: { color: BPCL_BLUE, fontSize: 15, fontWeight: 'bold' },
  resultPrimaryBtn: { backgroundColor: BPCL_BLUE, paddingVertical: 14, borderRadius: 12, width: '100%', alignItems: 'center' },
  resultPrimaryBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  resultBtnRow: { flexDirection: 'row', gap: 12, width: '100%' },
  resultSkipBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#ddd', alignItems: 'center', justifyContent: 'center' },
  resultSkipBtnText: { color: '#777', fontSize: 15, fontWeight: '600' },
  resultRecordBtn: { flex: 1.6, flexDirection: 'row', gap: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: '#27ae60', alignItems: 'center', justifyContent: 'center' },
  resultRecordBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  resultDeleteBtn: { flex: 1.6, flexDirection: 'row', gap: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: '#e74c3c', alignItems: 'center', justifyContent: 'center' },
  resultDeleteBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
});
