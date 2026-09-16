// app/(tabs)/loginScreen.tsx
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
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDataStore } from '../../store/dataStore';

const BPCL_BLUE   = '#017DC5';
const BPCL_YELLOW = '#FFDC02';

const VERIFY_PASSWORD_URL =
  'https://dfxlolpdxcnergtssyyd.supabase.co/functions/v1/verify-password';

const CREATE_USER_URL =
  'https://dfxlolpdxcnergtssyyd.supabase.co/functions/v1/create-user';

const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmeGxvbHBkeGNuZXJndHNzeXlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDI2NjksImV4cCI6MjA4NzA3ODY2OX0.xbmpR6piEiJjeiZT0LMMipggptk95EMT5w6NnyRt4lc';

const SUPABASE_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'apikey': SUPABASE_ANON_KEY,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  is_staff: boolean;
  is_superuser: boolean;
  is_active: boolean;
}

interface Props {
  onLoginSuccess: (user: AuthUser) => void;
}

// ─── Field helper — defined OUTSIDE SignUpModal to prevent keyboard dismiss ───

interface FieldProps {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder: string;
  secure?: boolean;
  showToggle?: boolean;
  onToggle?: () => void;
  icon: string;
  errorKey: string;
  keyboardType?: any;
  autoCapitalize?: any;
  errors: Record<string, string>;
  setErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

const Field = ({
  label, value, onChange, placeholder, secure, showToggle,
  onToggle, icon, errorKey, keyboardType, autoCapitalize, errors, setErrors,
}: FieldProps) => (
  <View style={su.fieldGroup}>
    <Text style={su.label}>{label}</Text>
    <View style={[su.inputRow, errors[errorKey] ? su.inputRowErr : {}]}>
      <Ionicons
        name={icon as any}
        size={17}
        color={errors[errorKey] ? '#e74c3c' : '#aaa'}
        style={{ marginRight: 8 }}
      />
      <TextInput
        style={su.input}
        placeholder={placeholder}
        placeholderTextColor="#bbb"
        value={value}
        onChangeText={(t) => {
          onChange(t);
          if (errors[errorKey]) setErrors((e) => ({ ...e, [errorKey]: '' }));
        }}
        secureTextEntry={secure && !showToggle}
        keyboardType={keyboardType || 'default'}
        autoCapitalize={autoCapitalize || 'none'}
        autoCorrect={false}
      />
      {onToggle && (
        <TouchableOpacity onPress={onToggle} style={{ padding: 4 }}>
          <Ionicons
            name={(showToggle ? 'eye-off-outline' : 'eye-outline') as any}
            size={17}
            color="#aaa"
          />
        </TouchableOpacity>
      )}
    </View>
    {!!errors[errorKey] && (
      <Text style={su.errText}>⚠ {errors[errorKey]}</Text>
    )}
  </View>
);

// ─── Sign Up Modal ────────────────────────────────────────────────────────────

interface SignUpModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function SignUpModal({ visible, onClose, onSuccess }: SignUpModalProps) {
  const [firstName,  setFirstName]  = useState('');
  const [lastName,   setLastName]   = useState('');
  const [email,      setEmail]      = useState('');
  const [username,   setUsername]   = useState('');
  const [password,   setPassword]   = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd,    setShowPwd]    = useState(false);
  const [showCPwd,   setShowCPwd]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [errors,     setErrors]     = useState<Record<string, string>>({});

  const reset = () => {
    setFirstName(''); setLastName(''); setEmail('');
    setUsername(''); setPassword(''); setConfirmPwd('');
    setErrors({});
  };

  const handleClose = () => { reset(); onClose(); };

