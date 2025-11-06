import pino from 'pino';

/**
 * Structured logging configuration using Pino
 * Provides better performance and more useful logs than console.log
 */

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

export const logger = pino({
  level: logLevel,
  // Pretty print in development for better readability
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Add base context to all logs
  base: {
    env: process.env.NODE_ENV || 'development',
  },
});

/**
 * Child logger for specific components
 * Usage: const log = getLogger('storage')
 */
export function getLogger(component: string) {
  return logger.child({ component });
}

/**
 * Express middleware to log HTTP requests
 */
export function requestLogger() {
  return (req: any, res: any, next: any) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
        userAgent: req.get('user-agent'),
      }, 'HTTP request');
    });

    next();
  };
}
