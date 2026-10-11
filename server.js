'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

/* ---------- config ---------- */
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const adminEnabled = ADMIN_PASSWORD.length >= 8 && ADMIN_PASSWORD !== 'change-me-please';

/* The admin page lives in its own folder and is served only at a secret
   address you choose (ADMIN_PATH). Nothing on the public site links to it. */
const ADMIN_PATH = String(process.env.ADMIN_PATH || '').replace(/^\/+|\/+$/g, '');
const adminPageEnabled =
  /^[a-z0-9][a-z0-9_-]{7,}$/i.test(ADMIN_PATH) && !['admin', 'api', 'uploads', 'studio-k7x2m9'].includes(ADMIN_PATH.toLowerCase());

const ADMIN_DIR = path.join(__dirname, 'admin');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'media.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

/* Only these types can be uploaded. The file extension on disk comes from
   this table, never from the name the visitor sent. */
const TYPES = {
  'image/jpeg': { ext: '.jpg', kind: 'image' },
  'image/png': { ext: '.png', kind: 'image' },
  'image/webp': { ext: '.webp', kind: 'image' },
  'image/gif': { ext: '.gif', kind: 'image' },
  'image/avif': { ext: '.avif', kind: 'image' },
  'video/mp4': { ext: '.mp4', kind: 'video' },
  'video/webm': { ext: '.webm', kind: 'video' },
  'video/quicktime': { ext: '.mov', kind: 'video' },
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/* ---------- tiny JSON "database" ---------- */
let db = [];
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!Array.isArray(db)) db = [];
} catch {
  db = [];
}

let writeChain = Promise.resolve();
function saveDb() {
  writeChain = writeChain
    .then(async () => {
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('Could not save media.json:', err));
  return writeChain;
}

/* ---------- admin password ---------- */
const passwordDigest = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();

function passwordMatches(candidate) {
  const digest = crypto.createHash('sha256').update(String(candidate || '')).digest();
  return crypto.timingSafeEqual(digest, passwordDigest);
}

/* Lock an IP out for 15 minutes after 10 wrong passwords. */
const failures = new Map();
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

function requireAdmin(req, res, next) {
  if (!adminEnabled) {
    return next(
      new HttpError(
        'Uploads are switched off. Set ADMIN_PASSWORD (8+ characters) in .env, then restart the server.',
        503
      )
    );
  }
  const now = Date.now();
  const record = failures.get(req.ip);
  if (record && record.until > now) {
    return next(new HttpError('Too many wrong passwords. Try again in 15 minutes.', 429));
  }
  if (!passwordMatches(req.get('x-admin-password'))) {
    const stale = !record || now - record.last > LOCK_MS;
    const count = (stale ? 0 : record.count) + 1;
    failures.set(req.ip, { count, last: now, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
    return next(new HttpError('Wrong password.', 401));
  }
  failures.delete(req.ip);
  next();
}

/* ---------- uploads ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    cb(null, crypto.randomBytes(12).toString('hex') + TYPES[file.mimetype].ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 8, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => {
    if (TYPES[file.mimetype]) return cb(null, true);
    cb(new HttpError('That file type is not allowed. Use JPG, PNG, WebP, GIF, AVIF, MP4, WebM or MOV.', 415));
  },
});

/* Check the first bytes so a renamed .exe or .html can't pass as a photo. */
async function contentMatchesType(filePath, mimetype) {
  const fh = await fsp.open(filePath, 'r');
  const buf = Buffer.alloc(16);
  try {
    await fh.read(buf, 0, 16, 0);
  } finally {
    await fh.close();
  }
  const ascii = (a, b) => buf.toString('ascii', a, b);
  switch (mimetype) {
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png':
      return buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'image/gif':
      return ascii(0, 4) === 'GIF8';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'video/webm':
      return buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'image/avif':
    case 'video/mp4':
    case 'video/quicktime':
      return ascii(4, 8) === 'ftyp';
    default:
      return false;
  }
}

const cleanText = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanDim = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
};

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  next();
});

if (adminPageEnabled) {
  app.use(
    '/' + ADMIN_PATH,
    (req, res, next) => {
      res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
      next();
    },
    express.static(ADMIN_DIR, { index: 'admin.html', dotfiles: 'deny' })
  );
}

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' })
);
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

/* Public: list everything, newest first */
app.get('/api/media', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(db);
});

/* Admin: check a password (used by the login form) */
app.post('/api/auth', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

/* Admin: upload one photo or video */
app.post('/api/media', requireAdmin, upload.single('file'), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) throw new HttpError('Choose a photo or video to upload.', 400);

    if (!(await contentMatchesType(file.path, file.mimetype))) {
      throw new HttpError("The file's contents don't match its type. Use a real JPG, PNG, WebP, GIF, AVIF, MP4, WebM or MOV.", 415);
    }

    const item = {
      id: crypto.randomUUID(),
      file: file.filename,
      type: TYPES[file.mimetype].kind,
      title: cleanText(req.body.title, 120),
      caption: cleanText(req.body.caption, 500),
      w: cleanDim(req.body.w),
      h: cleanDim(req.body.h),
      size: file.size,
      createdAt: new Date().toISOString(),
    };
    db.unshift(item);
    await saveDb();
    res.status(201).json(item);
  } catch (err) {
    if (file) await fsp.unlink(file.path).catch(() => {});
    next(err);
  }
});

/* Admin: delete one item and its file */
app.delete('/api/media/:id', requireAdmin, async (req, res, next) => {
  try {
    const index = db.findIndex((m) => m.id === req.params.id);
    if (index === -1) throw new HttpError('That item no longer exists.', 404);
    const [removed] = db.splice(index, 1);
    await saveDb();
    await fsp.unlink(path.join(UPLOAD_DIR, path.basename(removed.file))).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use('/api', (req, res, next) => next(new HttpError('Not found.', 404)));

/* eslint-disable-next-line no-unused-vars */
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? `That file is larger than ${MAX_MB} MB.` : 'The upload could not be read.';
  } else if (!err.status) {
    console.error(err);
    message = 'Something went wrong on the server.';
  }
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Portfolio running at http://localhost:${PORT}`);
  if (!adminEnabled) console.log('Uploads are OFF: set ADMIN_PASSWORD (8+ characters) in .env to turn them on.');
  if (!adminPageEnabled) {
    console.log('Admin page is OFF: set ADMIN_PATH in .env to a secret word of 8+ letters, numbers, - or _ (for example studio-k7x2m9).');
  } else if (adminEnabled) {
    console.log(`Admin page (keep this address private): http://localhost:${PORT}/${ADMIN_PATH}/`);
  }
});
