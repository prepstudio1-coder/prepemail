// verify-email.js
import { getBackendBaseUrl } from './config.js';

const RESEND_COOLDOWN_SEC = 60; // seconds before user can resend

// ─── Read state passed from signup ───────────────────────────────────────────
// signup.js stores { uid, email, fullName } in sessionStorage so this page
// knows who to verify without relying on query-string parameters.
const pendingVerification = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('pendingVerification') || 'null');
  } catch {
    return null;
  }
})();

if (!pendingVerification?.uid || !pendingVerification?.email) {
  // No pending session — send back to signup
  window.location.replace('signup.html');
}

const { uid, email, fullName } = pendingVerification;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const digits      = Array.from(document.querySelectorAll('.otp-digit'));
const verifyBtn   = document.getElementById('verifyBtn');
const messageEl   = document.getElementById('verifyMessage');
const resendBtn   = document.getElementById('resendBtn');
const countdownEl = document.getElementById('countdownText');
const emailLabel  = document.getElementById('verifyEmail');

emailLabel.innerHTML = `Sent to <strong>${email}</strong>`;

// ─── Countdown timer ──────────────────────────────────────────────────────────
let countdownTimer = null;

function startCountdown(seconds) {
  resendBtn.disabled = true;
  clearInterval(countdownTimer);

  const tick = () => {
    if (seconds <= 0) {
      clearInterval(countdownTimer);
      countdownEl.textContent = '';
      resendBtn.disabled = false;
      return;
    }
    countdownEl.textContent = `Resend in ${seconds}s`;
    seconds--;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

startCountdown(RESEND_COOLDOWN_SEC);

// ─── OTP input behaviour ──────────────────────────────────────────────────────
digits.forEach((input, i) => {
  input.addEventListener('input', (e) => {
    // Strip non-digits and keep only first character
    const val = e.target.value.replace(/\D/g, '').slice(0, 1);
    e.target.value = val;
    e.target.classList.toggle('filled', val !== '');

    if (val && i < digits.length - 1) {
      digits[i + 1].focus();
    }
    checkComplete();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
      if (!input.value && i > 0) {
        digits[i - 1].value = '';
        digits[i - 1].classList.remove('filled');
        digits[i - 1].focus();
      } else {
        input.value = '';
        input.classList.remove('filled');
      }
      checkComplete();
      e.preventDefault();
    }

    // Allow pasting from any digit cell
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') return;
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData)
      .getData('text')
      .replace(/\D/g, '')
      .slice(0, 6);

    pasted.split('').forEach((char, idx) => {
      if (digits[i + idx]) {
        digits[i + idx].value = char;
        digits[i + idx].classList.add('filled');
      }
    });

    // Focus the cell after the last pasted digit
    const nextFocus = Math.min(i + pasted.length, digits.length - 1);
    digits[nextFocus].focus();
    checkComplete();
  });

  input.addEventListener('focus', () => input.select());
});

function checkComplete() {
  const complete = digits.every(d => /^\d$/.test(d.value));
  verifyBtn.disabled = !complete;
}

function getOtp() {
  return digits.map(d => d.value).join('');
}

// ─── Message helpers ──────────────────────────────────────────────────────────
function showMessage(msg, type = 'success') {
  messageEl.textContent = msg;
  messageEl.className   = `message ${type}`;
  messageEl.style.display = 'block';
}

function clearMessage() {
  messageEl.textContent = '';
  messageEl.className   = 'message';
  messageEl.style.display = 'none';
}

// ─── Verify ───────────────────────────────────────────────────────────────────
verifyBtn.addEventListener('click', async () => {
  clearMessage();
  const otp = getOtp();

  verifyBtn.disabled = true;
  verifyBtn.innerHTML = '<span class="spinner"></span> Verifying…';

  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, otp })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showMessage(data.error || 'Incorrect code. Please try again.', 'error');
      // Clear inputs on wrong code so user can retype
      digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
      digits[0].focus();
      verifyBtn.disabled = true;
      return;
    }

    // ✅ Verified
    sessionStorage.removeItem('pendingVerification');
    showMessage('Email verified! Redirecting to login…', 'success');
    setTimeout(() => { window.location.href = 'login.html'; }, 1800);
  } catch (err) {
    console.error('OTP verify error:', err);
    showMessage('Something went wrong. Please check your connection and try again.', 'error');
  } finally {
    verifyBtn.textContent = 'Verify Email';
    // Keep disabled if inputs are incomplete
    checkComplete();
  }
});

// ─── Resend ───────────────────────────────────────────────────────────────────
resendBtn.addEventListener('click', async () => {
  clearMessage();
  resendBtn.disabled = true;
  resendBtn.textContent = 'Sending…';

  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, email, fullName })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showMessage(data.error || 'Could not resend code. Please try again shortly.', 'error');
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend code';
      return;
    }

    showMessage('New code sent — check your inbox.', 'success');
    // Clear previous digits
    digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
    digits[0].focus();
    verifyBtn.disabled = true;
    startCountdown(RESEND_COOLDOWN_SEC);
  } catch (err) {
    console.error('OTP resend error:', err);
    showMessage('Failed to resend. Please try again.', 'error');
    resendBtn.disabled = false;
  } finally {
    resendBtn.textContent = 'Resend code';
  }
});
