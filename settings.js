import { initializeAnalytics, logFeatureUsage } from './analytics-init.js';
import { auth, db } from './firebase.js';
import { getBackendBaseUrl } from './config.js';
import {
  signOut,
  deleteUser,
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import {
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getUserPlan, formatPlanName, getNextRenewalDate } from './subscription.js';
import { getFormattedPrice } from './currency-utils.js';
import { getAIUsage } from './gemini-client.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate or retrieve a stable session ID for this browser tab/device.
 * Stored in sessionStorage so it's unique per tab but survives page reloads.
 */
function getSessionId() {
  let sid = sessionStorage.getItem('prep_session_id');
  if (!sid) {
    sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('prep_session_id', sid);
  }
  return sid;
}

/** Detect a human-readable device/browser label */
function getDeviceLabel() {
  const ua = navigator.userAgent;
  let browser = 'Unknown Browser';
  let os = 'Unknown OS';

  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/OPR\/|Opera\//.test(ua)) browser = 'Opera';

  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

/** Register the current session in Firestore under users/{uid}/sessions/{sessionId} */
async function registerSession(user) {
  const sessionId = getSessionId();
  const sessionRef = doc(db, 'users', user.uid, 'sessions', sessionId);
  await setDoc(sessionRef, {
    sessionId,
    deviceLabel: getDeviceLabel(),
    userAgent: navigator.userAgent,
    lastActive: serverTimestamp(),
    createdAt: serverTimestamp(),
    isCurrent: true
  }, { merge: true });
}

/** Update lastActive timestamp for the current session */
async function touchSession(user) {
  const sessionId = getSessionId();
  const sessionRef = doc(db, 'users', user.uid, 'sessions', sessionId);
  await setDoc(sessionRef, { lastActive: serverTimestamp() }, { merge: true });
}

/** Remove a specific session from Firestore */
async function removeSession(uid, sessionId) {
  await deleteDoc(doc(db, 'users', uid, 'sessions', sessionId));
}

/** Fetch all sessions for the current user */
async function fetchSessions(uid) {
  const snap = await getDocs(collection(db, 'users', uid, 'sessions'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Dark Mode ──────────────────────────────────────────────────────────────

function applyDarkMode(isDark) {
  document.body.classList.toggle('dark', isDark);
}

document.addEventListener('DOMContentLoaded', async () => {
  await initializeAnalytics('settings');
  const notificationsOn = localStorage.getItem('notifications') === 'on';
  const notifToggle = document.getElementById('notifToggle');
  if (notifToggle) notifToggle.checked = notificationsOn;

  const darkModeOn = localStorage.getItem('darkMode') === 'on';
  const darkToggle = document.getElementById('darkModeToggle');
  if (darkToggle) darkToggle.checked = darkModeOn;

  applyDarkMode(darkModeOn);
});

// ─── Notifications ──────────────────────────────────────────────────────────

const notifToggle = document.getElementById('notifToggle');
if (notifToggle) {
  notifToggle.addEventListener('change', (e) => {
    localStorage.setItem('notifications', e.target.checked ? 'on' : 'off');
  });
}

// ─── Dark Mode Toggle ───────────────────────────────────────────────────────

const darkToggle = document.getElementById('darkModeToggle');
if (darkToggle) {
  darkToggle.addEventListener('change', (e) => {
    const isDark = e.target.checked;
    localStorage.setItem('darkMode', isDark ? 'on' : 'off');
    applyDarkMode(isDark);
  });
}

// ─── Confirmation Modal ─────────────────────────────────────────────────────

const confirmationModal = document.getElementById('confirmationModal');
const confirmationMessage = document.getElementById('confirmationMessage');
const confirmOkBtn = document.getElementById('confirmOkBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');

function showConfirmationModal(message, onConfirm, okLabel = 'Confirm') {
  if (confirmationMessage) confirmationMessage.textContent = message;
  if (confirmOkBtn) confirmOkBtn.textContent = okLabel;
  if (confirmationModal) confirmationModal.style.display = 'flex';

  const onOkClick = () => { onConfirm(); cleanup(); };
  const onCancelClick = () => { confirmationModal.style.display = 'none'; cleanup(); };
  const cleanup = () => {
    confirmOkBtn.removeEventListener('click', onOkClick);
    confirmCancelBtn.removeEventListener('click', onCancelClick);
  };

  confirmOkBtn.addEventListener('click', onOkClick);
  confirmCancelBtn.addEventListener('click', onCancelClick);
}

// ─── Logout ─────────────────────────────────────────────────────────────────

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    showConfirmationModal('Are you sure you want to log out?', async () => {
      try {
        const user = auth.currentUser;
        if (user) {
          // Remove this session from Firestore before signing out
          await removeSession(user.uid, getSessionId());
        }
        await signOut(auth);
        localStorage.clear();
        window.location.href = 'index.html';
      } catch (error) {
        console.error('Error signing out:', error);
        alert('Failed to log out. Please try again.');
      }
    }, 'Log Out');
  });
}

// ─── Delete Account ─────────────────────────────────────────────────────────

const deleteAccountBtn = document.getElementById('deleteAccountBtn');
if (deleteAccountBtn) {
  deleteAccountBtn.addEventListener('click', () => {
    showConfirmationModal(
      'Delete your account? All your projects and data will be permanently erased. This cannot be undone.',
      async () => {
        const user = auth.currentUser;
        if (!user) return;
        try {
          // Step 1 — Delete all Firestore data under users/{uid}
          // We delete the user document and all known subcollections.
          // Firestore does not cascade-delete subcollections automatically,
          // so we handle each one explicitly.
          const uid = user.uid;
          const subcollections = ['projects', 'collaboratedProjects', 'notifications', 'sessions', 'payments', 'media'];

          for (const sub of subcollections) {
            try {
              const snap = await getDocs(collection(db, 'users', uid, sub));
              const deletes = snap.docs.map(d => deleteDoc(d.ref));
              await Promise.all(deletes);
            } catch (e) {
              console.warn(`Could not delete subcollection ${sub}:`, e.message);
            }
          }

          // Delete the top-level user document
          try {
            await deleteDoc(doc(db, 'users', uid));
          } catch (e) {
            console.warn('Could not delete user document:', e.message);
          }

          // Step 2 — Delete the Firebase Auth account
          await deleteUser(user);

          // Step 3 — Clear local state and redirect
          localStorage.clear();
          sessionStorage.clear();
          window.location.href = 'index.html';
        } catch (error) {
          if (error.code === 'auth/requires-recent-login') {
            alert('For security, please log out and log back in before deleting your account.');
          } else {
            console.error('Error deleting account:', error);
            alert('Failed to delete account. Please try again.');
          }
        }
      },
      'Delete Account'
    );
  });
}

// ─── Change Password ────────────────────────────────────────────────────────

const changePasswordBtn = document.getElementById('changePasswordBtn');
const changePasswordModal = document.getElementById('changePasswordModal');
const cancelPasswordBtn = document.getElementById('cancelPasswordBtn');
const confirmPasswordBtn = document.getElementById('confirmPasswordBtn');
const passwordChangeMessage = document.getElementById('passwordChangeMessage');

function showPasswordMessage(msg, type = 'error') {
  if (!passwordChangeMessage) return;
  passwordChangeMessage.textContent = msg;
  passwordChangeMessage.className = 'password-message ' + type;
}

function closePasswordModal() {
  if (changePasswordModal) changePasswordModal.style.display = 'none';
  ['currentPassword', 'newPassword', 'confirmNewPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showPasswordMessage('');
}

if (changePasswordBtn) {
  changePasswordBtn.addEventListener('click', () => {
    if (changePasswordModal) changePasswordModal.style.display = 'flex';
  });
}

if (cancelPasswordBtn) {
  cancelPasswordBtn.addEventListener('click', closePasswordModal);
}

// Password visibility toggles inside the modal
document.querySelectorAll('.toggle-password-icon').forEach(icon => {
  icon.addEventListener('click', () => {
    const targetId = icon.getAttribute('data-target');
    const input = document.getElementById(targetId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    icon.querySelector('i').classList.toggle('fa-eye', !isPassword);
    icon.querySelector('i').classList.toggle('fa-eye-slash', isPassword);
  });
});

if (confirmPasswordBtn) {
  confirmPasswordBtn.addEventListener('click', async () => {
    const currentPwd = document.getElementById('currentPassword')?.value;
    const newPwd = document.getElementById('newPassword')?.value;
    const confirmPwd = document.getElementById('confirmNewPassword')?.value;

    if (!currentPwd || !newPwd || !confirmPwd) {
      showPasswordMessage('Please fill in all fields.', 'error');
      return;
    }
    if (newPwd.length < 6) {
      showPasswordMessage('New password must be at least 6 characters.', 'error');
      return;
    }
    if (newPwd !== confirmPwd) {
      showPasswordMessage('New passwords do not match.', 'error');
      return;
    }

    confirmPasswordBtn.disabled = true;
    confirmPasswordBtn.textContent = 'Updating...';

    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not authenticated');

      // Re-authenticate before changing password
      const credential = EmailAuthProvider.credential(user.email, currentPwd);
      await reauthenticateWithCredential(user, credential);

      await updatePassword(user, newPwd);
      showPasswordMessage('Password updated successfully!', 'success');

      setTimeout(closePasswordModal, 1800);
    } catch (error) {
      console.error('Password change error:', error);
      if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        showPasswordMessage('Current password is incorrect.', 'error');
      } else if (error.code === 'auth/weak-password') {
        showPasswordMessage('New password is too weak.', 'error');
      } else if (error.code === 'auth/requires-recent-login') {
        showPasswordMessage('Session expired. Please log out and log back in.', 'error');
      } else {
        showPasswordMessage('Failed to update password. Please try again.', 'error');
      }
    } finally {
      confirmPasswordBtn.disabled = false;
      confirmPasswordBtn.textContent = 'Change Password';
    }
  });
}

// ─── Active Devices ─────────────────────────────────────────────────────────

const activeDevicesBtn = document.getElementById('activeDevicesBtn');
const activeDevicesModal = document.getElementById('activeDevicesModal');
const closeDevicesBtn = document.getElementById('closeDevicesBtn');
const devicesLoading = document.getElementById('devicesLoading');
const devicesList = document.getElementById('devicesList');

function formatLastActive(ts) {
  if (!ts) return 'Unknown';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 2) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

function getDeviceIcon(userAgent = '') {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) {
    return '<i class="fas fa-mobile-alt"></i>';
  }
  if (/Tablet|iPad/i.test(userAgent)) {
    return '<i class="fas fa-tablet-alt"></i>';
  }
  return '<i class="fas fa-laptop"></i>';
}

async function loadDevices() {
  const user = auth.currentUser;
  if (!user) return;

  devicesLoading.style.display = 'flex';
  devicesList.style.display = 'none';
  devicesList.innerHTML = '';

  try {
    const sessions = await fetchSessions(user.uid);
    const currentSessionId = getSessionId();

    devicesLoading.style.display = 'none';
    devicesList.style.display = 'block';

    if (sessions.length === 0) {
      devicesList.innerHTML = '<p class="no-devices">No active sessions found.</p>';
      return;
    }

    // Sort: current session first, then by lastActive descending
    sessions.sort((a, b) => {
      if (a.id === currentSessionId) return -1;
      if (b.id === currentSessionId) return 1;
      const aTime = a.lastActive?.toDate?.() || new Date(0);
      const bTime = b.lastActive?.toDate?.() || new Date(0);
      return bTime - aTime;
    });

    sessions.forEach(session => {
      const isCurrent = session.id === currentSessionId;
      const card = document.createElement('div');
      card.className = 'device-card' + (isCurrent ? ' device-card--current' : '');
      card.innerHTML = `
        <div class="device-icon">${getDeviceIcon(session.userAgent)}</div>
        <div class="device-info">
          <span class="device-name">${session.deviceLabel || 'Unknown Device'}</span>
          <span class="device-meta">Last active: ${formatLastActive(session.lastActive)}</span>
          ${isCurrent ? '<span class="device-badge">This device</span>' : ''}
        </div>
        ${!isCurrent ? `<button class="device-remove-btn" data-session="${session.id}" aria-label="Remove device">
          <i class="fas fa-times"></i>
        </button>` : ''}
      `;
      devicesList.appendChild(card);
    });

    // Attach remove handlers
    devicesList.querySelectorAll('.device-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sessionId = btn.getAttribute('data-session');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
          await removeSession(user.uid, sessionId);
          btn.closest('.device-card').remove();
          if (devicesList.querySelectorAll('.device-card').length === 0) {
            devicesList.innerHTML = '<p class="no-devices">No other active sessions.</p>';
          }
        } catch (err) {
          console.error('Failed to remove session:', err);
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-times"></i>';
        }
      });
    });

  } catch (err) {
    console.error('Failed to load devices:', err);
    devicesLoading.style.display = 'none';
    devicesList.style.display = 'block';
    devicesList.innerHTML = '<p class="no-devices">Failed to load devices. Please try again.</p>';
  }
}

