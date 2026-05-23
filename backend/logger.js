// backend/logger.js
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
const LOG_RETENTION_DAYS = 30;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(category) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${category}-${date}.log`);
}

function rotateLogs() {
  ensureLogDir();
  const files = fs.readdirSync(LOG_DIR);
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of files) {
    const match = file.match(/-(\d{4}-\d{2}-\d{2})\.log$/);
    if (match) {
      const fileDate = new Date(match[1]);
      if (fileDate.getTime() < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, file)); } catch {}
      }
    }
  }
}

function log(level, category, message, data = {}) {
  ensureLogDir();
  rotateLogs();
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    category: category.toUpperCase(),
    message,
    data
  };
  const line = JSON.stringify(entry);
  console.log(line);
  try {
    fs.appendFileSync(getLogFilePath(category.toUpperCase()), line + '\n', 'utf8');
  } catch (err) {
    // fallback: log error to console
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      category: 'LOGGER',
      message: 'Failed to write log file',
      data: { error: err.message }
    }));
  }
}

module.exports = { log };
