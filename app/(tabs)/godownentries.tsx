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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '@/lib/supabase';
import { format, subDays } from 'date-fns';
import DateTimePicker from '@react-native-community/datetimepicker';

// Import our push notification utility
import { registerForPushNotificationsAsync } from '@/utils/notifications';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface DailyStock {
  date: string;
  opening_full: number;
  opening_empty: number;
  supply_received_full: number;
  supply_sent_empty: number;
  closing_full: number;
  closing_empty: number;
}

interface GodownTrip {
  id: string;
  date: string;
  delivery_boy: string;
  trip_number: number;
  full_dispatched: number;
  full_returned: number;
  empty_returned: number;
}

interface AgencyTransaction {
  id: string;
  agency_name: string;
  transaction_type: 'RECEIVED_FULL' | 'RECEIVED_EMPTY' | 'SENT_FULL' | 'SENT_EMPTY';
  quantity: number;
}

interface SpotDelivery {
  id: string;
  token_number: number;
  consumer_identifier: string;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function GodownKeeperScreen() {
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [loading, setLoading] = useState(false);

  // Daily State
  const [stockRecord, setStockRecord] = useState<DailyStock | null>(null);
  const [dailyTrips, setDailyTrips] = useState<GodownTrip[]>([]);
  const [agencyTransactions, setAgencyTransactions] = useState<AgencyTransaction[]>([]);
  const [spotDeliveries, setSpotDeliveries] = useState<SpotDelivery[]>([]);

  // Selection Dropdown Lists (Initially empty to ensure zero hard-coded names)
  const [deliveryBoysList, setDeliveryBoysList] = useState<string[]>([]);
  const [agenciesList, setAgenciesList] = useState<string[]>([]);

  // Dispatch Form Fields (Morning)
  const [newTripBoy, setNewTripBoy] = useState('');
  const [newTripDispatched, setNewTripDispatched] = useState('');

  // Return Form Fields (Evening)
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [selectedTripToReturn, setSelectedTripToReturn] = useState<GodownTrip | null>(null);
  const [tripReturnedFull, setTripReturnedFull] = useState('');
  const [tripReturnedEmpty, setTripReturnedEmpty] = useState('');

  // Agency Transaction Fields
  const [newAgencyName, setNewAgencyName] = useState('');
  const [customAgencyInput, setCustomAgencyInput] = useState('');
  const [agencyTradeType, setAgencyTradeType] = useState<'RECEIVED_FULL' | 'RECEIVED_EMPTY' | 'SENT_FULL' | 'SENT_EMPTY'>('RECEIVED_FULL');
  const [agencyQty, setAgencyQty] = useState('');

  // Plant Stock Fields
  const [supplyReceivedInput, setSupplyReceivedInput] = useState('');
  const [emptiesSentInput, setEmptiesSentInput] = useState('');

  // Token Spot Board Fields
  const [tokenPage, setTokenPage] = useState(0);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [selectedTokenNum, setSelectedTokenNum] = useState<number | null>(null);
  const [consumerIdInput, setConsumerIdInput] = useState('');

  const [duplicateConfirmModal, setDuplicateConfirmModal] = useState<{
    visible: boolean;
    tokenNum: number;
    existingEntry: string;
  } | null>(null);

  // Manual Opening Stock Fields
  const [openingStockModalVisible, setOpeningStockModalVisible] = useState(false);
  const [manualOpeningFull, setManualOpeningFull] = useState('');
  const [manualOpeningEmpty, setManualOpeningEmpty] = useState('');

  // ─── Fetching & Data Sync ──────────────────────────────────────────────────

  useEffect(() => {
    fetchGodownData();
  }, [selectedDate]);

  const fetchGodownData = async () => {
    setLoading(true);
    try {
      // 1. Fetch dynamic Delivery Boys list from dashboard_deliveryboyname (excluding 'DBA -' and no hardcoding)
      const { data: rawDeliveryBoys, error: boyErr } = await supabase
        .from('dashboard_deliveryboyname')
        .select('name');

      if (!boyErr && rawDeliveryBoys) {
        const filtered = rawDeliveryBoys
          .map((db) => db.name)
          .filter((name) => name && !name.includes('DBA -'));
        setDeliveryBoysList(Array.from(new Set(filtered)));
      }

      // 2. Fetch external Agencies list
      const { data: rawAgencies } = await supabase.from('mobile_godownagencytransactions').select('agency_name');
      const uniqueAgencies = Array.from(new Set((rawAgencies || []).map((a) => a.agency_name).filter(Boolean)));
      setAgenciesList(Array.from(new Set([...['MANGALAM', 'DESHMUKH', 'SAI KRUPA', 'SATYAM', 'SAGAR'], ...uniqueAgencies])));

      // 3. Fetch Daily Stock
      let { data: stock, error: stockErr } = await supabase
        .from('mobile_godowndailystock')
        .select('*')
        .eq('date', selectedDate)
        .single();

      if (stockErr && stockErr.code === 'PGRST116') {
        // Find previous date to carry forward closing balances
        const prevDateStr = format(subDays(new Date(selectedDate + 'T00:00:00'), 1), 'yyyy-MM-dd');
        const { data: prevStockArray, error: prevErr } = await supabase
          .from('mobile_godowndailystock')
          .select('closing_full, closing_empty')
          .eq('date', prevDateStr);

        if (!prevErr && prevStockArray && prevStockArray.length > 0) {
          const yesterdayStock = prevStockArray[0];
          const openingFull = yesterdayStock.closing_full || 0;
          const openingEmpty = yesterdayStock.closing_empty || 0;

          const { data: newStock, error: insErr } = await supabase
            .from('mobile_godowndailystock')
            .insert({
              date: selectedDate,
              opening_full: openingFull,
              opening_empty: openingEmpty,
              supply_received_full: 0,
              supply_sent_empty: 0,
              closing_full: openingFull,
              closing_empty: openingEmpty,
            })
            .select()
            .single();

          if (!insErr && newStock) {
            stock = newStock;
          }
        } else {
          // Trigger opening stock manual entering popup
          setStockRecord(null);
          setOpeningStockModalVisible(true);
          setLoading(false);
          return;
        }
      }

      setStockRecord(stock);
      setSupplyReceivedInput(stock?.supply_received_full?.toString() || '0');
      setEmptiesSentInput(stock?.supply_sent_empty?.toString() || '0');

      // 4. Fetch daily trips
      const { data: trips } = await supabase
        .from('mobile_godowntrips')
        .select('*')
        .eq('date', selectedDate)
        .order('created_at', { ascending: true });
      setDailyTrips(trips || []);

      // 5. Fetch agency exchanges
      const { data: agencyTrans } = await supabase
        .from('mobile_godownagencytransactions')
        .select('*')
        .eq('date', selectedDate)
        .order('created_at', { ascending: true });
      setAgencyTransactions(agencyTrans || []);

      // 6. Fetch spot counter deliveries
      const { data: spotDels } = await supabase
        .from('mobile_godownspotdeliveries')
        .select('*')
        .eq('date', selectedDate)
        .order('created_at', { ascending: true });
      setSpotDeliveries(spotDels || []);

    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'डेटा लोड करने में समस्या आई।');
    } finally {
      setLoading(false);
    }
  };

