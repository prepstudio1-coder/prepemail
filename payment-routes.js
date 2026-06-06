/**
 * Payment Routes for Flutterwave Integration
 * Add these routes to your Express server (server.js)
 *
 * Firebase Admin is intentionally NOT initialized here.
 * This module exports a factory function that accepts the already-initialized
 * { admin, db } instances from server.js, ensuring a single initialization
 * point for the entire process.
 */

const express = require('express');
const fetch = require('node-fetch');

const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com/v3';

/**
 * Factory function — call with the shared { admin, db } from server.js.
 * Returns the configured Express router.
 */
function createPaymentRouter({ admin, db }) {
  const router = express.Router();
  const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
  const APP_URL = process.env.APP_URL || 'https://prepapp.name.ng';

  function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    if (!admin || !db) {
      return res.status(503).json({ success: false, message: 'Auth service unavailable' });
    }

    admin.auth().verifyIdToken(idToken)
      .then((decoded) => {
        req.user = decoded;
        next();
      })
      .catch((err) => {
        console.error('Token verification failed:', err.message);
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
      });
  }

  router.post('/api/payment/initialize', verifyFirebaseToken, async (req, res) => {
    try {
      // Extract userId from verified token, not from request body
      const userId = req.user.uid;
      const email = req.user.email;
      const fullName = req.user.name || req.user.email;
      
      const { amount, planType } = req.body;

      if (!amount || !planType) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      if (!FLUTTERWAVE_SECRET_KEY) {
        console.error('FLUTTERWAVE_SECRET_KEY not configured');
        return res.status(500).json({
          success: false,
          message: 'Payment service not configured'
        });
      }

      // Validate planType before embedding in meta so arbitrary strings cannot
      // be written into Firestore via the webhook or verify endpoint.
      const ALLOWED_PLANS = ['pro', 'studio'];
      if (!ALLOWED_PLANS.includes(planType)) {
        return res.status(400).json({ success: false, message: 'Invalid plan type' });
      }

      // Embed userId (server-sourced from the verified token) so the webhook can
      // identify the correct user even when the redirect/verify flow is bypassed.
      const txRef = `PREP-${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const response = await fetch(`${FLUTTERWAVE_API_URL}/payments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount,
          currency: 'USD',
          payment_options: 'card,ussd,account,credit_topup,apple_pay,google_pay',
          customer: {
            email,
            name: fullName
          },
          customizations: {
            title: 'PREP Pro Subscription',
            description: `Monthly subscription - ${planType.toUpperCase()} plan`
          },
          meta: {
            // userId set by the server from the verified token — not client-supplied
            userId,
            planType
          },
          redirect_url: `${APP_URL}/payment-success.html`
        })
      });

      const data = await response.json();

      if (data.status === 'success') {
        return res.json({
          success: true,
          paymentLink: data.data.link,
          transactionId: data.data.id,
          txRef
        });
      }

      return res.status(400).json({
        success: false,
        message: data.message || 'Failed to initialize payment'
      });
    } catch (error) {
      console.error('Payment initialization error:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error'
      });
    }
  });

  router.post('/api/payment/verify', verifyFirebaseToken, async (req, res) => {
    try {
      const { transactionId } = req.body;
      // Always use the UID from the verified token — never trust req.body
      const userId = req.user.uid;

      if (!transactionId) {
        return res.status(400).json({ success: false, message: 'Transaction ID required' });
      }

      if (!FLUTTERWAVE_SECRET_KEY) {
        console.error('FLUTTERWAVE_SECRET_KEY not configured');
        return res.status(500).json({ success: false, message: 'Payment service not configured' });
      }

      const response = await fetch(`${FLUTTERWAVE_API_URL}/transactions/${transactionId}/verify`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.status !== 'success' || data.data?.status !== 'successful') {
        return res.status(400).json({
          success: false,
          message: 'Payment not successful',
          transaction: data.data
        });
      }

      if (!db) {
        console.error('Firestore not available for payment verification');
        return res.status(500).json({ success: false, message: 'Database not configured' });
      }

      // Normalize plan aliases (premium/paid → pro) before persisting
      const rawPlanType = data.data?.meta?.planType || 'pro';
      const planAliases = { premium: 'pro', paid: 'pro' };
      const planType = planAliases[rawPlanType.toLowerCase()] || rawPlanType.toLowerCase();

      const subscriptionId = data.data?.id;
      const email = data.data?.customer?.email || null;
      const fullName = data.data?.customer?.name || null;

      try {
        await db.collection('users').doc(userId).update({
          plan: planType,
          subscriptionId,
          subscriptionStatus: 'active',
          subscriptionStartDate: new Date(),
          lastPaymentDate: new Date(),
          lastPaymentAmount: data.data?.amount,
          lastPaymentCurrency: data.data?.currency,
          email,
          displayName: fullName,
          planUpdatedAt: new Date()
        });
        console.log(`✅ Plan updated to "${planType}" for user ${userId}`);
      } catch (dbError) {
        console.error('Firestore update failed during payment verification:', dbError);
        return res.status(500).json({ success: false, message: 'Failed to update subscription record' });
      }

      return res.json({
        success: true,
        message: 'Payment verified',
        plan: planType,
        transaction: data.data
      });
    } catch (error) {
      console.error('Payment verification error:', error);
      return res.status(500).json({ success: false, message: 'Verification failed' });
    }
  });

  router.post('/api/subscription/cancel', verifyFirebaseToken, async (req, res) => {
    try {
      const { subscriptionId } = req.body;
      const userId = req.user?.uid;

      if (!subscriptionId) {
        return res.status(400).json({ success: false, message: 'Subscription ID required' });
      }

      if (!FLUTTERWAVE_SECRET_KEY) {
        console.error('FLUTTERWAVE_SECRET_KEY not configured');
        return res.status(500).json({ success: false, message: 'Payment service not configured' });
      }

      const response = await fetch(`${FLUTTERWAVE_API_URL}/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (response.ok && data.status === 'success') {
        if (db && userId) {
          try {
            await db.collection('users').doc(userId).update({
              subscriptionStatus: 'cancelled',
              subscriptionCancelledAt: new Date(),
              plan: 'free'
            });
          } catch (dbError) {
            console.error('Firestore update failed while cancelling subscription:', dbError);
            return res.status(500).json({ success: false, message: 'Subscription cancelled, but failed to update database' });
          }
        }

        return res.json({ success: true, message: 'Subscription cancelled successfully', data });
      }

      console.error('Flutterwave subscription cancel failed:', data);
      return res.status(400).json({ success: false, message: data.message || 'Failed to cancel subscription' });
    } catch (error) {
      console.error('Subscription cancellation error:', error);
      return res.status(500).json({ success: false, message: 'Cancellation failed' });
    }
  });

  return router;
}

module.exports = createPaymentRouter;
