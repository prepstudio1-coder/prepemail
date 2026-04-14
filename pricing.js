import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { apiConfig } from './config.js';

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

    // Initialize payment with server
    const response = await fetch(`${apiConfig.baseUrl}/api/payment/initialize`, {
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

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Server error: ${response.status}`);
    }

    const data = await response.json();

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
    console.error('Payment error:', error);
    showErrorModal(error.message || 'An error occurred during payment');
    
    const button = document.getElementById('upgradeProBtn');
    button.innerHTML = '<i class="fa-solid fa-credit-card"></i> Upgrade to Pro';
    button.disabled = false;
  }
}

async function verifyPayment(transactionId, plan) {
  try {
    const response = await fetch(`${apiConfig.baseUrl}/api/payment/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        transactionId: transactionId,
        plan: plan
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Server error: ${response.status}`);
    }

    const data = await response.json();
    
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

  modal.innerHTML = `
    <div style="
      background: white;
      padding: 40px;
      border-radius: 20px;
      text-align: center;
      max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    ">
      <div style="font-size: 3rem; margin-bottom: 20px;">❌</div>
      <h2 style="margin: 0 0 10px; color: #d32f2f;">Payment Failed</h2>
      <p style="margin: 0; color: #6f6578; line-height: 1.6;">${message}</p>
      <button onclick="this.closest('div').parentElement.remove()" style="
        margin-top: 20px;
        padding: 10px 20px;
        background: #ff6500;
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 700;
      ">Try Again</button>
    </div>
  `;

  document.body.appendChild(modal);
}