  const calculateLiveStocks = () => {
    if (!stockRecord) return { full: 0, empty: 0, deliveredNet: 0, receivedEmptiesTotal: 0 };

    const openingFull = stockRecord.opening_full || 0;
    const openingEmpty = stockRecord.opening_empty || 0;
    const supplyReceivedFull = stockRecord.supply_received_full || 0;
    const supplySentEmpty = stockRecord.supply_sent_empty || 0;

    let dispatchedFullTotal = 0;
    let returnedFullTotal = 0;
    let returnedEmptyTotal = 0;

    dailyTrips.forEach((t) => {
      dispatchedFullTotal += t.full_dispatched;
      returnedFullTotal += t.full_returned;
      returnedEmptyTotal += t.empty_returned;
    });

    let agencyFullIn = 0, agencyFullOut = 0, agencyEmptyIn = 0, agencyEmptyOut = 0;
    agencyTransactions.forEach((t) => {
      if (t.transaction_type === 'RECEIVED_FULL') agencyFullIn += t.quantity;
      if (t.transaction_type === 'SENT_FULL') agencyFullOut += t.quantity;
      if (t.transaction_type === 'RECEIVED_EMPTY') agencyEmptyIn += t.quantity;
      if (t.transaction_type === 'SENT_EMPTY') agencyEmptyOut += t.quantity;
    });

    const calculatedFull =
      openingFull +
      supplyReceivedFull +
      returnedFullTotal +
      agencyFullIn -
      dispatchedFullTotal -
      agencyFullOut;

    const calculatedEmpty =
      openingEmpty +
      returnedEmptyTotal +
      agencyEmptyIn -
      agencyEmptyOut -
      supplySentEmpty;

    return {
      full: calculatedFull,
      empty: calculatedEmpty,
      deliveredNet: dispatchedFullTotal - returnedFullTotal,
      receivedEmptiesTotal: returnedEmptyTotal,
    };
  };

  const syncLiveStockToDatabase = async (dateStr: string) => {
    try {
      const { data: stock } = await supabase
        .from('mobile_godowndailystock')
        .select('*')
        .eq('date', dateStr)
        .single();

      if (!stock) return;

      const [tripsRes, agencyRes] = await Promise.all([
        supabase.from('mobile_godowntrips').select('*').eq('date', dateStr),
        supabase.from('mobile_godownagencytransactions').select('*').eq('date', dateStr),
      ]);

      const trips = tripsRes.data || [];
      const agency = agencyRes.data || [];

      let dispatchedFullTotal = 0;
      let returnedFullTotal = 0;
      let returnedEmptyTotal = 0;
      trips.forEach((t) => {
        dispatchedFullTotal += t.full_dispatched;
        returnedFullTotal += t.full_returned;
        returnedEmptyTotal += t.empty_returned;
      });

      let agencyFullIn = 0, agencyFullOut = 0, agencyEmptyIn = 0, agencyEmptyOut = 0;
      agency.forEach((t) => {
        if (t.transaction_type === 'RECEIVED_FULL') agencyFullIn += t.quantity;
        if (t.transaction_type === 'SENT_FULL') agencyFullOut += t.quantity;
        if (t.transaction_type === 'RECEIVED_EMPTY') agencyEmptyIn += t.quantity;
        if (t.transaction_type === 'SENT_EMPTY') agencyEmptyOut += t.quantity;
      });

      const closingFull =
        stock.opening_full +
        stock.supply_received_full +
        returnedFullTotal +
        agencyFullIn -
        dispatchedFullTotal -
        agencyFullOut;

      const closingEmpty =
        stock.opening_empty +
        returnedEmptyTotal +
        agencyEmptyIn -
        agencyEmptyOut -
        stock.supply_sent_empty;

      await supabase
        .from('mobile_godowndailystock')
        .update({
          closing_full: closingFull,
          closing_empty: closingEmpty,
        })
        .eq('date', dateStr);

    } catch (err: any) {
      // Handled silently
    }
  };

  const updateGodownClosingAndPlantStock = async (field: 'supply_received_full' | 'supply_sent_empty', value: number) => {
    if (!stockRecord) return;
    try {
      const updatedRecord = { ...stockRecord, [field]: value };

      let dispatchedFullTotal = 0;
      let returnedFullTotal = 0;
      let returnedEmptyTotal = 0;
      dailyTrips.forEach((t) => {
        dispatchedFullTotal += t.full_dispatched;
        returnedFullTotal += t.full_returned;
        returnedEmptyTotal += t.empty_returned;
      });

      let agencyFullIn = 0, agencyFullOut = 0, agencyEmptyIn = 0, agencyEmptyOut = 0;
      agencyTransactions.forEach((t) => {
        if (t.transaction_type === 'RECEIVED_FULL') agencyFullIn += t.quantity;
        if (t.transaction_type === 'SENT_FULL') agencyFullOut += t.quantity;
        if (t.transaction_type === 'RECEIVED_EMPTY') agencyEmptyIn += t.quantity;
        if (t.transaction_type === 'SENT_EMPTY') agencyEmptyOut += t.quantity;
      });

      const closingFull =
        updatedRecord.opening_full +
        updatedRecord.supply_received_full +
        returnedFullTotal +
        agencyFullIn -
        dispatchedFullTotal -
        agencyFullOut;

      const closingEmpty =
        updatedRecord.opening_empty +
        returnedEmptyTotal +
        agencyEmptyIn -
        agencyEmptyOut -
        updatedRecord.supply_sent_empty;

      const { error } = await supabase
        .from('mobile_godowndailystock')
        .update({
          [field]: value,
          closing_full: closingFull,
          closing_empty: closingEmpty,
        })
        .eq('date', selectedDate);

      if (error) throw error;
      fetchGodownData();
      Alert.alert('सफल', 'स्टॉक जानकारी अपडेट कर दी गई है।');
    } catch (err: any) {
      Alert.alert('त्रुटि', err?.message || 'अपडेट करने में विफल।');
    }
  };

