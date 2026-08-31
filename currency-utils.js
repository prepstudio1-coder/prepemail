/**
 * Currency Utilities
 * Handles geolocation, currency mapping, and price conversion
 */

// Country to currency code mapping
const COUNTRY_CURRENCY_MAP = {
  // Africa
  'NG': { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', rate: 1500 },
  'ZA': { code: 'ZAR', name: 'South African Rand', symbol: 'R', rate: 18 },
  'EG': { code: 'EGP', name: 'Egyptian Pound', symbol: '£', rate: 48 },
  'KE': { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', rate: 130 },
  'GH': { code: 'GHS', name: 'Ghanaian Cedi', symbol: '₵', rate: 13 },
  'UG': { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh', rate: 3700 },
  
  // Americas
  'US': { code: 'USD', name: 'US Dollar', symbol: '$', rate: 1 },
  'CA': { code: 'CAD', name: 'Canadian Dollar', symbol: '$', rate: 1.35 },
  'BR': { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', rate: 5 },
  'MX': { code: 'MXN', name: 'Mexican Peso', symbol: '$', rate: 17 },
  'AR': { code: 'ARS', name: 'Argentine Peso', symbol: '$', rate: 850 },
  
  // Europe
  'GB': { code: 'GBP', name: 'British Pound', symbol: '£', rate: 0.79 },
  'DE': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'FR': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'IT': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'ES': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'NL': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'BE': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'AT': { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
  'SE': { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', rate: 10.5 },
  'NO': { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', rate: 10.8 },
  'CH': { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr', rate: 0.88 },
  'RU': { code: 'RUB', name: 'Russian Ruble', symbol: '₽', rate: 90 },
  'PL': { code: 'PLN', name: 'Polish Zloty', symbol: 'zł', rate: 4 },
  'TR': { code: 'TRY', name: 'Turkish Lira', symbol: '₺', rate: 33 },
  
  // Asia
  'IN': { code: 'INR', name: 'Indian Rupee', symbol: '₹', rate: 83 },
  'JP': { code: 'JPY', name: 'Japanese Yen', symbol: '¥', rate: 150 },
  'CN': { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', rate: 7.2 },
  'SG': { code: 'SGD', name: 'Singapore Dollar', symbol: '$', rate: 1.35 },
  'MY': { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', rate: 4.8 },
  'TH': { code: 'THB', name: 'Thai Baht', symbol: '฿', rate: 36 },
  'PH': { code: 'PHP', name: 'Philippine Peso', symbol: '₱', rate: 56 },
  'ID': { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', rate: 15700 },
  'VN': { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', rate: 24500 },
  'AE': { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', rate: 3.67 },
  'SA': { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', rate: 3.75 },
  'KW': { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك', rate: 0.31 },
  'QA': { code: 'QAR', name: 'Qatari Riyal', symbol: 'ر.ق', rate: 3.64 },
  
  // Oceania
  'AU': { code: 'AUD', name: 'Australian Dollar', symbol: '$', rate: 1.52 },
  'NZ': { code: 'NZD', name: 'New Zealand Dollar', symbol: '$', rate: 1.67 },
};

// Base prices in USD
const BASE_PRICE_USD = 8;           // Pro monthly
const STUDIO_BASE_PRICE_USD = 20;  // Studio monthly
// Yearly prices apply ~20% discount (2 months free)
const PRO_YEARLY_BASE_USD = 77;    // $8 × 12 = $96 → $77 (save $19)
const STUDIO_YEARLY_BASE_USD = 192; // $20 × 12 = $240 → $192 (save $48)

// NGN is priced locally rather than converted from USD.
// Paystack will charge this exact amount in kobo (× 100 server-side).
const NGN_PRO_MONTHLY = 1000; // ₦1,000/mo

// Cache for user's currency
let cachedCurrency = null;
let cacheTimestamp = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get user's country code via IP geolocation
 * Uses multiple fallback services for reliability
 */
export async function getUserCountry() {
  try {
    // Try to get from localStorage first (cached)
    const cached = localStorage.getItem('userCountry');
    if (cached) {
      return cached;
    }

    // Try ip-api.com (free, no key required)
    try {
      const response = await fetch('https://ipapi.co/json/', {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const data = await response.json();
        const countryCode = data.country_code;
        if (countryCode) {
          localStorage.setItem('userCountry', countryCode);
          return countryCode;
        }
      }
    } catch (e) {
      console.warn('IP geolocation service unavailable:', e.message);
    }

    // Fallback: try another service
    try {
      const response = await fetch('https://ipwho.is/', {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          const countryCode = data.country_code;
          if (countryCode) {
            localStorage.setItem('userCountry', countryCode);
            return countryCode;
          }
        }
      }
    } catch (e) {
      console.warn('Fallback geolocation service unavailable:', e.message);
    }

    // Default to US if geolocation fails
    console.warn('Could not determine user country, defaulting to US');
    return 'US';
  } catch (error) {
    console.error('Error getting user country:', error);
    return 'US';
  }
}

/**
 * Get currency info for a country
 */
export function getCurrencyForCountry(countryCode) {
  return COUNTRY_CURRENCY_MAP[countryCode] || COUNTRY_CURRENCY_MAP['US'];
}

/**
 * Get user's currency information
 */
export async function getUserCurrency() {
  // Return cached value if available
  if (cachedCurrency && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
    return cachedCurrency;
  }

  const countryCode = await getUserCountry();
  const currency = getCurrencyForCountry(countryCode);
  
  cachedCurrency = currency;
  cacheTimestamp = Date.now();
  
  return currency;
}

/**
 * Helper to round a price to the appropriate number of decimal places
 */
function roundPrice(price, currencyCode) {
  const decimals = ['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(currencyCode) ? 3 : 2;
  return Math.round(price * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Convert a USD amount to user's local currency
 */
export async function convertAmountToLocal(usdAmount) {
  const currency = await getUserCurrency();
  return roundPrice(usdAmount * currency.rate, currency.code);
}

/**
 * Convert base price (USD) to user's local currency — Pro monthly.
 * NGN users pay a fixed local price rather than a USD conversion.
 */
export async function getLocalPrice() {
  const currency = await getUserCurrency();
  if (currency.code === 'NGN') return NGN_PRO_MONTHLY;
  return roundPrice(BASE_PRICE_USD * currency.rate, currency.code);
}

/**
 * Get Pro yearly price in local currency
 */
export async function getProYearlyLocalPrice() {
  const currency = await getUserCurrency();
  return roundPrice(PRO_YEARLY_BASE_USD * currency.rate, currency.code);
}

/**
 * Get Studio monthly price in local currency
 */
export async function getStudioLocalPrice() {
  const currency = await getUserCurrency();
  return roundPrice(STUDIO_BASE_PRICE_USD * currency.rate, currency.code);
}

/**
 * Get Studio yearly price in local currency
 */
export async function getStudioYearlyLocalPrice() {
  const currency = await getUserCurrency();
  return roundPrice(STUDIO_YEARLY_BASE_USD * currency.rate, currency.code);
}

/**
 * Format a local price amount into a display string
 */
async function formatAmount(amount, suffix = '/mo') {
  const currency = await getUserCurrency();
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(amount);
  return `${currency.symbol}${formatted}${suffix}`;
}

/**
 * Get formatted price string (e.g., "₦7,500/mo")
 */
export async function getFormattedPrice() {
  const price = await getLocalPrice();
  return formatAmount(price, '/mo');
}

/**
 * Get formatted Pro yearly price (e.g., "₦92,400/yr")
 */
export async function getFormattedProYearlyPrice() {
  const price = await getProYearlyLocalPrice();
  return formatAmount(price, '/yr');
}

/**
 * Get formatted Studio monthly price (e.g., "$20/mo")
 */
export async function getFormattedStudioPrice() {
  const price = await getStudioLocalPrice();
  return formatAmount(price, '/mo');
}

/**
 * Get formatted Studio yearly price (e.g., "$192/yr")
 */
export async function getFormattedStudioYearlyPrice() {
  const price = await getStudioYearlyLocalPrice();
  return formatAmount(price, '/yr');
}

/**
 * Get formatted price string with currency code (e.g., "₦7,500 NGN/mo")
 */
export async function getFormattedPriceWithCode() {
  const currency = await getUserCurrency();
  const price = await getLocalPrice();
  
  const formattedPrice = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(price);
  
  return `${currency.symbol}${formattedPrice} ${currency.code}/mo`;
}

/**
 * Get currency code (e.g., "USD", "NGN")
 */
export async function getCurrencyCode() {
  const currency = await getUserCurrency();
  return currency.code;
}

/**
 * Get currency symbol (e.g., "$", "₦")
 */
export async function getCurrencySymbol() {
  const currency = await getUserCurrency();
  return currency.symbol;
}

/**
 * Convert amount from USD to local currency
 */
export async function convertFromUSD(usdAmount) {
  return convertAmountToLocal(usdAmount);
}

/**
 * Get the exchange rate for current user
 */
export async function getExchangeRate() {
  const currency = await getUserCurrency();
  return currency.rate;
}

/**
 * Initialize currency on page load
 */
export async function initializeCurrency() {
  try {
    const currency = await getUserCurrency();
    console.log('User currency initialized:', currency.code, currency.name);
    return currency;
  } catch (error) {
    console.error('Error initializing currency:', error);
    return getCurrencyForCountry('US');
  }
}

export default {
  getUserCountry,
  getCurrencyForCountry,
  getUserCurrency,
  getLocalPrice,
  getProYearlyLocalPrice,
  getStudioLocalPrice,
  getStudioYearlyLocalPrice,
  getFormattedPrice,
  getFormattedProYearlyPrice,
  getFormattedStudioPrice,
  getFormattedStudioYearlyPrice,
  getFormattedPriceWithCode,
  getCurrencyCode,
  getCurrencySymbol,
  convertAmountToLocal,
  convertFromUSD,
  getExchangeRate,
  initializeCurrency
};
