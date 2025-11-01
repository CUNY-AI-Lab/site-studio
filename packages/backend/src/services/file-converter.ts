import mime from 'mime-types';
import path from 'path';

/**
 * Get file type description for user-friendly messaging
 */
export function getFileTypeDescription(filename: string): string {
  const mimeType = mime.lookup(filename) || 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();

  // Images
  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  // PDFs
  if (mimeType === 'application/pdf' || ext === '.pdf') {
    return 'PDF document';
  }

  // Word documents
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    return 'Word document';
  }

  // Excel spreadsheets
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    ext === '.xlsx' ||
    ext === '.xls'
  ) {
    return 'Excel spreadsheet';
  }

  // Text files
  if (
    mimeType.startsWith('text/') ||
    ['.txt', '.md', '.json', '.csv', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp'].includes(ext)
  ) {
    return 'text file';
  }

  // Default
  return 'file';
}

/**
 * Check if file type is supported
 */
export function isSupportedFileType(filename: string): boolean {
  const mimeType = mime.lookup(filename) || 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();

  const supported = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    // Documents
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // XLSX
    'application/vnd.ms-excel', // XLS
    // Text
    'text/plain', 'text/markdown', 'text/html', 'text/css', 'text/javascript',
    'text/csv', 'application/json'
  ];

  const supportedExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
    '.pdf',
    '.docx', '.xlsx', '.xls',
    '.txt', '.md', '.json', '.csv', '.html', '.css', '.js', '.ts',
    '.py', '.java', '.c', '.cpp', '.h', '.hpp'
  ];

  return supported.includes(mimeType) || supportedExtensions.includes(ext);
}

/**
 * Generate the prompt text for an uploaded file
 * Just tells the agent the file path - let it use Read tool
 */
export function generateFilePrompt(
  originalPrompt: string,
  filename: string,
  filepath: string
): string {
  const fileType = getFileTypeDescription(filename);

  return `${originalPrompt}\n\nI've uploaded a ${fileType}: ${filename}\nPath: ${filepath}\n\nPlease use the Read tool to access this file and help me with it.`;
}
