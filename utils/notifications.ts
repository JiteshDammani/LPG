import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// Set up the notification handler configuration for when the app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, // Retained for older SDK compatibility
    shouldShowBanner: true, // Required by newer versions of expo-notifications
    shouldShowList: true,   // Required by newer versions of expo-notifications
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log('Must use physical device for Push Notifications');
    return null;
  }

  // Set up Android notification channel (required for Android 8.0+)
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#017DC5',
    });
  }

  // Check existing notification permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // Ask for permission if not granted
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Failed to get push token for push notifications (Permission denied)');
    return null;
  }

  try {
    // Retrieve the dynamic projectId from your app.json config
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      console.error(
        'Project ID not found in app configuration. Ensure it is defined under extra.eas.projectId in app.json.'
      );
      return null;
    }

    // Retrieve your Expo Push Token using the dynamic project ID
    const token = (
      await Notifications.getExpoPushTokenAsync({
        projectId,
      })
    ).data;

    console.log('Expo Push Token successfully fetched:', token);
    return token;
  } catch (error) {
    console.error('Error fetching Expo Push Token:', error);
    return null;
  }
}