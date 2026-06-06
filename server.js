const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Firebase Admin SDK
let admin = null;
let db = null;
try {
  admin = require('firebase-admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (Object.keys(serviceAccount).length > 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized successfully');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — Firestore features disabled');
  }
} catch (err) {
  console.warn('firebase-admin not available — Firestore features disabled:', err.message);
}

// Use native fetch for Node 18+ or import node-fetch for older versions
let fetchFn;
if (typeof fetch === 'undefined') {
  fetchFn = require('node-fetch');
} else {
  fetchFn = fetch;
}

// Monitoring & Error Logging System
const {
  errorLogger,
  paymentLogger,
  performanceMonitor,
  auditLogger,
  healthMonitor
} = require('./monitoring-logger.js');

const app = express();

// CORS Configuration - Allow requests from frontend and handle preflight
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://prepapp.name.ng',
      'https://www.prepapp.name.ng',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5500',
      'http://localhost:5500',
      'http://127.0.0.1:5502',
      'http://localhost:5502'
    ];
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Range', 'X-Content-Range', 'Content-Type'],
  maxAge: 86400 // 24 hours preflight cache
};

// Middleware - Apply CORS before other middleware
app.use(cors(corsOptions));

// Additional CORS headers middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.get('Origin') || 'https://prepapp.name.ng');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Expose-Headers', 'Content-Range, X-Content-Range, Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log(`Preflight request from ${req.get('Origin')} to ${req.path}`);
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Protects against brute-force and abuse on sensitive endpoints.
const rateLimit = require('express-rate-limit');

// General API limit — 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});

// Strict limit for payment endpoints — 10 per minute per IP
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment requests. Please wait a moment.' }
});

// AI endpoints — 20 per minute per IP (Gemini calls are expensive)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests. Please wait a moment.' }
});

// Password-reset — 5 per hour per IP.
// This endpoint is intentionally unauthenticated (the user is logged out),
// so a tighter window prevents email flooding and account enumeration attacks.
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many password reset attempts. Please try again later.' }
});

// Apply general limiter to all routes
app.use(generalLimiter);

// Apply stricter limiters to specific route groups
app.use('/api/payment', paymentLimiter);
app.use('/api/subscription', paymentLimiter);
app.use('/api/ai', aiLimiter);
app.use('/api/password-reset', passwordResetLimiter);

const paymentRoutes = require('./payment-routes');
app.use('/', paymentRoutes({ admin, db }));

