const multer = require('multer');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');

function audioExtensionForUpload(file) {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  if (['.m4a', '.mp4', '.webm', '.mp3', '.wav', '.mpeg', '.mpga'].includes(extension)) return extension;
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  return '.webm';
}

function createRecordingUpload({ directory, maxFileSize = 200 * 1024 * 1024 }) {
  const storage = multer.diskStorage({
    destination: directory,
    filename: (req, file, callback) => callback(null, `${Date.now()}-${uuidv4()}${audioExtensionForUpload(file)}`),
  });
  const parse = multer({ storage, limits: { fileSize: maxFileSize } }).single('audio_file');
  return (req, res, next) => parse(req, res, error => {
    if (req.aborted) return;
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        success: false,
        message: error.code === 'LIMIT_FILE_SIZE' ? 'Audio file is too large.' : 'Invalid audio upload.',
      });
    }
    if (/^(Unexpected end of (form|file)|Multipart: Boundary not found)$/.test(error.message)) {
      return res.status(400).json({ success: false, message: 'Invalid audio upload.' });
    }
    return next(error);
  });
}

module.exports = { createRecordingUpload, audioExtensionForUpload };
