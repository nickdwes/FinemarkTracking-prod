import rateLimit from "express-rate-limit";

/**
 * OTP request/verify rate limiter — this portal's login flow had no rate
 * limiting at all before this (unlike the main CRM backend's authLimiter).
 * Shared across both /auth/request-otp and /auth/verify-otp so an attacker
 * can't work around the cap by alternating between the two; a legitimate
 * user completing a normal login (request once, verify once) stays well
 * under it. 2 attempts per 5 minutes per IP.
 */
export const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      message: "Too many attempts. Please wait 5 minutes and try again.",
    });
  },
});
