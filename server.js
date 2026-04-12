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

// Brevo API Configuration
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PREP Server running on http://localhost:${PORT}`);
});