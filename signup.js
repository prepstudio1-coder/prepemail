// signup.js
import { auth, db } from './firebase.js';
import { createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { doc, setDoc, getDoc, Timestamp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { initializeAnalytics, logFeatureUsage, logCustomEvent } from './analytics-init.js';

// Form state
let currentStep = 1;
const totalSteps = 4;
let teamMembers = [];
let selectedJobTitles = []; // tracks up to 3 job titles

// Initialize analytics on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', async () => {
    await initializeAnalytics('signup');
    logFeatureUsage('signup_page_viewed');
  });
} else {
  initializeAnalytics('signup').then(() => {
    logFeatureUsage('signup_page_viewed');
  });
}

const signupForm = document.getElementById('signupForm');
const messageBox = document.getElementById('signupMessage');
const signupBtn = document.getElementById('signupBtn');

// Password visibility toggle
const togglePasswordIcons = document.querySelectorAll('.toggle-password');
togglePasswordIcons.forEach(icon => {
  icon.addEventListener('click', () => {
    const targetId = icon.getAttribute('data-target');
    const passwordInput = document.getElementById(targetId);
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);

    const eyeIcon = icon.querySelector('i');
    eyeIcon.classList.toggle('fa-eye');
    eyeIcon.classList.toggle('fa-eye-slash');
  });
});


// Navigation button handlers
document.querySelectorAll('[data-next], [data-prev]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    
    if (btn.dataset.next) {
      const nextStep = parseInt(btn.dataset.next);
      if (validateCurrentStep()) {
        goToStep(nextStep);
      }
    } else if (btn.dataset.prev) {
      const prevStep = parseInt(btn.dataset.prev);
      goToStep(prevStep);
    }
  });
});

// ── Job title multi-picker ──────────────────────────────────────────────────
const MAX_JOB_TITLES = 3;

function renderJobTags() {
  const container = document.getElementById('jobTagsContainer');
  const hint = document.getElementById('jobTitleHint');
  if (!container) return;

  container.innerHTML = '';
  selectedJobTitles.forEach((title, idx) => {
    const tag = document.createElement('span');
    tag.className = 'job-tag';
    tag.innerHTML = `${title} <button type="button" class="job-tag-remove" aria-label="Remove ${title}" data-idx="${idx}">✕</button>`;
    container.appendChild(tag);
  });

  if (hint) {
    if (selectedJobTitles.length >= MAX_JOB_TITLES) {
      hint.textContent = 'Maximum of 3 job titles reached.';
      hint.style.display = 'block';
    } else {
      hint.textContent = '';
      hint.style.display = 'none';
    }
  }
}

const jobTitleSelect = document.getElementById('jobTitleInput');
if (jobTitleSelect) {
  jobTitleSelect.addEventListener('change', () => {
    const val = jobTitleSelect.value;
    if (!val) return;
    if (selectedJobTitles.length >= MAX_JOB_TITLES) {
      jobTitleSelect.value = '';
      return;
    }
    if (!selectedJobTitles.includes(val)) {
      selectedJobTitles.push(val);
      renderJobTags();
    }
    jobTitleSelect.value = '';
  });
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('job-tag-remove')) {
    const idx = parseInt(e.target.getAttribute('data-idx'));
    selectedJobTitles.splice(idx, 1);
    renderJobTags();
  }
});

// ── Account type card highlight ─────────────────────────────────────────────
document.querySelectorAll('input[name="accountTypeInput"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.account-type-card').forEach(card => card.classList.remove('selected'));
    if (radio.checked) {
      radio.closest('.account-type-card').classList.add('selected');
    }
  });
});
// Set initial highlight
const defaultRadio = document.querySelector('input[name="accountTypeInput"]:checked');
if (defaultRadio) defaultRadio.closest('.account-type-card').classList.add('selected');

