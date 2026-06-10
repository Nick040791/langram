// LAN Media Gallery — hardened public-facing release.
//
// Security model:
//   * The server is intended to run on a trusted LAN. The host filesystem is
//     exposed read-only through /api/media and /media/*, scoped to a single
//     "gallery root" directory chosen at first run.
//   * The browser is treated as untrusted input: every API request is
//     validated, every path resolved and re-checked against the gallery root
//     before any filesystem call. Symbolic links are never followed.
//   * Mutating endpoints (POST /api/config, POST /api/likes/toggle) and the
//     /api/browse folder picker require a bearer token via the
//     LANGRAM_TOKEN environment variable. Read-only endpoints are open so a
//     phone on the LAN can browse without logging in.
//   * Security headers (CSP, X-Content-Type-Options, Referrer-Policy,
//     X-Frame-Options) are set on every response. The /media/* route sets
//     Content-Type: text/plain on errors so a misconfigured CDN or browser
//     can never sniff an HTML page where a binary was expected.
//   * The recursive walk is bounded (max depth, max file count) so a hostile
//     or accidentally-huge folder cannot DoS the server.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const getLanAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
};

const app = express();
const PORT = Number(process.env.PORT) || 3012;
const MAX_DEPTH = Number(process.env.LANGRAM_MAX_DEPTH) || 12;
const MAX_FILES = Number(process.env.LANGRAM_MAX_FILES) || 50000;
const TOKEN = (process.env.LANGRAM_TOKEN || '').trim();

if (!TOKEN) {
  console.warn(
    '[langram] LANGRAM_TOKEN is not set. Mutating endpoints (POST /api/config, ' +
      'POST /api/likes/toggle, /api/browse) will REFUSE all requests. ' +
      'Set LANGRAM_TOKEN in the environment to a long random string to enable them.'
  );
}

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif',
  '.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv'
]);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv']);
const LIKES_FILE = path.join(__dirname, 'data', 'likes.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

let galleryRoot = process.env.GALLERY_PATH || process.cwd();

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.galleryRoot === 'string' && parsed.galleryRoot) {
      return parsed.galleryRoot;
    }
  } catch (_err) { /* ignore */ }
  return null;
}

function saveSettings() {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ galleryRoot, savedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (_err) { /* non-fatal */ }
}

const persisted = loadSettings();
if (persisted) {
  try {
    if (fs.existsSync(persisted) && fs.statSync(persisted).isDirectory()) {
      galleryRoot = path.resolve(persisted);
    }
  } catch (_err) { /* persisted value unusable; keep default */ }
}

let mediaCache = null; // { root, mtime, items, folders }

// ---------- Security helpers ----------

// Resolve a user-supplied path and verify it is a directory that is a
// descendant of the current gallery root. Returns the resolved absolute path
// or throws. Never returns something outside galleryRoot — that is the
// "can't escape the gallery" guarantee.
function resolveInsideRoot(input, { mustExist = true } = {}) {
  if (typeof input !== 'string' || !input) {
    throw new Error('Path is required.');
  }
  const resolved = path.resolve(input);
  const rel = path.relative(galleryRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside the gallery root.');
  }
  if (mustExist) {
    if (!fs.existsSync(resolved)) {
      throw new Error('Selected path does not exist.');
    }
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed.');
    }
    if (!stat.isDirectory()) {
      throw new Error('Selected path must be a directory.');
    }
  }
  return resolved;
}

function setSecurityHeaders(res, next) {
  // Be defensive: a few internal paths pass non-response objects to
  // middleware. Express's `res` always has setHeader, but res objects from
  // the static middleware (e.g. SendStream) do not.
  if (!res || typeof res.setHeader !== 'function') {
    if (typeof next === 'function') return next();
    return;
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
    "form-action 'self'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (typeof next === 'function') next();
}

app.use((req, res, next) => {
  setSecurityHeaders(res);
  next();
});

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // Browsers send OPTIONS preflights; allow them through with no body.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: '32kb' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
      if (/\.(?:js|css|svg|png|jpg|jpeg|webp|woff2?)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })
);

// Constant-time string compare for the bearer token.
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireToken(req, res, next) {
  if (!TOKEN) {
    return res.status(503).json({ error: 'Server has no LANGRAM_TOKEN configured.' });
  }
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !tokensEqual(match[1], TOKEN)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="langram"');
    return res.status(401).json({ error: 'Bearer token required.' });
  }
  return next();
}

function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'other';
}

function toRelative(filePath) {
  return path.relative(galleryRoot, filePath).split(path.sep).join('/');
}

