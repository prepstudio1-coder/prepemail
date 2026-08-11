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
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const BREVO_API_URL = 'https://api.brevo.com/v3';

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Normalize plan strings: strip billing-period suffixes and apply aliases.
   * e.g. "pro-monthly" → "pro", "studio-yearly" → "studio", "premium" → "pro"
   */
  function normalizePlan(raw) {
    if (!raw) return 'pro';
    const aliases = { premium: 'pro', paid: 'pro' };
    const base = raw.toLowerCase().replace(/-(monthly|yearly|annual)$/, '');
    return aliases[base] || base;
  }

  /**
   * Send payment confirmation email via Brevo (non-blocking — never fails the request).
   */
  async function sendPaymentConfirmationEmail(email, fullName, plan, amount) {
    if (!BREVO_API_KEY || !email) return;
    const { generatePaymentConfirmationEmail } = require('./email-templates');
    const safePlan  = (plan === 'studio') ? 'studio' : 'pro';
    const planLabel = safePlan === 'studio' ? 'Studio' : 'Pro';
    try {
      await fetch(`${BREVO_API_URL}/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: [{ email, name: fullName || email }],
          sender: { name: 'PREP - Cinematic Pre-production', email: 'noreply@prepapp.name.ng' },
          subject: `You're on PREP ${planLabel}! 🎬`,
          htmlContent: generatePaymentConfirmationEmail(fullName || 'Filmmaker', safePlan, amount),
          replyTo: { email: 'info@prepapp.name.ng', name: 'PREP Support' }
        })
      });
      console.log(`✅ Payment confirmation email sent to ${email}`);
    } catch (err) {
      console.warn('Payment confirmation email failed (non-fatal):', err.message);
    }
  }

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
      
      const { amount, planType, currency } = req.body;

      if (!amount || !planType) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Validate currency — must be a 3-letter ISO code. Defaults to USD.
      const CURRENCY_PATTERN = /^[A-Z]{3}$/;
      const resolvedCurrency = (typeof currency === 'string' && CURRENCY_PATTERN.test(currency))
        ? currency
        : 'USD';

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
      // Normalize first (strip billing-period suffixes like "pro-monthly")
      const normalizedPlanType = normalizePlan(planType);
      if (!ALLOWED_PLANS.includes(normalizedPlanType)) {
        return res.status(400).json({ success: false, message: 'Invalid plan type' });
      }

      // Detect billing cycle from the raw planType string (e.g. "pro-yearly")
      const billingCycle = /yearly|annual/i.test(planType) ? 'yearly' : 'monthly';
      const cycleLabel   = billingCycle === 'yearly' ? 'Annual' : 'Monthly';

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
          currency: resolvedCurrency,
          payment_options: 'card,ussd,account,credit_topup,apple_pay,google_pay',
          customer: {
            email,
            name: fullName
          },
          customizations: {
            title: 'PREP Pro Subscription',
            description: `${cycleLabel} subscription - ${normalizedPlanType.toUpperCase()} plan`
          },
          meta: {
            // userId set by the server from the verified token — not client-supplied
            userId,
            planType: normalizedPlanType,
            billingCycle,
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

      // Log the full Flutterwave response so we can diagnose the exact failure
      console.error('Flutterwave payment init failed:', JSON.stringify({
        httpStatus: response.status,
        flwStatus: data.status,
        flwMessage: data.message,
        flwData: data.data,
        txRef,
        resolvedCurrency,
        normalizedPlanType,
        amount
      }));

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

      // Normalize plan aliases (premium/paid → pro) and strip billing-period suffixes before persisting
      const rawPlanType = data.data?.meta?.planType || 'pro';
      const planType = normalizePlan(rawPlanType);

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

      // Send payment confirmation email (non-blocking)
      sendPaymentConfirmationEmail(
        email,
        fullName,
        planType,
        data.data?.amount,
        data.data?.meta?.currency || 'USD',
        data.data?.meta?.billingCycle
      ).catch(err => console.warn('Verify: confirmation email failed:', err.message));

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