// ── Searchable country code combobox ────────────────────────────────────────
const COUNTRIES = [
  { flag:'🇩🇿', code:'+213', name:'Algeria' },
  { flag:'🇦🇴', code:'+244', name:'Angola' },
  { flag:'🇦🇷', code:'+54',  name:'Argentina' },
  { flag:'🇦🇺', code:'+61',  name:'Australia' },
  { flag:'🇦🇹', code:'+43',  name:'Austria' },
  { flag:'🇧🇩', code:'+880', name:'Bangladesh' },
  { flag:'🇧🇪', code:'+32',  name:'Belgium' },
  { flag:'🇧🇷', code:'+55',  name:'Brazil' },
  { flag:'🇧🇬', code:'+359', name:'Bulgaria' },
  { flag:'🇨🇲', code:'+237', name:'Cameroon' },
  { flag:'🇨🇦', code:'+1',   name:'Canada' },
  { flag:'🇨🇱', code:'+56',  name:'Chile' },
  { flag:'🇨🇳', code:'+86',  name:'China' },
  { flag:'🇨🇴', code:'+57',  name:'Colombia' },
  { flag:'🇭🇷', code:'+385', name:'Croatia' },
  { flag:'🇨🇺', code:'+53',  name:'Cuba' },
  { flag:'🇨🇿', code:'+420', name:'Czech Republic' },
  { flag:'🇩🇰', code:'+45',  name:'Denmark' },
  { flag:'🇩🇴', code:'+1-809', name:'Dominican Rep.' },
  { flag:'🇪🇨', code:'+593', name:'Ecuador' },
  { flag:'🇪🇬', code:'+20',  name:'Egypt' },
  { flag:'🇪🇹', code:'+251', name:'Ethiopia' },
  { flag:'🇫🇮', code:'+358', name:'Finland' },
  { flag:'🇫🇷', code:'+33',  name:'France' },
  { flag:'🇩🇪', code:'+49',  name:'Germany' },
  { flag:'🇬🇭', code:'+233', name:'Ghana' },
  { flag:'🇬🇷', code:'+30',  name:'Greece' },
  { flag:'🇬🇹', code:'+502', name:'Guatemala' },
  { flag:'🇭🇺', code:'+36',  name:'Hungary' },
  { flag:'🇮🇳', code:'+91',  name:'India' },
  { flag:'🇮🇩', code:'+62',  name:'Indonesia' },
  { flag:'🇮🇷', code:'+98',  name:'Iran' },
  { flag:'🇮🇶', code:'+964', name:'Iraq' },
  { flag:'🇮🇪', code:'+353', name:'Ireland' },
  { flag:'🇮🇱', code:'+972', name:'Israel' },
  { flag:'🇮🇹', code:'+39',  name:'Italy' },
  { flag:'🇯🇵', code:'+81',  name:'Japan' },
  { flag:'🇯🇴', code:'+962', name:'Jordan' },
  { flag:'🇰🇪', code:'+254', name:'Kenya' },
  { flag:'🇰🇼', code:'+965', name:'Kuwait' },
  { flag:'🇱🇾', code:'+218', name:'Libya' },
  { flag:'🇲🇾', code:'+60',  name:'Malaysia' },
  { flag:'🇲🇽', code:'+52',  name:'Mexico' },
  { flag:'🇲🇦', code:'+212', name:'Morocco' },
  { flag:'🇲🇿', code:'+258', name:'Mozambique' },
  { flag:'🇳🇱', code:'+31',  name:'Netherlands' },
  { flag:'🇳🇿', code:'+64',  name:'New Zealand' },
  { flag:'🇳🇬', code:'+234', name:'Nigeria' },
  { flag:'🇳🇴', code:'+47',  name:'Norway' },
  { flag:'🇵🇰', code:'+92',  name:'Pakistan' },
  { flag:'🇵🇪', code:'+51',  name:'Peru' },
  { flag:'🇵🇭', code:'+63',  name:'Philippines' },
  { flag:'🇵🇱', code:'+48',  name:'Poland' },
  { flag:'🇵🇹', code:'+351', name:'Portugal' },
  { flag:'🇵🇷', code:'+1-787', name:'Puerto Rico' },
  { flag:'🇷🇴', code:'+40',  name:'Romania' },
  { flag:'🇷🇺', code:'+7',   name:'Russia' },
  { flag:'🇷🇼', code:'+250', name:'Rwanda' },
  { flag:'🇸🇦', code:'+966', name:'Saudi Arabia' },
  { flag:'🇸🇳', code:'+221', name:'Senegal' },
  { flag:'🇸🇬', code:'+65',  name:'Singapore' },
  { flag:'🇿🇦', code:'+27',  name:'South Africa' },
  { flag:'🇰🇷', code:'+82',  name:'South Korea' },
  { flag:'🇪🇸', code:'+34',  name:'Spain' },
  { flag:'🇱🇰', code:'+94',  name:'Sri Lanka' },
  { flag:'🇸🇩', code:'+249', name:'Sudan' },
  { flag:'🇸🇪', code:'+46',  name:'Sweden' },
  { flag:'🇨🇭', code:'+41',  name:'Switzerland' },
  { flag:'🇹🇼', code:'+886', name:'Taiwan' },
  { flag:'🇹🇿', code:'+255', name:'Tanzania' },
  { flag:'🇹🇭', code:'+66',  name:'Thailand' },
  { flag:'🇹🇳', code:'+216', name:'Tunisia' },
  { flag:'🇦🇪', code:'+971', name:'UAE' },
  { flag:'🇺🇦', code:'+380', name:'Ukraine' },
  { flag:'🇬🇧', code:'+44',  name:'United Kingdom' },
  { flag:'🇺🇸', code:'+1',   name:'USA' },
  { flag:'🇺🇬', code:'+256', name:'Uganda' },
  { flag:'🇻🇪', code:'+58',  name:'Venezuela' },
  { flag:'🇻🇳', code:'+84',  name:'Vietnam' },
  { flag:'🇿🇼', code:'+263', name:'Zimbabwe' },
  { flag:'🇨🇮', code:'+225', name:"Côte d'Ivoire" },
];

