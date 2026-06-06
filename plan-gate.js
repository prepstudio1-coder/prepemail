/**
 * plan-gate.js — PREP Free Tier Feature Limits
 *
 * Single source of truth for all quantity limits on the free plan.
 * Every feature file imports checkFreeTierLimit() and calls it before
 * saving a new item. Pro/Studio users are never blocked.
 *
 * Usage:
 *   import { checkFreeTierLimit } from './plan-gate.js';
 *
 *   const allowed = await checkFreeTierLimit('shots', currentShots.length);
 *   if (!allowed) return; // gate already showed the upgrade prompt
 */

import { auth, db } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// ─── Limits ───────────────────────────────────────────────────────────────────
// Free tier quantity limits per feature.
// Pro/Studio = no limit enforced here (Infinity).
// Philosophy: "taste everything, limited depth" — free users can access every
// feature but hit a cap that makes sense for a short film. They see the full
// product, get real value, and upgrade when they need more.
export const FREE_LIMITS = {
  scenes:    20,   // script breakdown scenes  — covers a short film
  shots:     30,   // shot list shots (per project total) — covers 2-3 scenes
  frames:    15,   // storyboard frames — covers one sequence
  castCrew:   8,   // cast + crew entries combined — covers a small cast
  locations:  5,   // locations — covers a short film
  costumes:  10,   // costume items
  budget:    20,   // budget line items — covers a basic budget
  // Limited-access features (not quantity-capped, but capped by use count):
  callSheet:  1,   // free users can generate/view 1 call sheet (no PDF export)
  avScript:   1,   // free users can create 1 AV script (no PDF export)
};

// Features that are fully locked on free (no quantity — just blocked entirely).
// These show a lock screen instead of a limit toast.
// NOTE: callSheet, stripBoard, avScript, scriptReport have been moved to
// LIMITED ACCESS — free users can view/use them with restrictions instead of
// being fully blocked. Only PDF export remains locked via checkPdfExport().
export const FREE_LOCKED_FEATURES = new Set([
  // Empty — all features now use limited access instead of full lock.
  // Keeping this Set for future use if needed.
]);

// ─── Plan cache ───────────────────────────────────────────────────────────────
let _cachedPlan = null;
let _cacheTime  = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getUserPlanTier() {
  const now = Date.now();
  if (_cachedPlan && now - _cacheTime < CACHE_TTL) return _cachedPlan;

  try {
    const user = auth.currentUser;
    if (!user) return 'free';
    const snap = await getDoc(doc(db, 'users', user.uid));
    const raw  = snap.exists() ? (snap.data().plan || 'free') : 'free';
    // Normalise aliases and billing-period suffixes (e.g. "pro-yearly" → "pro")
    const aliases = { premium: 'pro', paid: 'pro' };
    const base = raw.toLowerCase().replace(/-(monthly|yearly|annual)$/, '');
    _cachedPlan = aliases[base] || base;
    _cacheTime  = now;
    return _cachedPlan;
  } catch {
    return 'free';
  }
}

/** Call this whenever the plan changes (e.g. after upgrade) to bust the cache. */
export function bustPlanCache() {
  _cachedPlan = null;
  _cacheTime  = 0;
}

// ─── Gate check ───────────────────────────────────────────────────────────────
/**
 * Check whether a free user is allowed to add one more item to a feature.
 *
 * @param {string} featureKey  - Key from FREE_LIMITS (e.g. 'shots', 'castCrew')
 * @param {number} currentCount - How many items already exist
 * @returns {Promise<boolean>}  - true = allowed, false = blocked (toast shown)
 */
export async function checkFreeTierLimit(featureKey, currentCount) {
  const plan = await getUserPlanTier();
  if (plan !== 'free') return true; // Pro/Studio — never blocked

  const limit = FREE_LIMITS[featureKey];
  if (limit === undefined) return true; // unknown key — allow

  if (currentCount >= limit) {
    showUpgradeToast(featureKey, limit);
    return false;
  }
  return true;
}

/**
 * Check whether a free user can access a fully-locked feature.
 * Now that all features use limited access instead of full lock,
 * this always returns true. Kept for backward compatibility.
 *
 * @param {string} featureKey  - Previously a key from FREE_LOCKED_FEATURES
 * @returns {Promise<boolean>}  - always true (features are now limited, not locked)
 */
export async function checkLockedFeature(featureKey) {
  // All features now use limited access — no feature is fully blocked.
  // Free users see a limited-access banner instead of a lock screen.
  return true;
}

/**
 * Check whether a free user can access a limited feature (call sheet, AV script).
 * Free users get 1 use; after that they see an upgrade prompt.
 * Pro/Studio users are never blocked.
 *
 * @param {string} featureKey  - 'callSheet' | 'avScript'
 * @param {number} currentCount - How many they've already created
 * @returns {Promise<boolean>}  - true = allowed, false = blocked (banner shown)
 */
