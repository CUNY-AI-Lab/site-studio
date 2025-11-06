import { fileTypeFromBuffer } from 'file-type';
import { getLogger } from '../config/logger.js';

const log = getLogger('file-validation');

/**
 * Allowed MIME types for file uploads
 */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/csv',
]);

/**
 * Allowed file extensions
 */
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.pdf',
  '.docx',
  '.txt',
  '.csv',
]);

/**
 * Maximum file size (32MB to match current limit)
 */
export const MAX_FILE_SIZE = 32 * 1024 * 1024;

/**
 * Validate file upload based on extension, MIME type, and magic bytes
 */
export async function validateFileUpload(
  filename: string,
  buffer: Buffer,
  declaredMimeType?: string
): Promise<{ valid: boolean; error?: string; detectedType?: string }> {
  // Check file size
  if (buffer.length > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
    };
  }

  // Check extension
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `File extension not allowed: ${ext}`,
    };
  }

  // Check declared MIME type
  if (declaredMimeType && !ALLOWED_MIME_TYPES.has(declaredMimeType)) {
    return {
      valid: false,
      error: `MIME type not allowed: ${declaredMimeType}`,
    };
  }

  // Validate magic bytes for binary files (images, PDFs, etc.)
  // Skip magic byte validation for text files
  if (ext !== '.txt' && ext !== '.csv') {
    try {
      const fileType = await fileTypeFromBuffer(buffer);

      if (!fileType) {
        log.warn({ filename, ext }, 'Could not detect file type from magic bytes');
        // Allow it if extension and declared type are valid
        return { valid: true, detectedType: 'unknown' };
      }

      // Check if detected MIME type is allowed
      if (!ALLOWED_MIME_TYPES.has(fileType.mime)) {
        return {
          valid: false,
          error: `Detected file type not allowed: ${fileType.mime}`,
          detectedType: fileType.mime,
        };
      }

      // Warn if declared type doesn't match detected type
      if (declaredMimeType && declaredMimeType !== fileType.mime) {
        log.warn({
          filename,
          declared: declaredMimeType,
          detected: fileType.mime,
        }, 'MIME type mismatch');
      }

      return {
        valid: true,
        detectedType: fileType.mime,
      };
    } catch (error) {
      log.error({ error, filename }, 'Error detecting file type');
      return {
        valid: false,
        error: 'Could not validate file type',
      };
    }
  }

  // Text files don't need magic byte validation
  return { valid: true, detectedType: declaredMimeType };
}

/**
 * Express middleware for file upload validation
 */
export function fileUploadValidator() {
  return async (req: any, res: any, next: any) => {
    if (!req.file) {
      return next();
    }

    const validation = await validateFileUpload(
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype
    );

    if (!validation.valid) {
      res.status(400).json({
        error: 'File validation failed',
        details: validation.error,
      });
      return;
    }

    // Attach detected type to request for logging
    req.file.detectedType = validation.detectedType;

    next();
  };
}
