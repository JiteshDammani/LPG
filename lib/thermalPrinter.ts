import {
  BluetoothManager,
  BluetoothEscposPrinter,
} from 'react-native-bluetooth-escpos-printer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PermissionsAndroid, Platform } from 'react-native';

// ─── Storage key for the "remembered" printer ──────────────────────────────
const SAVED_PRINTER_KEY = 'shreejee_saved_printer_address';

export interface BluetoothDevice {
  name: string;
  address: string;
}

// ─── Ask Android for Bluetooth permission at runtime ───────────────────────
// Android 12+ (API 31+) treats Bluetooth as a "dangerous" permission that
// must be granted via a popup, not just declared in the manifest. This must
// run before any scan/connect call, every time (Android may reset it if the
// user revokes it later in Settings).
export async function requestBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  const permissions = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ].filter(Boolean); // older Android SDKs won't have BLUETOOTH_CONNECT/SCAN defined; filter out undefined

  const results = await PermissionsAndroid.requestMultiple(permissions as any);
  return Object.values(results).every(
    (status) => status === PermissionsAndroid.RESULTS.GRANTED
  );
}

// ─── Discover devices ───────────────────────────────────────────────────────
// Returns already-paired devices immediately (fast) and newly-found ones
// after a short scan (slower, only needed the first time you pair).
export async function listPairedDevices(): Promise<BluetoothDevice[]> {
  const granted = await requestBluetoothPermissions();
  if (!granted) {
    throw new Error('Bluetooth permission was denied. Please allow it in Android Settings > Apps > Permissions.');
  }
  await BluetoothManager.enableBluetooth(); // prompts user if BT is off
  const raw = await BluetoothManager.scanDevices();
  const parsed = JSON.parse(raw as unknown as string);
  const paired: BluetoothDevice[] = (parsed.paired || []).map((d: any) => ({
    name: d.name || 'Unknown printer',
    address: d.address,
  }));
  return paired;
}

// ─── Connect + remember the printer so you don't have to pick it every time ─
export async function connectAndSavePrinter(device: BluetoothDevice): Promise<void> {
  const granted = await requestBluetoothPermissions();
  if (!granted) {
    throw new Error('Bluetooth permission was denied. Please allow it in Android Settings > Apps > Permissions.');
  }
  await BluetoothManager.connect(device.address);
  await AsyncStorage.setItem(SAVED_PRINTER_KEY, JSON.stringify(device));
}

export async function getSavedPrinter(): Promise<BluetoothDevice | null> {
  const raw = await AsyncStorage.getItem(SAVED_PRINTER_KEY);
  return raw ? JSON.parse(raw) : null;
}

// ─── Connect to whichever printer was last used, if any ───────────────────
export async function connectToSavedPrinter(): Promise<boolean> {
  const saved = await getSavedPrinter();
  if (!saved) return false;
  try {
    const granted = await requestBluetoothPermissions();
    if (!granted) return false; // no permission — caller can prompt user to reconnect manually
    await BluetoothManager.connect(saved.address);
    return true;
  } catch {
    return false; // printer off / out of range / permission denied
  }
}

// ─── Business constants ─────────────────────────────────────────────────────
const CONTACT_NUMBER = '9133444342';
const UPI_VPA = '9133444342@hdfc'; // same UPI ID already used in your WhatsApp payment links

const BANK_DETAILS = {
  accountName: 'SHREEJEE GAS SERVICE',
  accountNumber: '50200100450236',
  ifsc: 'HDFC0000257',
};

// ─── Receipt data shapes ────────────────────────────────────────────────────

export interface DeliveryReceiptData {
  type: 'DELIVERY';
  customerName: string;
  date: string;
  sent: number;
  received: number;
  deliveryBoy: string;
  rate: number;          // actual (undiscounted) rate per cylinder
  amountDue: number;     // rate * sent — estimated amount owed for this delivery
}

export interface PaymentReceiptData {
  type: 'PAYMENT';
  customerName: string;
  deliveryDate: string;
  paymentDate: string;
  quantity: number;
  rate: number;          // actual (undiscounted) rate per cylinder
  amount: number;        // amount actually paid now
  paymentMode: 'CASH' | 'PAYTM';
  pendingQty?: number;      // cylinders from this delivery still unpaid, if any
  pendingAmount?: number;   // estimated amount still owed, if any
}

type ReceiptData = DeliveryReceiptData | PaymentReceiptData;

// ─── Small helpers for 32-column (58mm) roll formatting ────────────────────
const LINE_WIDTH = 32; // change to 48 if you have an 80mm roll printer

function divider(char = '-') {
  return char.repeat(LINE_WIDTH);
}

function twoCol(left: string, right: string) {
  const space = LINE_WIDTH - left.length - right.length;
  return left + ' '.repeat(Math.max(space, 1)) + right;
}

