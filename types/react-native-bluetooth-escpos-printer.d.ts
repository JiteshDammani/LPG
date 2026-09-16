declare module 'react-native-bluetooth-escpos-printer' {
  export interface PrintTextOptions {
    encoding?: string;
    codepage?: number;
    widthtimes?: number;
    heigthtimes?: number;
    fonttype?: number;
  }

  export const BluetoothManager: {
    /** Prompts the user to enable Bluetooth if it's off. */
    enableBluetooth(): Promise<string[] | void>;
    /** Returns a JSON string: {"paired":[{name,address}], "found":[...]} */
    scanDevices(): Promise<string>;
    connect(address: string): Promise<void>;
    disconnect(address?: string): Promise<void>;
    unpaire(address: string): Promise<void>;
  };

  export const BluetoothEscposPrinter: {
    ALIGN: {
      LEFT: number;
      CENTER: number;
      RIGHT: number;
    };
    printerAlign(align: number): Promise<void>;
    printText(text: string, options: PrintTextOptions): Promise<void>;
    printColumnsText(
      columnTextArr: string[],
      columnWidthArr: number[],
      columnAlignArr: number[],
      columnStyleArr: PrintTextOptions[],
    ): Promise<void>;
    printPic(base64: string, options?: { width?: number; left?: number }): Promise<void>;
    printQRCode(content: string, size: number, correctionLevel: number): Promise<void>;
    printAndFeed(feed: number): Promise<void>;
    cutOnePoint(): Promise<void>;
  };

  export const BluetoothTscPrinter: {
    printLabel(options: Record<string, any>): Promise<void>;
  };
}