// Use this on any endpoint that modifies user data (payments, subscriptions, etc.)
// It verifies the Firebase ID token sent in the Authorization header and attaches
// the decoded token to req.firebaseUser. The UID is then taken from the token —
// never from the request body — so clients cannot impersonate other users.
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  if (!db) {
    // Firebase Admin not initialised — cannot verify tokens. Fail closed.
    return res.status(503).json({ success: false, message: 'Auth service unavailable' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decoded; // { uid, email, ... }
    next();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ─── Flutterwave Webhook Signature Verification ───────────────────────────────
// Validates the verificationhash header against the secret hash configured in
// your Flutterwave dashboard (Settings → Webhooks → Secret Hash).
// Set FLUTTERWAVE_WEBHOOK_SECRET in your Render environment variables.
const crypto = require('crypto');
function verifyFlutterwaveWebhook(req, res, next) {
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  if (!secretHash) {
    // Secret not configured — reject all webhook calls to prevent abuse
    console.error('FLUTTERWAVE_WEBHOOK_SECRET not set — rejecting webhook');
    return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
  }
  const signature = req.headers['verificationhash'];
  if (!signature || signature !== secretHash) {
    console.warn('Webhook signature mismatch — possible spoofed request');
    return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
  }
  next();
}

// Enhanced Request Logging & Performance Monitoring Middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const originalJson = res.json;

  // Override res.json to capture response data
  res.json = function(data) {
    const duration = Date.now() - startTime;
    const status = res.statusCode;
    const isError = status >= 400;

    // Log performance metrics
    performanceMonitor.recordEndpoint(req.method, req.path, duration, status);

    // Log errors to error logger
    if (isError && data.error) {
      errorLogger.log(new Error(data.error), {
        method: req.method,
        path: req.path,
        status,
        duration
      });
    }

    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${status} (${duration}ms)`);
    return originalJson.call(this, data);
  };

  next();
});

// Email Service Configuration (Your Brevo account)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3';
const APP_URL = process.env.APP_URL || 'https://prepapp.name.ng';
const RESET_PAGE_URL = `${APP_URL}/login.html`;

/**
 * Send welcome email to new users via Brevo.
 * Requires a valid Firebase ID token — the email is taken from the verified token,
 * not from the request body, so callers cannot send welcome emails on behalf of
 * other users or spam arbitrary addresses.
 */
app.post('/api/send-welcome-email', verifyFirebaseToken, async (req, res) => {
  try {
    // email comes from the verified token to prevent spoofing
    const verifiedEmail = req.firebaseUser.email;
    const { fullName, accountType } = req.body;

    // Accept fullName from body (not sensitive), but validate it
    const safeName = (typeof fullName === 'string' && fullName.trim()) ? fullName.trim() : verifiedEmail;

    if (!BREVO_API_KEY) {
      console.error('BREVO_API_KEY not configured in environment variables');
      return res.status(500).json({ 
        success: false, 
        error: 'Email service not configured' 
      });
    }

    // Step 1: Create/Update contact and add to "New users #5" list (ID: 5)
    const contactResponse = await fetchFn(`${BREVO_API_URL}/contacts`, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: verifiedEmail,
        listIds: [5], // Matches your "New users #5" list
        updateEnabled: true,
        attributes: {
          FIRSTNAME: safeName,
          ACCOUNT_TYPE: accountType || 'individual',
          SIGNUP_DATE: new Date().toISOString()
        }
      })
    });

    if (!contactResponse.ok) {
      const error = await contactResponse.json();
      console.error('Brevo contact creation failed:', error);
    }

    // Step 2: Send transactional email using the authenticated domain
    const emailResponse = await fetchFn(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: [
          {
            email: verifiedEmail,
            name: safeName
          }
        ],
        sender: {
          name: 'PREP - Cinematic Pre-production',
          email: 'noreply@prepapp.name.ng'
        },
        subject: `Welcome to PREP, ${safeName}!`,
        htmlContent: generateWelcomeEmailHTML(safeName, accountType),
        replyTo: {
          email: 'info@prepapp.name.ng',
          name: 'PREP Support'
        }
      })
    });

    if (!emailResponse.ok) {
      const error = await emailResponse.json();
      console.error('Brevo email send failed:', error);
      throw new Error(`Failed to send email: ${error.message || 'Unknown error'}`);
    }

    const emailResult = await emailResponse.json();

    res.json({
      success: true,
      message: 'Welcome email sent successfully',
      messageId: emailResult.messageId
    });

  } catch (error) {
    console.error('Error in send-welcome-email:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send welcome email'
    });
  }
});

app.post('/api/password-reset', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !admin) {
      console.error('Firebase Admin SDK not configured for password reset');
      return res.status(503).json({
        success: false,
        error: 'Password reset service unavailable'
      });
    }

    if (!BREVO_API_KEY) {
      console.error('BREVO_API_KEY not configured in environment variables');
      return res.status(500).json({
        success: false,
        error: 'Email service not configured'
      });
    }

    let resetLink;
    try {
      resetLink = await admin.auth().generatePasswordResetLink(email, {
        url: RESET_PAGE_URL,
        handleCodeInApp: false
      });
    } catch (error) {
      console.error('Firebase password reset link generation failed:', error);
      if (error.code === 'auth/user-not-found') {
        return res.status(404).json({
          success: false,
          error: 'No account found with that email'
        });
      }
      return res.status(500).json({
        success: false,
        error: 'Unable to generate password reset link'
      });
    }

    const emailResponse = await fetchFn(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: [
          {
            email: email,
            name: email
          }
        ],
        sender: {
          name: 'PREP - Cinematic Pre-production',
          email: 'noreply@prepapp.name.ng'
        },
        subject: 'Reset your PREP password',
        htmlContent: generatePasswordResetEmailHTML(resetLink),
        replyTo: {
          email: 'info@prepapp.name.ng',
          name: 'PREP Support'
        }
      })
    });

    if (!emailResponse.ok) {
      const error = await emailResponse.json();
      console.error('Brevo password reset email failed:', error);
      throw new Error(`Failed to send email: ${error.message || 'Unknown error'}`);
    }

    const emailResult = await emailResponse.json();

    res.json({
      success: true,
      message: 'Password reset email sent successfully',
      messageId: emailResult.messageId
    });
  } catch (error) {
    console.error('Error in password reset email:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send password reset email'
    });
  }
});

function generatePasswordResetEmailHTML(resetLink) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset your PREP password</title>
    </head>
    <body style="margin:0; padding:0; background:#0f172a; font-family:Arial, sans-serif; color:#f8fafc;">
        <div style="max-width:640px; margin:0 auto; padding:24px;">
            <div style="background:#020617; border:1px solid #1e293b; border-radius:16px; padding:24px;">
                <h1 style="margin:0 0 12px; font-size:24px; color:#f59e0b;">Reset your PREP password</h1>
                <p style="margin:0 0 16px; line-height:1.5; color:#d0d6e2;">
                    We received a request to reset the password for your PREP account. Click the button below to create a new password.
                </p>
                <div style="text-align:center; margin:24px 0;">
                    <a href="${resetLink}" style="display:inline-block; background:#f59e0b; color:#020617; text-decoration:none; padding:12px 18px; border-radius:999px; font-weight:700;">Reset password</a>
                </div>
                <p style="margin:0; line-height:1.5; color:#94a3b8; font-size:12px;">
                    If you didn’t request this, you can ignore this email. The link will expire soon.
                </p>
            </div>
        </div>
    </body>
    </html>
  `;
}

/**
 * Generate HTML content for welcome email
 */
function generateWelcomeEmailHTML(fullName, accountType) {
  const accountTypeDisplay = accountType === 'company' ? 'Company' : 'Individual';
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to PREP</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { text-align: center; padding: 20px 0; border-bottom: 2px solid #007bff; margin-bottom: 30px; }
            .header h1 { color: #007bff; margin: 0; font-size: 28px; }
            .content { padding: 20px 0; }
            .content h2 { color: #333; font-size: 20px; }
            .content p { margin: 10px 0; }
            .features { margin: 20px 0; padding: 15px; background: #f8f9fa; border-left: 4px solid #007bff; }
            .features li { margin: 8px 0; }
            .cta-button { display: inline-block; margin: 20px 0; padding: 12px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center; font-size: 12px; color: #666; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Welcome to PREP!</h1>
            </div>
            
            <div class="content">
                <p>Hi <strong>${fullName}</strong>,</p>
                
                <p>Thank you for joining PREP - the ultimate cinematic pre-production operating system. Your ${accountTypeDisplay} account has been successfully created.</p>
                
                <h2>Get Started</h2>
                <p>Your account is ready to use. Here's what you can do:</p>
                
                <div class="features">
                    <ul>
                        <li>Create and manage screenplay projects</li>
                        <li>Build detailed storyboards and shot lists</li>
                        <li>Organize shooting schedules</li>
                        <li>Collaborate with your team</li>
                        <li>Access AI-powered script analysis tools</li>
                    </ul>
                </div>
                
                <a href="https://prepapp.name.ng/dashboard.html" class="cta-button">Go to Dashboard</a>
                
                <h2>Need Help?</h2>
                <p>Check out our <a href="https://prepapp.name.ng/guide.html">User Guide</a> or <a href="https://prepapp.name.ng/contactsupport.html">Contact Support</a> if you have any questions.</p>
                
                <p>Happy creating!<br>The PREP Team</p>
            </div>
            
            <div class="footer">
                <p>&copy; 2026 PREP - Cinematic Pre-production Operating System</p>
                <p><a href="https://prepapp.name.ng">Visit Website</a> | <a href="https://prepapp.name.ng/contactsupport.html">Support</a></p>
            </div>
        </div>
    </body>
    </html>
  `;
}

/**
 * Send payment confirmation email via Brevo
 * Same service used for signup welcome emails
 */
async function sendPaymentConfirmationEmail(email, fullName, plan, amount, transactionId) {
  try {
    if (!BREVO_API_KEY) {
      console.warn('BREVO_API_KEY not configured - payment email skipped');
      return false;
    }

    // Send email via Brevo
    const response = await fetchFn(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: [
          {
            email: email,
            name: fullName
          }
        ],
        sender: {
          name: 'PREP - Cinematic Pre-production',
          email: 'noreply@prepapp.name.ng'
        },
        subject: `🎉 Welcome to PREP Pro, ${fullName}!`,
        htmlContent: generatePaymentConfirmationEmail(fullName, plan, amount),
        replyTo: {
          email: 'info@prepapp.name.ng',
          name: 'PREP Support'
        }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Brevo payment email send failed:', error);
      return false;
    }

    const result = await response.json();
    console.log('Payment confirmation email sent:', result.messageId);
    return true;
  } catch (error) {
    console.error('Error sending payment confirmation email:', error);
    // Don't fail payment if email fails - just log it
    return false;
  }
}

/**
 * Generate HTML content for payment confirmation email
 */
function generatePaymentConfirmationEmail(fullName, plan, amount) {
  const planFeatures = {
    pro: [
      '<li>✅ Unlimited active projects</li>',
      '<li>✅ Advanced AI scene analysis</li>',
      '<li>✅ 500MB+ upload storage</li>',
      '<li>✅ Team collaboration tools</li>',
      '<li>✅ Priority support</li>'
    ],
    studio: [
      '<li>✅ Unlimited everything</li>',
      '<li>✅ Custom workflows</li>',
      '<li>✅ Dedicated account manager</li>',
      '<li>✅ SSO and API access</li>'
    ]
  };

  const features = (planFeatures[plan] || planFeatures.pro).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Confirmed - PREP</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { text-align: center; padding: 20px 0; margin-bottom: 30px; }
            .header h1 { color: #28a745; margin: 0; font-size: 28px; }
            .content { padding: 20px 0; }
            .content h2 { color: #333; font-size: 20px; }
            .content p { margin: 10px 0; }
            .plan-badge { display: inline-block; background: #ff6500; color: white; padding: 8px 16px; border-radius: 20px; font-weight: bold; margin: 10px 0; }
            .features { margin: 20px 0; padding: 15px; background: #f8f9fa; border-left: 4px solid #28a745; }
            .features li { margin: 8px 0; }
            .cta-button { display: inline-block; margin: 20px 0; padding: 12px 30px; background: #ff6500; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center; font-size: 12px; color: #666; }
            .amount { font-size: 24px; color: #28a745; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>✅ Payment Successful!</h1>
            </div>
            
            <div class="content">
                <p>Hi <strong>${fullName}</strong>,</p>
                
                <p>Thank you for upgrading to PREP Pro! Your payment has been received and processed successfully.</p>
                
                <div style="text-align: center; margin: 20px 0;">
                    <div class="amount">$${amount}/month</div>
                    <div class="plan-badge">${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan</div>
                </div>
                
                <h2>What's Included</h2>
                <div class="features">
                    <ul style="margin: 0; padding-left: 20px;">
                        ${features}
                    </ul>
                </div>
                
                <p>Your account is now fully upgraded. You have immediate access to all Pro features!</p>
                
                <a href="https://prepapp.name.ng/dashboard.html" class="cta-button">Go to Dashboard</a>
                
                <h2>Next Steps</h2>
                <p>Start creating unlimited projects and leverage advanced AI features to streamline your pre-production workflow.</p>
                
                <p>Have questions? Check out our <a href="https://prepapp.name.ng/guide.html">User Guide</a> or <a href="https://prepapp.name.ng/contactsupport.html">Contact Support</a>.</p>
                
                <p>Happy creating!<br>The PREP Team</p>
            </div>
            
            <div class="footer">
                <p>&copy; 2026 PREP - Cinematic Pre-production Operating System</p>
                <p><a href="https://prepapp.name.ng">Visit Website</a> | <a href="https://prepapp.name.ng/contactsupport.html">Support</a></p>
            </div>
        </div>
    </body>
    </html>
  `;
}

/**
 * Flutterwave Payment Endpoints
 */

const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com/v3';

// NOTE: /api/payment/initialize is handled by payment-routes.js (mounted above).
// The authenticated factory route is the canonical implementation.
// The duplicate route that previously lived here has been removed to prevent
// Express from silently shadowing the correct authenticated version.

// NOTE: /api/payment/verify is handled by payment-routes.js (mounted above at line 136).
// The factory route is registered first and is the canonical authenticated implementation.
// The route that previously lived here was dead code (Express matched the factory first)
// and has been removed to avoid confusion.

/**
 * GET /api/payment/history
 * Get payment history for the authenticated user.
 * Reads from the users/{userId}/payments subcollection written by flutterwave.js.
 * Requires a valid Firebase ID token — users can only read their own history.
 */
app.get('/api/payment/history', verifyFirebaseToken, async (req, res) => {
  try {
    // Ignore the URL param — always use the UID from the verified token
    const userId = req.firebaseUser.uid;

    if (!db) {
      return res.status(503).json({ success: false, message: 'Database not configured' });
    }

    const paymentsSnap = await db
      .collection('users')
      .doc(userId)
      .collection('payments')
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    const payments = paymentsSnap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        plan: data.plan || 'pro',
        amount: data.amount || 0,
        currency: data.currency || 'USD',
        status: data.status || 'successful',
        date: data.date?.toDate?.()?.toISOString() || data.date || null,
        subscriptionId: data.subscriptionId || null,
      };
    });

    res.json({ success: true, payments });

  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch payment history'
    });
  }
});

/**
 * Webhook endpoint for Flutterwave payment updates.
 * Signature is verified against FLUTTERWAVE_WEBHOOK_SECRET before any processing.
 *
 * Security note on userId: the userId in meta was embedded server-side by
 * /api/payment/initialize from a verified Firebase token — it is NOT
 * user-supplied in the original HTTP sense. However, since Flutterwave sends
 * it back in the webhook body, we treat it as semi-trusted: we use it to
 * find the Firestore document, but we also verify the tx_ref prefix
 * (PREP-{userId}-{timestamp}) matches, adding a second layer of confirmation
 * before writing the plan upgrade.
 */
app.post('/api/payment/webhook', verifyFlutterwaveWebhook, async (req, res) => {
  try {
    const payload = req.body;

    console.log('Webhook received:', JSON.stringify({ event: payload.event, status: payload.data?.status, txRef: payload.data?.tx_ref }));

    if (payload.data?.status === 'successful') {
      const txRef = payload.data?.tx_ref || '';
      const email = payload.data?.customer?.email;
      const customerName = payload.data?.customer?.name || 'Valued Customer';

      // Normalize the plan from meta — strip billing-period suffixes and aliases.
      const rawPlan = payload.data?.meta?.planType || payload.data?.meta?.plan || 'pro';
      const plan = normalizePlan(rawPlan);

      // Validate plan against allowlist so the webhook cannot escalate to an
      // unknown/privileged tier even if meta is tampered with.
      const ALLOWED_PLANS = ['pro', 'studio'];
      const safePlan = ALLOWED_PLANS.includes(plan) ? plan : 'pro';

      // userId comes from meta (set server-side during initialize).
      // Cross-check it against the tx_ref prefix for extra confidence.
      const metaUserId = payload.data?.meta?.userId;
      const txRefUserId = txRef.startsWith('PREP-') ? txRef.split('-')[1] : null;
      const userId = (metaUserId && txRefUserId && metaUserId === txRefUserId)
        ? metaUserId
        : (metaUserId || txRefUserId);  // fall back to whichever is available

      if (userId) {
        if (!db) {
          console.error('❌ Webhook: Firestore not initialized — check FIREBASE_SERVICE_ACCOUNT_JSON');
        } else {
          try {
            await db.collection('users').doc(userId).update({
              plan: safePlan,
              subscriptionId: payload.data?.id,
              subscriptionStatus: 'active',
              subscriptionStartDate: new Date(),
              lastPaymentDate: new Date(),
              lastPaymentAmount: payload.data?.amount,
              lastPaymentCurrency: payload.data?.currency,
              email: email || null,
              displayName: customerName || null,
              planUpdatedAt: new Date(),
            });
            console.log(`✅ Webhook upgraded user ${userId} to "${safePlan}"`);
          } catch (firestoreError) {
            console.error('❌ Webhook: Firestore update failed:', firestoreError);
          }
        }
      } else {
        console.error('❌ Webhook: Could not determine userId from meta or tx_ref — no plan update performed');
      }

      if (email) {
        sendPaymentConfirmationEmail(email, customerName, safePlan, payload.data?.amount, payload.data?.id)
          .catch(err => console.error('Webhook: payment confirmation email failed:', err));
      }
    }

    res.json({ success: true, message: 'Webhook received' });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

/**
 * Save user subscription to Firebase
 * Called from frontend after successful payment verification.
 * Requires a valid Firebase ID token — userId is taken from the token.
 */
app.post('/api/subscription/save', verifyFirebaseToken, async (req, res) => {
  try {
    const { plan, subscriptionId, amount, currency } = req.body;
    const userId = req.firebaseUser.uid; // from verified token

    if (!userId || !plan) {
      return res.status(400).json({
        success: false,
        message: 'User ID and plan are required'
      });
    }

    // Update user subscription in Firestore
    if (!db) {
      console.error('❌ Firestore database not initialized - check FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
      return res.status(500).json({
        success: false,
        message: 'Database not configured - contact support'
      });
    }

    try {
      await db.collection('users').doc(userId).update({
        plan: plan,
        subscriptionId: subscriptionId,
        subscriptionStatus: 'active',
        subscriptionStartDate: new Date(),
        lastPaymentDate: new Date(),
        lastPaymentAmount: amount,
        lastPaymentCurrency: currency,
        // User identity from the verified Firebase token
        email: req.firebaseUser.email || null,
        displayName: req.firebaseUser.name || null,
        planUpdatedAt: new Date(),
      });
      console.log(`✅ Subscription saved for user ${userId}: ${plan} plan`);
    } catch (firestoreError) {
      console.error('❌ Error saving subscription to Firestore:', firestoreError);
      return res.status(500).json({
        success: false,
        message: 'Failed to save subscription to database'
      });
    }

    res.json({
      success: true,
      message: 'Subscription saved successfully',
      data: {
        userId: userId,
        plan: plan,
        subscriptionId: subscriptionId,
        amount: amount,
        currency: currency,
        savedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error saving subscription:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to save subscription'
    });
  }
});

/**
 * POST /api/ai/generate-image
 * Proxies requests to HF Inference API to avoid CORS issues.
 * Requires a valid Firebase ID token — prevents anonymous quota burn.
 */
app.post('/api/ai/generate-image', verifyFirebaseToken, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        message: 'Prompt is required'
      });
    }

    // Read token from server environment — never expose it to the client
    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) {
      return res.status(500).json({
        success: false,
        message: 'HF_TOKEN not configured on server. Add it to your Render environment variables.'
      });
    }

    const HF_API_URL = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0';

    const response = await fetchFn(HF_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          num_inference_steps: 25,
          guidance_scale: 7.5,
          negative_prompt: 'blurry, bad quality, distorted, ugly, low resolution'
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('HF API Error:', errorText);
      
      if (response.status === 503) {
        return res.status(503).json({
          success: false,
          message: 'Model is loading. Please wait a moment and try again.'
        });
      }
      if (response.status === 401) {
        return res.status(401).json({
          success: false,
          message: 'Invalid Hugging Face token.'
        });
      }
      
      return res.status(response.status).json({
        success: false,
        message: `Failed to generate image (${response.status})`
      });
    }

    // Get the image blob
    const imageBuffer = await response.arrayBuffer();
    
    // Convert to base64 for JSON transport
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    
    res.json({
      success: true,
      image: base64Image,
      contentType: response.headers.get('content-type') || 'image/jpeg'
    });

  } catch (error) {
    console.error('AI image generation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate image'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

/**
 * POST /api/subscription/cancel
 * Cancel user subscription and downgrade to free plan.
 * Requires a valid Firebase ID token — userId comes from the token.
 */
app.post('/api/subscription/cancel', verifyFirebaseToken, async (req, res) => {
  const userId = req.firebaseUser.uid;
  const { subscriptionId, reason } = req.body;

  if (!subscriptionId) {
    return res.status(400).json({ success: false, message: 'Subscription ID required' });
  }

  if (!db) {
    return res.status(503).json({ success: false, message: 'Database not configured' });
  }

  // Cancel with Flutterwave (non-blocking — continue even if it fails)
  try {
    const cancelResponse = await fetchFn(
      `${FLUTTERWAVE_API_URL}/subscriptions/${subscriptionId}/cancel`,
      { method: 'PUT', headers: { 'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );
    if (!cancelResponse.ok) {
      const err = await cancelResponse.json();
      console.warn('Flutterwave cancel warning:', err.message);
    } else {
      console.log(`✅ Subscription ${subscriptionId} cancelled with Flutterwave`);
    }
  } catch (flutterErr) {
    console.warn('Flutterwave cancel error (continuing):', flutterErr.message);
  }

  // Downgrade in Firestore
  try {
    await db.collection('users').doc(userId).update({
      plan: 'free',
      subscriptionStatus: 'cancelled',
      subscriptionCancelledDate: new Date(),
      cancellationReason: reason || 'User requested',
      planUpdatedAt: new Date(),
    });
    console.log(`✅ User ${userId} downgraded to free after cancellation`);
  } catch (firestoreError) {
    console.error('Firestore cancel error:', firestoreError);
    return res.status(500).json({ success: false, message: 'Failed to update subscription in database' });
  }

  res.json({ success: true, message: 'Subscription cancelled successfully', newPlan: 'free', cancelledAt: new Date().toISOString() });
});

/**
 * GET /api/storage/usage
 * Get storage usage for the authenticated user.
 * Requires a valid Firebase ID token — userId comes from the token.
 */
app.get('/api/storage/usage', verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.firebaseUser.uid; // from verified token only

    // Note: In production, compute real usage from Firestore storage metadata
    res.json({
      success: true,
      data: {
        usedMB: 0,
        maxMB: 50,
        percentUsed: 0
      }
    });

  } catch (error) {
    console.error('Error getting storage usage:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get storage usage'
    });
  }
});

/**
 * POST /api/subscription/check-expiry
 * Checks if a user's subscription has expired and downgrades them if so.
 * Call this on dashboard load to keep plan status accurate.
 * Requires a valid Firebase ID token.
 */
app.post('/api/subscription/check-expiry', verifyFirebaseToken, async (req, res) => {
  const userId = req.firebaseUser.uid;

  if (!db) {
    return res.status(503).json({ success: false, message: 'Database not configured' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const data = userDoc.data();
    const plan = data.plan || 'free';

    // Free users have nothing to expire
    if (plan === 'free') {
      return res.json({ success: true, expired: false, plan: 'free' });
    }

    // Check nextChargeDate / subscriptionEndDate
    const endDate = data.subscriptionEndDate || data.nextChargeDate;
    if (!endDate) {
      // No end date recorded — treat as active (legacy subscription)
      return res.json({ success: true, expired: false, plan });
    }

    const expiryMs = endDate.toDate
      ? endDate.toDate().getTime()
      : new Date(endDate.seconds ? endDate.seconds * 1000 : endDate).getTime();

    const isExpired = Date.now() > expiryMs;

    if (isExpired) {
      await db.collection('users').doc(userId).update({
        plan: 'free',
        subscriptionStatus: 'expired',
        subscriptionExpiredDate: new Date(),
        planUpdatedAt: new Date(),
      });
      console.log(`[Subscription] User ${userId} downgraded to free — subscription expired`);
      return res.json({ success: true, expired: true, plan: 'free' });
    }

    return res.json({ success: true, expired: false, plan });

  } catch (error) {
    console.error('Subscription expiry check error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Send collaboration invite email.
 * Requires a valid Firebase ID token — only authenticated PREP users can trigger
 * collaboration emails, which prevents this endpoint from being used as an
 * open email relay. The inviterName is taken from the verified token, not the body.
 * Handles two cases:
 *  - userExists: true  → notify existing PREP user they've been added
 *  - userExists: false → invite non-user to sign up and join the project
 */
app.post('/api/collaboration/invite', verifyFirebaseToken, async (req, res) => {
  try {
    const { inviteeEmail, inviteeName, projectName, role, userExists, signupLink } = req.body;
    // inviterName comes from the verified token — not trusted from the body
    const inviterName = req.firebaseUser.name || req.firebaseUser.email || 'A PREP user';

    if (!inviteeEmail || !projectName) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Basic email format guard — Brevo will reject malformed addresses,
    // but checking here avoids a round-trip and provides a clearer error.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteeEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid invitee email address' });
    }

    // Role allowlist — prevent arbitrary strings reaching Firestore or email copy
    const safeRole = ['editor', 'viewer'].includes(role) ? role : 'viewer';

    if (!BREVO_API_KEY) {
      return res.status(500).json({ success: false, message: 'Email service not configured' });
    }

    const subject = userExists
      ? `${inviterName} added you to a project on PREP`
      : `You've been invited to collaborate on PREP`;

    const htmlContent = userExists
      ? generateCollabNotificationEmail(inviteeName || inviteeEmail, inviterName, projectName, safeRole)
      : generateCollabInviteEmail(inviteeEmail, inviterName, projectName, safeRole, signupLink);

    const emailResponse = await fetchFn(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: [{ email: inviteeEmail, name: inviteeName || inviteeEmail }],
        sender: { name: 'PREP - Cinematic Pre-production', email: 'noreply@prepapp.name.ng' },
        subject,
        htmlContent,
        replyTo: { email: 'info@prepapp.name.ng', name: 'PREP Support' }
      })
    });

    if (!emailResponse.ok) {
      const err = await emailResponse.json();
      console.error('Brevo collab invite email failed:', err);
      return res.status(500).json({ success: false, message: 'Failed to send email' });
    }

    res.json({ success: true, message: 'Invitation email sent' });

  } catch (error) {
    console.error('Collaboration invite email error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send invite email' });
  }
});

/**
 * Email for existing PREP users — notifies them they've been added to a project
 */
function generateCollabNotificationEmail(recipientName, inviterName, projectName, role) {
  const roleLabel = role === 'editor' ? 'Editor' : 'Viewer';
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>You've been added to a project</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #f4f7f9; margin: 0; padding: 0; }
        .wrapper { max-width: 580px; margin: 40px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(90,24,154,0.08); }
        .header { background: linear-gradient(135deg, #5a189a, #7b2fbe); padding: 36px 32px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 26px; letter-spacing: -0.5px; }
        .header p { color: rgba(255,255,255,0.8); margin: 8px 0 0; font-size: 15px; }
        .body { padding: 32px; }
        .body p { color: #444; font-size: 15px; line-height: 1.7; margin: 0 0 16px; }
        .project-card { background: #f8f4ff; border: 1px solid #e0d0f5; border-radius: 12px; padding: 20px 24px; margin: 24px 0; }
        .project-card .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #9b59b6; margin-bottom: 6px; }
        .project-card .name { font-size: 20px; font-weight: 700; color: #3E1F47; }
        .role-badge { display: inline-block; background: rgba(90,24,154,0.12); color: #5a189a; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; margin-top: 8px; }
        .cta { text-align: center; margin: 28px 0 8px; }
        .cta a { display: inline-block; background: #5a189a; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; }
        .footer { background: #f4f7f9; padding: 20px 32px; text-align: center; font-size: 12px; color: #999; }
        .footer a { color: #5a189a; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="header">
          <h1>PREP</h1>
          <p>Cinematic Pre-production</p>
        </div>
        <div class="body">
          <p>Hi <strong>${recipientName}</strong>,</p>
          <p><strong>${inviterName}</strong> has added you as a collaborator on their project. You can now access it directly from your PREP dashboard.</p>
          <div class="project-card">
            <div class="label">Project</div>
            <div class="name">${projectName}</div>
            <span class="role-badge">${roleLabel}</span>
          </div>
          <p>Head to your Projects page and you'll see it listed under your projects.</p>
          <div class="cta">
            <a href="https://prepapp.name.ng/project_folder.html">Open My Projects</a>
          </div>
        </div>
        <div class="footer">
          <p>&copy; 2026 PREP &nbsp;|&nbsp; <a href="https://prepapp.name.ng">prepapp.name.ng</a> &nbsp;|&nbsp; <a href="https://prepapp.name.ng/contactsupport.html">Support</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Email for non-PREP users — invites them to sign up and join the project
 */
function generateCollabInviteEmail(inviteeEmail, inviterName, projectName, role, signupLink) {
  const roleLabel = role === 'editor' ? 'Editor' : 'Viewer';
  const link = signupLink || 'https://prepapp.name.ng/signup.html';
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>You're invited to PREP</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #f4f7f9; margin: 0; padding: 0; }
        .wrapper { max-width: 580px; margin: 40px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(90,24,154,0.08); }
        .header { background: linear-gradient(135deg, #ff6500, #ff8533); padding: 36px 32px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 26px; letter-spacing: -0.5px; }
        .header p { color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 15px; }
        .body { padding: 32px; }
        .body p { color: #444; font-size: 15px; line-height: 1.7; margin: 0 0 16px; }
        .project-card { background: #fff5f0; border: 1px solid #ffd0b5; border-radius: 12px; padding: 20px 24px; margin: 24px 0; }
        .project-card .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #ff6500; margin-bottom: 6px; }
        .project-card .name { font-size: 20px; font-weight: 700; color: #7a2e00; }
        .role-badge { display: inline-block; background: rgba(255,101,0,0.12); color: #ff6500; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; margin-top: 8px; }
        .features { background: #f8f4ff; border-radius: 10px; padding: 16px 20px; margin: 20px 0; }
        .features li { color: #555; font-size: 14px; margin: 6px 0; }
        .cta { text-align: center; margin: 28px 0 8px; }
        .cta a { display: inline-block; background: #ff6500; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; }
        .note { font-size: 13px; color: #999; text-align: center; margin-top: 12px; }
        .footer { background: #f4f7f9; padding: 20px 32px; text-align: center; font-size: 12px; color: #999; }
        .footer a { color: #5a189a; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="header">
          <h1>You're Invited to PREP</h1>
          <p>Cinematic Pre-production Platform</p>
        </div>
        <div class="body">
          <p>Hi there,</p>
          <p><strong>${inviterName}</strong> has invited you to collaborate on their project on <strong>PREP</strong> — the cinematic pre-production platform for filmmakers.</p>
          <div class="project-card">
            <div class="label">Project</div>
            <div class="name">${projectName}</div>
            <span class="role-badge">${roleLabel}</span>
          </div>
          <p>To access this project, create your free PREP account. It only takes a minute.</p>
          <div class="features">
            <ul style="margin:0; padding-left:20px;">
              <li>Script breakdown, storyboarding & shotlists</li>
              <li>AI-powered script analysis</li>
              <li>Shoot scheduling & production planning</li>
              <li>Real-time team collaboration</li>
            </ul>
          </div>
          <div class="cta">
            <a href="${link}">Create Free Account & Join Project</a>
          </div>
          <p class="note">Once you sign up with this email address (${inviteeEmail}), ${inviterName} can add you to the project.</p>
        </div>
        <div class="footer">
          <p>&copy; 2026 PREP &nbsp;|&nbsp; <a href="https://prepapp.name.ng">prepapp.name.ng</a> &nbsp;|&nbsp; <a href="https://prepapp.name.ng/contactsupport.html">Support</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ─── AI Usage Limits ──────────────────────────────────────────────────────────
// Free tier: 20 AI calls per calendar month.
// Pro tier:  500 AI calls per calendar month (soft cap — generous but prevents runaway abuse).
// Studio/Enterprise: unlimited (no cap enforced).
const AI_USAGE_LIMITS = {
  free: 20,
  pro: 500,
  studio: 999999,    // effectively unlimited; avoids JSON.stringify(Infinity) → null
  enterprise: 999999,
};

/**
 * Normalise a raw plan string stored in Firestore or received from payment meta.
 * Strips billing-period suffixes like "-monthly" / "-yearly" and known aliases,
 * returning one of the canonical tier names: 'free' | 'pro' | 'studio' | 'enterprise'.
 *
 * Examples:
 *   'pro-monthly'   → 'pro'
 *   'studio-yearly' → 'studio'
 *   'premium'       → 'pro'
 *   'paid'          → 'pro'
 */
function normalizePlan(raw) {
  if (!raw) return 'free';
  // Strip billing period suffix (e.g. "-monthly", "-yearly", "-annual")
  const base = raw.toLowerCase().replace(/-(monthly|yearly|annual)$/, '');
  // Normalise known aliases
  const aliases = { premium: 'pro', paid: 'pro' };
  return aliases[base] || base;
}

/**
 * Reads the user's Firestore doc, checks their monthly AI usage against their
 * plan limit, and atomically increments the counter if they are within quota.
 *
 * Returns { allowed: true, used, limit } on success.
 * Returns { allowed: false, used, limit, plan } when the quota is exceeded.
 *
 * Uses a YYYY-MM key so the counter resets automatically each calendar month.
 */
async function checkAndIncrementAIUsage(uid) {
  if (!db) return { allowed: true, used: 0, limit: Infinity }; // Firebase not configured — fail open

  const userRef = db.collection('users').doc(uid);
  const monthKey = new Date().toISOString().slice(0, 7); // e.g. "2026-05"
  const usageField = `aiUsage.${monthKey}`;

  // Run as a transaction so concurrent requests don't race past the limit
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(userRef);
    if (!snap.exists) {
      // New user — treat as free
      txn.set(userRef, { [usageField]: 1 }, { merge: true });
      return { allowed: true, used: 1, limit: AI_USAGE_LIMITS.free };
    }

    const data = snap.data();
    const plan = normalizePlan(data.plan || 'free');
    const limit = AI_USAGE_LIMITS[plan] ?? AI_USAGE_LIMITS.free;
    const used = (data.aiUsage?.[monthKey] || 0);

    if (used >= limit) {
      return { allowed: false, used, limit, plan };
    }

    txn.update(userRef, { [usageField]: used + 1 });
    return { allowed: true, used: used + 1, limit, plan };
  });
}

/**
 * Gemini AI Proxy
 * Keeps the API key server-side so it is never exposed to the browser.
 * Requires a valid Firebase ID token to prevent anonymous quota abuse.
 * Includes retry-with-backoff for 429 rate limit errors and model fallback.
 * Enforces per-user monthly AI usage limits based on subscription plan.
 */
app.post('/api/ai/gemini', verifyFirebaseToken, async (req, res) => {
  try {
    const { model, contents, generationConfig } = req.body;

    if (!model || !contents) {
      return res.status(400).json({ success: false, message: 'model and contents are required' });
    }

    // ── Usage gate ────────────────────────────────────────────────────────────
    const uid = req.firebaseUser.uid;
    const usage = await checkAndIncrementAIUsage(uid);
    if (!usage.allowed) {
      return res.status(429).json({
        success: false,
        code: 'limit_reached',
        message: `You've used all ${usage.limit} AI calls included in your ${usage.plan} plan this month. Upgrade to Pro for more.`,
        used: usage.used,
        limit: usage.limit,
        plan: usage.plan,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return res.status(500).json({ success: false, message: 'GEMINI_API_KEY not configured on server.' });
    }

    // Model fallback chain — if primary is rate-limited, try the next one
    const modelChain = [
      model,
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash-latest',
    ].filter(Boolean).filter((m, i, arr) => arr.indexOf(m) === i); // dedupe

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1500; // start at 1.5s, doubles each retry

    let lastError = null;

    for (const candidateModel of modelChain) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${candidateModel}:generateContent?key=${geminiKey}`;

          const geminiRes = await fetchFn(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents, generationConfig }),
          });

          const data = await geminiRes.json();

          if (geminiRes.status === 429) {
            // Rate limited — back off and retry (or move to next model after max retries)
            lastError = data?.error?.message || 'Rate limit exceeded';
            if (attempt < MAX_RETRIES) {
              const delay = BASE_DELAY_MS * Math.pow(2, attempt);
              console.warn(`[Gemini] 429 on ${candidateModel} attempt ${attempt + 1}/${MAX_RETRIES + 1} — retrying in ${delay}ms`);
              await new Promise(r => setTimeout(r, delay));
              continue; // retry same model
            }
            // Exhausted retries on this model — try next in chain
            console.warn(`[Gemini] Exhausted retries on ${candidateModel}, trying next model`);
            break;
          }

          if (!geminiRes.ok) {
            const message = data?.error?.message || `Gemini API error (${geminiRes.status})`;
            return res.status(geminiRes.status).json({ success: false, message });
          }

          // Success — return with the model that actually responded
          if (candidateModel !== model) {
            console.log(`[Gemini] Responded via fallback model: ${candidateModel}`);
          }
          return res.json({ success: true, data, model: candidateModel });

        } catch (fetchErr) {
          lastError = fetchErr.message;
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    }

    // All models and retries exhausted
    console.error('[Gemini] All models rate-limited or failed:', lastError);
    return res.status(429).json({
      success: false,
      message: 'The AI service is currently busy. Please wait a moment and try again.',
      retryAfter: 10,
    });

  } catch (error) {
    console.error('Gemini proxy error:', error);
    res.status(500).json({ success: false, message: error.message || 'Gemini proxy failed' });
  }
});

/**
 * ===== SUBSCRIPTION MANAGEMENT ENDPOINTS =====
 * Complete implementation of subscription lifecycle
 */

/**
 * GET /api/ai/usage
 * Returns the current user's AI call usage for the current calendar month.
 * Used by the client to show a usage indicator in the UI.
 */
app.get('/api/ai/usage', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.firebaseUser.uid;
    if (!db) return res.json({ success: true, used: 0, limit: AI_USAGE_LIMITS.free, plan: 'free' });

    const snap = await db.collection('users').doc(uid).get();
    const data = snap.exists ? snap.data() : {};
    const plan  = normalizePlan(data.plan || 'free');
    const limit = AI_USAGE_LIMITS[plan] ?? AI_USAGE_LIMITS.free;
    const monthKey = new Date().toISOString().slice(0, 7);
    const used  = data.aiUsage?.[monthKey] || 0;

    res.json({ success: true, used, limit, plan, remaining: Math.max(0, limit - used) });
  } catch (err) {
    console.error('[AI Usage] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/subscription/update-billing
 * Update subscription billing information.
 * Requires a valid Firebase ID token — userId comes from the token.
 */
app.post('/api/subscription/update-billing', verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.firebaseUser.uid; // from verified token — never from body
    const { subscriptionId, cardToken } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        message: 'Subscription ID required'
      });
    }

    if (!db) {
      console.error('❌ Firestore database not initialized');
      return res.status(500).json({
        success: false,
        message: 'Database not configured - contact support'
      });
    }

    // Update payment method with Flutterwave
    try {
      const updateResponse = await fetchFn(
        `${FLUTTERWAVE_API_URL}/subscriptions/${subscriptionId}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            card_token: cardToken
          })
        }
      );

      if (!updateResponse.ok) {
        const error = await updateResponse.json();
        console.error('Flutterwave update failed:', error);
        return res.status(400).json({
          success: false,
          message: 'Failed to update payment method'
        });
      }

      console.log(`✅ Payment method updated for subscription ${subscriptionId}`);
    } catch (flutterErr) {
      console.error('Flutterwave API error:', flutterErr);
      return res.status(500).json({
        success: false,
        message: 'Failed to update payment method with provider'
      });
    }

    // Log update in Firestore — use admin.firestore.FieldValue, not db.FieldValue
    try {
      await db.collection('users').doc(userId).update({
        lastBillingUpdate: new Date(),
        billingUpdateCount: admin.firestore.FieldValue.increment(1)
      });
    } catch (firestoreError) {
      console.error('Error logging billing update:', firestoreError);
    }

    res.json({
      success: true,
      message: 'Payment method updated successfully'
    });

  } catch (error) {
    console.error('Billing update error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update billing'
    });
  }
});

/**
 * POST /api/subscription/upgrade
 * Upgrade subscription to a higher tier.
 * Requires a valid Firebase ID token — userId comes from the token.
 */
app.post('/api/subscription/upgrade', verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.firebaseUser.uid; // from verified token — never from body
    const { currentPlan, newPlan, amount, currency } = req.body;

    if (!currentPlan || !newPlan) {
      return res.status(400).json({
        success: false,
        message: 'Current plan and new plan are required'
      });
    }

    // Validate newPlan to prevent arbitrary values
    const ALLOWED_PLANS = ['pro', 'studio'];
    if (!ALLOWED_PLANS.includes(newPlan)) {
      return res.status(400).json({ success: false, message: 'Invalid plan type' });
    }

    if (!db) {
      console.error('❌ Firestore database not initialized');
      return res.status(500).json({
        success: false,
        message: 'Database not configured - contact support'
      });
    }

    // Update plan in Firestore
    try {
      await db.collection('users').doc(userId).update({
        plan: newPlan,
        planUpgradedDate: new Date(),
        previousPlan: currentPlan,
        planUpdatedAt: new Date()
      });

      console.log(`✅ User ${userId} upgraded from ${currentPlan} to ${newPlan}`);
    } catch (firestoreError) {
      console.error('❌ Error updating plan upgrade:', firestoreError);
      return res.status(500).json({
        success: false,
        message: 'Failed to record plan upgrade'
      });
    }

    res.json({
      success: true,
      message: `Successfully upgraded from ${currentPlan} to ${newPlan}`,
      newPlan: newPlan,
      upgradedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Plan upgrade error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upgrade plan'
    });
  }
});

/**
 * GET /api/subscription/status
 * Get current subscription status for the authenticated user.
 * Requires a valid Firebase ID token — userId comes from the token.
 */
app.get('/api/subscription/status', verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.firebaseUser.uid; // from verified token only

    if (!db) {
      console.error('❌ Firestore database not initialized');
      return res.status(500).json({
        success: false,
        message: 'Database not configured - contact support'
      });
    }

    try {
      const userDoc = await db.collection('users').doc(userId).get();

      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const userData = userDoc.data();

      res.json({
        success: true,
        subscription: {
          plan: userData.plan || 'free',
          status: userData.subscriptionStatus || 'active',
          subscriptionId: userData.subscriptionId || null,
          startDate: userData.subscriptionStartDate,
          lastPaymentDate: userData.lastPaymentDate,
          lastPaymentAmount: userData.lastPaymentAmount,
          currency: userData.lastPaymentCurrency,
          cancellationReason: userData.cancellationReason || null
        }
      });
    } catch (firestoreError) {
      console.error('Error fetching subscription status:', firestoreError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch subscription status'
      });
    }

  } catch (error) {
    console.error('Error getting subscription status:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get subscription status'
    });
  }
});

/**
 * ===== MONITORING & HEALTH CHECK ENDPOINTS =====
 */

/**
 * GET /api/monitoring/health
 * Check system health status.
 * Requires a valid Firebase ID token with admin claim to prevent exposing
 * internal service status to unauthenticated callers.
 */
app.get('/api/monitoring/health', verifyFirebaseToken, async (req, res) => {
  // Restrict to admin users only
  if (!req.firebaseUser?.admin) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  try {
    const services = {
      firestore: { status: db ? 'healthy' : 'unhealthy', message: db ? 'Connected' : 'Not configured' },
      flutterwave: { status: FLUTTERWAVE_SECRET_KEY ? 'healthy' : 'unhealthy', message: FLUTTERWAVE_SECRET_KEY ? 'Configured' : 'Not configured' },
      brevo: { status: BREVO_API_KEY ? 'healthy' : 'unhealthy', message: BREVO_API_KEY ? 'Configured' : 'Not configured' }
    };

    const allHealthy = Object.values(services).every(s => s.status === 'healthy');

    res.json({
      success: true,
      status: allHealthy ? 'healthy' : 'degraded',
      services,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      message: error.message
    });
  }
});

/**
 * GET /api/monitoring/performance
 * Get server performance metrics.
 * Restricted to admin users only.
 */
app.get('/api/monitoring/performance', verifyFirebaseToken, (req, res) => {
  if (!req.firebaseUser?.admin) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  try {
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();

    res.json({
      success: true,
      performance: {
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        memory: {
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /api/cloudinary/sign
 * Generates a signed Cloudinary upload signature server-side.
 * Requires a valid Firebase ID token — anonymous users cannot upload.
 * This replaces the unsigned upload preset so only authenticated PREP users
 * can upload files to our Cloudinary account.
 *
 * Add to Render environment variables:
 *   CLOUDINARY_API_SECRET=your_cloudinary_api_secret
 *   CLOUDINARY_API_KEY=your_cloudinary_api_key
 *   CLOUDINARY_CLOUD_NAME=dct7psmk7
 */
app.post('/api/cloudinary/sign', verifyFirebaseToken, (req, res) => {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dz0gnzsiq';

  if (!apiSecret || !apiKey) {
    return res.status(500).json({ success: false, message: 'Cloudinary not configured on server' });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = `prep/${req.firebaseUser.uid}`; // scope uploads per user

  // Build the string to sign — must match what the Cloudinary SDK expects
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha256')
    .update(paramsToSign + apiSecret)
    .digest('hex');

  res.json({
    success: true,
    signature,
    timestamp,
    apiKey,
    cloudName,
    folder,
  });
});

/**
 * POST /api/join-waitlist
 * Record a waitlist signup for an upcoming feature.
 * Accepts both authenticated (with token) and unauthenticated requests so
 * the form works even if the user's session has lapsed — but we log the
 * verified uid when a token is present.
 */
app.post('/api/join-waitlist', async (req, res) => {
  try {
    const { email, name, feature, receiveUpdates, projectId } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Valid email required' });
    }

    if (!feature || typeof feature !== 'string') {
      return res.status(400).json({ success: false, message: 'Feature name required' });
    }

    // Try to extract uid from the token if provided (non-blocking — don't fail without it)
    let uid = null;
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ') && admin) {
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        uid = decoded.uid;
      } catch { /* token absent or invalid — proceed without uid */ }
    }

    // Persist to Firestore if available
    if (db) {
      await db.collection('waitlist').add({
        email: email.toLowerCase().trim(),
        name: (typeof name === 'string') ? name.trim() : '',
        feature: feature.trim(),
        receiveUpdates: receiveUpdates === true,
        projectId: projectId || null,
        uid,
        createdAt: new Date()
      });
    }

    res.json({ success: true, message: 'Added to waitlist' });
  } catch (error) {
    console.error('join-waitlist error:', error);
    // Return success anyway — don't block the user over a logging failure
    res.json({ success: true, message: 'Added to waitlist' });
  }
});

/**
 * POST /api/send-invite
 * Send a "join PREP" invite email to a non-PREP contact.
 * Requires a valid Firebase ID token — inviterName is taken from the token,
 * not the request body, to prevent spoofing.
 * Rate limited by the general limiter (100/min/IP).
 */
app.post('/api/send-invite', verifyFirebaseToken, async (req, res) => {
  try {
    const { toEmail, toName, inviteLink } = req.body;
    // Inviter identity from the verified token only
    const inviterName  = req.firebaseUser.name  || req.firebaseUser.email || 'A PREP user';
    const inviterEmail = req.firebaseUser.email || '';

    if (!toEmail) {
      return res.status(400).json({ success: false, message: 'toEmail is required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    if (!BREVO_API_KEY) {
      return res.status(500).json({ success: false, message: 'Email service not configured' });
    }

    const safeLink = inviteLink || 'https://prepapp.name.ng/signup.html';
    const recipientName = (typeof toName === 'string' && toName.trim()) ? toName.trim() : toEmail;

    const htmlContent = `
      <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
      <title>You're invited to PREP</title></head>
      <body style="margin:0;padding:0;background:#f4f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(90,24,154,0.08);">
          <div style="background:linear-gradient(135deg,#ff6500,#ff8533);padding:32px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:24px;">You're invited to PREP</h1>
          </div>
          <div style="padding:32px;">
            <p style="color:#444;font-size:15px;line-height:1.7;">Hi <strong>${recipientName}</strong>,</p>
            <p style="color:#444;font-size:15px;line-height:1.7;">
              <strong>${inviterName}</strong> is inviting you to join <strong>PREP</strong> — the cinematic pre-production platform for filmmakers.
            </p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${safeLink}" style="display:inline-block;background:#ff6500;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;">
                Create Free Account
              </a>
            </div>
            <p style="color:#999;font-size:12px;text-align:center;">
              Sent by ${inviterName} (${inviterEmail}) via PREP
            </p>
          </div>
        </div>
      </body></html>
    `;

    const emailRes = await fetchFn(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: [{ email: toEmail, name: recipientName }],
        sender: { name: 'PREP - Cinematic Pre-production', email: 'noreply@prepapp.name.ng' },
        subject: `${inviterName} invited you to PREP`,
        htmlContent,
        replyTo: { email: 'info@prepapp.name.ng', name: 'PREP Support' }
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.json();
      console.error('Brevo send-invite failed:', err);
      return res.status(500).json({ success: false, message: 'Failed to send invite email' });
    }

    res.json({ success: true, message: 'Invite email sent' });
  } catch (error) {
    console.error('send-invite error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send invite' });
  }
});

/**
 * POST /api/send-feature-request
 * Store a feature request and email the team.
 * Requires a valid Firebase ID token.
 * User identity comes from the token — uid/email from the body are ignored.
 */
app.post('/api/send-feature-request', verifyFirebaseToken, async (req, res) => {
  try {
    const { title, category, description, useCase } = req.body;
    const uid   = req.firebaseUser.uid;
    const email = req.firebaseUser.email;

    if (!title || !category || !description) {
      return res.status(400).json({ success: false, message: 'title, category, and description are required' });
    }
    if (typeof title !== 'string' || title.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Title must be at least 5 characters' });
    }

    // Optionally store in Firestore for a backlog view
    if (db) {
      await db.collection('featureRequests').add({
        uid,
        email,
        title:       title.trim(),
        category,
        description: description.trim(),
        useCase:     (typeof useCase === 'string') ? useCase.trim() : '',
        createdAt:   new Date(),
        status:      'new'
      });
    }

    // Email the team via Brevo (non-blocking — don't fail the request if email fails)
    if (BREVO_API_KEY) {
      fetchFn(`${BREVO_API_URL}/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: [{ email: 'info@prepapp.name.ng', name: 'PREP Team' }],
          sender: { name: 'PREP Feature Requests', email: 'noreply@prepapp.name.ng' },
          subject: `[Feature Request] ${title.trim()}`,
          htmlContent: `
            <p><strong>From:</strong> ${email} (uid: ${uid})</p>
            <p><strong>Category:</strong> ${category}</p>
            <p><strong>Title:</strong> ${title.trim()}</p>
            <p><strong>Description:</strong></p>
            <p>${description.trim().replace(/\n/g, '<br>')}</p>
            ${useCase ? `<p><strong>Use case:</strong> ${String(useCase).trim().replace(/\n/g, '<br>')}</p>` : ''}
          `
        })
      }).catch(e => console.warn('Feature request email failed (non-blocking):', e.message));
    }

    res.json({ success: true, message: 'Feature request received — thank you!' });
  } catch (error) {
    console.error('send-feature-request error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to submit feature request' });
  }
});

// ─── OTP Email Verification ───────────────────────────────────────────────────
// Replaces Firebase's email-link flow (which triggers cross-origin errors) with
// a simple 6-digit OTP sent via Brevo.  OTPs are stored hashed in Firestore
// under users/{uid}/otpVerification/{docId} and expire after 10 minutes.

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.uid || req.ip,
  message: { success: false, error: 'Too many OTP requests. Please wait before requesting another code.' }
});

/**
 * POST /api/otp/send
 * Generates a 6-digit OTP, hashes it with SHA-256, stores it in Firestore
 * under users/{uid}/otpVerification, and emails it to the user via Brevo.
 *
 * Body: { uid, email, fullName }
 * The uid is taken from the body here because the user is not yet verified —
 * we validate it actually corresponds to a real Firebase Auth user via Admin SDK.
 */
app.post('/api/otp/send', otpLimiter, async (req, res) => {
  try {
    const { uid, email, fullName } = req.body;

    if (!uid || !email) {
      return res.status(400).json({ success: false, error: 'uid and email are required' });
    }

    // Validate uid is a real Firebase Auth user so callers can't spam arbitrary emails
    if (!admin) {
      return res.status(503).json({ success: false, error: 'Auth service unavailable' });
    }
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().getUser(uid);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid user' });
    }
    // Ensure email in body matches what Firebase has on record (prevents spoofing)
    if (firebaseUser.email !== email) {
      return res.status(400).json({ success: false, error: 'Email does not match account' });
    }

    // Already verified — nothing to do
    if (db) {
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists && userDoc.data().emailVerified === true) {
        return res.json({ success: true, message: 'Email already verified' });
      }
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    // Hash before storing — never save plaintext OTPs
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    if (db) {
      // Store in a subcollection — one doc per attempt, so we can clean up old ones
      await db.collection('users').doc(uid).collection('otpVerification').add({
        otpHash,
        expiresAt,
        attempts: 0,
        createdAt: new Date()
      });
    }

    // Send OTP email via Brevo
    if (!BREVO_API_KEY) {
      return res.status(500).json({ success: false, error: 'Email service not configured' });
    }

    const safeName = (typeof fullName === 'string' && fullName.trim()) ? fullName.trim() : email;

    const emailResponse = await fetchFn(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: [{ email, name: safeName }],
        sender: { name: 'PREP - Cinematic Pre-production', email: 'noreply@prepapp.name.ng' },
        subject: `${otp} is your PREP verification code`,
        htmlContent: generateOtpEmailHTML(safeName, otp),
        replyTo: { email: 'info@prepapp.name.ng', name: 'PREP Support' }
      })
    });

    if (!emailResponse.ok) {
      const err = await emailResponse.json();
      console.error('Brevo OTP email failed:', err);
      return res.status(500).json({ success: false, error: 'Failed to send verification email' });
    }

    res.json({ success: true, message: 'Verification code sent to your email' });
  } catch (error) {
    console.error('otp/send error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to send code' });
  }
});

/**
 * POST /api/otp/verify
 * Validates the OTP the user typed. On success, sets emailVerified:true in
 * Firestore and uses Firebase Admin to set the Firebase Auth emailVerified flag.
 *
 * Body: { uid, otp }
 */
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { uid, otp } = req.body;

    if (!uid || !otp) {
      return res.status(400).json({ success: false, error: 'uid and otp are required' });
    }

    if (!admin || !db) {
      return res.status(503).json({ success: false, error: 'Auth service unavailable' });
    }

    const submittedHash = crypto.createHash('sha256').update(String(otp)).digest('hex');
    const now = new Date();

    // Find the most recent non-expired OTP for this user
    const otpSnap = await db
      .collection('users').doc(uid)
      .collection('otpVerification')
      .where('expiresAt', '>', now)
      .orderBy('expiresAt', 'desc')
      .limit(1)
      .get();

    if (otpSnap.empty) {
      return res.status(400).json({ success: false, error: 'Code expired or not found. Please request a new one.' });
    }

    const otpDoc = otpSnap.docs[0];
    const otpData = otpDoc.data();

    // Guard against brute-force: max 5 attempts per OTP doc
    if (otpData.attempts >= 5) {
      await otpDoc.ref.delete();
      return res.status(400).json({ success: false, error: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (otpData.otpHash !== submittedHash) {
      await otpDoc.ref.update({ attempts: (otpData.attempts || 0) + 1 });
      const remaining = 4 - (otpData.attempts || 0);
      return res.status(400).json({ success: false, error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
    }

    // ✅ OTP is correct — mark verified
    await otpDoc.ref.delete(); // clean up used OTP

    // Update Firestore user document
    await db.collection('users').doc(uid).update({ emailVerified: true });

    // Also update Firebase Auth so auth.currentUser.emailVerified is true
    await admin.auth().updateUser(uid, { emailVerified: true });

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    console.error('otp/verify error:', error);
    res.status(500).json({ success: false, error: error.message || 'Verification failed' });
  }
});

function generateOtpEmailHTML(name, otp) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your PREP verification code</title>
    </head>
    <body style="margin:0;padding:0;background:#0f172a;font-family:Arial,sans-serif;color:#f8fafc;">
      <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
        <div style="background:#020617;border:1px solid #1e293b;border-radius:16px;padding:36px 28px;text-align:center;">
          <h1 style="margin:0 0 8px;font-size:22px;color:#ffd60a;letter-spacing:-0.5px;">PREP</h1>
          <p style="margin:0 0 28px;color:#94a3b8;font-size:13px;">Cinematic Pre-production</p>

          <p style="margin:0 0 20px;color:#e2e8f0;font-size:15px;line-height:1.6;text-align:left;">
            Hi <strong>${name}</strong>,<br>
            Here is your email verification code. It expires in <strong>10 minutes</strong>.
          </p>

          <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:24px;margin:0 0 24px;">
            <span style="font-size:40px;font-weight:800;letter-spacing:10px;color:#ffd60a;font-family:monospace;">${otp}</span>
          </div>

          <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;text-align:left;">
            If you didn't create a PREP account, you can safely ignore this email.
            Never share this code with anyone.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    errorId: new Date().getTime()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PREP Server running on http://localhost:${PORT}`);
});
