/**
 * Flutterwave Payment Integration Module
 * Handles payment initialization and verification
 */

import { auth, db } from './firebase.js';
import { getBackendBaseUrl } from './config.js';
import { doc, getDoc, updateDoc, collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// The public key is safe to expose in client-side code.
const FLUTTERWAVE_PUBLIC_KEY =
  window.PREP_CONFIG?.flutterwavePublicKey ||
  import.meta?.env?.VITE_FLUTTERWAVE_PUBLIC_KEY ||
  '';

/**
 * Initialize a payment transaction with Flutterwave.
 * Identity (userId, email) is taken from the Firebase token on the server —
 * we do NOT send userId in the body to prevent impersonation.
 */
export async function initiatePayment(planType, amount) {
  const user = auth.currentUser;
  if (!user) throw new Error('User must be authenticated to make payment');

  // Validate planType client-side before sending (server also validates)
  const ALLOWED_PLANS = ['pro', 'studio'];
  if (!ALLOWED_PLANS.includes(planType)) throw new Error('Invalid plan type');

  const idToken = await user.getIdToken();

  const response = await fetch(`${getBackendBaseUrl()}/api/payment/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    },
    body: JSON.stringify({
      // userId and email are read server-side from the verified token
      amount,
      planType,
      fullName: user.displayName || user.email || 'User'
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to initialize payment');
  }

  return response.json();
}

/**
 * Handle Flutterwave payment response
 * @param {object} response - Flutterwave payment response
 * @returns {Promise<object>} Verification result
 */
export async function handlePaymentResponse(response) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('User must be authenticated');
  }

  try {
    // Verify payment with backend — send the Firebase ID token so the server
    // can verify the caller's identity without trusting the client-supplied userId.
    const idToken = await user.getIdToken();
    const verifyResponse = await fetch(`${getBackendBaseUrl()}/api/payment/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        transactionId: response.transaction_id,
        transactionRef: response.tx_ref,
        status: response.status
        // userId is intentionally omitted — the server reads it from the token
      })
    });

    if (!verifyResponse.ok) {
      const error = await verifyResponse.json();
      throw new Error(error.message || 'Payment verification failed');
    }

    const verifyData = await verifyResponse.json();
    
    // If payment is successful, update user subscription in Firestore
    if (verifyData.success && verifyData.status === 'success') {
      await updateUserSubscription(user.uid, verifyData.plan, verifyData.subscriptionId);
      return { success: true, message: 'Payment successful!' };
    } else {
      return { success: false, message: 'Payment verification failed' };
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    throw error;
  }
}

/**
 * Update user subscription in Firestore
 * @param {string} userId - User ID
 * @param {string} plan - Plan type ('pro' or 'studio')
 * @param {string} subscriptionId - Flutterwave subscription ID
 */
export async function updateUserSubscription(userId, plan, subscriptionId) {
  const userRef = doc(db, 'users', userId);
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days for monthly

  try {
    await updateDoc(userRef, {
      plan: plan,
      subscriptionId: subscriptionId,
      subscriptionStartDate: serverTimestamp(),
      subscriptionEndDate: expiryDate,
      subscriptionStatus: 'active',
      lastPaymentDate: serverTimestamp()
    });

    // Add to payment history
    const paymentsRef = collection(db, 'users', userId, 'payments');
    await addDoc(paymentsRef, {
      subscriptionId: subscriptionId,
      plan: plan,
      amount: plan === 'pro' ? 8 : 0, // Adjust amount as needed
      currency: 'USD',
      status: 'successful',
      date: serverTimestamp(),
      expiryDate: expiryDate
    });

    return true;
  } catch (error) {
    console.error('Error updating subscription:', error);
    throw error;
  }
}

/**
 * Get user's current plan
 * @param {string} userId - User ID
 * @returns {Promise<string>} Current plan ('free', 'pro', or 'studio')
 */
export async function getUserPlan(userId) {
  try {
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);
    return userDoc.data()?.plan || 'free';
  } catch (error) {
    console.error('Error fetching user plan:', error);
    return 'free';
  }
}

/**
 * Initialize Flutterwave payment modal
 * @param {object} config - Payment configuration
 */
export function openFlutterwave(config) {
  return new Promise((resolve, reject) => {
    if (!window.FlutterwaveCheckout) {
      reject(new Error('Flutterwave script not loaded'));
      return;
    }

    window.FlutterwaveCheckout({
      public_key: FLUTTERWAVE_PUBLIC_KEY,
      tx_ref: config.txRef,
      amount: config.amount,
      currency: config.currency || 'USD',
      payment_options: 'card, mobilemoney, ussd',
      customer: {
        email: config.email,
        phonenumber: config.phone || '',
        name: config.name
      },
      customizations: {
        title: 'PREP - ' + config.planName,
        description: 'Upgrade to ' + config.planName + ' plan',
        logo: 'https://prepapp.name.ng/assets/logo.png'
      },
      callback: (data) => {
        resolve(data);
      },
      onclose: () => {
        reject(new Error('Payment cancelled by user'));
      }
    });
  });
}

export default {
  initiatePayment,
  handlePaymentResponse,
  updateUserSubscription,
  getUserPlan,
  openFlutterwave
};
