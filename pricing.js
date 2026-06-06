import { initializeAnalytics, logFeatureUsage } from './analytics-init.js';
import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { apiConfig } from './config.js';
import {
  getFormattedPrice,
  getFormattedProYearlyPrice,
  getFormattedStudioPrice,
  getFormattedStudioYearlyPrice,
  getLocalPrice,
  getProYearlyLocalPrice,
  getStudioLocalPrice,
  getStudioYearlyLocalPrice,
  getCurrencyCode,
  initializeCurrency,
} from './currency-utils.js';

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

// Track current billing period: 'monthly' | 'yearly'
let billingPeriod = 'monthly';

// Cached price strings
const prices = {
  proMonthly: null,
  proYearly: null,
  studioMonthly: null,
  studioYearly: null,
};

document.addEventListener('DOMContentLoaded', async () => {
  await initializeAnalytics('pricing');
  applyDarkMode();
  await updatePriceDisplays();
  setupBillingToggle();
  setupPricingButtons();
});

function applyDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'on';
  document.body.classList.toggle('dark', isDark);
}

async function updatePriceDisplays() {
  try {
    const [proM, proY, stuM, stuY] = await Promise.all([
      getFormattedPrice(),
      getFormattedProYearlyPrice(),
      getFormattedStudioPrice(),
      getFormattedStudioYearlyPrice(),
    ]);

    prices.proMonthly    = proM;
    prices.proYearly     = proY;
    prices.studioMonthly = stuM;
    prices.studioYearly  = stuY;

    renderPrices();
  } catch (error) {
    console.error('Error updating price display:', error);
  }
}

function renderPrices() {
  const isYearly = billingPeriod === 'yearly';

  // Pro price
  const proDisplay = document.getElementById('proPriceDisplay');
  const proNote    = document.getElementById('proPerMonthNote');
  if (proDisplay && prices.proMonthly) {
    const active = isYearly ? prices.proYearly : prices.proMonthly;
    const suffix = isYearly ? '/yr' : '/mo';
    const match  = active.match(/(.+?)\/(mo|yr)/);
    if (match) {
      proDisplay.innerHTML = `${match[1]}<span style="font-size:1rem; color:#6f6578;">${suffix}</span>`;
    }
    if (isYearly && proNote) {
      // Show equivalent monthly breakdown
      const moMatch = prices.proMonthly.match(/(.+?)\/mo/);
      proNote.textContent = moMatch ? `Billed yearly — ${moMatch[1]}/mo equivalent` : '';
    }
  }

  // Studio price
  const studioDisplay = document.getElementById('studioPriceDisplay');
  const studioNote    = document.getElementById('studioPerMonthNote');
  if (studioDisplay && prices.studioMonthly) {
    const active = isYearly ? prices.studioYearly : prices.studioMonthly;
    const suffix = isYearly ? '/yr' : '/mo';
    const match  = active.match(/(.+?)\/(mo|yr)/);
    if (match) {
      studioDisplay.innerHTML = `${match[1]}<span style="font-size:1rem; color:#6f6578;">${suffix}</span>`;
    }
    if (isYearly && studioNote) {
      const moMatch = prices.studioMonthly.match(/(.+?)\/mo/);
      studioNote.textContent = moMatch ? `Billed yearly — ${moMatch[1]}/mo equivalent` : '';
    }
  }

  // Toggle body class so .price-per-month-note shows/hides via CSS
  document.body.classList.toggle('yearly-mode', isYearly);
}

function setupBillingToggle() {
  const toggle       = document.getElementById('billingToggle');
  const monthlyLabel = document.getElementById('monthlyLabel');
  const yearlyLabel  = document.getElementById('yearlyLabel');

  if (!toggle) return;

  toggle.addEventListener('change', () => {
    billingPeriod = toggle.checked ? 'yearly' : 'monthly';
    monthlyLabel?.classList.toggle('active', !toggle.checked);
    yearlyLabel?.classList.toggle('active', toggle.checked);
    renderPrices();
  });
}

