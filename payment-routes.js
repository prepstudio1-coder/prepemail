/**
 * Payment Routes — Paystack Integration
 *
 * Flow:
 *   1. POST /api/payment/initialize  → calls Paystack /transaction/initialize
 *      Returns { success, paymentLink, reference }
 *   2. User is redirected to Paystack's hosted payment page.
 *   3. Paystack redirects back to /payment-success.html?reference=<ref>
 *   4. POST /api/payment/verify      → calls Paystack /transaction/verify/:reference
 *      Writes plan to Firestore on success.
 *
 * Firebase Admin is intentionally NOT initialized here.
 * This module exports a factory function that accepts the already-initialized
 * { admin, db } instances from server.js, ensuring a single initialization
 * point for the entire process.
 */

const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');

const PAYSTACK_API_URL = 'https://api.paystack.co';

/**
 * Factory function — call with the shared { admin, db } from server.js.
 * Returns the configured Express router.
 */
function createPaymentRouter({ admin, db }) {
  const router = express.Router();

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const APP_URL             = process.env.APP_URL || 'https://prepapp.name.ng';
  const BREVO_API_KEY       = process.env.BREVO_API_KEY;
  const BREVO_API_URL       = 'https://api.brevo.com/v3';

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
    try {
      const { generatePaymentConfirmationEmail } = require('./email-templates');
      const safePlan  = plan === 'studio' ? 'studio' : 'pro';
      const planLabel = safePlan === 'studio' ? 'Studio' : 'Pro';
      await fetch(`${BREVO_API_URL}/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: [{ email, name: fullName || email }],
          sender: { name: 'PREP - Cinematic Pre-production', email: 'noreply@prepapp.name.ng' },
          subject: `You're on PREP ${planLabel}! 🎬`,
          htmlContent: generatePaymentConfirmationEmail(fullName || 'Filmmaker', safePlan, amount),
          replyTo: { email: 'info@prepapp.name.ng', name: 'PREP Support' },
        }),
      });
      console.log(`✅ Payment confirmation email sent to ${email}`);
    } catch (err) {
      console.warn('Payment confirmation email failed (non-fatal):', err.message);
    }
  }

  /**
   * Middleware: verify Firebase ID token from Authorization header.
   * Attaches decoded token to req.user.
   */
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
      .then((decoded) => { req.user = decoded; next(); })
      .catch((err) => {
        console.error('Token verification failed:', err.message);
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
      });
  }

  // ─── POST /api/payment/initialize ────────────────────────────────────────────
  /**
   * Initializes a Paystack transaction and returns the hosted payment URL.
   * Amount must be in the smallest currency unit (kobo for NGN, pesewas for GHS, etc.).
   * The frontend sends the amount already converted to local currency — we multiply
   * by 100 here to convert to subunits as Paystack requires.
   *
   * Body: { amount, planType, currency }
   * Returns: { success, paymentLink, reference }
   */
  router.post('/api/payment/initialize', verifyFirebaseToken, async (req, res) => {
    try {
      const userId   = req.user.uid;
      const email    = req.user.email;
      const fullName = req.user.name || req.user.email;

      const { amount, planType, currency } = req.body;

      if (!amount || !planType) {
        return res.status(400).json({ success: false, message: 'Missing required fields: amount and planType' });
      }

      // Validate currency — must be a 3-letter ISO code. Defaults to NGN.
      const CURRENCY_PATTERN = /^[A-Z]{3}$/;
      const resolvedCurrency = (typeof currency === 'string' && CURRENCY_PATTERN.test(currency))
        ? currency
        : 'NGN';

      if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY not configured');
        return res.status(500).json({ success: false, message: 'Payment service not configured' });
      }

      // Validate planType before embedding in metadata.
      const ALLOWED_PLANS    = ['pro', 'studio'];
      const normalizedPlan   = normalizePlan(planType);
      if (!ALLOWED_PLANS.includes(normalizedPlan)) {
        return res.status(400).json({ success: false, message: 'Invalid plan type' });
      }

      const billingCycle = /yearly|annual/i.test(planType) ? 'yearly' : 'monthly';
      const cycleLabel   = billingCycle === 'yearly' ? 'Annual' : 'Monthly';

      // Unique reference for this transaction
      const reference = `PREP-${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Paystack expects amount in smallest currency unit (kobo for NGN = × 100)
      const amountInSubunits = Math.round(parseFloat(amount) * 100);

      const paystackPayload = {
        email,
        amount:       amountInSubunits,
        currency:     resolvedCurrency,
        reference,
        callback_url: `${APP_URL}/payment-success.html`,
        metadata: {
          userId,          // set server-side from verified token — not client-supplied
          planType:   normalizedPlan,
          billingCycle,
          fullName,
          custom_fields: [
            { display_name: 'Plan',          variable_name: 'plan',           value: `${normalizedPlan} (${cycleLabel})` },
            { display_name: 'Customer Name', variable_name: 'customer_name',  value: fullName },
          ],
        },
      };

      const response = await fetch(`${PAYSTACK_API_URL}/transaction/initialize`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(paystackPayload),
      });

      const data = await response.json();

      if (data.status === true && data.data?.authorization_url) {
        console.log(`✅ Paystack transaction initialized: ${reference}`);
        return res.json({
          success:     true,
          paymentLink: data.data.authorization_url,
          reference:   data.data.reference,
        });
      }

      console.error('Paystack init failed:', JSON.stringify({
        httpStatus:   response.status,
        message:      data.message,
        reference,
        resolvedCurrency,
        normalizedPlan,
        amountInSubunits,
      }));

      return res.status(400).json({
        success: false,
        message: data.message || 'Failed to initialize payment',
      });

    } catch (error) {
      console.error('Payment initialization error:', error);
      return res.status(500).json({ success: false, message: 'Server error during payment initialization' });
    }
  });

  // ─── POST /api/payment/verify ─────────────────────────────────────────────
  /**
   * Verifies a Paystack transaction by reference and upgrades the user's plan.
   *
   * Body: { reference }   (the ?reference= query param from payment-success.html)
   * Returns: { success, plan, transaction }
   */
  router.post('/api/payment/verify', verifyFirebaseToken, async (req, res) => {
    try {
      const { reference } = req.body;
      const userId        = req.user.uid; // always from verified token

      if (!reference) {
        return res.status(400).json({ success: false, message: 'Payment reference is required' });
      }

      if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY not configured');
        return res.status(500).json({ success: false, message: 'Payment service not configured' });
      }

      const response = await fetch(`${PAYSTACK_API_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
        method:  'GET',
        headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` },
      });

      const data = await response.json();

      if (data.status !== true || data.data?.status !== 'success') {
        console.warn('Paystack verification failed:', { reference, paystackStatus: data.data?.status, message: data.message });
        return res.status(400).json({
          success:     false,
          message:     'Payment not successful',
          transaction: data.data,
        });
      }

      if (!db) {
        console.error('Firestore not available for payment verification');
        return res.status(500).json({ success: false, message: 'Database not configured' });
      }

      // Cross-validate: the reference must start with PREP-{userId}-
      // so that a user cannot verify someone else's transaction.
      const expectedPrefix = `PREP-${userId}-`;
      if (!reference.startsWith(expectedPrefix)) {
        console.warn(`Reference mismatch — reference "${reference}" does not belong to user "${userId}"`);
        return res.status(403).json({ success: false, message: 'Transaction does not belong to this account' });
      }

      const rawPlan  = data.data?.metadata?.planType || 'pro';
      const planType = normalizePlan(rawPlan);

      // Validate against allowlist — prevents escalation via metadata tampering.
      const ALLOWED_PLANS = ['pro', 'studio'];
      const safePlan      = ALLOWED_PLANS.includes(planType) ? planType : 'pro';

      const subscriptionId = data.data?.id?.toString() || reference;
      const email          = data.data?.customer?.email || req.user.email || null;
      const fullName       = data.data?.metadata?.fullName || data.data?.customer?.first_name || null;
      const amountPaid     = (data.data?.amount || 0) / 100; // convert back from subunits
      const currency       = data.data?.currency || 'NGN';

      try {
        await db.collection('users').doc(userId).update({
          plan:                   safePlan,
          subscriptionId,
          subscriptionStatus:     'active',
          subscriptionStartDate:  new Date(),
          lastPaymentDate:        new Date(),
          lastPaymentAmount:      amountPaid,
          lastPaymentCurrency:    currency,
          email,
          displayName:            fullName,
          planUpdatedAt:          new Date(),
          paymentGateway:         'paystack',
          paystackReference:      reference,
        });
        console.log(`✅ Plan updated to "${safePlan}" for user ${userId} (ref: ${reference})`);
      } catch (dbError) {
        console.error('Firestore update failed during payment verification:', dbError);
        return res.status(500).json({ success: false, message: 'Failed to update subscription record' });
      }

      // Send confirmation email (non-blocking)
      sendPaymentConfirmationEmail(email, fullName, safePlan, amountPaid)
        .catch(err => console.warn('Verify: confirmation email failed:', err.message));

      return res.json({
        success:     true,
        message:     'Payment verified',
        plan:        safePlan,
        transaction: data.data,
      });

    } catch (error) {
      console.error('Payment verification error:', error);
      return res.status(500).json({ success: false, message: 'Verification failed' });
    }
  });

  // ─── POST /api/subscription/cancel ───────────────────────────────────────
  /**
   * Downgrades the user to free plan.
   * Paystack does not have a subscription cancel API for one-time charges,
   * so we simply update Firestore.
   *
   * Body: { subscriptionId } (optional — kept for API compatibility)
   */
  router.post('/api/subscription/cancel', verifyFirebaseToken, async (req, res) => {
    try {
      const userId = req.user?.uid;

      if (!userId) {
        return res.status(401).json({ success: false, message: 'User not authenticated' });
      }

      if (!db) {
        return res.status(503).json({ success: false, message: 'Database not configured' });
      }

      try {
        await db.collection('users').doc(userId).update({
          subscriptionStatus:      'cancelled',
          subscriptionCancelledAt: new Date(),
          plan:                    'free',
          planUpdatedAt:           new Date(),
        });
        console.log(`✅ Subscription cancelled for user ${userId}`);
      } catch (dbError) {
        console.error('Firestore update failed while cancelling subscription:', dbError);
        return res.status(500).json({ success: false, message: 'Failed to update database' });
      }

      return res.json({ success: true, message: 'Subscription cancelled successfully' });

    } catch (error) {
      console.error('Subscription cancellation error:', error);
      return res.status(500).json({ success: false, message: 'Cancellation failed' });
    }
  });

  return router;
}

module.exports = createPaymentRouter;
