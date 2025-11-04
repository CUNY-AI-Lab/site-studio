import rateLimit from 'express-rate-limit';

/**
 * General API rate limiter
 * Applies to all API endpoints except agent queries
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes per IP
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
});

/**
 * Strict rate limiter for AI agent queries
 * These are expensive operations that call the Anthropic API
 */
export const agentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 agent queries per minute per IP
  message: 'Rate limit exceeded for agent queries. Please wait a moment before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting in development
  skip: (req) => process.env.NODE_ENV === 'development',
});

/**
 * File upload rate limiter
 * Prevents abuse of file upload endpoints
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 uploads per minute per IP
  message: 'Too many file uploads. Please wait a moment before uploading again.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Auth endpoint rate limiter
 * Extra strict to prevent brute force attacks
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  message: 'Too many authentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