export async function checkLimitedFeature(featureKey, currentCount) {
  const plan = await getUserPlanTier();
  if (plan !== 'free') return true;

  const limit = FREE_LIMITS[featureKey];
  if (limit === undefined) return true;

  if (currentCount >= limit) {
    showUpgradeToast(featureKey, limit);
    return false;
  }

  // Show a soft "limited access" info banner so the user knows they're on free
  showLimitedAccessBanner(featureKey, limit);
  return true;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
const FEATURE_LABELS = {
  scenes:    'script breakdown scenes',
  shots:     'shots',
  frames:    'storyboard frames',
  castCrew:  'cast & crew members',
  locations: 'locations',
  costumes:  'costume items',
  budget:    'budget line items',
  callSheet: 'Call Sheet',
  avScript:  'AV Script',
  stripBoard:'Strip Board',
  scriptReport: 'Script Report',
};

function showUpgradeToast(featureKey, limit) {
  const label = FEATURE_LABELS[featureKey] || featureKey;
  const msg   = `Free plan includes up to ${limit} ${label}. Upgrade to Pro for unlimited.`;

  // Try to use the page's existing toast container
  const container = document.getElementById('toastContainer')
    || document.getElementById('toastNotification')?.parentElement;

  if (container && container.id === 'toastContainer') {
    // Pages that use a toast container (ai_script style)
    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.style.cssText = 'max-width:380px;cursor:pointer;';
    toast.innerHTML = `
      <i class="fas fa-lock"></i>
      <span>
        <strong>Limit reached (${limit} ${label}).</strong><br>
        <a href="pricing.html" style="color:#ff6500;font-weight:700;">Upgrade to Pro</a> for unlimited access.
      </span>`;
    toast.addEventListener('click', () => { window.location.href = 'pricing.html'; });
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 7000);
  } else {
    // Fallback: simple alert-style banner injected at top of page
    _showBanner(msg);
  }
}

/**
 * Show a non-blocking info banner for limited-access features.
 * Tells the user they're on the free tier and what the limit is,
 * without blocking them from using the feature.
 */
function showLimitedAccessBanner(featureKey, limit) {
  const label = FEATURE_LABELS[featureKey] || featureKey;
  const existing = document.getElementById('planLimitedBanner');
  if (existing) return; // already shown

  const banner = document.createElement('div');
  banner.id = 'planLimitedBanner';
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:9000;
    background:linear-gradient(90deg,#5a189a,#7b2fbe);
    color:#fff;padding:10px 20px;
    display:flex;align-items:center;justify-content:space-between;
    font-family:'Poppins',sans-serif;font-size:0.85rem;gap:12px;
    box-shadow:0 2px 12px rgba(90,24,154,0.25);
  `;
  banner.innerHTML = `
    <span style="display:flex;align-items:center;gap:8px;">
      <i class="fas fa-info-circle" style="color:#ffd700;"></i>
      <span>Free plan: up to <strong>${limit} ${label}</strong>. PDF export requires Pro or Studio.</span>
    </span>
    <span style="display:flex;align-items:center;gap:12px;">
      <a href="pricing.html" style="color:#ffd700;font-weight:700;text-decoration:none;white-space:nowrap;">
        <i class="fas fa-crown"></i> Upgrade to Pro
      </a>
      <button onclick="this.closest('#planLimitedBanner').remove()" style="
        background:none;border:none;color:#fff;cursor:pointer;font-size:1rem;opacity:0.7;padding:0;
      " aria-label="Dismiss">✕</button>
    </span>
  `;
  document.body.insertAdjacentElement('afterbegin', banner);
  // Push page content down so banner doesn't overlap
  document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0') + 42) + 'px';
}

function showLockedOverlay(featureKey) {
  // Kept for backward compatibility — now shows limited access banner instead
  showLimitedAccessBanner(featureKey, FREE_LIMITS[featureKey] || 1);
}

function _showBanner(msg) {
  const existing = document.getElementById('planGateBanner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'planGateBanner';
  banner.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:#2f0e4f;color:#fff;padding:14px 24px;border-radius:16px;
    font-family:'Poppins',sans-serif;font-size:0.9rem;z-index:9999;
    display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);
    max-width:420px;cursor:pointer;
  `;
  banner.innerHTML = `
    <i class="fas fa-lock" style="color:#ff6500;font-size:1.1rem;"></i>
    <span>${msg}</span>
    <a href="pricing.html" style="color:#ff6500;font-weight:700;white-space:nowrap;text-decoration:none;">Upgrade →</a>
  `;
  banner.addEventListener('click', () => { window.location.href = 'pricing.html'; });
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 7000);
}

/**
 * Check if the current user can export a PDF.
 * Free users see an upgrade banner and get false returned.
 * @returns {Promise<boolean>}
 */
export async function checkPdfExport() {
  const plan = await getUserPlanTier();
  if (plan !== 'free') return true;
  _showBanner('PDF export is a Pro feature. Upgrade to Pro to export your work.');
  return false;
}