if (activeDevicesBtn) {
  activeDevicesBtn.addEventListener('click', () => {
    if (activeDevicesModal) activeDevicesModal.style.display = 'flex';
    loadDevices();
  });
}

if (closeDevicesBtn) {
  closeDevicesBtn.addEventListener('click', () => {
    if (activeDevicesModal) activeDevicesModal.style.display = 'none';
  });
}

// Close modals on backdrop click
[changePasswordModal, activeDevicesModal].forEach(modal => {
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });
  }
});

// ─── Subscription Modal ──────────────────────────────────────────────────────

const subscriptionBtn = document.getElementById('subscriptionBtn');
const subscriptionModal = document.getElementById('subscriptionModal');
const closeSubscriptionBtn = document.getElementById('closeSubscriptionBtn');

const PLAN_FEATURES_DISPLAY = {
  free: [
    { icon: 'fa-folder', text: '1 active project' },
    { icon: 'fa-wand-magic-sparkles', text: 'Basic AI scene breakdowns' },
    { icon: 'fa-film', text: 'Storyboards, shotlists & schedules' },
    { icon: 'fa-hard-drive', text: '50MB upload storage' },
    { icon: 'fa-times-circle', text: 'No team collaboration', muted: true },
  ],
  pro: [
    { icon: 'fa-folder-open', text: 'Unlimited active projects' },
    { icon: 'fa-wand-magic-sparkles', text: 'Advanced AI analysis & reports' },
    { icon: 'fa-hard-drive', text: '500MB upload storage' },
    { icon: 'fa-users', text: 'Team collaboration & sharing' },
    { icon: 'fa-headset', text: 'Priority support' },
  ],
  studio: [
    { icon: 'fa-folder-open', text: 'Unlimited projects & storage' },
    { icon: 'fa-wand-magic-sparkles', text: 'Full AI suite' },
    { icon: 'fa-users', text: 'Custom team size & roles' },
    { icon: 'fa-plug', text: 'API access & SSO' },
    { icon: 'fa-headset', text: 'Dedicated account manager' },
  ],
};

