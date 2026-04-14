/**
 * Configuration loader for PREP application
 * Loads Firebase and other configuration from environment variables
 * 
 * Note: Firebase API keys are intentionally public - security comes from Firebase Rules
 * Other secrets (BREVO_API_KEY, etc.) should NEVER be exposed in client-side code
 */

// Firebase Configuration
// These values are loaded from environment variables in production
// For development, they can be hardcoded, but should use .env files
export const firebaseConfig = {
  apiKey: import.meta?.env?.VITE_FIREBASE_API_KEY || "AIzaSyAzJT1E4IRwKo7FVwFpsXVXY3NGWl3L434",
  authDomain: import.meta?.env?.VITE_FIREBASE_AUTH_DOMAIN || "prep-a3139.firebaseapp.com",
  projectId: import.meta?.env?.VITE_FIREBASE_PROJECT_ID || "prep-a3139",
  storageBucket: import.meta?.env?.VITE_FIREBASE_STORAGE_BUCKET || "prep-a3139.appspot.com",
  messagingSenderId: import.meta?.env?.VITE_FIREBASE_MESSAGING_SENDER_ID || "967383426123",
  appId: import.meta?.env?.VITE_FIREBASE_APP_ID || "1:967383426123:web:83cc098d549ff148fe99ce",
  databaseURL: import.meta?.env?.VITE_FIREBASE_DATABASE_URL || "https://prep-a3139-default-rtdb.firebaseio.com"
};

// Cloudinary Configuration
export const cloudinaryConfig = {
  cloudName: import.meta?.env?.VITE_CLOUDINARY_CLOUD_NAME || "dct7psmk7",
  uploadPreset: import.meta?.env?.VITE_CLOUDINARY_UPLOAD_PRESET || "unsigned_preset"
};

// API Configuration
export const apiConfig = {
  baseUrl: import.meta?.env?.VITE_API_BASE_URL || "https://prepemail.onrender.com"
};

// App Environment
export const appConfig = {
  environment: import.meta?.env?.MODE || "development",
  isDevelopment: (import.meta?.env?.MODE || "development") === "development",
  isProduction: (import.meta?.env?.MODE || "development") === "production"
};

// Validate configuration on load
if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.warn("Firebase configuration may be incomplete. Check your environment variables.");
}

export default {
  firebase: firebaseConfig,
  cloudinary: cloudinaryConfig,
  api: apiConfig,
  app: appConfig
};