(function initCountryCombobox() {
  const trigger    = document.getElementById('countryTrigger');
  const dropdown   = document.getElementById('countryDropdown');
  const searchInput= document.getElementById('countrySearch');
  const listEl     = document.getElementById('countryList');
  const flagEl     = document.getElementById('countryFlag');
  const codeEl     = document.getElementById('countryCodeDisplay');
  const hiddenInput= document.getElementById('countryCodeInput');

  if (!trigger) return;

  function renderList(filter = '') {
    const q = filter.toLowerCase().trim();
    listEl.innerHTML = '';
    const filtered = q
      ? COUNTRIES.filter(c =>
          c.name.toLowerCase().includes(q) ||
          c.code.includes(q) ||
          c.code.replace('+','').includes(q)
        )
      : COUNTRIES;

    if (filtered.length === 0) {
      listEl.innerHTML = '<li class="country-no-results">No results</li>';
      return;
    }

    filtered.forEach(c => {
      const li = document.createElement('li');
      li.className = 'country-option';
      li.setAttribute('role', 'option');
      li.dataset.code = c.code;
      li.innerHTML = `<span class="co-flag">${c.flag}</span><span class="co-name">${c.name}</span><span class="co-code">${c.code}</span>`;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus from leaving search input
        selectCountry(c);
      });
      listEl.appendChild(li);
    });
  }

  function selectCountry(c) {
    flagEl.textContent     = c.flag;
    codeEl.textContent     = c.code;
    hiddenInput.value      = c.code;
    closeDropdown();
  }

  function openDropdown() {
    dropdown.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    searchInput.value = '';
    renderList();
    searchInput.focus();
  }

  function closeDropdown() {
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', () => {
    dropdown.hidden ? openDropdown() : closeDropdown();
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDropdown(); }
  });

  searchInput.addEventListener('input', () => renderList(searchInput.value));

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDropdown();
    if (e.key === 'Enter') {
      const first = listEl.querySelector('.country-option');
      if (first) {
        const code = first.dataset.code;
        const match = COUNTRIES.find(c => c.code === code && first.querySelector('.co-name').textContent === c.name);
        if (match) selectCountry(match);
      }
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!document.getElementById('countryCombobox').contains(e.target)) {
      closeDropdown();
    }
  });

  // Initial render
  renderList();
})();

// Form submission
if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (validateCurrentStep()) {
      submitSignup();
    }
  });
}

function goToStep(step) {
  if (step < 1 || step > totalSteps) return;

  // Hide all steps
  document.querySelectorAll('.form-step').forEach(el => {
    el.classList.remove('active');
    el.classList.add('hidden');
  });

  // Show target step
  const targetStep = document.getElementById(`step${step}`);
  if (targetStep) {
    targetStep.classList.remove('hidden');
    targetStep.classList.add('active');
  }

  // Update progress
  updateProgress(step);
  currentStep = step;
  clearMessage();
}

function updateProgress(step) {
  const progressBar = document.getElementById('progressBar');
  const stepCounter = document.getElementById('stepCounter');
  
  const progress = (step / totalSteps) * 100;

  if (progressBar) {
    progressBar.style.width = progress + '%';
  }

  if (stepCounter) {
    stepCounter.textContent = `${step} of ${totalSteps}`;
  }
}

function validateCurrentStep() {
  clearMessage();

  switch (currentStep) {
    case 1:
      return validateStep1();
    case 2:
      return validateStep2();
    case 3:
      return validateStep3();
    case 4:
      return validateStep4();
    default:
      return false;
  }
}

