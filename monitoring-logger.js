/**
 * Monitoring & Error Logging System
 * Centralized error tracking, performance monitoring, and audit logs
 */

const fs = require('fs');
const path = require('path');

// Log storage directory
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Format timestamp for logs
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Error Logger - Logs errors to both console and file
 */
class ErrorLogger {
  constructor() {
    this.errorFile = path.join(LOG_DIR, 'errors.log');
  }

  log(error, context = {}) {
    const timestamp = getTimestamp();
    const errorData = {
      timestamp,
      level: 'ERROR',
      message: error.message || String(error),
      stack: error.stack || 'No stack trace',
      context,
      severity: this.calculateSeverity(error)
    };

    // Write to file
    try {
      fs.appendFileSync(
        this.errorFile,
        JSON.stringify(errorData) + '\n',
        'utf-8'
      );
    } catch (writeErr) {
      console.error('Failed to write error log:', writeErr);
    }

    // Write to console with color coding
    console.error(`\n❌ [ERROR] ${timestamp}`, errorData);

    return errorData;
  }

  calculateSeverity(error) {
    if (error.message.includes('Firebase') || error.message.includes('Database')) {
      return 'CRITICAL';
    }
    if (error.message.includes('payment') || error.message.includes('subscription')) {
      return 'HIGH';
    }
    return 'MEDIUM';
  }
}

/**
 * Payment Transaction Logger - Tracks all payment events
 */
class PaymentLogger {
  constructor() {
    this.paymentFile = path.join(LOG_DIR, 'payments.log');
  }

  logTransaction(event, data) {
    const timestamp = getTimestamp();
    const paymentData = {
      timestamp,
      event,
      userId: data.userId,
      email: data.email,
      transactionId: data.transactionId,
      amount: data.amount,
      currency: data.currency,
      plan: data.plan,
      status: data.status,
      metadata: data.metadata || {}
    };

    try {
      fs.appendFileSync(
        this.paymentFile,
        JSON.stringify(paymentData) + '\n',
        'utf-8'
      );
    } catch (writeErr) {
      console.error('Failed to write payment log:', writeErr);
    }

    console.log(`✅ [PAYMENT] ${event}:`, paymentData);
  }

  /**
   * Get payment statistics
   */
  getStatistics() {
    try {
      const data = fs.readFileSync(this.paymentFile, 'utf-8');
      const lines = data.trim().split('\n').filter(l => l);
      const transactions = lines.map(l => JSON.parse(l));

      return {
        totalTransactions: transactions.length,
        successful: transactions.filter(t => t.status === 'successful').length,
        failed: transactions.filter(t => t.status === 'failed').length,
        pending: transactions.filter(t => t.status === 'pending').length,
        totalRevenue: transactions
          .filter(t => t.status === 'successful')
          .reduce((sum, t) => sum + (t.amount || 0), 0)
      };
    } catch (err) {
      return { error: 'Unable to read payment logs' };
    }
  }
}

/**
 * Performance Monitor - Tracks API response times
 */
class PerformanceMonitor {
  constructor() {
    this.perfFile = path.join(LOG_DIR, 'performance.log');
    this.metrics = {};
  }

  recordEndpoint(method, path, duration, status, error = null) {
    const timestamp = getTimestamp();
    const perfData = {
      timestamp,
      method,
      path,
      duration: `${duration}ms`,
      status,
      error: error ? error.message : null,
      slow: duration > 1000 // Flag slow requests
    };

    try {
      fs.appendFileSync(
        this.perfFile,
        JSON.stringify(perfData) + '\n',
        'utf-8'
      );
    } catch (writeErr) {
      console.error('Failed to write performance log:', writeErr);
    }

    // Log slow endpoints
    if (duration > 1000) {
      console.warn(`⚠️ [SLOW] ${method} ${path} took ${duration}ms`);
    }
  }

  /**
   * Get performance statistics
   */
  getStats() {
    try {
      const data = fs.readFileSync(this.perfFile, 'utf-8');
      const lines = data.trim().split('\n').filter(l => l);
      const metrics = lines.map(l => JSON.parse(l));

      const slowRequests = metrics.filter(m => m.slow).length;
      const avgDuration = Math.round(
        metrics.reduce((sum, m) => {
          const duration = parseInt(m.duration);
          return sum + duration;
        }, 0) / metrics.length
      );

      return {
        totalRequests: metrics.length,
        slowRequests,
        avgDuration: `${avgDuration}ms`,
        errorRequests: metrics.filter(m => m.error).length
      };
    } catch (err) {
      return { error: 'Unable to read performance logs' };
    }
  }
}

/**
 * Audit Logger - Logs user actions and system events
 */
class AuditLogger {
  constructor() {
    this.auditFile = path.join(LOG_DIR, 'audit.log');
  }

  log(action, userId, details) {
    const timestamp = getTimestamp();
    const auditData = {
      timestamp,
      action,
      userId,
      details,
      ipAddress: details?.ipAddress || 'unknown'
    };

    try {
      fs.appendFileSync(
        this.auditFile,
        JSON.stringify(auditData) + '\n',
        'utf-8'
      );
    } catch (writeErr) {
      console.error('Failed to write audit log:', writeErr);
    }
  }
}

/**
 * System Health Monitor
 */
class HealthMonitor {
  constructor() {
    this.healthFile = path.join(LOG_DIR, 'health.log');
    this.lastCheck = null;
  }

  checkHealth(services) {
    const timestamp = getTimestamp();
    const health = {
      timestamp,
      services,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      healthy: Object.values(services).every(s => s.status === 'healthy')
    };

    try {
      fs.appendFileSync(
        this.healthFile,
        JSON.stringify(health) + '\n',
        'utf-8'
      );
    } catch (writeErr) {
      console.error('Failed to write health log:', writeErr);
    }

    this.lastCheck = health;
    return health;
  }

  getStatus() {
    return this.lastCheck || { status: 'unknown' };
  }
}

// Export singleton instances
module.exports = {
  errorLogger: new ErrorLogger(),
  paymentLogger: new PaymentLogger(),
  performanceMonitor: new PerformanceMonitor(),
  auditLogger: new AuditLogger(),
  healthMonitor: new HealthMonitor()
};
