import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { apiConfig } from './config.js';

// Diagnostic logging for troubleshooting
const diagnostics = {
  frontendOrigin: window.location.origin,
  backendUrl: apiConfig.baseUrl,
  environment: apiConfig.environment || 'unknown',
  
  log: function(message, data = {}) {
    console.log(`[PREP Payment Diagnostics] ${message}`, data);
  },
  
  error: function(message, error = {}) {
    console.error(`[PREP Payment Error] ${message}`, error);
  }
};

// Log diagnostic info on page load
diagnostics.log('Payment system initialized', {
  frontend: diagnostics.frontendOrigin,
  backend: diagnostics.backendUrl,
  timestamp: new Date().toISOString()
});

document.addEventListener('DOMContentLoaded', async () => {
  applyDarkMode();
  setupPricingButtons();
});

function applyDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'on';
  if (isDark) {
    document.body.classList.add('dark');
  } else {
    document.body.classList.remove('dark');
  }
}

function setupPricingButtons() {
  onAuthStateChanged(auth, (user) => {
    // Pro plan button
    const upgradeProBtn = document.getElementById('upgradeProBtn');
    
    if (upgradeProBtn) {
      if (user) {
        upgradeProBtn.addEventListener('click', (e) => {
          e.preventDefault();
          startProPayment(user);
        });
      } else {
        upgradeProBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Sign in to upgrade';
        upgradeProBtn.addEventListener('click', (e) => {
          e.preventDefault();
          window.location.href = 'login.html';
        });
      }
    } else {
      console.error('Upgrade button not found in DOM');
    }
  });
}

async function startProPayment(user) {
  try {
    const button = document.getElementById('upgradeProBtn');
    const originalText = button.innerHTML;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    button.disabled = true;

    const paymentUrl = `${apiConfig.baseUrl}/api/payment/initialize`;
    console.log('Initiating payment request to:', paymentUrl);

    let response;
    try {
      // Initialize payment with server
      response = await fetch(paymentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          email: user.email,
          displayName: user.displayName || 'PREP User',
          plan: 'pro',
          amount: 5.00,
          currency: 'USD',
        }),
      });

      console.log('Payment response status:', response.status);
      console.log('Response headers:', {
        'content-type': response.headers.get('content-type'),
        'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
        'access-control-allow-methods': response.headers.get('access-control-allow-methods'),
      });

    } catch (fetchError) {
      // Network or CORS error
      console.error('Fetch error details:', {
        message: fetchError.message,
        type: fetchError.name,
        cause: fetchError.cause,
      });

      let errorMessage = 'Payment initialization failed';

      if (fetchError.message.includes('Failed to fetch')) {
        errorMessage = 'CORS Error: Server blocked the request. This is a backend configuration issue.\n\nThe server at ' + apiConfig.baseUrl + ' is not allowing requests from ' + window.location.origin + '.\n\nPlease contact support.';
      } else if (fetchError.message.includes('NetworkError') || fetchError.type === 'NetworkError') {
        errorMessage = 'Network Error: Unable to reach the payment server. Check your internet connection.';
      } else {
        errorMessage = `Network Error: ${fetchError.message}`;
      }

      console.error('Network/CORS error:', errorMessage);
      showErrorModal(errorMessage);
      button.innerHTML = originalText;
      button.disabled = false;
      return;
    }

    if (!response.ok) {
      console.error(`HTTP Error: ${response.status} ${response.statusText}`);
      
      let errorData = {};
      try {
        errorData = await response.json();
      } catch (e) {
        console.warn('Could not parse error response JSON');
      }

      const errorMessage = `Server Error (HTTP ${response.status}): ${errorData.message || response.statusText || 'Failed to initialize payment'}`;
      console.error('Error message:', errorMessage);
      showErrorModal(errorMessage);
      button.innerHTML = originalText;
      button.disabled = false;
      return;
    }

    let data;
    try {
      data = await response.json();
      console.log('Payment initialization response:', data);
    } catch (parseError) {
      console.error('Failed to parse response JSON:', parseError);
      showErrorModal('Server returned invalid response. Please try again.');
      button.innerHTML = originalText;
      button.disabled = false;
      return;
    }

    if (!data.success) {
      showErrorModal(data.message || 'Failed to initialize payment');
      button.innerHTML = originalText;
      button.disabled = false;
      return;
    }

    // Open Flutterwave payment modal if link is available
    if (data.data?.paymentLink) {
      window.location.href = data.data.paymentLink;
    } else if (window.FlutterwaveCheckout) {
      // Fallback to direct Flutterwave SDK integration
      window.FlutterwaveCheckout({
        public_key: 'PK_LIVE_YOUR_PUBLIC_KEY', // Replace with actual key from server config
        tx_ref: data.data.txRef,
        amount: 5.00,
        currency: 'USD',
        payment_options: 'card,ussd,account,credit_topup,apple_pay,google_pay',
        customer: {
          email: user.email,
          name: user.displayName || 'PREP User',
        },
        customizations: {
          title: 'PREP Pro Subscription',
          description: 'Monthly subscription to PREP Pro plan',
          logo: '/assets/logo.png',
        },
        onclose: () => {
          button.innerHTML = originalText;
          button.disabled = false;
        },
        callback: async (response) => {
          if (response.status === 'successful') {
            // Verify payment on server
            await verifyPayment(response.transaction_id, 'pro');
          } else {
            showErrorModal('Payment was not completed');
            button.innerHTML = originalText;
            button.disabled = false;
          }
        },
      });
    } else {
      showErrorModal('Flutterwave payment system not loaded');
      button.innerHTML = originalText;
      button.disabled = false;
    }

  } catch (error) {
    console.error('Unexpected payment error:', {
      message: error.message,
      stack: error.stack,
      type: error.name,
    });
    
    showErrorModal(error.message || 'An unexpected error occurred during payment');
    
    const button = document.getElementById('upgradeProBtn');
    button.innerHTML = '<i class="fa-solid fa-credit-card"></i> Upgrade to Pro';
    button.disabled = false;
  }
}

