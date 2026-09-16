import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';

const BPCL_BLUE = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoginScreenProps {
  onLoginSuccess: (user: AuthUser) => void;
}

interface AuthUser {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  is_staff: boolean;
  is_superuser: boolean;
  is_active: boolean;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // ─── Validation ─────────────────────────────────────────────────────────

  const validate = (): boolean => {
    let valid = true;
    setUsernameError('');
    setPasswordError('');

    if (!username.trim()) {
      setUsernameError('Username is required');
      valid = false;
    }
    if (!password) {
      setPasswordError('Password is required');
      valid = false;
    }
    return valid;
  };

  // ─── Login Handler ───────────────────────────────────────────────────────

  const handleLogin = async () => {
    if (!validate()) return;

    try {
      setLoading(true);

      // Query auth_user table from Django's default auth table
      const { data, error } = await supabase
        .from('auth_user')
        .select(
          'id, username, first_name, last_name, email, is_staff, is_superuser, is_active, password'
        )
        .eq('username', username.trim())
        .eq('is_active', true)
        .single();

      if (error || !data) {
        Alert.alert('Login Failed', 'Invalid username or password.');
        return;
      }

      // NOTE: Django stores passwords as hashed (e.g. pbkdf2_sha256$...).
      // Direct plain-text comparison is only safe if your app stores plain passwords.
      // For production, implement a backend endpoint or Edge Function that
      // verifies the Django password hash server-side.
      //
      // Below is a plain-text comparison — replace with your hash-check logic:
      if (data.password !== password) {
        Alert.alert('Login Failed', 'Invalid username or password.');
        return;
      }

      // Strip password before passing user object along
      const { password: _pwd, ...safeUser } = data;
      onLoginSuccess(safeUser as AuthUser);

    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── Blue Header ─────────────────────────────────────────────────── */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerContent}>
          <View style={styles.logoRow}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>BPCL</Text>
            </View>
            <View>
              <Text style={styles.headerTitle}>Stock Manager</Text>
              <Text style={styles.headerSubtitle}>Cylinder Distribution System</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>

      {/* ── Form ────────────────────────────────────────────────────────── */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Welcome Card */}
          <View style={styles.welcomeCard}>
            <View style={styles.welcomeIconWrap}>
              <Ionicons name="person-circle-outline" size={56} color={BPCL_BLUE} />
            </View>
            <Text style={styles.welcomeTitle}>Welcome Back</Text>
            <Text style={styles.welcomeSubtitle}>
              Sign in to access your stock dashboard
            </Text>
          </View>

          {/* Login Card */}
          <View style={styles.loginCard}>
            {/* Username */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Username</Text>
              <View
                style={[
                  styles.inputWrapper,
                  usernameError ? styles.inputWrapperError : {},
                ]}
              >
                <Ionicons
                  name="person-outline"
                  size={18}
                  color={usernameError ? '#e74c3c' : '#aaa'}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.textInput}
                  placeholder="Enter your username"
                  placeholderTextColor="#bbb"
                  value={username}
                  onChangeText={(t) => {
                    setUsername(t);
                    if (usernameError) setUsernameError('');
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                />
              </View>
              {!!usernameError && (
                <Text style={styles.errorText}>
                  <Ionicons name="alert-circle-outline" size={12} /> {usernameError}
                </Text>
              )}
            </View>

            {/* Password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Password</Text>
              <View
                style={[
                  styles.inputWrapper,
                  passwordError ? styles.inputWrapperError : {},
                ]}
              >
                <Ionicons
                  name="lock-closed-outline"
                  size={18}
                  color={passwordError ? '#e74c3c' : '#aaa'}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.textInput}
                  placeholder="Enter your password"
                  placeholderTextColor="#bbb"
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    if (passwordError) setPasswordError('');
                  }}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((v) => !v)}
                  style={styles.eyeButton}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color="#aaa"
                  />
                </TouchableOpacity>
              </View>
              {!!passwordError && (
                <Text style={styles.errorText}>
                  <Ionicons name="alert-circle-outline" size={12} /> {passwordError}
                </Text>
              )}
            </View>

            {/* Login Button */}
            <TouchableOpacity
              style={[styles.loginButton, loading && styles.loginButtonDisabled]}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="log-in-outline" size={20} color="#fff" />
                  <Text style={styles.loginButtonText}>Sign In</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Info note */}
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color="#999" />
            <Text style={styles.infoText}>
              Use your BPCL staff credentials to sign in. Contact your administrator if
              you have trouble accessing your account.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>BPCL Cylinder Stock Management System</Text>
        <Text style={styles.footerVersion}>v1.0.0</Text>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    backgroundColor: BPCL_BLUE,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 5,
  },
  headerContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logoBadge: {
    backgroundColor: BPCL_YELLOW,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  logoBadgeText: {
    color: '#333',
    fontWeight: 'bold',
    fontSize: 14,
    letterSpacing: 1,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#fff',
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
  },

  // ── Scroll ────────────────────────────────────────────────────────────────
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },

  // ── Welcome Card ──────────────────────────────────────────────────────────
  welcomeCard: {
    alignItems: 'center',
    paddingVertical: 28,
  },
  welcomeIconWrap: {
    backgroundColor: '#e3f2fd',
    borderRadius: 50,
    padding: 10,
    marginBottom: 12,
  },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#222',
    marginBottom: 6,
  },
  welcomeSubtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
  },

  // ── Login Card ────────────────────────────────────────────────────────────
  loginCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    gap: 4,
  },

  // ── Fields ────────────────────────────────────────────────────────────────
  fieldGroup: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#444',
    marginBottom: 8,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    backgroundColor: '#fafafa',
    paddingHorizontal: 12,
    height: 50,
  },
  inputWrapperError: {
    borderColor: '#e74c3c',
    backgroundColor: '#fff5f5',
  },
  inputIcon: {
    marginRight: 10,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    color: '#333',
    paddingVertical: 0,
  },
  eyeButton: {
    padding: 4,
    marginLeft: 4,
  },
  errorText: {
    fontSize: 12,
    color: '#e74c3c',
    marginTop: 5,
    marginLeft: 4,
  },

  // ── Login Button ──────────────────────────────────────────────────────────
  loginButton: {
    backgroundColor: BPCL_BLUE,
    borderRadius: 10,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
    elevation: 2,
    shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  loginButtonDisabled: {
    opacity: 0.7,
  },
  loginButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 0.3,
  },

  // ── Info Box ──────────────────────────────────────────────────────────────
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 20,
    backgroundColor: '#f0f4f8',
    padding: 12,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: BPCL_BLUE,
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: '#777',
    lineHeight: 18,
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    alignItems: 'center',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
  },
  footerText: {
    fontSize: 12,
    color: '#bbb',
  },
  footerVersion: {
    fontSize: 11,
    color: '#ccc',
    marginTop: 2,
  },
});