const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Firebase Admin SDK
let db = null;
try {
  const admin = require('firebase-admin');
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
      'http://localhost:5500'
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

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Email Service Configuration (Your Brevo account)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3';

/**
 * Send welcome email to new users via Brevo
 * Adds user to "New users" list and sends welcome email
 */
app.post('/api/send-welcome-email', async (req, res) => {
  try {
    const { email, fullName, accountType } = req.body;

    // Validate required fields
    if (!email || !fullName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and fullName are required' 
      });
    }

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
        email: email,
        listIds: [5], // Matches your "New users #5" list
        updateEnabled: true,
        attributes: {
          FIRSTNAME: fullName,
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
            email: email,
            name: fullName
          }
        ],
        sender: {
          name: 'PREP - Cinematic Pre-production',
          email: 'noreply@prepapp.name.ng' // Updated to match your verified domain
        },
        subject: `Welcome to PREP, ${fullName}!`,
        htmlContent: generateWelcomeEmailHTML(fullName, accountType),
        replyTo: {
          email: 'hello@prepapp.name.ng', // Updated to match your verified domain
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
          email: 'hello@prepapp.name.ng',
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

/**
 * Initialize payment - Create transaction reference and prepare payment
 */
app.post('/api/payment/initialize', async (req, res) => {
  try {
    const { userId, email, displayName, plan, amount, currency } = req.body;

    // Validate required fields
    if (!userId || !email || !plan || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment information'
      });
    }

    if (!FLUTTERWAVE_SECRET_KEY) {
      console.error('FLUTTERWAVE_SECRET_KEY not configured');
      return res.status(500).json({
        success: false,
        message: 'Payment service not configured'
      });
    }

    // Generate unique transaction reference
    const txRef = `PREP-${userId}-${Date.now()}`;

    // Create payment payload
    const paymentPayload = {
      tx_ref: txRef,
      amount: amount,
      currency: currency || 'USD',
      payment_options: 'card,mobilemoney,ussd',
      customer: {
        email: email,
        name: displayName || 'Customer'
      },
      customizations: {
        title: `PREP ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`,
        description: `Subscribe to PREP ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan`,
        logo: 'https://prepapp.name.ng/assets/logo.png'
      },
      meta: {
        userId: userId,
        plan: plan
      },
      redirect_url: `${process.env.APP_URL || 'http://localhost:3000'}/payment-success`
    };

    // Initialize transaction with Flutterwave
    const response = await fetchFn(`${FLUTTERWAVE_API_URL}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentPayload)
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Flutterwave initialization failed:', error);
      return res.status(400).json({
        success: false,
        message: error.message || 'Failed to initialize payment'
      });
    }

    const data = await response.json();

    res.json({
      success: true,
      data: {
        txRef: txRef,
        paymentLink: data.data?.link || null,
        transactionId: data.data?.id || null
      }
    });

  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initialize payment'
    });
  }
});

/**
 * Verify payment - Check payment status with Flutterwave
 */
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { transactionId, transactionRef, userId, status } = req.body;

    if (!transactionId && !transactionRef) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID or reference required'
      });
    }

    if (!FLUTTERWAVE_SECRET_KEY) {
      console.error('FLUTTERWAVE_SECRET_KEY not configured');
      return res.status(500).json({
        success: false,
        message: 'Payment service not configured'
      });
    }

    // Verify transaction with Flutterwave
    const verifyUrl = transactionId 
      ? `${FLUTTERWAVE_API_URL}/transactions/${transactionId}/verify`
      : `${FLUTTERWAVE_API_URL}/transactions/verify_by_ref?tx_ref=${transactionRef}`;

    const response = await fetchFn(verifyUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Flutterwave verification failed:', error);
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed',
        status: 'failed'
      });
    }

    const data = await response.json();
    const paymentStatus = data.data?.status;
    const plan = data.data?.meta?.plan || 'pro';
    const subscriptionId = data.data?.id;
    const email = data.data?.customer?.email;
    const customerName = data.data?.customer?.name || 'Valued Customer';
    
    // Extract userId from request or transaction meta
    const transactionUserId = userId || data.data?.meta?.userId;

    // Check if payment was successful
    if (paymentStatus === 'successful') {
      try {
        // Update user's plan in Firestore if userId is available
        if (transactionUserId) {
          if (!db) {
            console.error('❌ Firestore database not initialized - check FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
            return res.status(500).json({
              success: false,
              message: 'Database not configured - contact support',
              status: 'error'
            });
          }

          await db.collection('users').doc(transactionUserId).update({
            plan: plan,
            subscriptionId: subscriptionId,
            subscriptionStatus: 'active',
            subscriptionStartDate: new Date(),
            lastPaymentDate: new Date(),
            lastPaymentAmount: data.data?.amount,
            lastPaymentCurrency: data.data?.currency
          });
          console.log(`✅ Plan updated to "${plan}" for user ${transactionUserId}`);
        } else {
          console.error('❌ No userId available for Firestore update');
          return res.status(400).json({
            success: false,
            message: 'User ID required for plan update',
            status: 'error'
          });
        }
      } catch (firestoreError) {
        console.error('❌ Error updating user plan in Firestore:', firestoreError);
        return res.status(500).json({
          success: false,
          message: 'Failed to update user plan in database',
          status: 'error'
        });
      }

      // Send payment confirmation email asynchronously (don't block response)
      if (email) {
        sendPaymentConfirmationEmail(email, customerName, plan, data.data?.amount, subscriptionId)
          .catch(err => console.error('Email sending failed (non-blocking):', err));
      }

      res.json({
        success: true,
        status: 'success',
        message: 'Payment verified successfully',
        plan: plan,
        subscriptionId: subscriptionId,
        amount: data.data?.amount,
        currency: data.data?.currency
      });
    } else {
      res.json({
        success: false,
        status: paymentStatus,
        message: `Payment status: ${paymentStatus}`
      });
    }

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Payment verification failed',
      status: 'error'
    });
  }
});

/**
 * Get payment history for a user
 */
app.get('/api/payment/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID required'
      });
    }

    // Note: Actual implementation would fetch from Firestore
    // This is a placeholder for the endpoint structure
    res.json({
      success: true,
      payments: []
    });

  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch payment history'
    });
  }
});

/**
 * Webhook endpoint for Flutterwave payment updates
 */
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const payload = req.body;

    // Verify webhook signature (optional but recommended)
    const hash = req.headers['verificationhash'];
    
    console.log('Webhook received:', payload);

    // Log payment event and send confirmation email
    if (payload.data?.status === 'successful') {
      console.log(`Payment successful for transaction: ${payload.data.tx_ref}`);
      
      // Send payment confirmation email
      const email = payload.data?.customer?.email;
      const customerName = payload.data?.customer?.name || 'Valued Customer';
      const plan = payload.data?.meta?.plan || 'pro';
      const userId = payload.data?.meta?.userId;
      
      // Update user subscription in Firestore if userId is available
      if (userId) {
        if (!db) {
          console.error('❌ Webhook: Firestore database not initialized - check FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
        } else {
          try {
            await db.collection('users').doc(userId).update({
              plan: plan,
              subscriptionId: payload.data?.id,
              subscriptionStatus: 'active',
              subscriptionStartDate: new Date(),
              lastPaymentDate: new Date(),
              lastPaymentAmount: payload.data?.amount,
              lastPaymentCurrency: payload.data?.currency
            });
            console.log(`✅ Webhook updated plan to "${plan}" for user ${userId}`);
          } catch (firestoreError) {
            console.error('❌ Webhook: Error updating user plan in Firestore:', firestoreError);
          }
        }
      } else {
        console.error('❌ Webhook: No userId available for Firestore update');
      }
      
      if (email) {
        sendPaymentConfirmationEmail(email, customerName, plan, payload.data?.amount, payload.data?.id)
          .catch(err => console.error('Webhook email sending failed:', err));
      }
    }

    res.json({ success: true, message: 'Webhook received' });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      success: false,
      message: 'Webhook processing failed'
    });
  }
});

/**
 * Save user subscription to Firebase
 * Called from frontend after successful payment verification
 */
app.post('/api/subscription/save', async (req, res) => {
  try {
    const { userId, plan, subscriptionId, amount, currency } = req.body;

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
        lastPaymentCurrency: currency
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
 * Hugging Face Image Generation Proxy
 * Proxies requests to HF Inference API to avoid CORS issues
 */
app.post('/api/ai/generate-image', async (req, res) => {
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
 * Get payment history for a user
 */
app.get('/api/payment/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID required'
      });
    }

    // Note: In production, fetch from Firestore
    // For now, return empty array
    res.json({
      success: true,
      payments: []
    });

  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch payment history'
    });
  }
});

/**
 * Cancel user subscription (downgrade to free)
 */
app.post('/api/subscription/cancel', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID required'
      });
    }

    // Import handlePlanDowngrade from firebase-operations
    const { handlePlanDowngrade } = await import('./firebase-operations.js');
    
    // Handle plan downgrade: archive excess projects, disable team collaboration
    const downgradeResult = await handlePlanDowngrade(userId);

    // Log the downgrade event
    console.log(`Subscription cancellation completed for user: ${userId}`, downgradeResult);

    res.json({
      success: true,
      message: downgradeResult.message,
      newPlan: 'free',
      archivedProjects: downgradeResult.archivedProjects,
      archivedCount: downgradeResult.archivedProjects.length
    });

  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel subscription'
    });
  }
});

/**
 * Get storage usage for a user
 */
app.get('/api/storage/usage/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID required'
      });
    }

    // Note: In production, fetch from Firestore
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
 * Check subscription expiry and downgrade if needed
 */
app.post('/api/subscription/check-expiry', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID required'
      });
    }

    // Note: In production, check Firestore for expiry date
    // If expired, downgrade to free and archive projects

    res.json({
      success: true,
      message: 'Subscription status checked',
      expired: false
    });

  } catch (error) {
    console.error('Error checking subscription expiry:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to check subscription status'
    });
  }
});

/**
 * Send collaboration invite email
 * Handles two cases:
 *  - userExists: true  → notify existing PREP user they've been added
 *  - userExists: false → invite non-user to sign up and join the project
 */
app.post('/api/collaboration/invite', async (req, res) => {
  try {
    const { inviteeEmail, inviteeName, inviterName, projectName, role, userExists, signupLink } = req.body;

    if (!inviteeEmail || !inviterName || !projectName) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!BREVO_API_KEY) {
      return res.status(500).json({ success: false, message: 'Email service not configured' });
    }

    const subject = userExists
      ? `${inviterName} added you to a project on PREP`
      : `You've been invited to collaborate on PREP`;

    const htmlContent = userExists
      ? generateCollabNotificationEmail(inviteeName || inviteeEmail, inviterName, projectName, role)
      : generateCollabInviteEmail(inviteeEmail, inviterName, projectName, role, signupLink);

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
        replyTo: { email: 'hello@prepapp.name.ng', name: 'PREP Support' }
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PREP Server running on http://localhost:${PORT}`);
});