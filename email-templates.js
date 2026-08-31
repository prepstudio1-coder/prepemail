/**
 * email-templates.js
 * Branded HTML email templates for PREP transactional emails.
 *
 * Brand identity:
 *   Primary   : #5a189a (purple)
 *   Secondary : #ffc300 (gold)
 *   Background: #050505 (studio black)
 *   Font      : -apple-system / Helvetica Neue (web-safe stack)
 *   Style     : dark cinematic, glass card feel
 */

'use strict';

// ─── Shared layout helpers ────────────────────────────────────────────────────

const BASE_BG    = '#050505';
const CARD_BG    = '#120a22';
const BORDER     = 'rgba(90,24,154,0.4)';
const TEXT       = '#f0eaf8';
const MUTED      = '#a89bc4';
const SUBTLE     = '#6b5f80';
const PRIMARY    = '#5a189a';
const SECONDARY  = '#ffc300';
const BTN_GRAD   = 'linear-gradient(135deg,#5a189a,#7b2fbe)';

function emailWrapper(bodyHTML) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="color-scheme" content="dark">
</head>
<body style="margin:0;padding:0;background:${BASE_BG};font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:${TEXT};-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BASE_BG};padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:600px;" cellpadding="0" cellspacing="0" role="presentation">

        <!-- Logo -->
        <tr><td style="padding-bottom:28px;text-align:center;">
          <a href="https://prepapp.name.ng" style="text-decoration:none;">
            <span style="font-family:'Montserrat','Trebuchet MS','Segoe UI',sans-serif;font-size:34px;font-weight:700;letter-spacing:-1.5px;color:${SECONDARY};">PREP</span>
          </a>
        </td></tr>

        <!-- Main card -->
        <tr><td style="background:${CARD_BG};border:1px solid ${BORDER};border-radius:20px;padding:40px 36px;">
          ${bodyHTML}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding-top:24px;text-align:center;color:${SUBTLE};font-size:12px;line-height:1.8;">
          <p style="margin:0;">&copy; 2026 PREP &mdash; Production Workspace for Filmmakers</p>
          <p style="margin:4px 0 0;">
            <a href="https://prepapp.name.ng" style="color:${PRIMARY};text-decoration:none;">prepapp.name.ng</a>
            &nbsp;&bull;&nbsp;
            <a href="https://prepapp.name.ng/contactsupport.html" style="color:${PRIMARY};text-decoration:none;">Support</a>
            &nbsp;&bull;&nbsp;
            <a href="https://prepapp.name.ng/privacy.html" style="color:${PRIMARY};text-decoration:none;">Privacy</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(href, label) {
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${href}"
       style="display:inline-block;background:${BTN_GRAD};color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:50px;font-weight:700;font-size:15px;letter-spacing:0.5px;mso-padding-alt:0;">
      ${label}
    </a>
  </div>`;
}

function divider() {
  return `<div style="border-top:1px solid rgba(90,24,154,0.25);margin:24px 0;"></div>`;
}

function featureList(items) {
  const rows = items.map(item =>
    `<tr>
      <td style="padding:8px 0;color:${MUTED};font-size:14px;line-height:1.5;border-bottom:1px solid rgba(90,24,154,0.12);">
        <span style="color:${SECONDARY};margin-right:10px;">&#10003;</span>${item}
      </td>
    </tr>`
  ).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:20px 0;">${rows}</table>`;
}


// ─── Welcome email ────────────────────────────────────────────────────────────

/**
 * @param {string} fullName
 * @param {'individual'|'company'} accountType
 * @returns {string} HTML
 */
function generateWelcomeEmailHTML(fullName, accountType) {
  const accountTypeDisplay = accountType === 'company' ? 'Company' : 'Individual';

  const body = `
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <span style="display:inline-block;width:60px;height:60px;line-height:60px;border-radius:50%;background:rgba(255,195,0,0.12);border:1px solid rgba(255,195,0,0.3);font-size:26px;text-align:center;">🎬</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:${TEXT};text-align:center;letter-spacing:-0.4px;">
      Welcome to PREP, ${fullName}!
    </h1>
    <p style="margin:0 0 28px;color:${MUTED};font-size:14px;text-align:center;line-height:1.6;">
      Your ${accountTypeDisplay} account is ready. You now have access to the full cinematic pre-production suite.
    </p>

    ${featureList([
      'Write and format professional screenplays',
      'Break down scripts with AI-powered scene analysis',
      'Build storyboards and detailed shot lists',
      'Schedule shoots, manage cast &amp; crew, and track budgets',
      'Collaborate with your team in real time',
    ])}

    ${ctaButton('https://prepapp.name.ng/dashboard.html', 'Open Your Dashboard')}

    ${divider()}

    <p style="margin:0;color:${MUTED};font-size:13px;line-height:1.7;text-align:center;">
      New to PREP? Start with our
      <a href="https://prepapp.name.ng/guide.html" style="color:${SECONDARY};text-decoration:none;font-weight:600;">User Guide</a>
      or reach out at
      <a href="mailto:info@prepapp.name.ng" style="color:${SECONDARY};text-decoration:none;">info@prepapp.name.ng</a>.
    </p>
  `;

  return emailWrapper(body);
}


// ─── Password reset email ─────────────────────────────────────────────────────

