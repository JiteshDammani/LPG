# 📱 Build Android APK - Complete Guide

## LPG Cylinder Tracker - BPCL App

---

## 🚀 Quick Build (Using EAS Build - Recommended)

### Prerequisites
- Node.js installed (v16 or higher)
- Expo CLI installed globally
- Free Expo account (create at expo.dev)

### Step 1: Install Required Tools

Open terminal/command prompt and run:

```bash
npm install -g eas-cli expo-cli
```

### Step 2: Login to Expo

```bash
eas login
```

Enter your Expo account credentials.

### Step 3: Navigate to Project

```bash
cd /path/to/your/project/frontend
```

### Step 4: Configure EAS Build

```bash
eas build:configure
```

This creates an `eas.json` file automatically.

### Step 5: Build APK

```bash
eas build -p android --profile preview
```

**What happens:**
- Code is uploaded to Expo servers
- APK is built in the cloud (takes 10-15 minutes)
- You'll get a download link when complete

### Step 6: Download & Install

1. Build finishes → You get a download URL
2. Download the APK to your phone
3. Enable "Install from unknown sources" in Android settings
4. Install the APK

---

## 🔧 Alternative: Local Build (Advanced)

### Prerequisites
- Android Studio installed
- Java JDK 11 or higher
- Android SDK configured

### Build Locally

```bash
# Install dependencies
cd frontend
npm install

# Create APK
npx expo run:android --variant release
```

---

## 📋 Important Configuration

### Backend URL Configuration

Before building, update the backend URL in `/frontend/.env`:

```env
EXPO_PUBLIC_BACKEND_URL=YOUR_PRODUCTION_BACKEND_URL
```

**Current value:** `https://cylinder-track-4.preview.emergentagent.com`

⚠️ **Note:** Replace with your production backend URL if deploying separately.

---

## 🎯 App Information

- **App Name:** LPG Cylinder Tracker
- **Package:** com.bpcl.lpgtracker
- **Version:** 1.0.0
- **Colors:** BPCL Blue (#017DC5) & Yellow (#FFDC02)

---

## 📱 Features Included

✅ Delivery entry with auto calculations
✅ Mandatory cylinder reconciliation
✅ Staff management
✅ Daily records with calendar
✅ Export to Excel & CSV
✅ Offline-first data storage
✅ Daily summary reports

---

## 🆘 Troubleshooting

### Build Fails?

1. **Check Node version:** `node --version` (should be 16+)
2. **Clear cache:** `npx expo start --clear`
3. **Reinstall dependencies:** `rm -rf node_modules && npm install`

### APK Won't Install?

1. Enable "Install from unknown sources" in Android settings
2. Make sure you downloaded the full APK (not partial)
3. Check available storage space

### Need Help?

- **Expo Documentation:** https://docs.expo.dev/build/setup/
- **Discord Support:** https://discord.gg/VzKfwCXC4A
- **Email:** support@emergent.sh

---

## 🔐 Security Notes

- APK is signed with debug key (for testing)
- For production, use release signing
- Keep backend credentials secure
- Update backend URL before distribution

---

## ✅ Ready to Build!

Your app is configured and ready. Just run:

```bash
eas build -p android --profile preview
```

**Estimated time:** 15-20 minutes for first build

Good luck! 🚀