function validateStep1() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  const confirmPassword = document.getElementById('confirmPassword').value.trim();
  const fullName = document.getElementById('fullNameInput').value.trim();

  if (!email) {
    showMessage('Please enter your email address.', 'error');
    return false;
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showMessage('Please enter a valid email address.', 'error');
    return false;
  }

  if (!password) {
    showMessage('Please enter a password.', 'error');
    return false;
  }

  if (password.length < 8) {
    showMessage('Password must be at least 8 characters.', 'error');
    return false;
  }

  if (!/[A-Z]/.test(password)) {
    showMessage('Password must contain at least one uppercase letter.', 'error');
    return false;
  }

  if (!/[0-9]/.test(password)) {
    showMessage('Password must contain at least one number.', 'error');
    return false;
  }

  if (password !== confirmPassword) {
    showMessage('Passwords do not match.', 'error');
    return false;
  }

  if (!fullName) {
    showMessage('Please enter your full name.', 'error');
    return false;
  }

  return true;
}

function validateStep2() {
  if (selectedJobTitles.length === 0) {
    showMessage('Please select at least one job title.', 'error');
    return false;
  }

  const accountType = document.querySelector('input[name="accountTypeInput"]:checked');
  if (!accountType) {
    showMessage('Please select an account type.', 'error');
    return false;
  }

  return true;
}

function validateStep3() {
  const discoverSource = document.getElementById('discoverSourceInput').value;

  if (!discoverSource) {
    showMessage('Please select how you heard about PREP Studio.', 'error');
    return false;
  }

  return true;
}

function validateStep4() {
  const termsCheckbox = document.getElementById('termsCheckbox').checked;

  if (!termsCheckbox) {
    showMessage('You must agree to our Terms and Conditions.', 'error');
    return false;
  }

  return true;
}



