'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');


/* ---------- config ---------- */
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_MB = Math.max(1, Math.min(Number(process.env.MAX_UPLOAD_MB) || 100, 100));
const CLOUDINARY_URL = process.env.CLOUDINARY_URL || '';
const cloudinaryCredentials = (() => {
  if (!CLOUDINARY_URL) return null;
  try {
    const parsed = new URL(CLOUDINARY_URL);
    if (parsed.protocol !== 'cloudinary:' || !parsed.username || !parsed.password || !parsed.hostname) return null;
    return {
      apiKey: decodeURIComponent(parsed.username),
      apiSecret: decodeURIComponent(parsed.password),
      cloudName: parsed.hostname,
    };
  } catch {
    return null;
  }
})();
const cloudinaryEnabled = Boolean(cloudinaryCredentials);
const CLOUDINARY_TAG = 'jishnu-portfolio-media';
const adminEnabled = ADMIN_PASSWORD.length >= 8 && ADMIN_PASSWORD !== 'change-me-please';

/* The admin page lives in its own folder and is served only at a secret
   address you choose (ADMIN_PATH). Nothing on the public site links to it. */
const ADMIN_PATH = String(process.env.ADMIN_PATH || '').replace(/^\/+|\/+$/g, '');
const adminPageEnabled =
  /^[a-z0-9][a-z0-9_-]{7,}$/i.test(ADMIN_PATH) && !['admin', 'api', 'uploads', 'studio-k7x2m9'].includes(ADMIN_PATH.toLowerCase());

const ADMIN_DIR = path.join(__dirname, 'admin');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'jishnu-media-portfolio-uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'media.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

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
  destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
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
      "default-src 'self'; img-src 'self' https://res.cloudinary.com data: blob:; media-src 'self' https://res.cloudinary.com blob:; " +
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