function buildUpiLink(amount: number): string {
  return `upi://pay?pa=${UPI_VPA}&pn=Shreejee%20Gas%20Service&am=${Math.round(amount)}&cu=INR`;
}

// Prints a centered UPI QR code the customer can scan with any UPI app
async function printUpiQr(amount: number) {
  const p = BluetoothEscposPrinter;
  const link = buildUpiLink(amount);
  await p.printerAlign(p.ALIGN.CENTER);
  await p.printQRCode(link, 200, 1);
  await p.printText(`Scan to pay Rs.${Math.round(amount)}\n\n`, {});
}

async function printBankDetails() {
  const p = BluetoothEscposPrinter;
  await p.printerAlign(p.ALIGN.LEFT);
  await p.printText('Bank Transfer Details:\n', { fonttype: 1 });
  await p.printText(twoCol('A/C Name:', BANK_DETAILS.accountName) + '\n', {});
  await p.printText(twoCol('A/C No:', BANK_DETAILS.accountNumber) + '\n', {});
  await p.printText(twoCol('IFSC:', BANK_DETAILS.ifsc) + '\n', {});
}

// ─── Print the receipt ──────────────────────────────────────────────────────
export async function printReceipt(data: ReceiptData): Promise<void> {
  const p = BluetoothEscposPrinter;

  await p.printerAlign(p.ALIGN.CENTER);
  await p.printText('SHREEJEE GAS SERVICE\n', { widthtimes: 1, heigthtimes: 1, fonttype: 1 });
  await p.printText(`Contact: ${CONTACT_NUMBER}\n\n`, {});

  await p.printerAlign(p.ALIGN.LEFT);
  await p.printText(divider() + '\n', {});

  if (data.type === 'DELIVERY') {
    await p.printText(twoCol('Customer:', data.customerName) + '\n', {});
    await p.printText(twoCol('Date:', data.date) + '\n', {});
    await p.printText(twoCol('Delivery Boy:', data.deliveryBoy) + '\n', {});
    await p.printText(divider() + '\n', {});
    await p.printText(twoCol('Cylinders Sent:', String(data.sent)) + '\n', {});
    await p.printText(twoCol('Empty Received:', String(data.received)) + '\n', {});
    await p.printText(twoCol('Rate/Cyl:', `Rs.${data.rate}`) + '\n', {});
    await p.printText(divider('=') + '\n', {});
    await p.printText(twoCol('AMOUNT DUE:', `Rs.${data.amountDue}`) + '\n', { widthtimes: 1, heigthtimes: 1 });
    await p.printText(divider() + '\n', {});

    if (data.amountDue > 0) {
      await p.printerAlign(p.ALIGN.CENTER);
      await p.printText('\nKindly clear this payment at the\nearliest to help us serve you better.\n\n', {});
      await printUpiQr(data.amountDue);
      await printBankDetails();
    }
  } else {
    await p.printText(twoCol('Customer:', data.customerName) + '\n', {});
    await p.printText(twoCol('Delivery Date:', data.deliveryDate) + '\n', {});
    await p.printText(twoCol('Payment Date:', data.paymentDate) + '\n', {});
    await p.printText(divider() + '\n', {});
    await p.printText(twoCol('Cylinders Paid:', String(data.quantity)) + '\n', {});
    await p.printText(twoCol('Rate/Cyl:', `Rs.${data.rate}`) + '\n', {});
    await p.printText(twoCol('Mode:', data.paymentMode) + '\n', {});
    await p.printText(twoCol('Amount Received:', 'Yes') + '\n', {});
    await p.printText(divider('=') + '\n', {});
    await p.printText(twoCol('TOTAL PAID:', `Rs.${data.amount}`) + '\n', { widthtimes: 1, heigthtimes: 1 });
    await p.printText(divider() + '\n', {});

    if (data.pendingQty && data.pendingQty > 0 && data.pendingAmount) {
      await p.printText(twoCol('Still Pending:', `${data.pendingQty} cyl / Rs.${data.pendingAmount}`) + '\n', {});
      await p.printText(divider() + '\n', {});
      await p.printerAlign(p.ALIGN.CENTER);
      await p.printText('\nKindly clear the remaining balance\nat the earliest. Thank you!\n\n', {});
      await printUpiQr(data.pendingAmount);
      await printBankDetails();
    } else {
      await printBankDetails();
    }
  }

  await p.printerAlign(p.ALIGN.LEFT);
  await p.printText(divider() + '\n', {});
  await p.printerAlign(p.ALIGN.CENTER);
  await p.printText('\nThis is a receipt for cylinder delivery\nand/or payment collection, not a tax\ninvoice.\n\n', {});
  await p.printText('Thank you!\n\n\n', {});

  // Feed a bit of blank paper so the receipt tears off cleanly
  await p.printText('\n\n', {});
}