function setupPricingButtons() {
  onAuthStateChanged(auth, async (user) => {
    // Pro plan button
    const upgradeProBtn    = document.getElementById('upgradeProBtn');
    const upgradeStudioBtn = document.getElementById('upgradeStudioBtn');

    // Determine current user plan
    let userPlan = 'free';
    if (user) {
      try {
        const userDoc = await import('./firebase.js').then(m => m.db);
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js');
        const userRef   = doc(userDoc, 'users', user.uid);
        const snapshot  = await getDoc(userRef);
        if (snapshot.exists()) {
          const raw = snapshot.data()?.plan || 'free';
          const planAliases = { premium: 'pro', paid: 'pro' };
          userPlan = planAliases[raw] || raw;
        }
      } catch (error) {
        console.error('Error checking user plan:', error);
      }
    }

    // ── Pro button ──
    if (upgradeProBtn) {
      if (!user) {
        upgradeProBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Sign in to upgrade';
        upgradeProBtn.addEventListener('click', (e) => {
          e.preventDefault();
          window.location.href = 'login.html';
        });
      } else if (userPlan === 'studio') {
        upgradeProBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Included in Studio';
        upgradeProBtn.disabled = true;
        upgradeProBtn.style.cssText += 'background:#28a745;cursor:not-allowed;opacity:0.7;';
      } else if (userPlan === 'pro') {
        upgradeProBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Current Plan';
        upgradeProBtn.disabled = true;
        upgradeProBtn.style.cssText += 'background:#28a745;cursor:not-allowed;opacity:0.7;';
      } else {
        upgradeProBtn.addEventListener('click', (e) => {
          e.preventDefault();
          startPayment(user, 'pro');
        });
      }
    }

    // ── Studio button ──
    if (upgradeStudioBtn) {
      if (!user) {
        upgradeStudioBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Sign in to upgrade';
        upgradeStudioBtn.addEventListener('click', (e) => {
          e.preventDefault();
          window.location.href = 'login.html';
        });
      } else if (userPlan === 'studio') {
        upgradeStudioBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Current Plan';
        upgradeStudioBtn.disabled = true;
        upgradeStudioBtn.style.cssText += 'background:#28a745;cursor:not-allowed;opacity:0.7;';
      } else {
        upgradeStudioBtn.addEventListener('click', (e) => {
          e.preventDefault();
          startPayment(user, 'studio');
        });
      }
    }

    if (!upgradeProBtn && !upgradeStudioBtn) {
      console.error('Upgrade buttons not found in DOM');
    }
  });
}

async function startPayment(user, planType) {
  const btnId = planType === 'studio' ? 'upgradeStudioBtn' : 'upgradeProBtn';
  const button = document.getElementById(btnId);
  if (!button) return;

  const originalText = button.innerHTML;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  button.disabled = true;

  try {
    // Determine amount based on plan and billing period
    let localAmount;
    if (planType === 'studio') {
      localAmount = billingPeriod === 'yearly'
        ? await getStudioYearlyLocalPrice()
        : await getStudioLocalPrice();
    } else {
      localAmount = billingPeriod === 'yearly'
        ? await getProYearlyLocalPrice()
        : await getLocalPrice();
    }
    const currencyCode = await getCurrencyCode();
    const planLabel    = `${planType}-${billingPeriod}`; // e.g. "studio-yearly"

    const paymentUrl = `${apiConfig.baseUrl}/api/payment/initialize`;
    diagnostics.log('Initiating payment request', { paymentUrl, planLabel, localAmount, currencyCode });

    let response;
    try {
      // Get Firebase ID token — server reads userId/email from the token,
      // so we do NOT send those fields in the body.
      const idToken = await user.getIdToken();
      response = await fetch(paymentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          // userId and email intentionally omitted — server reads from verified token
          fullName:    user.displayName || 'PREP User',
          planType:    planLabel,
          amount:      localAmount,
          currency:    currencyCode,
        }),
      });
    } catch (fetchError) {
      diagnostics.error('Network/CORS error', { message: fetchError.message });
      showErrorModal('Payment service is temporarily unavailable. Please try again in a moment or contact support if the problem persists.');
      button.innerHTML = originalText;
      button.disabled  = false;
      return;
    }

    if (!response.ok) {
      let errorData = {};
      try { errorData = await response.json(); } catch (_) {}
      diagnostics.error('Server error', { status: response.status, data: errorData });
      showErrorModal('We encountered a problem processing your payment. Please try again or contact support.');
      button.innerHTML = originalText;
      button.disabled  = false;
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      showErrorModal('Server returned invalid response. Please try again.');
      button.innerHTML = originalText;
      button.disabled  = false;
      return;
    }

    if (!data.success) {
      showErrorModal(data.message || 'Failed to initialize payment');
      button.innerHTML = originalText;
      button.disabled  = false;
      return;
    }

    // Open Flutterwave payment modal
    if (data.data?.paymentLink) {
      window.location.href = data.data.paymentLink;
    } else if (window.FlutterwaveCheckout) {
      const flwPublicKey =
        window.PREP_CONFIG?.flutterwavePublicKey ||
        import.meta?.env?.VITE_FLUTTERWAVE_PUBLIC_KEY || '';
      if (!flwPublicKey) {
        showErrorModal('Payment configuration error. Please contact support.');
        button.innerHTML = originalText;
        button.disabled  = false;
        return;
      }
      const planTitle = planType === 'studio' ? 'PREP Studio Subscription' : 'PREP Pro Subscription';
      window.FlutterwaveCheckout({
        public_key: flwPublicKey,
        tx_ref:     data.data.txRef,
        amount:     localAmount,
        currency:   currencyCode,
        payment_options: 'card,ussd,account,credit_topup,apple_pay,google_pay',
        customer: {
          email: user.email,
          name:  user.displayName || 'PREP User',
        },
        customizations: {
          title:       planTitle,
          description: `${billingPeriod === 'yearly' ? 'Yearly' : 'Monthly'} subscription to PREP ${planType.toUpperCase()} plan`,
          logo:        '/assets/logo.png',
        },
        onclose: () => {
          button.innerHTML = originalText;
          button.disabled  = false;
        },
        callback: async (response) => {
          if (response.status === 'successful') {
            await verifyPayment(response.transaction_id, planLabel);
          } else {
            showErrorModal('Payment was not completed');
            button.innerHTML = originalText;
            button.disabled  = false;
          }
        },
      });
    } else {
      showErrorModal('Flutterwave payment system not loaded');
      button.innerHTML = originalText;
      button.disabled  = false;
    }

  } catch (error) {
    diagnostics.error('Unexpected payment error', { message: error.message, stack: error.stack });
    showErrorModal(error.message || 'An unexpected error occurred during payment');
    button.innerHTML = originalText;
    button.disabled  = false;
  }
}