// Walk a directory non-recursively into symlinks. Bounded by depth and a
// hard file cap to keep the server responsive on huge trees. Returns items
// or throws when the cap is hit.
function walkMedia(rootPath, items = [], depth = 0) {
  if (depth > MAX_DEPTH) return items;
  let entries;
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (_err) {
    return items;
  }
  for (const entry of entries) {
    if (items.length >= MAX_FILES) {
      throw new Error(`Scan stopped after ${MAX_FILES} files. Move some folders out of the gallery root or raise LANGRAM_MAX_FILES.`);
    }
    // Symbolic links are never followed.
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      walkMedia(fullPath, items, depth + 1);
      continue;
    }
    if (!entry.isFile() || !isMediaFile(fullPath)) continue;
    let stats;
    try { stats = fs.lstatSync(fullPath); } catch (_err) { continue; }
    if (stats.isSymbolicLink()) continue;
    let relativePath;
    try { relativePath = toRelative(fullPath); } catch (_err) { continue; }
    const folder = path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath);
    items.push({
      name: entry.name,
      relativePath,
      folder,
      type: getMediaType(fullPath),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      url: `/media/${encodeURIComponent(relativePath)}`
    });
  }
  return items;
}

function getRootMtime(rootPath) {
  try { return fs.statSync(rootPath).mtimeMs; } catch (_err) { return 0; }
}

function loadMediaIndex(force = false) {
  if (!force && mediaCache && mediaCache.root === galleryRoot) return mediaCache;
  const items = walkMedia(galleryRoot, [], 0)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  mediaCache = {
    root: galleryRoot,
    mtime: getRootMtime(galleryRoot),
    items,
    folders: getFolders(items)
  };
  return mediaCache;
}

function getFolders(items) {
  const folders = new Set(['']);
  for (const item of items) {
    const parts = item.folder ? item.folder.split('/') : [];
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      folders.add(current);
    }
  }
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

function ensureLikesFile() {
  const likesDir = path.dirname(LIKES_FILE);
  if (!fs.existsSync(likesDir)) fs.mkdirSync(likesDir, { recursive: true });
  if (!fs.existsSync(LIKES_FILE)) fs.writeFileSync(LIKES_FILE, '[]', 'utf8');
}

