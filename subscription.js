import { auth, db } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

/**
 * Subscription and Plan Management Utilities
 */

const PLAN_FEATURES = {
  free: {
    maxProjects: 1,
    storage: 52428800, // 50MB in bytes
    aiFeatures: ['basic_breakdown'],
    canCreateTeam: false,
    prioritySupport: false,
  },
  pro: {
    maxProjects: Infinity,
    storage: 524288000, // 500MB in bytes
    aiFeatures: ['basic_breakdown', 'advanced_analysis', 'detailed_reports'],
    canCreateTeam: true,
    maxTeamMembers: 5,
    prioritySupport: true,
  },
  studio: {
    maxProjects: Infinity,
    storage: 2147483648, // 2GB in bytes
    aiFeatures: ['all'],
    canCreateTeam: true,
    maxTeamMembers: 50,
    prioritySupport: true,
    dedicatedSupport: true,
  },
};

/**
 * Get user's current plan and subscription info
 */
export async function getUserPlan() {
  const userId = auth.currentUser?.uid;
  if (!userId) return { plan: 'free', subscription: null };

  try {
    const userRef = doc(db, 'users', userId);
    const snapshot = await getDoc(userRef);

    if (snapshot.exists()) {
      const data = snapshot.data();
      const raw = data.plan || 'free';
      // Normalise billing-period suffixes and aliases
      const aliases = { premium: 'pro', paid: 'pro' };
      const base = raw.toLowerCase().replace(/-(monthly|yearly|annual)$/, '');
      const plan = aliases[base] || base;
      return {
        plan,
        subscription: data.subscription || null,
        subscriptionId: data.subscriptionId || null,
      };
    }
  } catch (error) {
    console.error('Error fetching user plan:', error);
  }

  return { plan: 'free', subscription: null };
}

/**
 * Check if user is on Pro plan
 */
export async function isProUser() {
  const userPlan = await getUserPlan();
  return userPlan.plan === 'pro' || userPlan.plan === 'studio';
}

/**
 * Check if feature is available for user's plan
 */
export async function hasFeature(featureName) {
  const userPlan = await getUserPlan();
  const features = PLAN_FEATURES[userPlan.plan]?.aiFeatures || [];

  if (features[0] === 'all') return true;
  return features.includes(featureName);
}

/**
 * Get feature limits for user's plan
 */
export async function getFeatureLimits() {
  const userPlan = await getUserPlan();
  return PLAN_FEATURES[userPlan.plan] || PLAN_FEATURES.free;
}

/**
 * Check if user can create new project (based on max projects limit)
 */
export async function canCreateProject(currentProjectCount = 0) {
  const userPlan = await getUserPlan();
  const maxProjects = PLAN_FEATURES[userPlan.plan].maxProjects;
  return currentProjectCount < maxProjects;
}

/**
 * Get upgrade prompt message for feature
 */
export function getUpgradeMessage(featureName) {
  const messages = {
    multi_projects: 'Upgrade to Pro to create unlimited projects',
    advanced_ai: 'Upgrade to Pro for advanced AI analysis',
    priority_support: 'Upgrade to Pro for priority support',
    team_collaboration: 'Upgrade to Pro to collaborate with teams',
    storage: 'Upgrade to Pro for expanded storage',
  };

  return messages[featureName] || 'Upgrade to Pro to unlock this feature';
}

/**
 * Show upgrade prompt modal
 */
export function showUpgradePrompt(featureName) {
  const message = getUpgradeMessage(featureName);

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
    z-index: 10000;
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
      <div style="font-size: 3rem; margin-bottom: 15px;">🚀</div>
      <h2 style="margin: 0 0 10px; color: #2f0e4f; font-size: 1.5rem;">Unlock Pro Features</h2>
      <p style="margin: 0 0 20px; color: #6f6578; line-height: 1.6;">${message}</p>
      <div style="display: flex; gap: 10px;">
        <button onclick="this.closest('div').parentElement.remove()" style="
          flex: 1;
          padding: 12px;
          background: #f0f0f0;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          color: #333;
        ">Maybe Later</button>
        <button onclick="window.location.href='pricing.html'" style="
          flex: 1;
          padding: 12px;
          background: #ff6500;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
        ">Upgrade Now</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

/**
 * Get subscription renewal date
 */
export async function getNextRenewalDate() {
  const userPlan = await getUserPlan();
  if (userPlan.subscription?.nextChargeDate) {
    return new Date(userPlan.subscription.nextChargeDate.seconds * 1000);
  }
  return null;
}

/**
 * Format plan name for display
 */
export function formatPlanName(plan) {
  const names = {
    free: 'Starter (Free)',
    pro: 'Creator (Pro)',
    studio: 'Studio Scale',
  };
  return names[plan] || plan;
}

/**
 * Restrict feature based on plan
 */
export async function restrictFeatureIfNeeded(featureName) {
  if (await hasFeature(featureName)) {
    return true;
  }

  showUpgradePrompt(featureName);
  return false;
}
