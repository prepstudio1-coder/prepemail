const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Use native fetch for Node 18+ or import node-fetch for older versions
let fetchFn;
if (typeof fetch === 'undefined') {
  fetchFn = require('node-fetch');
} else {
  fetchFn = fetch;
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

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
        logo: 'https://res.cloudinary.com/dct7psmk7/image/upload/v1234567890/prep-logo.png'
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

    // Check if payment was successful
    if (paymentStatus === 'successful') {
      // Send payment confirmation email asynchronously (don't block response)
      const email = data.data?.customer?.email;
      const customerName = data.data?.customer?.name || 'Valued Customer';
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
      
      if (email) {
        sendPaymentConfirmationEmail(email, customerName, plan, payload.data?.amount, payload.data?.id)
          .catch(err => console.error('Webhook email sending failed:', err));
      }
      
      // Update user subscription in Firestore if needed
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PREP Server running on http://localhost:${PORT}`);
});