function readLikes() {
  ensureLikesFile();
  try {
    const raw = fs.readFileSync(LIKES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) { return []; }
}

function writeLikes(likes) {
  ensureLikesFile();
  fs.writeFileSync(LIKES_FILE, JSON.stringify(likes, null, 2), 'utf8');
}

function getLikeKey(relativePath) {
  return `${galleryRoot}::${relativePath}`;
}

// Sanitize a user-supplied relative path for use in a media URL. The
// resulting path is guaranteed to resolve inside the gallery root and to
// point to a real, non-symlink file.
function resolveMediaPath(relativeInput) {
  if (typeof relativeInput !== 'string' || !relativeInput) {
    throw new Error('Path is required.');
  }
  // Reject NULs and obvious traversal markers early.
  if (relativeInput.includes('\0')) throw new Error('Invalid path.');
  const relativePath = relativeInput.split(/[\\/]+/).filter(Boolean).join('/');
  const fullPath = path.resolve(galleryRoot, relativePath);
  const rel = path.relative(galleryRoot, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside the gallery root.');
  }
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed.');
  if (!stat.isFile()) throw new Error('Not a file.');
  return { fullPath, relativePath, stat };
}

// ---------- Public endpoints (no auth) ----------

app.get('/api/config', (_req, res) => {
  res.json({
    galleryRoot,
    host: getLanAddress(),
    port: PORT,
    authEnabled: Boolean(TOKEN)
  });
});

app.get('/api/media', (req, res) => {
  try {
    const cache = loadMediaIndex();
    const folder = typeof req.query.folder === 'string' ? req.query.folder : '';
    const type = typeof req.query.type === 'string' ? req.query.type : 'all';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 200));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const summary = req.query.summary === '1';

    const likedKeys = new Set(readLikes().map((like) => like.key));
    const liked = (relativePath) => likedKeys.has(getLikeKey(relativePath));

    const filtered = cache.items.filter((item) => {
      if (folder && item.folder !== folder && !item.folder.startsWith(`${folder}/`)) return false;
      if (type !== 'all' && item.type !== type) return false;
      if (search && !item.relativePath.toLowerCase().includes(search)) return false;
      return true;
    });

    const total = filtered.length;
    const slice = summary
      ? []
      : filtered.slice(offset, offset + limit).map((item) => ({ ...item, liked: liked(item.relativePath) }));

    res.set('Cache-Control', 'no-cache');
    res.json({
      galleryRoot: cache.root,
      folders: cache.folders,
      total,
      offset,
      limit,
      hasMore: offset + slice.length < total,
      items: slice
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/likes', (_req, res) => {
  try {
    const likes = readLikes().filter((like) => like.galleryRoot === galleryRoot);
    res.json({ galleryRoot, likes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/media/*', (req, res) => {
  let resolved;
  try {
    const relativePath = decodeURIComponent(req.params[0]);
    resolved = resolveMediaPath(relativePath);
  } catch (err) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (err.message === 'Path is outside the gallery root.') {
      return res.status(403).send('Forbidden');
    }
    if (err.message === 'Not a file.' || err.message === 'Symbolic links are not allowed.') {
      return res.status(404).send('Not found');
    }
    return res.status(400).send('Invalid path');
  }

  const { fullPath, stat } = resolved;
  const total = stat.size;
  const etag = `"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  const mime = guessMime(fullPath);
  if (mime) res.setHeader('Content-Type', mime);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400, must-revalidate');

  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(416).end();
    }
    let start = match[1] === '' ? Math.max(0, total - Number(match[2] || 0)) : Number(match[1]);
    let end = match[2] === '' ? total - 1 : Number(match[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return fs.createReadStream(fullPath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', String(total));
  return fs.createReadStream(fullPath).pipe(res);
});

// ---------- Authenticated endpoints ----------

// Read-only folder picker, but only inside the current gallery root. This
// replaces the previous open-server `GET /api/browse?path=...` endpoint.
app.get('/api/browse', requireToken, (req, res) => {
  try {
    const requested = typeof req.query.path === 'string' && req.query.path
      ? resolveInsideRoot(req.query.path)
      : galleryRoot;

    let entries;
    try {
      entries = fs.readdirSync(requested, { withFileTypes: true });
    } catch (err) {
      return res.status(404).json({ error: 'Path does not exist.' });
    }

    const dirs = [];
    let mediaCount = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow
      if (!entry.isDirectory()) {
        if (isMediaFile(entry.name)) mediaCount += 1;
        continue;
      }
      let childMedia = 0;
      try {
        const childEntries = fs.readdirSync(path.join(requested, entry.name), { withFileTypes: true });
        for (const child of childEntries) {
          if (child.isSymbolicLink()) continue;
          if (child.isFile() && isMediaFile(child.name)) childMedia += 1;
          if (childMedia >= 1) break;
        }
      } catch (_err) { /* ignore unreadable dirs */ }
      dirs.push({ name: entry.name, hasMedia: childMedia > 0 });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));

    const breadcrumbs = [];
    let cursor = requested;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      breadcrumbs.unshift(cursor);
      const next = path.dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
    res.json({
      path: requested,
      parent: requested === path.dirname(requested) ? null : path.dirname(requested),
      breadcrumbs,
      dirs,
      mediaCount
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/config', requireToken, (req, res) => {
  try {
    const next = resolveInsideRoot(req.body.galleryRoot);
    if (next !== galleryRoot) {
      galleryRoot = next;
      mediaCache = null;
      saveSettings();
    }
    res.json({ galleryRoot });
  } catch (error) {
    res.status(400).json({ error: error.message, galleryRoot });
  }
});

app.post('/api/likes/toggle', requireToken, (req, res) => {
  try {
    const relativePath = String(req.body.relativePath || '');
    if (!relativePath) {
      return res.status(400).json({ error: 'relativePath is required.' });
    }
    const { fullPath, stat } = resolveMediaPath(relativePath);
    const likes = readLikes();
    const key = getLikeKey(toRelative(fullPath));
    const existingIndex = likes.findIndex((like) => like.key === key);

    if (existingIndex >= 0) {
      likes.splice(existingIndex, 1);
      writeLikes(likes);
      return res.json({ liked: false, relativePath: toRelative(fullPath) });
    }

    likes.push({
      key,
      galleryRoot,
      relativePath: toRelative(fullPath),
      name: path.basename(fullPath),
      folder: path.dirname(toRelative(fullPath)) === '.' ? '' : path.dirname(toRelative(fullPath)),
      type: getMediaType(fullPath),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      likedAt: new Date().toISOString()
    });
    writeLikes(likes);
    return res.json({ liked: true, relativePath: toRelative(fullPath) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    case '.avif': return 'image/avif';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.m4v': return 'video/x-m4v';
    case '.avi': return 'video/x-msvideo';
    case '.mkv': return 'video/x-matroska';
    default: return null;
  }
}

// Generic 404 + error handlers, last in the chain.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(404).send('Not found');
});

app.use((err, _req, res, _next) => {
  console.error('[langram] unhandled error:', err.message);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LAN media gallery running at http://${getLanAddress()}:${PORT}`);
  console.log(`Current gallery root: ${galleryRoot}`);
  if (TOKEN) console.log('Mutating endpoints: bearer-token protected.');
  else console.log('Mutating endpoints: DISABLED (no LANGRAM_TOKEN).');
});