/* Cloudinary API helpers: signed uploads and authenticated resource listing. */
function cloudinarySignature(params) {
  const serialized = Object.entries(params)
    .filter(([key, value]) => !['file', 'api_key', 'resource_type', 'cloud_name', 'signature'].includes(key) && value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return crypto.createHash('sha1').update(serialized + cloudinaryCredentials.apiSecret).digest('hex');
}

function cloudinaryContext(title, caption, w, h) {
  const escape = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/=/g, '\\=');
  return Object.entries({ caption, height: h, title, width: w })
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${key}=${escape(value)}`)
    .join('|');
}

async function cloudinaryUpload(file, fields, resourceType) {
  const params = {
    timestamp: String(Math.floor(Date.now() / 1000)),
    public_id: 'media-' + crypto.randomUUID(),
    tags: CLOUDINARY_TAG,
    overwrite: 'false',
  };
  const context = cloudinaryContext(fields.title, fields.caption, fields.w, fields.h);
  if (context) params.context = context;
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.append(key, value);
  form.append('api_key', cloudinaryCredentials.apiKey);
  form.append('signature', cloudinarySignature(params));
  const bytes = await fsp.readFile(file.path);
  form.append('file', new Blob([bytes], { type: file.mimetype }), path.basename(file.path));
  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudinaryCredentials.cloudName)}/${resourceType}/upload`;
  const response = await fetch(endpoint, { method: 'POST', body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error && result.error.message;
    throw new HttpError(message || `Cloudinary upload failed (HTTP ${response.status}). Check your Cloudinary account and file limits.`, response.status === 413 ? 413 : 502);
  }
  return result;
}

async function cloudinaryApiRequest(apiPath, options = {}) {
  const { apiKey, apiSecret, cloudName } = cloudinaryCredentials;
  const url = new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${apiPath}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const response = await fetch(url, { method: options.method || 'GET', headers: { Authorization: `Basic ${auth}`, ...(options.headers || {}) }, body: options.body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error && result.error.message;
    throw new HttpError(message || `Cloudinary API request failed (HTTP ${response.status}).`, 502);
  }
  return result;
}

/* ---------- persistent cloud media ---------- */
let cloudMediaCache = { at: 0, items: null };
const CLOUD_CACHE_MS = 20_000;

function contextOf(resource) {
  return (resource.context && (resource.context.custom || resource.context)) || {};
}

function fromCloudResource(resource) {
  const custom = contextOf(resource);
  const type = resource.resource_type === 'video' ? 'video' : 'image';
  return {
    id: resource.public_id,
    file: resource.secure_url,
    url: resource.secure_url,
    type,
    title: cleanText(custom.title, 120),
    caption: cleanText(custom.caption, 500),
    w: cleanDim(custom.width) || resource.width || null,
    h: cleanDim(custom.height) || resource.height || null,
    size: Number(resource.bytes) || 0,
    createdAt: resource.created_at || new Date().toISOString(),
    resourceType: resource.resource_type,
  };
}

async function listCloudMedia() {
  if (cloudMediaCache.items && Date.now() - cloudMediaCache.at < CLOUD_CACHE_MS) {
    return cloudMediaCache.items;
  }
  const resources = [];
  let nextCursor;
  do {
    const options = { max_results: 500, context: true };
    if (nextCursor) options.next_cursor = nextCursor;
    const page = await cloudinaryApiRequest('resources/by_tag/' + encodeURIComponent(CLOUDINARY_TAG), { query: options });
    resources.push(...(page.resources || []));
    nextCursor = page.next_cursor;
  } while (nextCursor);

  const items = resources
    .map(fromCloudResource)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  cloudMediaCache = { at: Date.now(), items };
  return items;
}

/* Public: list persistent Cloudinary media (local JSON only for local development). */
app.get('/api/media', async (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  if (!cloudinaryEnabled) return res.json(db);
  try {
    res.json(await listCloudMedia());
  } catch (err) {
    console.error('Could not load media from Cloudinary:', err.message);
    next(new HttpError('The gallery storage is temporarily unavailable. Please try again shortly.', 503));
  }
});

/* Admin: check a password (used by the login form) */
app.post('/api/auth', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

/* Admin: upload one photo or video */
app.post('/api/media', requireAdmin, upload.single('file'), async (req, res, next) => {
  const file = req.file;
  try {
    if (process.env.RENDER_SERVICE_ID && !cloudinaryEnabled) {
      throw new HttpError('Persistent storage is not configured. Add a valid CLOUDINARY_URL in Render Environment before uploading.', 503);
    }
    if (!file) throw new HttpError('Choose a photo or video to upload.', 400);

    if (!(await contentMatchesType(file.path, file.mimetype))) {
      throw new HttpError("The file's contents don't match its type. Use a real JPG, PNG, WebP, GIF, AVIF, MP4, WebM or MOV.", 415);
    }

    const title = cleanText(req.body.title, 120);
    const caption = cleanText(req.body.caption, 500);
    const w = cleanDim(req.body.w);
    const h = cleanDim(req.body.h);
    let item;

    if (cloudinaryEnabled) {
      // Cloudinary's Free plan currently limits images to 10 MB and videos to 100 MB.
      if (TYPES[file.mimetype].kind === 'image' && file.size > 10 * 1024 * 1024) {
        throw new HttpError('This image is over 10 MB. Resize/compress it or use a plan that supports larger images.', 413);
      }
      const resourceType = TYPES[file.mimetype].kind === 'video' ? 'video' : 'image';
      const uploaded = await cloudinaryUpload(file, { title, caption, w, h }, resourceType);
      item = {
        id: uploaded.public_id,
        file: uploaded.secure_url,
        url: uploaded.secure_url,
        type: resourceType,
        title,
        caption,
        w: w || uploaded.width || null,
        h: h || uploaded.height || null,
        size: uploaded.bytes || file.size,
        createdAt: uploaded.created_at || new Date().toISOString(),
        resourceType,
      };
      cloudMediaCache = { at: 0, items: null };
    } else {
      const filename = crypto.randomBytes(12).toString('hex') + TYPES[file.mimetype].ext;
      const finalPath = path.join(UPLOAD_DIR, filename);
      await fsp.copyFile(file.path, finalPath);
      item = {
        id: crypto.randomUUID(),
        file: filename,
        type: TYPES[file.mimetype].kind,
        title,
        caption,
        w,
        h,
        size: file.size,
        createdAt: new Date().toISOString(),
      };
      db.unshift(item);
      await saveDb();
    }
    res.status(201).json(item);
  } catch (err) {
    next(err);
  } finally {
    if (file) await fsp.unlink(file.path).catch(() => {});
  }
});

/* Admin: delete one item from cloud storage (or local storage in development). */
app.delete('/api/media/:id', requireAdmin, async (req, res, next) => {
  try {
    if (cloudinaryEnabled) {
      const items = await listCloudMedia();
      const item = items.find((m) => m.id === req.params.id);
      if (!item) throw new HttpError('That item no longer exists.', 404);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const destroyParams = { public_id: item.id, timestamp, invalidate: 'true' };
      const result = await cloudinaryApiRequest(`${item.resourceType || item.type}/destroy`, {
        method: 'POST',
        body: new URLSearchParams({ ...destroyParams, api_key: cloudinaryCredentials.apiKey, signature: cloudinarySignature(destroyParams) }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (result.result === 'not found') throw new HttpError('That item no longer exists in cloud storage.', 404);
      if (result.result !== 'ok') throw new HttpError('Cloud storage could not delete this item. Please try again.', 502);
      cloudMediaCache = { at: 0, items: null };
      return res.json({ ok: true });
    }

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
  if (cloudinaryEnabled) console.log('Media storage: Cloudinary (persistent cloud storage).');
  else if (process.env.RENDER_SERVICE_ID) console.warn('PERSISTENT STORAGE NOT CONFIGURED: set a valid CLOUDINARY_URL in Render before accepting uploads.');
  else console.warn('Media storage: local disk only. Configure CLOUDINARY_URL for persistent cloud storage.');
  if (!adminEnabled) console.log('Uploads are OFF: set ADMIN_PASSWORD (8+ characters) in .env to turn them on.');
  if (!adminPageEnabled) {
    console.log('Admin page is OFF: set ADMIN_PATH in .env to a secret word of 8+ letters, numbers, - or _ (for example studio-k7x2m9).');
  } else if (adminEnabled) {
    console.log(`Admin page (keep this address private): http://localhost:${PORT}/${ADMIN_PATH}/`);
  }
});