async function verifyPayment(transactionId, plan) {
  try {
    const verifyUrl = `${apiConfig.baseUrl}/api/payment/verify`;
    console.log('Verifying payment at:', verifyUrl);

    let response;
    try {
      response = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          transactionId: transactionId,
          plan: plan
        }),
      });

      console.log('Verify response status:', response.status);

    } catch (fetchError) {
      console.error('Verification fetch error:', fetchError.message);
      
      let errorMessage = 'Payment verification failed';
      if (fetchError.message.includes('Failed to fetch')) {
        errorMessage = 'CORS Error during verification. Backend configuration issue.';
      }
      
      showErrorModal(errorMessage);
      return;
    }

    if (!response.ok) {
      console.error(`Verification HTTP Error: ${response.status}`);
      const errorData = await response.json().catch(() => ({}));
      showErrorModal(errorData.message || `Verification failed: HTTP ${response.status}`);
      return;
    }

    const data = await response.json();
    console.log('Verification response:', data);
    
    if (data.success && data.status === 'success') {
      showSuccessModal();
      setTimeout(() => {
        window.location.href = 'dashboard.html?upgrade=success';
      }, 2000);
    } else {
      showErrorModal(data.message || 'Payment verification failed');
    }
  } catch (error) {
    console.error('Verification error:', error);
    showErrorModal('Could not verify payment. Please contact support.');
  }
}

function showSuccessModal(message = 'Welcome to PREP Pro! 🎉') {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  `;

  modal.innerHTML = `
    <div style="
      background: white;
      padding: 40px;
      border-radius: 20px;
      text-align: center;
      max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    ">
      <div style="font-size: 3rem; margin-bottom: 20px;">✅</div>
      <h2 style="margin: 0 0 10px; color: #2f0e4f;">Payment Successful!</h2>
      <p style="margin: 0; color: #6f6578; line-height: 1.6;">${message}</p>
      <p style="margin: 15px 0 0; color: #999; font-size: 0.9rem;">Redirecting to dashboard...</p>
    </div>
  `;

  document.body.appendChild(modal);
}

function showErrorModal(message) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  `;

  const isCorsError = message.includes('CORS') || message.includes('Failed to fetch');
  const diagnosticInfo = `
    Frontend: ${diagnostics.frontendOrigin}
    Backend: ${diagnostics.backendUrl}
    Time: ${new Date().toISOString()}
  `;

  modal.innerHTML = `
    <div style="
      background: white;
      padding: 40px;
      border-radius: 20px;
      text-align: center;
      max-width: 500px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-height: 80vh;
      overflow-y: auto;
    ">
      <div style="font-size: 3rem; margin-bottom: 20px;">❌</div>
      <h2 style="margin: 0 0 10px; color: #d32f2f;">Payment Failed</h2>
      <p style="margin: 0 0 20px; color: #6f6578; line-height: 1.6; white-space: pre-wrap; word-break: break-word;">${message}</p>
      
      ${isCorsError ? `
        <div style="
          background: #fff3cd;
          border: 1px solid #ffc107;
          border-radius: 8px;
          padding: 15px;
          margin: 15px 0;
          text-align: left;
          font-size: 12px;
        ">
          <strong style="color: #856404;">CORS Configuration Issue Detected</strong>
          <p style="margin: 10px 0 0 0; color: #856404;">
            The backend server is not allowing requests from your frontend domain. 
            This is a server configuration issue that needs to be fixed by the administrator.
          </p>
        </div>
      ` : ''}
      
      <div style="
        background: #f5f5f5;
        border-radius: 8px;
        padding: 10px;
        margin: 15px 0;
        font-size: 11px;
        color: #666;
        text-align: left;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 100px;
        overflow-y: auto;
      ">
        <strong>Diagnostic Info:</strong>
        ${diagnosticInfo}
      </div>
      
      <div style="display: flex; gap: 10px; margin-top: 20px;">
        <button onclick="this.closest('div').parentElement.remove()" style="
          flex: 1;
          padding: 10px 20px;
          background: #ff6500;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 700;
        ">Try Again</button>
        <button onclick="console.log('Diagnostic Info:'); console.log('${diagnosticInfo.replace(/\n/g, '\\n')}'); alert('Check browser console (F12) for diagnostic details')" style="
          flex: 1;
          padding: 10px 20px;
          background: #666;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 700;
        ">View Details</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}