async function verifyPayment(transactionId, plan) {
  try {
    const verifyUrl = `${apiConfig.baseUrl}/api/payment/verify`;
    console.log('Verifying payment at:', verifyUrl);

    // Get the current user's Firebase ID token to authenticate the request.
    // The server extracts the UID from this token — we do NOT send userId in the body.
    const user = auth.currentUser;
    if (!user) {
      showErrorModal('You must be signed in to verify a payment.');
      return;
    }
    const idToken = await user.getIdToken();

    let response;
    try {
      response = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ 
          transactionId: transactionId,
          plan: plan
          // userId intentionally omitted — server reads it from the verified token
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
      // data.plan comes back already normalized by the server (e.g. 'studio', 'pro')
      const planLabel = (data.plan || plan).startsWith('studio') ? 'PREP Studio' : 'PREP Pro';
      showSuccessModal(`Welcome to ${planLabel}! 🎉`);
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
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    font-family: 'Poppins', sans-serif;
  `;

  modal.innerHTML = `
    <div style="
      background: white;
      padding: 48px 36px;
      border-radius: 24px;
      text-align: center;
      max-width: 450px;
      width: 90%;
      box-shadow: 0 25px 60px rgba(0,0,0,0.25);
    ">
      <div style="
        width: 80px;
        height: 80px;
        margin: 0 auto 24px;
        background: #fee;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 2.5rem;
      ">⚠️</div>
      
      <h2 style="
        margin: 0 0 12px;
        color: #d32f2f;
        font-size: 1.5rem;
        font-weight: 700;
      ">Payment Unavailable</h2>
      
      <p style="
        margin: 0 0 28px;
        color: #666;
        font-size: 1rem;
        line-height: 1.6;
      ">${message}</p>
      
      <div style="
        background: #f0f0f0;
        border-radius: 12px;
        padding: 16px;
        margin: 0 0 24px;
        font-size: 0.9rem;
        color: #666;
        line-height: 1.5;
      ">
        <p style="margin: 0;">
          <strong>💡 Helpful tips:</strong><br>
          • Check your internet connection<br>
          • Try again in a few moments<br>
          • Contact support if this persists
        </p>
      </div>
      
      <div style="display: flex; gap: 12px;">
        <button onclick="this.closest('div').parentElement.remove()" style="
          flex: 1;
          padding: 12px 24px;
          background: #ff6500;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 700;
          font-size: 0.95rem;
          transition: background 0.2s ease;
        " onmouseover="this.style.background='#e55c00'" onmouseout="this.style.background='#ff6500'"
        >Close</button>
        <button onclick="window.location.href='contactsupport.html'" style="
          flex: 1;
          padding: 12px 24px;
          background: #f0f0f0;
          color: #666;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 700;
          font-size: 0.95rem;
          transition: background 0.2s ease;
        " onmouseover="this.style.background='#e0e0e0'" onmouseout="this.style.background='#f0f0f0'"
        >Contact Support</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}