  // ─── Push Notification Trigger Helper ──────────────────────────────────────

  const triggerPushNotification = async (title: string, body: string) => {
    try {
      const pushToken = await registerForPushNotificationsAsync();
      if (!pushToken) {
        console.log('Skipping push notification (No push token retrieved)');
        return;
      }

      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: pushToken,
          title: title,
          body: body,
          sound: 'default',
          priority: 'high',
        }),
      });
      console.log('Push notification triggered successfully!');
    } catch (error) {
      console.error('Failed to trigger push notification API call:', error);
    }
  };

  // ─── Save Manual Opening Stock (Upsert) ────────────────────────────────────

  const handleSaveOpeningStock = async () => {
    const opFull = parseInt(manualOpeningFull, 10) || 0;
    const opEmpty = parseInt(manualOpeningEmpty, 10) || 0;

    try {
      const { error } = await supabase
        .from('mobile_godowndailystock')
        .upsert({
          date: selectedDate,
          opening_full: opFull,
          opening_empty: opEmpty,
          closing_full: opFull,
          closing_empty: opEmpty,
        });

      if (error) throw error;

      setOpeningStockModalVisible(false);
      setManualOpeningFull('');
      setManualOpeningEmpty('');
      await syncLiveStockToDatabase(selectedDate);
      await fetchGodownData();
      Alert.alert('सफल', 'प्रारंभिक स्टॉक सफलतापूर्वक सहेज लिया गया है।');
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'प्रारंभिक स्टॉक सहेजने में त्रुटि आई।');
    }
  };

  // ─── Dispatch Morning Entry ────────────────────────────────────────────────

  const handleSaveDispatch = async () => {
    const boy = newTripBoy.trim();
    const disp = parseInt(newTripDispatched, 10) || 0;

    if (!boy) {
      Alert.alert('त्रुटि', 'कृपया डिलीवरी बॉय चुनें या नाम दर्ज करें।');
      return;
    }
    if (disp <= 0) {
      Alert.alert('त्रुटि', 'भेजे गए सिलेंडर की संख्या 0 से अधिक होनी चाहिए।');
      return;
    }

    try {
      const { data: existingTrips } = await supabase
        .from('mobile_godowntrips')
        .select('trip_number')
        .eq('date', selectedDate)
        .eq('delivery_boy', boy);

      const nextTripNum = (existingTrips || []).reduce((max, t) => Math.max(max, t.trip_number), 0) + 1;

      const { error } = await supabase.from('mobile_godowntrips').insert({
        date: selectedDate,
        delivery_boy: boy,
        trip_number: nextTripNum,
        full_dispatched: disp,
        full_returned: 0,
        empty_returned: 0,
      });

      if (error) throw error;

      setNewTripBoy('');
      setNewTripDispatched('');

      await syncLiveStockToDatabase(selectedDate);
      fetchGodownData();

      // Trigger Dispatch Notification
      const pushTitle = `🚚 Vehicle Dispatched: ${boy}`;
      const pushBody = `Trip #${nextTripNum} started. Dispatched ${disp} full cylinders to the field.`;
      triggerPushNotification(pushTitle, pushBody);

      Alert.alert('सफल', 'गाड़ी प्रेषण दर्ज कर लिया गया है।');
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'प्रेषण सहेजने में असमर्थ।');
    }
  };

  // ─── Return Evening Entry ──────────────────────────────────────────────────

  const handleOpenReturnModal = (trip: GodownTrip) => {
    setSelectedTripToReturn(trip);
    setTripReturnedFull(trip.full_returned.toString() || '0');
    setTripReturnedEmpty(trip.empty_returned.toString() || '0');
    setShowReturnModal(true);
  };

  const handleSaveReturn = async () => {
    if (!selectedTripToReturn) return;
    const retFull = parseInt(tripReturnedFull, 10) || 0;
    const retEmp = parseInt(tripReturnedEmpty, 10) || 0;

    if (retFull < 0 || retEmp < 0) {
      Alert.alert('त्रुटि', 'कृपया सही मात्रा दर्ज करें।');
      return;
    }

    try {
      const { error } = await supabase
        .from('mobile_godowntrips')
        .update({
          full_returned: retFull,
          empty_returned: retEmp,
        })
        .eq('id', selectedTripToReturn.id);

      if (error) throw error;

      // Extract details before resetting the state variable
      const returnedBoyName = selectedTripToReturn.delivery_boy;
      const returnedTripNumber = selectedTripToReturn.trip_number;

      setShowReturnModal(false);
      setSelectedTripToReturn(null);

      await syncLiveStockToDatabase(selectedDate);
      fetchGodownData();

      // Trigger Return Notification
      const pushTitle = `🏡 Vehicle Returned: ${returnedBoyName}`;
      const pushBody = `Trip #${returnedTripNumber} completed. Returned ${retFull} unsold full and ${retEmp} empty cylinders.`;
      triggerPushNotification(pushTitle, pushBody);

      Alert.alert('सफल', 'वापसी की एंट्री सहेज ली गई है।');
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'वापसी एंट्री सहेजने में विफल।');
    }
  };

  // ─── External Agency Exchanges ────────────────────────────────────────────

  const handleSaveAgencyExchange = async () => {
    let agency = newAgencyName === 'OTHER' ? customAgencyInput.trim().toUpperCase() : newAgencyName;
    const qty = parseInt(agencyQty, 10) || 0;

    if (!agency) {
      Alert.alert('त्रुटि', 'कृपया गैस एजेंसी चुनें या नाम लिखें।');
      return;
    }
    if (qty <= 0) {
      Alert.alert('त्रुटि', 'संख्या 0 से अधिक होनी चाहिए।');
      return;
    }

    try {
      const { error } = await supabase.from('mobile_godownagencytransactions').insert({
        date: selectedDate,
        agency_name: agency,
        transaction_type: agencyTradeType,
        quantity: qty,
      });

      if (error) throw error;

      setNewAgencyName('');
      setCustomAgencyInput('');
      setAgencyQty('');

      await syncLiveStockToDatabase(selectedDate);
      fetchGodownData();

      // Format trade action text for push notification details
      let actionText = '';
      let cylinderState = '';
      if (agencyTradeType === 'RECEIVED_FULL') {
        actionText = 'received';
        cylinderState = 'full';
      } else if (agencyTradeType === 'SENT_FULL') {
        actionText = 'supplied';
        cylinderState = 'full';
      } else if (agencyTradeType === 'RECEIVED_EMPTY') {
        actionText = 'received';
        cylinderState = 'empty';
      } else if (agencyTradeType === 'SENT_EMPTY') {
        actionText = 'supplied';
        cylinderState = 'empty';
      }

      // Trigger Agency Exchange Notification
      const pushTitle = `🔄 Agency Exchange: ${agency}`;
      const pushBody = `Successfully ${actionText} ${qty} ${cylinderState} cylinders during transaction with ${agency}.`;
      triggerPushNotification(pushTitle, pushBody);

      Alert.alert('सफल', 'गैस एजेंसी लेनदेन सहेज लिया गया है।');
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'लेनदेन दर्ज नहीं हो सका।');
    }
  };

  // ─── Spot Deliveries (AHD) ─────────────────────────────────────────────────

  const handleTokenClick = (tokenNum: number) => {
    setSelectedTokenNum(tokenNum);
    const existing = spotDeliveries.find((d) => d.token_number === tokenNum);
    if (existing) {
      setDuplicateConfirmModal({
        visible: true,
        tokenNum,
        existingEntry: existing.consumer_identifier,
      });
    } else {
      setConsumerIdInput('');
      setShowTokenModal(true);
    }
  };

  const handleConfirmSpotDelivery = async () => {
    if (!selectedTokenNum) return;
    const identifier = consumerIdInput.trim() || 'काउंटर ग्राहक';

    try {
      const { error } = await supabase.from('mobile_godownspotdeliveries').insert({
        date: selectedDate,
        token_number: selectedTokenNum,
        consumer_identifier: identifier,
      });

      if (error) throw error;

      setShowTokenModal(false);
      setConsumerIdInput('');

      await syncAHDConsolidatedTrip();
      await syncLiveStockToDatabase(selectedDate);
      fetchGodownData();
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'काउंटर डिलीवरी दर्ज नहीं हो सकी।');
    }
  };

  const handleRegisterDuplicateToken = () => {
    setDuplicateConfirmModal(null);
    setConsumerIdInput('');
    setShowTokenModal(true);
  };

  const syncAHDConsolidatedTrip = async () => {
    try {
      const { data: latestSpots } = await supabase
        .from('mobile_godownspotdeliveries')
        .select('id')
        .eq('date', selectedDate);

      const spotCount = latestSpots?.length || 0;

      const { data: ahdTrip } = await supabase
        .from('mobile_godowntrips')
        .select('id')
        .eq('date', selectedDate)
        .eq('delivery_boy', 'AHD')
        .single();

      if (spotCount === 0) {
        if (ahdTrip) {
          await supabase.from('mobile_godowntrips').delete().eq('id', ahdTrip.id);
        }
        return;
      }

      if (ahdTrip) {
        await supabase
          .from('mobile_godowntrips')
          .update({
            full_dispatched: spotCount,
            empty_returned: spotCount,
          })
          .eq('id', ahdTrip.id);
      } else {
        await supabase.from('mobile_godowntrips').insert({
          date: selectedDate,
          delivery_boy: 'AHD',
          trip_number: 1,
          full_dispatched: spotCount,
          full_returned: 0,
          empty_returned: spotCount,
        });
      }
    } catch (err: any) {
      // Sync failed
    }
  };

  const handleDeleteTrip = async (id: string, name: string) => {
    try {
      const { error } = await supabase.from('mobile_godowntrips').delete().eq('id', id);
      if (error) throw error;
      if (name === 'AHD') {
        await supabase.from('mobile_godownspotdeliveries').delete().eq('date', selectedDate);
      }
      await syncLiveStockToDatabase(selectedDate);
      fetchGodownData();
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'लॉग हटाने में असमर्थ।');
    }
  };

  const handleDeleteAgencyTransaction = async (id: string) => {
    try {
      const { error } = await supabase.from('mobile_godownagencytransactions').delete().eq('id', id);
      if (error) throw error;
      await syncLiveStockToDatabase(selectedDate);
      fetchGodownData();
    } catch (e: any) {
      Alert.alert('त्रुटि', e?.message || 'लेनदेन डिलीट नहीं हो सका।');
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const activeStocks = calculateLiveStocks();

  const pendingTripsForReturn = dailyTrips.filter(
    (t) => t.delivery_boy !== 'AHD' && t.full_returned === 0 && t.empty_returned === 0 && t.full_dispatched > 0
  );

  return (
    <View style={styles.container}>

      {/* ── Header ── */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>गोदाम प्रबंधन (गोदाम कीपर)</Text>

              <TouchableOpacity
                onPress={() => setShowDatePicker(true)}
                style={styles.headerDateRow}
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
                    }
                  }}
                />
              )}
            </View>
          </View>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={BPCL_BLUE} />
              <Text style={styles.loadingText}>स्टॉक और लॉग फाइल्स लोड हो रही हैं...</Text>
            </View>
          ) : (
            <>
              {/* Daily Balance Stock Sheet */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>दैनिक स्टॉक बैलेंस शीट</Text>

                <View style={styles.stockSummaryRow}>
                  <View style={styles.stockSummaryBox}>
                    <Text style={styles.stockSummaryLabel}>शुरुआती भरा स्टॉक</Text>
                    <Text style={styles.stockSummaryNum}>{stockRecord?.opening_full || 0}</Text>
                  </View>
                  <View style={styles.stockSummaryBox}>
                    <Text style={styles.stockSummaryLabel}>शुरुआती खाली स्टॉक</Text>
                    <Text style={styles.stockSummaryNum}>{stockRecord?.opening_empty || 0}</Text>
                  </View>
                </View>

                {/* Edit/Initial Setup Manual Button */}
                <TouchableOpacity
                  style={styles.editOpeningStockBtn}
                  onPress={() => {
                    setManualOpeningFull(stockRecord?.opening_full?.toString() || '0');
                    setManualOpeningEmpty(stockRecord?.opening_empty?.toString() || '0');
                    setOpeningStockModalVisible(true);
                  }}
                >
                  <Ionicons name="create-outline" size={16} color={BPCL_BLUE} />
                  <Text style={styles.editOpeningStockBtnText}>शुरुआती स्टॉक दर्ज / बदलें</Text>
                </TouchableOpacity>

                <View style={[styles.stockSummaryRow, { marginTop: 12 }]}>
                  <View style={[styles.stockSummaryBox, { backgroundColor: '#eefcf4', borderColor: '#c2f0d5' }]}>
                    <Text style={[styles.stockSummaryLabel, { color: '#27ae60' }]}>आज कुल बिक्री/वितरण</Text>
                    <Text style={[styles.stockSummaryNum, { color: '#27ae60' }]}>{activeStocks.deliveredNet}</Text>
                  </View>
                  <View style={[styles.stockSummaryBox, { backgroundColor: '#eefcf4', borderColor: '#c2f0d5' }]}>
                    <Text style={[styles.stockSummaryLabel, { color: '#27ae60' }]}>आज वापस मिले खाली</Text>
                    <Text style={[styles.stockSummaryNum, { color: '#27ae60' }]}>{activeStocks.receivedEmptiesTotal}</Text>
                  </View>
                </View>

                {/* Live Stock view */}
                <View style={styles.liveStockContainer}>
                  <Text style={styles.liveStockLabel}>गोदाम में वर्तमान स्टॉक</Text>
                  <View style={styles.liveStockRow}>
                    <View style={styles.liveStockBlock}>
                      <Text style={styles.liveStockCount}>{activeStocks.full}</Text>
                      <Text style={styles.liveStockSub}>भरा हुआ स्टॉक</Text>
                    </View>
                    <View style={styles.liveStockBlock}>
                      <Text style={styles.liveStockCount}>{activeStocks.empty}</Text>
                      <Text style={styles.liveStockSub}>खाली स्टॉक</Text>
                    </View>
                  </View>
                </View>

                {/* Plant Supply input */}
                <Text style={styles.label}>प्लांट से आज आया नया भरा स्टॉक (गाड़ी खाली हुई)</Text>
                <View style={styles.stockConfigRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="0"
                    keyboardType="numeric"
                    value={supplyReceivedInput}
                    onChangeText={setSupplyReceivedInput}
                  />
                  <TouchableOpacity
                    style={styles.stockConfigButton}
                    onPress={() => updateGodownClosingAndPlantStock('supply_received_full', parseInt(supplyReceivedInput, 10) || 0)}
                  >
                    <Text style={styles.stockConfigButtonText}>अपडेट करें</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Trip Dispatch logger (Morning) */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>गाड़ी प्रेषण (सिलेंडर बाहर भेजना)</Text>

                <Text style={styles.label}>डिलीवरी बॉय चुनें</Text>
                {deliveryBoysList.length === 0 ? (
                  <Text style={styles.subtext}>डेटाबेस से डिलीवरी बॉय लोड हो रहे हैं...</Text>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {deliveryBoysList.map((boy) => (
                        <TouchableOpacity
                          key={boy}
                          style={[styles.smallPill, newTripBoy === boy && styles.smallPillActive]}
                          onPress={() => setNewTripBoy(boy)}
                        >
                          <Text style={[styles.smallPillText, newTripBoy === boy && styles.smallPillTextActive]}>{boy}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                )}

                <TextInput
                  style={styles.input}
                  placeholder="या नया डिलीवरी बॉय नाम यहाँ दर्ज करें..."
                  value={newTripBoy}
                  onChangeText={(val) => setNewTripBoy(val.toUpperCase())}
                />

                <Text style={[styles.label, { marginTop: 12 }]}>भेजे गए भरे सिलेंडर</Text>
                <TextInput style={styles.input} placeholder="0" keyboardType="numeric" value={newTripDispatched} onChangeText={setNewTripDispatched} />

                <TouchableOpacity style={styles.submitButton} onPress={handleSaveDispatch}>
                  <Ionicons name="paper-plane-outline" size={18} color="#fff" />
                  <Text style={styles.submitButtonText}>गाड़ी रवाना करें</Text>
                </TouchableOpacity>
              </View>

              {/* Active Dispatch Return Logger (Evening) */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>सिलेंडर वापसी दर्ज करें</Text>
                <Text style={styles.subtext}>यहाँ आज प्रेषित उन गाड़ियों की सूची है जिनकी सिलेंडर वापसी अभी लंबित है।</Text>

                {pendingTripsForReturn.length === 0 ? (
                  <View style={[styles.emptyBox, { padding: 16 }]}>
                    <Text style={[styles.emptyText, { fontSize: 13 }]}>सभी गाड़ियों की सिलेंडर वापसी पूर्ण हो चुकी है।</Text>
                  </View>
                ) : (
                  <View style={{ gap: 8 }}>
                    {pendingTripsForReturn.map((trip) => (
                      <View key={trip.id} style={styles.pendingTripRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.pendingTripBoyName}>{trip.delivery_boy} (ट्रिप {trip.trip_number})</Text>
                          <Text style={styles.pendingTripDetail}>सुबह भेजे गए: {trip.full_dispatched} भरे सिलेंडर</Text>
                        </View>
                        <TouchableOpacity style={styles.logReturnBtn} onPress={() => handleOpenReturnModal(trip)}>
                          <Text style={styles.logReturnBtnText}>वापसी दर्ज करें</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              {/* Token Spot Board */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>नगद / टोकन काउंटर बिक्री (AHD)</Text>
                <Text style={styles.subtext}>सीधे गोदाम से दी गई टोकन डिलीवरी। यह एंट्री अपने आप 'AHD' के नाम से दर्ज होगी।</Text>

                <View style={styles.tokenGrid}>
                  {Array.from({ length: 20 }, (_, i) => {
                    const tokenNum = tokenPage * 20 + (i + 1);
                    const isDelivered = spotDeliveries.find((d) => d.token_number === tokenNum);
                    const duplicateCount = spotDeliveries.filter((d) => d.token_number === tokenNum).length;

                    return (
                      <TouchableOpacity
                        key={tokenNum}
                        style={[
                          styles.tokenCircle,
                          isDelivered && styles.tokenCircleGreen,
                          duplicateCount > 1 && styles.tokenCircleOrange,
                        ]}
                        onPress={() => handleTokenClick(tokenNum)}
                      >
                        <Text style={[styles.tokenCircleText, isDelivered && { color: '#fff' }]}>{tokenNum}</Text>
                        {duplicateCount > 1 && (
                          <View style={styles.duplicateIndicator}>
                            <Text style={styles.duplicateIndicatorText}>x{duplicateCount}</Text>
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <View style={styles.tokenPaginationRow}>
                  <TouchableOpacity
                    style={[styles.pageButton, tokenPage === 0 && { opacity: 0.3 }]}
                    disabled={tokenPage === 0}
                    onPress={() => setTokenPage((p) => Math.max(0, p - 1))}
                  >
                    <Text style={styles.pageButtonText}>◀ पीछे</Text>
                  </TouchableOpacity>
                  <Text style={styles.pageIndicatorText}>टोकन {tokenPage * 20 + 1} - {(tokenPage + 1) * 20}</Text>
                  <TouchableOpacity
                    style={styles.pageButton}
                    onPress={() => setTokenPage((p) => p + 1)}
                  >
                    <Text style={styles.pageButtonText}>आगे ▶</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Agency exchanges */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>अन्य गैस एजेंसी से लेनदेन</Text>

                <Text style={styles.label}>एजेंसी चुनें</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {agenciesList.map((agency) => (
                      <TouchableOpacity
                        key={agency}
                        style={[styles.smallPill, newAgencyName === agency && styles.smallPillActive]}
                        onPress={() => setNewAgencyName(agency)}
                      >
                        <Text style={[styles.smallPillText, newAgencyName === agency && styles.smallPillTextActive]}>{agency}</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      style={[styles.smallPill, newAgencyName === 'OTHER' && styles.smallPillActive]}
                      onPress={() => setNewAgencyName('OTHER')}
                    >
                      <Text style={[styles.smallPillText, newAgencyName === 'OTHER' && styles.smallPillTextActive]}>अन्य</Text>
                    </TouchableOpacity>
                  </View>
                </ScrollView>

                {newAgencyName === 'OTHER' && (
                  <TextInput
                    style={[styles.input, { marginBottom: 12 }]}
                    placeholder="नई एजेंसी का नाम दर्ज करें..."
                    value={customAgencyInput}
                    onChangeText={setCustomAgencyInput}
                  />
                )}

                <Text style={styles.label}>लेनदेन का प्रकार</Text>
                <View style={styles.toggleRow}>
                  {(['RECEIVED_FULL', 'SENT_FULL', 'RECEIVED_EMPTY', 'SENT_EMPTY'] as const).map((type) => (
                    <TouchableOpacity
                      key={type}
                      style={[
                        styles.toggleButton,
                        { flex: 1, paddingVertical: 8 },
                        agencyTradeType === type && styles.toggleButtonSelected,
                      ]}
                      onPress={() => setAgencyTradeType(type)}
                    >
                      <Text style={[styles.toggleButtonText, { fontSize: 10 }, agencyTradeType === type && styles.toggleButtonTextSelected]}>
                        {type === 'RECEIVED_FULL' && 'भरा सिलेंडर मिला (+)'}
                        {type === 'SENT_FULL' && 'भरा सिलेंडर दिया (-)'}
                        {type === 'RECEIVED_EMPTY' && 'खाली सिलेंडर मिला (+)'}
                        {type === 'SENT_EMPTY' && 'खाली सिलेंडर दिया (-)'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={[styles.label, { marginTop: 14 }]}>सिलेंडर संख्या (मात्रा)</Text>
                <TextInput style={styles.input} placeholder="0" keyboardType="numeric" value={agencyQty} onChangeText={setAgencyQty} />

                <TouchableOpacity style={styles.submitButton} onPress={handleSaveAgencyExchange}>
                  <Ionicons name="swap-horizontal" size={18} color="#fff" />
                  <Text style={styles.submitButtonText}>लेनदेन सहेजें</Text>
                </TouchableOpacity>
              </View>

              {/* Plant Return */}
              <View style={[styles.card, { borderColor: BPCL_YELLOW, borderWidth: 1.5 }]}>
                <Text style={styles.cardTitle}>प्लांट वापस (खाली सिलेंडर लोड आउट)</Text>
                <Text style={styles.subtext}>🚨 ध्यान दें: यह एंट्री केवल दिन के अंत में करें जब गाड़ियां वापस आ जाएं और खाली सिलेंडर प्लांट की गाड़ी में लोड कर दिए जाएं।</Text>

                <Text style={[styles.label, { marginTop: 14 }]}>प्लांट की गाड़ी में भेजे गए खाली सिलेंडर</Text>
                <View style={styles.stockConfigRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="0"
                    keyboardType="numeric"
                    value={emptiesSentInput}
                    onChangeText={setEmptiesSentInput}
                  />
                  <TouchableOpacity
                    style={[styles.stockConfigButton, { backgroundColor: '#27ae60' }]}
                    onPress={() => updateGodownClosingAndPlantStock('supply_sent_empty', parseInt(emptiesSentInput, 10) || 0)}
                  >
                    <Text style={styles.stockConfigButtonText}>वापसी दर्ज करें</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Daily Activity log list */}
              <View style={styles.tableCard}>
                <View style={styles.tableHeader}>
                  <Text style={styles.tableTitle}>आज का लॉग विवरण (गतिविधियां) — {selectedDate}</Text>
                </View>

                {dailyTrips.length === 0 && agencyTransactions.length === 0 ? (
                  <View style={styles.emptyBox}>
                    <Text style={styles.emptyText}>आज अभी तक कोई एंट्री दर्ज नहीं की गई है।</Text>
                  </View>
                ) : (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                    {dailyTrips.map((trip) => (
                      <View key={trip.id} style={styles.activityRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.activityTitle}>{trip.delivery_boy === 'AHD' ? 'काउंटर बिक्री (AHD)' : `${trip.delivery_boy} (ट्रिप ${trip.trip_number})`}</Text>
                          <Text style={styles.activitySubtitle}>
                            भेजे गए: {trip.full_dispatched} भरे | वापस आए: {trip.full_returned} भरे, {trip.empty_returned} खाली
                          </Text>
                        </View>
                        <TouchableOpacity onPress={() => handleDeleteTrip(trip.id, trip.delivery_boy)}>
                          <Ionicons name="trash-outline" size={18} color="#e74c3c" />
                        </TouchableOpacity>
                      </View>
                    ))}

                    {agencyTransactions.map((trade) => (
                      <View key={trade.id} style={styles.activityRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.activityTitle, { color: BPCL_BLUE }]}>{trade.agency_name} (गैस एजेंसी)</Text>
                          <Text style={styles.activitySubtitle}>
                            प्रकार:{' '}
                            {trade.transaction_type === 'RECEIVED_FULL' && 'भरा सिलेंडर मिला'}
                            {trade.transaction_type === 'SENT_FULL' && 'भरा सिलेंडर दिया'}
                            {trade.transaction_type === 'RECEIVED_EMPTY' && 'खाली सिलेंडर मिला'}
                            {trade.transaction_type === 'SENT_EMPTY' && 'खाली सिलेंडर दिया'}{' '}
                            | मात्रा: {trade.quantity}
                          </Text>
                        </View>
                        <TouchableOpacity onPress={() => handleDeleteAgencyTransaction(trade.id)}>
                          <Ionicons name="trash-outline" size={18} color="#e74c3c" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ══════════  प्रारंभिक स्टॉक दर्ज करें (Opening Stock Modal)  ══════════ */}
      <Modal visible={openingStockModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>प्रारंभिक स्टॉक दर्ज करें</Text>
            </View>
            <Text style={styles.subtext}>आज का स्टॉक ट्रैक करने के लिए शुरुआती मात्रा दर्ज करना आवश्यक है।</Text>

            <Text style={styles.label}>शुरुआती भरा हुआ स्टॉक (Full stock)</Text>
            <TextInput
              style={[styles.input, { marginBottom: 12 }]}
              placeholder="0"
              keyboardType="numeric"
              value={manualOpeningFull}
              onChangeText={setManualOpeningFull}
            />

            <Text style={styles.label}>शुरुआती खाली स्टॉक (Empty stock)</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={manualOpeningEmpty}
              onChangeText={setManualOpeningEmpty}
            />

            <View style={[styles.modalButtons, { marginTop: 18 }]}>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={handleSaveOpeningStock}>
                <Text style={styles.modalConfirmText}>स्टॉक सहेजें</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══════════  वापसी विवरण दर्ज करें (Return Trip Modal)  ══════════ */}
      <Modal visible={showReturnModal} transparent animationType="slide" onRequestClose={() => setShowReturnModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>सिलेंडर वापसी: {selectedTripToReturn?.delivery_boy}</Text>
            </View>

            <Text style={styles.label}>वापस आए भरे सिलेंडर (Unsold Full)</Text>
            <TextInput
              style={[styles.input, { marginBottom: 12 }]}
              placeholder="0"
              keyboardType="numeric"
              value={tripReturnedFull}
              onChangeText={setTripReturnedFull}
            />

            <Text style={styles.label}>वापस आए खाली सिलेंडर (Empties)</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              keyboardType="numeric"
              value={tripReturnedEmpty}
              onChangeText={setTripReturnedEmpty}
            />

            <View style={[styles.modalButtons, { marginTop: 18 }]}>
              <TouchableOpacity style={styles.modalCancelButton} onPress={() => setShowReturnModal(false)}>
                <Text style={styles.modalCancelText}>रद्द करें</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={handleSaveReturn}>
                <Text style={styles.modalConfirmText}>सहेजें</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══════════  नगद टोकन इनपुट मॉडल  ══════════ */}
      <Modal visible={showTokenModal} transparent animationType="slide" onRequestClose={() => setShowTokenModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>काउंटर डिलीवरी: टोकन #{selectedTokenNum}</Text>
            </View>
            <Text style={styles.label}>ग्राहक का नाम / रसीद नंबर दर्ज करें</Text>
            <TextInput
              style={styles.input}
              placeholder="ग्राहक का नाम या रसीद टोकन नंबर लिखें..."
              value={consumerIdInput}
              onChangeText={setConsumerIdInput}
            />
            <View style={[styles.modalButtons, { marginTop: 18 }]}>
              <TouchableOpacity style={styles.modalCancelButton} onPress={() => setShowTokenModal(false)}>
                <Text style={styles.modalCancelText}>रद्द करें</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={handleConfirmSpotDelivery}>
                <Text style={styles.modalConfirmText}>डिलीवरी करें</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══════════  डुप्लीकेट चेतावनी मॉडल  ══════════ */}
      <Modal visible={!!duplicateConfirmModal?.visible} transparent animationType="fade">
        <View style={styles.resultOverlay}>
          <View style={styles.resultBox}>
            <Text style={[styles.resultTitle, { color: '#e67e22' }]}>डुप्लीकेट टोकन चेतावनी</Text>
            <Text style={styles.resultSubtitle}>
              टोकन #{duplicateConfirmModal?.tokenNum} आज पहले ही डिलीवर किया जा चुका है:{'\n'}
              <Text style={{ fontWeight: 'bold' }}>{duplicateConfirmModal?.existingEntry}</Text>
            </Text>
            <View style={styles.resultBtnRow}>
              <TouchableOpacity style={styles.resultSkipBtn} onPress={() => setDuplicateConfirmModal(null)}>
                <Text style={styles.resultSkipBtnText}>पीछे जाएं</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.resultRecordBtn, { backgroundColor: '#e67e22' }]} onPress={handleRegisterDuplicateToken}>
                <Text style={styles.resultRecordBtnText}>डुप्लीकेट जारी करें</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  // Header
  header: { backgroundColor: BPCL_BLUE, shadowColor: '#000', shadowOffset: { width: 0, height: 1.5 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 5 },
  headerContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  headerDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  headerDate: { fontSize: 14, color: 'rgba(255,255,255,0.9)' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff' },

  scrollView: { flex: 1 },

  // Card
  card: { backgroundColor: '#fff', margin: 16, padding: 16, borderRadius: 12, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4 },
  cardTitle: { fontSize: 18, fontWeight: 'bold', color: BPCL_BLUE, marginBottom: 4 },
  subtext: { fontSize: 12, color: '#777', marginBottom: 12, lineHeight: 16 },

  // Form Inputs
  label: { fontSize: 14, color: '#666', marginBottom: 8, fontWeight: '600' },
  input: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16 },
  row: { flexDirection: 'row', gap: 12 },
  halfInput: { flex: 1 },

  // Edit Opening Stock Button
  editOpeningStockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: BPCL_BLUE, borderRadius: 8, paddingVertical: 8, marginTop: 10, backgroundColor: '#f0f8ff' },
  editOpeningStockBtnText: { fontSize: 12, fontWeight: 'bold', color: BPCL_BLUE },

  // Toggle
  toggleRow: { flexDirection: 'row', gap: 8 },
  toggleButton: { flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', alignItems: 'center', backgroundColor: '#f8f9fa' },
  toggleButtonSelected: { backgroundColor: BPCL_BLUE, borderColor: BPCL_BLUE },
  toggleButtonText: { fontSize: 11, color: '#666', fontWeight: '600', textAlign: 'center' },
  toggleButtonTextSelected: { color: '#fff' },

  // Submit Button
  submitButton: { backgroundColor: BPCL_BLUE, padding: 14, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20 },
  submitButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  // Stock Summary Box
  stockSummaryRow: { flexDirection: 'row', gap: 10 },
  stockSummaryBox: { flex: 1, backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 10, alignItems: 'center' },
  stockSummaryLabel: { fontSize: 11, color: '#718096', fontWeight: '600', textAlign: 'center' },
  stockSummaryNum: { fontSize: 18, fontWeight: 'bold', color: '#2d3748', marginTop: 2 },

  liveStockContainer: { backgroundColor: '#ebf8ff', borderWidth: 1, borderColor: '#bee3f8', borderRadius: 10, padding: 14, marginVertical: 14 },
  liveStockLabel: { fontSize: 11, fontWeight: 'bold', color: '#2b6cb0', textAlign: 'center', letterSpacing: 0.5 },
  liveStockRow: { flexDirection: 'row', marginTop: 10 },
  liveStockBlock: { flex: 1, alignItems: 'center' },
  liveStockCount: { fontSize: 24, fontWeight: 'bold', color: '#2b6cb0' },
  liveStockSub: { fontSize: 11, color: '#4a5568', marginTop: 2 },

  stockConfigRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  stockConfigButton: { backgroundColor: BPCL_BLUE, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8 },
  stockConfigButtonText: { color: '#fff', fontWeight: 'bold' },

  smallPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#edf2f7', borderWidth: 1, borderColor: '#cbd5e0' },
  smallPillActive: { backgroundColor: BPCL_BLUE },
  smallPillText: { fontSize: 11, color: '#4a5568', fontWeight: '600' },
  smallPillTextActive: { color: '#fff' },

  // Pending active trips
  pendingTripRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f8f9fa', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#edf2f7' },
  pendingTripBoyName: { fontSize: 14, fontWeight: 'bold', color: '#2d3748' },
  pendingTripDetail: { fontSize: 11, color: '#718096', marginTop: 2 },
  logReturnBtn: { backgroundColor: '#27ae60', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  logReturnBtnText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },

  // Token grid
  tokenGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 10 },
  tokenCircle: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#edf2f7', borderWidth: 1.5, borderColor: '#cbd5e0', alignItems: 'center', justifyContent: 'center', position: 'relative' },
  tokenCircleGreen: { backgroundColor: '#48bb78', borderColor: '#38a169' },
  tokenCircleOrange: { backgroundColor: '#ed8936', borderColor: '#dd6b20' },
  tokenCircleText: { fontSize: 14, fontWeight: 'bold', color: '#4a5568' },
  duplicateIndicator: { position: 'absolute', right: -4, bottom: -4, backgroundColor: '#e53e3e', paddingHorizontal: 4, borderRadius: 8 },
  duplicateIndicatorText: { fontSize: 8, color: '#fff', fontWeight: 'bold' },

  tokenPaginationRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  pageButton: { padding: 10, backgroundColor: '#edf2f7', borderRadius: 8 },
  pageButtonText: { fontSize: 12, fontWeight: 'bold', color: '#4a5568' },
  pageIndicatorText: { fontSize: 12, fontWeight: 'bold', color: '#718096' },

  // Activity Row
  activityRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#edf2f7' },
  activityTitle: { fontSize: 14, fontWeight: 'bold', color: '#2d3748' },
  activitySubtitle: { fontSize: 11, color: '#718096', marginTop: 2 },

  // Table Card
  tableCard: { backgroundColor: '#fff', margin: 16, marginTop: 0, borderRadius: 12, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4, overflow: 'hidden' },
  tableHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  tableTitle: { fontSize: 16, fontWeight: 'bold', color: '#333' },

  // Loading/Empty boxes
  loadingBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  loadingText: { color: '#999', fontSize: 14 },
  emptyBox: { alignItems: 'center', padding: 32, gap: 8 },
  emptyText: { fontSize: 14, color: '#ccc', fontWeight: '600' },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalHeader: { alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#333', marginTop: 8 },
  modalButtons: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  modalCancelButton: { flex: 1, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#ddd', alignItems: 'center' },
  modalCancelText: { fontSize: 16, color: '#666', fontWeight: '600' },
  modalConfirmButton: { flex: 2, padding: 14, borderRadius: 10, backgroundColor: BPCL_BLUE, alignItems: 'center' },
  modalConfirmText: { fontSize: 16, color: '#fff', fontWeight: 'bold' },

  // Duplicate warning overlay
  resultOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  resultBox: { backgroundColor: '#fff', borderRadius: 22, padding: 24, width: '100%', maxWidth: 380, alignItems: 'center', elevation: 12 },
  resultTitle: { fontSize: 21, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 6, textAlign: 'center' },
  resultSubtitle: { fontSize: 14, color: '#888', textAlign: 'center', lineHeight: 20, marginBottom: 18 },
  resultBtnRow: { flexDirection: 'row', gap: 12, width: '100%' },
  resultSkipBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#ddd', alignItems: 'center', justifyContent: 'center' },
  resultSkipBtnText: { color: '#777', fontSize: 15, fontWeight: '600' },
  resultRecordBtn: { flex: 1.6, flexDirection: 'row', gap: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: '#27ae60', alignItems: 'center', justifyContent: 'center' },
  resultRecordBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
});