import rateLimit from 'express-rate-limit';
import {
  RATE_LIMIT_WINDOW_MS,
  API_RATE_LIMIT_MAX,
  AGENT_RATE_LIMIT_MAX,
  UPLOAD_RATE_LIMIT_MAX,
  AUTH_RATE_LIMIT_MAX,
  ONE_MINUTE_MS,
} from '../config/constants.js';

/**
 * General API rate limiter
 * Applies to all API endpoints except agent queries
 */
export const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT_MAX,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
});

/**
 * Strict rate limiter for AI agent queries
 * These are expensive operations that call the Anthropic API
 */
export const agentLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  max: AGENT_RATE_LIMIT_MAX,
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
  windowMs: ONE_MINUTE_MS,
  max: UPLOAD_RATE_LIMIT_MAX,
  message: 'Too many file uploads. Please wait a moment before uploading again.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Auth endpoint rate limiter
 * Extra strict to prevent brute force attacks
 */
export const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  message: 'Too many authentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