const PLAN_META = {
  free:   { label: 'Free',    badgeClass: 'badge--free',   desc: 'Individual use — 1 project at a time' },
  pro:    { label: 'Pro ✨',  badgeClass: 'badge--pro',    desc: 'Unlimited projects & team tools' },
  studio: { label: 'Studio 🎬', badgeClass: 'badge--studio', desc: 'Custom workflows for production teams' },
};

/**
 * Handle subscription cancellation with confirmation.
 * Calls the backend to downgrade the user to free.
 */
async function handleCancelSubscription(subscriptionId) {
  if (!subscriptionId) {
    alert('No active subscription found. Please contact support.');
    return;
  }

  showConfirmationModal(
    'Cancel your Pro subscription? You will keep Pro access until the end of your current billing period, then be moved to the Free plan.',
    async () => {
      const cancelBtn = document.getElementById('cancelSubBtn');
      if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling...'; }

      try {
        const user = auth.currentUser;
        if (!user) throw new Error('Not authenticated');
        const idToken = await user.getIdToken();

        const res = await fetch(`${getBackendBaseUrl()}/api/subscription/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ subscriptionId, reason: 'User requested cancellation' }),
        });

        const data = await res.json();

        if (data.success) {
          // Close modal and show confirmation
          if (subscriptionModal) subscriptionModal.style.display = 'none';
          alert('Your subscription has been cancelled. You will keep Pro access until the end of your billing period.');
        } else {
          throw new Error(data.message || 'Cancellation failed');
        }
      } catch (err) {
        console.error('Cancellation error:', err);
        alert('Could not cancel subscription: ' + err.message + '. Please contact support.');
        if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel subscription'; }
      }
    },
    'Yes, Cancel'
  );
}

async function openSubscriptionModal() {
  if (!subscriptionModal) return;
  subscriptionModal.style.display = 'flex';

  const subLoading = document.getElementById('subLoading');
  const subContent = document.getElementById('subContent');
  subLoading.style.display = 'flex';
  subContent.style.display = 'none';

  try {
    const { plan, subscription } = await getUserPlan();
    const normalizedPlan = ['premium', 'paid'].includes(plan) ? 'pro' : (plan || 'free');
    const meta = PLAN_META[normalizedPlan] || PLAN_META.free;
    const features = PLAN_FEATURES_DISPLAY[normalizedPlan] || PLAN_FEATURES_DISPLAY.free;

    // Badge
    const badge = document.getElementById('subPlanBadge');
    badge.textContent = meta.label;
    badge.className = 'sub-plan-badge ' + meta.badgeClass;

    // Name & description
    document.getElementById('subPlanName').textContent = formatPlanName(normalizedPlan);
    document.getElementById('subPlanDesc').textContent = meta.desc;

    // Features list
    const featureList = document.getElementById('subFeatureList');
    featureList.innerHTML = features.map(f => `
      <li class="${f.muted ? 'sub-feature--muted' : ''}">
        <i class="fas ${f.icon}"></i>
        <span>${f.text}</span>
      </li>
    `).join('');

    // AI Usage widget
    const aiUsageSection = document.getElementById('aiUsageSection');
    const aiUsageFill    = document.getElementById('aiUsageFill');
    const aiUsageText    = document.getElementById('aiUsageText');
    if (aiUsageSection && aiUsageFill && aiUsageText) {
      getAIUsage().then(usage => {
        if (!usage) {
          aiUsageText.textContent = 'Could not load AI usage.';
          return;
        }
        const { used, limit, remaining } = usage;
        const isUnlimited = limit >= 999999;
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));

        // Colour the bar: green → orange → red as it fills up
        const barColor = pct >= 90
          ? 'linear-gradient(90deg,#dc3545,#ff6500)'
          : pct >= 70
            ? 'linear-gradient(90deg,#ff6500,#ffc107)'
            : 'linear-gradient(90deg,#5a189a,#ff6500)';

        aiUsageFill.style.width  = isUnlimited ? '0%' : `${pct}%`;
        aiUsageFill.style.background = barColor;

        if (isUnlimited) {
          aiUsageSection.querySelector('div').style.display = 'none'; // hide bar
          aiUsageText.textContent = `${used} calls used this month — unlimited on your plan.`;
        } else {
          aiUsageText.innerHTML = `
            <strong>${used}</strong> of <strong>${limit}</strong> calls used
            &nbsp;·&nbsp; <strong style="color:${pct>=90?'#dc3545':'#28a745'}">${remaining} remaining</strong>
            &nbsp;·&nbsp; resets ${new Date(new Date().getFullYear(), new Date().getMonth()+1, 1).toLocaleDateString('en-US',{month:'short',day:'numeric'})}
          `;
        }
      }).catch(() => {
        aiUsageText.textContent = 'Could not load AI usage.';
      });
    }

    // Renewal date (Pro/Studio only)
    const renewalEl = document.getElementById('subRenewal');
    const renewalText = document.getElementById('subRenewalText');
    if (normalizedPlan !== 'free' && subscription?.nextChargeDate) {
      const renewDate = subscription.nextChargeDate.toDate
        ? subscription.nextChargeDate.toDate()
        : new Date(subscription.nextChargeDate.seconds * 1000);
      renewalText.textContent = `Renews on ${renewDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
      renewalEl.style.display = 'flex';
    } else {
      renewalEl.style.display = 'none';
    }

    // Action buttons
    const actionsEl = document.getElementById('subActions');
    if (normalizedPlan === 'free') {
      const proPrice = await getFormattedPrice().catch(() => '$8/mo');
      actionsEl.innerHTML = `
        <a href="pricing.html" class="sub-upgrade-btn">
          <i class="fas fa-crown"></i> Upgrade to Pro — ${proPrice}
        </a>
        <a href="pricing.html" class="sub-compare-link">Compare all plans</a>
      `;
    } else {
      actionsEl.innerHTML = `
        <a href="pricing.html" class="sub-manage-btn">
          <i class="fas fa-sliders"></i> Manage Plan
        </a>
      `;
    }

    // Payment history (Pro/Studio only)
    const historySection = document.getElementById('paymentHistorySection');
    const historyList = document.getElementById('paymentHistoryList');
    if (normalizedPlan !== 'free' && historySection && historyList) {
      historySection.style.display = 'block';
      historyList.innerHTML = '<p style="font-size:0.85rem;color:#999;">Loading...</p>';
      try {
        const idToken = await auth.currentUser.getIdToken();
        // The server reads userId from the verified token — don't include it in the URL
        const histRes = await fetch(
          `${getBackendBaseUrl()}/api/payment/history`,
          { headers: { 'Authorization': `Bearer ${idToken}` } }
        );
        const histData = await histRes.json();
        if (histData.success && histData.payments.length > 0) {
          historyList.innerHTML = histData.payments.map(p => `
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:0.85rem;">
              <span style="color:#4d4558;">
                ${p.date ? new Date(p.date).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : '—'}
              </span>
              <span style="color:#5a189a;font-weight:600;text-transform:capitalize;">${p.plan} plan</span>
              <span style="color:#28a745;font-weight:700;">${p.currency} ${p.amount}</span>
            </div>
          `).join('');
        } else {
          historyList.innerHTML = '<p style="font-size:0.85rem;color:#999;">No payments yet.</p>';
        }
      } catch (e) {
        historyList.innerHTML = '<p style="font-size:0.85rem;color:#999;">Could not load history.</p>';
      }
    } else if (historySection) {
      historySection.style.display = 'none';
    }

    // Cancel subscription button (Pro/Studio only)
    const cancelSection = document.getElementById('cancelSubSection');
    const cancelBtn = document.getElementById('cancelSubBtn');
    if (normalizedPlan !== 'free' && cancelSection && cancelBtn) {
      cancelSection.style.display = 'block';
      // Remove any previous listener to avoid duplicates
      const freshBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(freshBtn, cancelBtn);
      freshBtn.addEventListener('click', () => handleCancelSubscription(subscription?.subscriptionId));
    } else if (cancelSection) {
      cancelSection.style.display = 'none';
    }

    subLoading.style.display = 'none';
    subContent.style.display = 'block';

  } catch (err) {
    console.error('Failed to load subscription:', err);
    subLoading.innerHTML = '<p style="color:var(--color-soft-gray)">Could not load plan details.</p>';
  }
}

if (subscriptionBtn) {
  subscriptionBtn.addEventListener('click', openSubscriptionModal);
}

if (closeSubscriptionBtn) {
  closeSubscriptionBtn.addEventListener('click', () => {
    if (subscriptionModal) subscriptionModal.style.display = 'none';
  });
}

if (subscriptionModal) {
  subscriptionModal.addEventListener('click', (e) => {
    if (e.target === subscriptionModal) subscriptionModal.style.display = 'none';
  });
}

// ─── Session Registration on Auth State ─────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      await registerSession(user);
    } catch (err) {
      console.warn('Could not register session:', err);
    }

    // Update subscription subtext in the settings list
    try {
      const { plan } = await getUserPlan();
      const subtext = document.getElementById('subscriptionSubtext');
      if (subtext) {
        const labels = { free: 'Starter — Free', pro: 'Creator — Pro ✨', studio: 'Studio Scale 🎬' };
        subtext.textContent = labels[plan] || 'Free';
      }
    } catch (err) {
      console.warn('Could not load plan for subtext:', err);
    }
  }
});
