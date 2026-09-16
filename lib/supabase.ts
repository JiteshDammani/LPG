import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = 'https://dfxlolpdxcnergtssyyd.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmeGxvbHBkeGNuZXJndHNzeXlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDI2NjksImV4cCI6MjA4NzA3ODY2OX0.xbmpR6piEiJjeiZT0LMMipggptk95EMT5w6NnyRt4lc';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    detectSessionInUrl: false,
  },
  db: {
    schema: 'public',
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});