/**
 * Plan Configuration and Limits
 * Centralized configuration for free and pro plan features
 */

import { getFormattedPrice, getFormattedProYearlyPrice, getFormattedStudioPrice, getFormattedStudioYearlyPrice } from './currency-utils.js';

export const PLAN_LIMITS = {
  free: {
    name: 'Free',
    price: 'Free',
    maxProjects: 1,
    maxStorageMB: 50,
    features: {
      basic: true,
      basicSceneBreakdowns: true,
      aiSceneAnalysis: true,        // Free users CAN ACCESS features
      advancedAI: true,             // Just limited to 1 project
      scriptBreakdown: true,
      advancedScriptBreakdown: true,
      storyboarding: true,
      shotPlanning: true,
      teamCollaboration: false,     // No project sharing, no team features
      advancedReporting: false,
      prioritySupport: false
    },
    icon: '👤',
    badge: 'Free',
    aiLevel: 'basic',
    description: 'Individual use only',
    teamCollaborationDetails: {
      canShare: false,
      canInviteMembers: false,
      maxTeamMembers: 1,
      hasComments: false,
      hasVersionHistory: false
    }
  },
  pro: {
    name: 'Pro',
    price: 'Loading...', // Will be updated with dynamic price
    priceYearly: 'Loading...',
    maxProjects: Infinity,
    maxStorageMB: 500,
    features: {
      basic: true,
      basicSceneBreakdowns: true,
      aiSceneAnalysis: true,
      advancedAI: true,
      scriptBreakdown: true,
      advancedScriptBreakdown: true,
      storyboarding: true,
      shotPlanning: true,
      teamCollaboration: true,
      advancedReporting: true,
      prioritySupport: true
    },
    icon: '✨',
    badge: 'Pro ✨',
    aiLevel: 'advanced',
    description: 'Multiple projects & team tools',
    teamCollaborationDetails: {
      canShare: true,
      canInviteMembers: true,
      maxTeamMembers: 5,
      hasComments: true,
      hasVersionHistory: true
    }
  },
  studio: {
    name: 'Studio',
    price: 'Loading...', // Will be updated with dynamic price
    priceYearly: 'Loading...',
    maxProjects: Infinity,
    maxStorageMB: 2000,
    features: {
      basic: true,
      basicSceneBreakdowns: true,
      aiSceneAnalysis: true,
      advancedAI: true,
      scriptBreakdown: true,
      advancedScriptBreakdown: true,
      storyboarding: true,
      shotPlanning: true,
      teamCollaboration: true,
      advancedReporting: true,
      prioritySupport: true,
      customWorkflows: true,
      dedicatedSupport: true,
      apiAccess: true
    },
    icon: '🎬',
    badge: 'Studio 🎬',
    aiLevel: 'advanced',
    description: 'Everything + custom workflows',
    teamCollaborationDetails: {
      canShare: true,
      canInviteMembers: true,
      maxTeamMembers: 50,
      hasComments: true,
      hasVersionHistory: true,
      hasRoles: true,
      hasActivityLog: true
    }
  }
};

export const DEFAULT_PLAN = 'free';

export function getPlanConfig(plan) {
  // Normalize plan aliases to their canonical tier
  const planAliases = { premium: 'pro', paid: 'pro' };
  const normalizedPlan = planAliases[plan] || plan;
  return PLAN_LIMITS[normalizedPlan] || PLAN_LIMITS[DEFAULT_PLAN];
}

export function getPlanLimit(plan, limitKey) {
  const config = getPlanConfig(plan);
  return config[limitKey] || null;
}

export function hasFeature(plan, featureName) {
  const config = getPlanConfig(plan);
  return config.features?.[featureName] === true;
}

export function canCreateProject(plan, currentProjectCount) {
  const maxProjects = getPlanLimit(plan, 'maxProjects');
  return currentProjectCount < maxProjects;
}

/**
 * Initialize plan prices with user's local currency
 */
export async function initializePrices() {
  try {
    const [proMonthly, proYearly, studioMonthly, studioYearly] = await Promise.all([
      getFormattedPrice(),
      getFormattedProYearlyPrice(),
      getFormattedStudioPrice(),
      getFormattedStudioYearlyPrice(),
    ]);
    PLAN_LIMITS.pro.price = proMonthly;
    PLAN_LIMITS.pro.priceYearly = proYearly;
    PLAN_LIMITS.studio.price = studioMonthly;
    PLAN_LIMITS.studio.priceYearly = studioYearly;
    return { proMonthly, proYearly, studioMonthly, studioYearly };
  } catch (error) {
    console.error('Error initializing prices:', error);
    PLAN_LIMITS.pro.price = '$8/mo';
    PLAN_LIMITS.pro.priceYearly = '$77/yr';
    PLAN_LIMITS.studio.price = '$20/mo';
    PLAN_LIMITS.studio.priceYearly = '$192/yr';
    return { proMonthly: '$8/mo', proYearly: '$77/yr', studioMonthly: '$20/mo', studioYearly: '$192/yr' };
  }
}

export default PLAN_LIMITS;