/**
 * @param {string} resetLink
 * @returns {string} HTML
 */
function generatePasswordResetEmailHTML(resetLink) {
  const body = `
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <span style="display:inline-block;width:60px;height:60px;line-height:60px;border-radius:50%;background:rgba(90,24,154,0.2);border:1px solid rgba(90,24,154,0.4);font-size:26px;text-align:center;">🔐</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:${TEXT};text-align:center;letter-spacing:-0.4px;">
      Reset your password
    </h1>
    <p style="margin:0 0 28px;color:${MUTED};font-size:14px;text-align:center;line-height:1.6;">
      We received a request to reset the password on your PREP account.<br>
      Click below to choose a new one.
    </p>

    ${ctaButton(resetLink, 'Reset Password')}

    ${divider()}

    <p style="margin:0;color:${SUBTLE};font-size:12px;line-height:1.6;text-align:center;">
      If you didn&rsquo;t request a password reset, you can safely ignore this email.<br>
      This link will expire in&nbsp;<strong style="color:${MUTED};">1&nbsp;hour</strong>.
    </p>
  `;

  return emailWrapper(body);
}


// ─── Payment confirmation email ───────────────────────────────────────────────

const PLAN_FEATURES = {
  pro: [
    'Unlimited active projects',
    'Advanced AI scene &amp; script analysis',
    '500MB+ media upload storage',
    'Team collaboration &amp; real-time sync',
    'Priority support',
  ],
  studio: [
    'Unlimited projects &amp; storage',
    'Custom workflows &amp; templates',
    'Dedicated account manager',
    'SSO &amp; API access',
    'White-label exports',
  ],
};

/**
 * @param {string} fullName
 * @param {'pro'|'studio'} plan
 * @param {number|string} amount  - numeric amount (already in display units, e.g. 1000 for ₦1,000)
 * @param {string} [currency]     - ISO currency code, e.g. 'USD' or 'NGN'
 * @param {string} [billingCycle] - 'monthly' | 'yearly' (optional, inferred from amount if omitted)
 * @returns {string} HTML
 */
function generatePaymentConfirmationEmail(fullName, plan, amount, currency, billingCycle) {
  const safePlan     = (plan === 'studio') ? 'studio' : 'pro';
  const planLabel    = safePlan === 'studio' ? 'Studio' : 'Pro';
  const features     = PLAN_FEATURES[safePlan] || PLAN_FEATURES.pro;
  const currencyCode = currency || 'USD';

  // Format the amount with the correct symbol/code
  let amountDisplay;
  try {
    amountDisplay = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(Number(amount) || 0);
  } catch (_) {
    amountDisplay = `${currencyCode} ${amount}`;
  }

  // Determine billing cycle label
  // If not explicitly provided, try to infer from the amount (yearly amounts are larger)
  const cycle = billingCycle || 'monthly';
  const cycleLabel = cycle === 'yearly' ? 'year' : 'month';

  const body = `
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <span style="display:inline-block;width:60px;height:60px;line-height:60px;border-radius:50%;background:rgba(255,195,0,0.12);border:1px solid rgba(255,195,0,0.3);font-size:26px;text-align:center;">🎉</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:${TEXT};text-align:center;letter-spacing:-0.4px;">
      You&rsquo;re on PREP ${planLabel}!
    </h1>
    <p style="margin:0 0 24px;color:${MUTED};font-size:14px;text-align:center;line-height:1.6;">
      Hi <strong style="color:${TEXT};">${fullName}</strong>, your payment was received and your account is fully upgraded.
    </p>

    <!-- Amount card -->
    <div style="background:rgba(90,24,154,0.15);border:1px solid rgba(90,24,154,0.3);border-radius:14px;padding:20px;text-align:center;margin-bottom:24px;">
      <div style="font-size:28px;font-weight:700;color:${SECONDARY};letter-spacing:-0.5px;">${amountDisplay}</div>
      <div style="font-size:13px;color:${MUTED};margin-top:4px;">per ${cycleLabel}</div>
      <div style="display:inline-block;background:linear-gradient(135deg,#5a189a,#7b2fbe);color:#fff;padding:5px 16px;border-radius:50px;font-size:12px;font-weight:700;letter-spacing:0.6px;margin-top:10px;text-transform:uppercase;">
        ${planLabel} Plan
      </div>
    </div>

    <p style="margin:0 0 12px;color:${TEXT};font-size:14px;font-weight:600;">What&rsquo;s included:</p>
    ${featureList(features)}

    ${ctaButton('https://prepapp.name.ng/dashboard.html', 'Go to Dashboard')}

    ${divider()}

    <p style="margin:0;color:${MUTED};font-size:13px;line-height:1.7;text-align:center;">
      Questions about your subscription?
      <a href="https://prepapp.name.ng/contactsupport.html" style="color:${SECONDARY};text-decoration:none;font-weight:600;">Contact support</a>
      or email us at
      <a href="mailto:info@prepapp.name.ng" style="color:${SECONDARY};text-decoration:none;">info@prepapp.name.ng</a>.
    </p>
  `;

  return emailWrapper(body);
}


module.exports = {
  generateWelcomeEmailHTML,
  generatePasswordResetEmailHTML,
  generatePaymentConfirmationEmail,
};