async function submitSignup() {
  clearMessage();
  setLoading(true);

  // Validate ALL steps before submitting, regardless of which step is currently shown.
  // This prevents skipping validation by jumping directly to the final step.
  const allStepsValid = validateStep1() && validateStep2() && validateStep3() && validateStep4();
  if (!allStepsValid) {
    setLoading(false);
    return;
  }

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  const fullName = document.getElementById('fullNameInput').value.trim() || 'User';
  const jobTitle = selectedJobTitles.join(', ');
  const accountTypeRadio = document.querySelector('input[name="accountTypeInput"]:checked');
  const accountType = accountTypeRadio ? accountTypeRadio.value : 'personal';
  const countryCode = document.getElementById('countryCodeInput').value;
  const phone = document.getElementById('phoneInput').value.trim();
  const discoverSource = document.getElementById('discoverSourceInput').value;
  const referralCode = document.getElementById('referralCodeInput')?.value.trim().toUpperCase() || '';
  const newsletter = document.getElementById('newsletterCheckbox').checked;

  // Validation
  if (!email || !password || !fullName || selectedJobTitles.length === 0 || !discoverSource) {
    showMessage('Please complete all required fields.', 'error');
    setLoading(false);
    return;
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // Prepare user data
    const userData = {
      uid: user.uid,
      email: user.email,
      displayName: fullName,
      jobTitles: selectedJobTitles,
      jobTitle,
      accountType,
      phone: phone ? `${countryCode} ${phone}` : '',
      profileImageUrl: '',
      bio: 'New PREP user',
      discoverSource,
      referralCode,
      newsletter,
      createdAt: new Timestamp(Math.floor(Date.now() / 1000), 0),
      joinDate: Timestamp.now(),
      role: 'user',
      plan: 'free'
    };

    // Save user to Firestore
    await setDoc(doc(db, 'users', user.uid), userData);

    // Log successful signup
    await logCustomEvent('user_signup', {
      accountType: accountType,
      discoverSource: discoverSource,
      jobTitles: selectedJobTitles
    });

    // Send OTP verification code via backend (replaces Firebase email-link flow)
    const { getBackendBaseUrl } = await import('./config.js');
    try {
      const otpRes = await fetch(`${getBackendBaseUrl()}/api/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid, email, fullName })
      });
      const otpData = await otpRes.json();
      if (!otpRes.ok || !otpData.success) {
        console.warn('OTP send failed:', otpData.error);
        // Non-fatal — account is created, user can request resend on the verify page
      }
    } catch (otpErr) {
      console.warn('Could not send OTP:', otpErr.message);
    }

    // Send welcome email (non-blocking)
    sendWelcomeEmail(email, fullName, 'personal');

    // Store verification state for the verify-email page
    sessionStorage.setItem('pendingVerification', JSON.stringify({
      uid: user.uid,
      email,
      fullName
    }));

    showMessage('Account created! Redirecting to verify your email…', 'success');
    setLoading(false);
    setTimeout(() => { window.location.href = 'verify-email.html'; }, 1500);
  } catch (error) {
    console.error(error);
    let errMsg = 'An unknown error occurred.';
    switch (error.code) {
      case 'auth/email-already-in-use':
        errMsg = 'An account with this email already exists. Please login.';
        break;
      case 'auth/invalid-email':
        errMsg = 'Invalid email format.';
        break;
      case 'auth/weak-password':
        errMsg = 'Password should be at least 8 characters with one uppercase letter and one number.';
        break;
      case 'auth/network-request-failed':
        errMsg = 'Network error. Check your internet connection.';
        break;
      default:
        errMsg = `Error: ${error.message}`;
        break;
    }
    showMessage(errMsg, 'error');
  } finally {
    setLoading(false);
  }
}

function showMessage(msg, type = 'info') {
  if (messageBox) {
    messageBox.innerText = msg;
    messageBox.className = `message ${type}`;
    messageBox.style.display = 'block';
  }
}

function clearMessage() {
  if (messageBox) {
    messageBox.innerText = '';
    messageBox.className = 'message';
    messageBox.style.display = 'none';
  }
}

function setLoading(isLoading) {
  if (signupBtn) {
    signupBtn.disabled = isLoading;
    if (isLoading) {
      signupBtn.innerHTML = `<span class="spinner"></span> Creating...`;
    } else {
      signupBtn.innerHTML = 'Create Account';
    }
  }
}

// --- Google Sign-Up ---
const googleSignupBtn = document.getElementById('googleSignupBtn');
if (googleSignupBtn) {
  googleSignupBtn.addEventListener('click', async () => {
    googleSignupBtn.disabled = true;
    googleSignupBtn.innerHTML = `<span class="spinner"></span> Connecting...`;

    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      // Check if a Firestore profile already exists (returning user)
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        // Already has an account — just log them in
        localStorage.setItem('welcomeMessage', `Welcome back, ${user.displayName || 'there'}!`);
        window.location.href = 'dashboard.html';
        return;
      }

      // New user — create their profile with Google data
      const fullName = user.displayName || 'User';
      const userData = {
        uid: user.uid,
        email: user.email,
        displayName: fullName,
        profileImageUrl: user.photoURL || '',
        bio: 'New PREP user',
        accountType: 'personal',
        jobTitles: [],
        jobTitle: '',
        phone: '',
        discoverSource: '',
        newsletter: false,
        createdAt: new Timestamp(Math.floor(Date.now() / 1000), 0),
        joinDate: Timestamp.now(),
        role: 'user',
        plan: 'free'
      };

      await setDoc(userRef, userData);

      // Send welcome email (non-blocking)
      sendWelcomeEmail(user.email, fullName, 'personal');

      localStorage.setItem('welcomeMessage', `Hi ${fullName}`);
      window.location.href = 'dashboard.html';
    } catch (error) {
      console.error(error);
      if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
        // User dismissed — no error needed
      } else if (error.code === 'auth/popup-blocked') {
        showMessage('Pop-up was blocked by your browser. Please allow pop-ups for this site and try again.', 'error');
      } else {
        showMessage(`Google sign-up failed: ${error.message}`, 'error');
      }
    } finally {
      googleSignupBtn.disabled = false;
      googleSignupBtn.innerHTML = `<svg class="google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Sign up with Google`;
    }
  });
}

/**
 * Send welcome email to new user via backend.
 * Sends the user's Firebase ID token so the server can verify the caller.
 */
async function sendWelcomeEmail(email, fullName, accountType) {
  try {
    const { getBackendBaseUrl } = await import('./config.js');
    const user = auth.currentUser;
    // If somehow called without an authenticated user, skip silently
    if (!user) {
      console.warn('sendWelcomeEmail called without authenticated user — skipping');
      return;
    }
    const idToken = await user.getIdToken();
    const response = await fetch(`${getBackendBaseUrl()}/api/send-welcome-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        fullName,
        accountType
        // email is taken server-side from the verified token
      })
    });

    const result = await response.json();

    if (result.success) {
      console.log('Welcome email sent successfully:', result.messageId);
    } else {
      console.error('Failed to send welcome email:', result.error);
    }
  } catch (error) {
    console.error('Error sending welcome email:', error);
  }
}