  // ── Validation ────────────────────────────────────────────────────
  const validate = (): boolean => {
    const e: Record<string, string> = {};

    if (!firstName.trim()) e.firstName = 'First name is required';

    if (!username.trim())  e.username = 'Username is required';
    else if (username.trim().length < 3)
      e.username = 'Username must be at least 3 characters';
    else if (!/^[a-zA-Z0-9_]+$/.test(username.trim()))
      e.username = 'Only letters, numbers and underscore allowed';

    if (!password)         e.password = 'Password is required';
    else if (password.length < 6)
      e.password = 'Password must be at least 6 characters';

    if (!confirmPwd)       e.confirmPwd = 'Please confirm your password';
    else if (password !== confirmPwd)
      e.confirmPwd = 'Passwords do not match';

    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      e.email = 'Enter a valid email address';

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Submit ────────────────────────────────────────────────────────
  const handleSignUp = async () => {
    if (!validate()) return;
    setLoading(true);

    try {
      const body = JSON.stringify({
        username:   username.trim().toLowerCase(),
        password,
        first_name: firstName.trim(),
        last_name:  lastName.trim(),
        email:      email.trim(),
      });

      const res = await fetch(CREATE_USER_URL, {
        method: 'POST',
        headers: SUPABASE_HEADERS,
        body,
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        if (json.error?.toLowerCase().includes('username')) {
          setErrors((e) => ({ ...e, username: json.error }));
        } else {
          Alert.alert('Sign Up Failed', json.error || 'Something went wrong.');
        }
        return;
      }

      Alert.alert(
        '✅ Account Created',
        `Welcome, ${firstName}!\n\nYour account has been created. Please ask Jitesh to grant you page access before logging in.`,
        [{ text: 'OK', onPress: () => { reset(); onSuccess(); } }]
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={su.container}>
        {/* Header */}
        <View style={su.header}>
          <View>
            <Text style={su.headerTitle}>Create Account</Text>
            <Text style={su.headerSub}>Fill in your details to register</Text>
          </View>
          <TouchableOpacity onPress={handleClose} style={su.closeBtn}>
            <Ionicons name="close" size={22} color="#666" />
          </TouchableOpacity>
        </View>

        {/* Notice */}
        <View style={su.noticeBanner}>
          <Ionicons name="information-circle" size={18} color={BPCL_BLUE} />
          <Text style={su.noticeText}>
            After registration, Jitesh must grant you page access before you can use the app.
          </Text>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={su.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Name row */}
            <View style={su.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label="First Name *"
                  value={firstName}
                  onChange={setFirstName}
                  placeholder="First name"
                  icon="person-outline"
                  errorKey="firstName"
                  autoCapitalize="words"
                  errors={errors}
                  setErrors={setErrors}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="Last Name"
                  value={lastName}
                  onChange={setLastName}
                  placeholder="Last name"
                  icon="person-outline"
                  errorKey="lastName"
                  autoCapitalize="words"
                  errors={errors}
                  setErrors={setErrors}
                />
              </View>
            </View>

            <Field
              label="Email (optional)"
              value={email}
              onChange={setEmail}
              placeholder="your@email.com"
              icon="mail-outline"
              errorKey="email"
              keyboardType="email-address"
              errors={errors}
              setErrors={setErrors}
            />

            <Field
              label="Username *"
              value={username}
              onChange={setUsername}
              placeholder="Choose a username"
              icon="at-outline"
              errorKey="username"
              errors={errors}
              setErrors={setErrors}
            />

            <Field
              label="Password *"
              value={password}
              onChange={setPassword}
              placeholder="Min. 6 characters"
              icon="lock-closed-outline"
              errorKey="password"
              secure
              showToggle={showPwd}
              onToggle={() => setShowPwd((v) => !v)}
              errors={errors}
              setErrors={setErrors}
            />

            <Field
              label="Confirm Password *"
              value={confirmPwd}
              onChange={setConfirmPwd}
              placeholder="Re-enter password"
              icon="lock-closed-outline"
              errorKey="confirmPwd"
              secure
              showToggle={showCPwd}
              onToggle={() => setShowCPwd((v) => !v)}
              errors={errors}
              setErrors={setErrors}
            />

            {/* Submit */}
            <TouchableOpacity
              style={[su.submitBtn, loading && { opacity: 0.7 }]}
              onPress={handleSignUp}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="person-add-outline" size={20} color="#fff" />
                  <Text style={su.submitText}>Create Account</Text>
                </>
              )}
            </TouchableOpacity>

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── Main Login Component ─────────────────────────────────────────────────────

export default function LoginScreen({ onLoginSuccess }: Props) {
  const { setAllowedPages } = useDataStore();

  const [username,      setUsername]      = useState('');
  const [password,      setPassword]      = useState('');
  const [showPassword,  setShowPassword]  = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [showSignUp,    setShowSignUp]    = useState(false);

  // ── Validation ────────────────────────────────────────────────────
  const validate = (): boolean => {
    let valid = true;
    setUsernameError('');
    setPasswordError('');
    if (!username.trim()) { setUsernameError('Username is required'); valid = false; }
    if (!password)        { setPasswordError('Password is required'); valid = false; }
    return valid;
  };

  // ── Login ─────────────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!validate()) return;
    setLoading(true);

    try {
      const res = await fetch(VERIFY_PASSWORD_URL, {
        method: 'POST',
        headers: SUPABASE_HEADERS,
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setPasswordError(json.error || 'Invalid username or password.');
        return;
      }

      onLoginSuccess(json.user as AuthUser);

    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* Blue Header */}
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

      {/* Form */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Welcome */}
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
              <View style={[styles.inputWrapper, usernameError ? styles.inputWrapperError : {}]}>
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
                  onChangeText={(t) => { setUsername(t); if (usernameError) setUsernameError(''); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                />
              </View>
              {!!usernameError && <Text style={styles.errorText}>⚠ {usernameError}</Text>}
            </View>

            {/* Password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Password</Text>
              <View style={[styles.inputWrapper, passwordError ? styles.inputWrapperError : {}]}>
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
                  onChangeText={(t) => { setPassword(t); if (passwordError) setPasswordError(''); }}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={styles.eyeButton}>
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color="#aaa"
                  />
                </TouchableOpacity>
              </View>
              {!!passwordError && <Text style={styles.errorText}>⚠ {passwordError}</Text>}
            </View>

            {/* Sign In Button */}
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

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Sign Up Button */}
            <TouchableOpacity
              style={styles.signUpButton}
              onPress={() => setShowSignUp(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="person-add-outline" size={18} color={BPCL_BLUE} />
              <Text style={styles.signUpButtonText}>Create New Account</Text>
            </TouchableOpacity>
          </View>

          {/* Info */}
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color="#999" />
            <Text style={styles.infoText}>
              Use your BPCL staff credentials. Contact Jitesh if you need access granted.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>BPCL Cylinder Stock Management System</Text>
        <Text style={styles.footerVersion}>v1.0.0</Text>
      </View>

      {/* Sign Up Modal */}
      <SignUpModal
        visible={showSignUp}
        onClose={() => setShowSignUp(false)}
        onSuccess={() => setShowSignUp(false)}
      />
    </View>
  );
}

// ─── Login Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:           { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    backgroundColor: BPCL_BLUE,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 5,
  },
  headerContent:       { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  logoRow:             { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logoBadge: {
    backgroundColor: BPCL_YELLOW,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  logoBadgeText:       { color: '#333', fontWeight: 'bold', fontSize: 14, letterSpacing: 1 },
  headerTitle:         { fontSize: 22, fontWeight: 'bold', color: '#fff', letterSpacing: 0.3 },
  headerSubtitle:      { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
  scrollContent:       { padding: 20, paddingBottom: 40 },
  welcomeCard:         { alignItems: 'center', paddingVertical: 28 },
  welcomeIconWrap: {
    backgroundColor: '#e3f2fd',
    borderRadius: 50,
    padding: 10,
    marginBottom: 12,
  },
  welcomeTitle:        { fontSize: 24, fontWeight: 'bold', color: '#222', marginBottom: 6 },
  welcomeSubtitle:     { fontSize: 14, color: '#888', textAlign: 'center' },
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
  fieldGroup:          { marginBottom: 16 },
  fieldLabel:          { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 8 },
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
  inputWrapperError:   { borderColor: '#e74c3c', backgroundColor: '#fff5f5' },
  inputIcon:           { marginRight: 10 },
  textInput:           { flex: 1, fontSize: 15, color: '#333', paddingVertical: 0 },
  eyeButton:           { padding: 4, marginLeft: 4 },
  errorText:           { fontSize: 12, color: '#e74c3c', marginTop: 5, marginLeft: 4 },
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
  loginButtonDisabled: { opacity: 0.7 },
  loginButtonText:     { color: '#fff', fontSize: 16, fontWeight: 'bold', letterSpacing: 0.3 },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
    gap: 10,
  },
  dividerLine:         { flex: 1, height: 1, backgroundColor: '#eee' },
  dividerText:         { fontSize: 13, color: '#bbb', fontWeight: '500' },
  signUpButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: BPCL_BLUE,
    backgroundColor: '#f0f8ff',
  },
  signUpButtonText:    { color: BPCL_BLUE, fontSize: 15, fontWeight: '700' },
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
  infoText:            { flex: 1, fontSize: 12, color: '#777', lineHeight: 18 },
  footer: {
    alignItems: 'center',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
  },
  footerText:          { fontSize: 12, color: '#bbb' },
  footerVersion:       { fontSize: 11, color: '#ccc', marginTop: 2 },
});

// ─── Sign Up Modal Styles ─────────────────────────────────────────────────────

const su = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle:  { fontSize: 20, fontWeight: '700', color: '#222' },
  headerSub:    { fontSize: 13, color: '#888', marginTop: 2 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: BPCL_BLUE + '11',
    padding: 14,
    margin: 16,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: BPCL_BLUE,
  },
  noticeText:    { flex: 1, fontSize: 13, color: '#444', lineHeight: 19 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  row:           { flexDirection: 'row' },
  fieldGroup:    { marginBottom: 14 },
  label:         { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 6 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    backgroundColor: '#fafafa',
    paddingHorizontal: 12,
    height: 48,
  },
  inputRowErr:   { borderColor: '#e74c3c', backgroundColor: '#fff5f5' },
  input:         { flex: 1, fontSize: 14, color: '#333' },
  errText:       { fontSize: 12, color: '#e74c3c', marginTop: 4, marginLeft: 2 },
  submitBtn: {
    backgroundColor: BPCL_BLUE,
    borderRadius: 12,
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
    elevation: 3,
    shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  submitText:    { color: '#fff', fontSize: 16, fontWeight: '700' },
});
