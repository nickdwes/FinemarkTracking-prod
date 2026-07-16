import rateLimit from "express-rate-limit";

/**
 * Login-specific rate limiter — stricter than the general authLimiter below.
 * Deliberately its own instance (not shared with /refresh, /forgot-password,
 * /reset-password, /otp/*) since those all share authLimiter's bucket per IP;
 * a user who mistypes a password once then falls back to OTP would otherwise
 * exhaust a tight shared limit through entirely legitimate actions.
 * 2 attempts per 5 minutes per IP.
 */
export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many login attempts. Please wait 5 minutes and try again.",
      },
    });
  },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many attempts. Please wait a minute and try again.",
      },
    });
  },
});

/**
 * Partner-portal auth rate limiter — applies to the /api/partner/auth/* routes.
 * Provides defence-in-depth alongside the DB-level lockout mechanism.
 * 20 requests per 15 minutes per IP.
 */
export const partnerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many authentication attempts. Please wait before trying again.",
      },
    });
  },
});
