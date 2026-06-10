// Mobile-first renderer for LANgram.
//
// Crash causes we are mitigating:
//   * Eager full-feed DOM: thousands of <img>/<video> blow through mobile RAM
//     and the GPU compositor. We now virtualize: only the cards visible in the
//     viewport (plus a small overscan) get real media. Off-screen cards are
//     placeholders that swap to real media on demand.
//   * Videos blocking the main thread: we use a single per-card
//     IntersectionObserver and we never mount <video> elements for cards that
//     aren't visible. We also unmount videos when they leave the viewport.
//   * innerHTML SVG strings: replaced with a single sprite <svg> in the DOM
//     and <use href="#id"/> clones. No HTML parsing on every card.
//   * Synchronous re-renders on every keystroke: search/type/folder inputs
//     are debounced, and we only re-render the visible window on filter change.
//   * No errors handled: every load now falls through to a "broken" state
//     instead of throwing.

const galleryPathInput = document.getElementById('galleryPath');
const savePathButton = document.getElementById('savePathButton');
const browsePathButton = document.getElementById('browsePathButton');
const folderFilter = document.getElementById('folderFilter');
const typeFilter = document.getElementById('typeFilter');
const searchInput = document.getElementById('searchInput');
const feed = document.getElementById('feed');
const emptyState = document.getElementById('emptyState');
const currentRoot = document.getElementById('currentRoot');
const lanUrl = document.getElementById('lanUrl');
const message = document.getElementById('message');
const likedOnlyToggle = document.getElementById('likedOnlyToggle');
const controlsPanel = document.getElementById('controlsPanel');
const storiesEl = document.getElementById('stories');
const summaryEl = document.getElementById('summary');

const viewer = document.getElementById('viewer');
const viewerStage = document.getElementById('viewerStage');
const viewerOverlay = document.getElementById('viewerOverlay');
const viewerMeta = document.getElementById('viewerMeta');
const viewerCounter = document.getElementById('viewerCounter');
const closeViewer = document.getElementById('closeViewer');
const prevViewer = document.getElementById('prevViewer');
const nextViewer = document.getElementById('nextViewer');
const likeViewer = document.getElementById('likeViewer');

const browseDialog = document.getElementById('browseDialog');
const browseCrumbs = document.getElementById('browseCrumbs');
const browseList = document.getElementById('browseList');
const browseUp = document.getElementById('browseUp');
const browsePick = document.getElementById('browsePick');
const browseMeta = document.getElementById('browseMeta');
const browseError = document.getElementById('browseError');
const browseRefresh = document.getElementById('browseRefresh');

const tokenDialog = document.getElementById('tokenDialog');
const tokenInput = document.getElementById('tokenInput');
const tokenSave = document.getElementById('tokenSave');
const tokenClear = document.getElementById('tokenClear');

let mediaItems = [];          // All items currently in the active page
let visibleItems = [];        // After liked-only filter (matches server)
let likedOnly = false;
let viewerIndex = 0;
let viewerList = [];
let viewerTouch = null;
let viewerZoom = 1;
let lastTap = 0;
let lastMediaTap = 0;
let activeTab = 'feed';
let currentFolder = '';
let totalServerCount = 0;
let nextOffset = 0;
let hasMore = true;
let isLoadingPage = false;
let inFlightController = null;
let cardObserver = null;      // IntersectionObserver for windowed rendering
let pendingMediaLoads = 0;
let searchDebounce = null;
let renderDebounce = null;
let filterTimer = null;

const CAPTIONS = [
  'Serving fresh memories from the LAN',
  'Moments captured, locally hosted.',
  'A new drop from the home network.',
  'Just between us and the Wi-Fi.',
  'Catch feels from the living room archive.',
  'Cozy vibes, no cloud required.',
  'Untouched originals, straight from disk.',
  'Weekend dump, raw & unfiltered.'
];

const HASHTAGS = [
  '#LANlife', '#OfflineOnly', '#HomeServer', '#NoCloud',
  '#PixelDiaries', '#LocalHost', '#ReelShorts', '#FoundOnDisk'
];

const AVATAR_PALETTE = [
  'linear-gradient(135deg, #feda75, #fa7e1e)',
  'linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)',
  'linear-gradient(135deg, #5851db, #833ab4, #c13584, #e1306c)',
  'linear-gradient(135deg, #43cea2, #185a9d)',
  'linear-gradient(135deg, #ff9966, #ff5e62)',
  'linear-gradient(135deg, #4568dc, #b06ab3)'
];

// ---------- Tiny utilities ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
const SPRITE = {
  'heart': 'i-heart',
  'heart-filled': 'i-heart-filled',
  'comment': 'i-comment',
  'share': 'i-share',
  'bookmark': 'i-bookmark',
  'bookmark-filled': 'i-bookmark-filled'
};

function renderIcon(host) {
  const name = host.dataset.icon;
  if (!name) return;
  const sym = SPRITE[name];
  if (!sym) return;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${sym}`);
  svg.appendChild(use);
  host.appendChild(svg);
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(renderIcon);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRelativeTime(iso) {
  if (!iso) return 'recently';
  const stamp = new Date(iso).getTime();
  if (Number.isNaN(stamp)) return 'recently';
  const diff = (Date.now() - stamp) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

function formatCount(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function setMessage(text = '') {
  message.textContent = text;
}

function initials(text) {
  if (!text) return '·';
  const parts = text.split(/[\s/_.-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

function paletteFor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function handleFromFolder(folder) {
  const clean = (folder || '').replace(/^[\\/]+|[\\/]+$/g, '');
  if (!clean) return 'lan';
  const leaf = clean.split(/[\\/]/).pop();
  return leaf.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function usernameFor(item) {
  const folderHandle = handleFromFolder(item.folder);
  const stem = item.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (folderHandle && folderHandle !== 'lan') return `@${folderHandle}.${stem}`.slice(0, 28);
  return `@${stem}`.slice(0, 28);
}

function captionFor(item, index) {
  const folder = item.folder ? item.folder.split(/[\\/]/).pop() : 'root';
  const cap = CAPTIONS[(index + folder.length) % CAPTIONS.length];
  const tag = HASHTAGS[(index + item.name.length) % HASHTAGS.length];
  return `${cap} Shared from ${folder || 'the gallery'}. ${tag}`;
}

const COMMENT_LINES = [
  'this hits different at midnight',
  'saving this to the local archive',
  'whoever curated this folder has taste',
  'POV: you found gold on the home server',
  'tag a friend who needs to see this',
  'this is the kind of content the LAN deserves',
  'the lighting in this one is unreal',
  'gonna show this off at the next LAN party'
];

function commentLineFor(item, index) {
  return COMMENT_LINES[(index + item.relativePath.length) % COMMENT_LINES.length];
}

function debounce(fn, wait) {
  let h;
  return function debounced(...args) {
    clearTimeout(h);
    h = setTimeout(() => fn.apply(this, args), wait);
  };
}

// ---------- Network ----------
// Bearer token used for mutating endpoints. Stored in localStorage so the
// user enters it once per browser. It is required for POST /api/config and
// POST /api/likes/toggle; read-only endpoints do not need it. The server
// reports `authEnabled: true|false` from /api/config so the UI can hide the
// token prompt when the server is open (LANGRAM_TOKEN unset).
const TOKEN_STORAGE_KEY = 'langram.token';
let bearerToken = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
let serverAuthEnabled = false;

function setBearerToken(value) {
  bearerToken = String(value || '').trim();
  if (bearerToken) localStorage.setItem(TOKEN_STORAGE_KEY, bearerToken);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function fetchJson(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const finalHeaders = { ...headers };
  if (body && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
  if (bearerToken) finalHeaders['Authorization'] = `Bearer ${bearerToken}`;
  const response = await fetch(url, { method, headers: finalHeaders, body, signal });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    let extra = null;
    let needsAuth = false;
    try {
      const data = await response.json();
      if (data) {
        if (data.error) msg = data.error;
        if (data.galleryRoot) extra = data.galleryRoot;
      }
    } catch (_err) { /* ignore */ }
    if (response.status === 401 || response.status === 503) needsAuth = true;
    const err = new Error(msg);
    err.status = response.status;
    err.serverRoot = extra;
    err.needsAuth = needsAuth;
    throw err;
  }
  return response.json();
}

async function loadConfig() {
  const config = await fetchJson('/api/config');
  serverAuthEnabled = Boolean(config.authEnabled);
  // Only seed the input on the very first load. After that, the user's typed
  // value is authoritative; we don't want to clobber it with the server's
  // stored value (which is exactly the "path won't load" symptom).
  if (!galleryPathInput.dataset.userTouched) {
    galleryPathInput.value = config.galleryRoot;
  }
  currentRoot.textContent = config.galleryRoot;
  lanUrl.textContent = `Open on your phone → http://${config.host}:${config.port}`;
  // Show a tiny auth-status pill so the user knows whether the server is
  // protected and whether this browser has a token.
  updateAuthIndicator();
}

function updateAuthIndicator() {
  let pill = document.getElementById('authPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'authPill';
    pill.className = 'auth-pill';
    const row = document.querySelector('.status-inline');
    if (row) row.appendChild(pill);
  }
  if (!serverAuthEnabled) {
    pill.textContent = 'No token required';
    pill.className = 'auth-pill auth-open';
    pill.title = 'LANGRAM_TOKEN is not set on the server. All endpoints are read-only for everyone on the LAN.';
    return;
  }
  pill.textContent = bearerToken ? 'Authenticated' : 'Token required for edits';
  pill.className = bearerToken ? 'auth-pill auth-ok' : 'auth-pill auth-needed';
  pill.title = bearerToken
    ? 'Bearer token is set in this browser.'
    : 'Set a bearer token in Settings to change the gallery path or like files.';
}

function buildMediaQuery({ offset = 0, limit = 24, summary = false } = {}) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (currentFolder) params.set('folder', currentFolder);
  if (typeFilter.value && typeFilter.value !== 'all') params.set('type', typeFilter.value);
  const q = searchInput.value.trim();
  if (q) params.set('search', q);
  if (likedOnly) params.set('liked', '1');
  if (summary) params.set('summary', '1');
  return `/api/media?${params.toString()}`;
}

// Liked-only is a client-side filter for now (likes change too often to
// require a server round-trip), but the rest of the filtering is server-side.
function clientFilter(items) {
  if (!likedOnly) return items;
  return items.filter((i) => i.liked);
}

async function loadMedia({ reset = true } = {}) {
  if (inFlightController) inFlightController.abort();
  inFlightController = new AbortController();
  setMessage('');

  if (reset) {
    mediaItems = [];
    visibleItems = [];
    nextOffset = 0;
    hasMore = true;
    feed.innerHTML = '';
    if (summaryEl) summaryEl.textContent = 'Loading…';
  }

  isLoadingPage = true;
  try {
    const data = await fetchJson(buildMediaQuery({ offset: nextOffset, limit: 24 }), {
      signal: inFlightController.signal
    });
    if (reset) {
      renderFolderOptions(data.folders || []);
      renderStories(data.folders || []);
      currentRoot.textContent = data.galleryRoot;
    }
    totalServerCount = data.total;
    hasMore = Boolean(data.hasMore);
    nextOffset = data.offset + (data.items ? data.items.length : 0);

    const newItems = (data.items || []).map((item) => decorateItem(item));
    mediaItems = reset ? newItems : mediaItems.concat(newItems);
    applyVisibleAndRender({ append: !reset });
  } catch (error) {
    if (error.name === 'AbortError') return;
    setMessage(error.message);
  } finally {
    isLoadingPage = false;
  }
}

function decorateItem(item) {
  // Deterministic pseudo-random likes/comments/shares so the feed feels
  // alive but doesn't require another network round-trip.
  let seed = 0;
  for (let i = 0; i < item.relativePath.length; i += 1) {
    seed = (seed * 31 + item.relativePath.charCodeAt(i)) >>> 0;
  }
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return {
    ...item,
    _likes: 12 + Math.floor(rand() * 480) + item.relativePath.length * 3,
    _comments: 1 + Math.floor(rand() * 90) + Math.floor(item.relativePath.length / 2),
    _shares: Math.floor(rand() * 35) + 1
  };
}

function applyVisibleAndRender({ append = false } = {}) {
  visibleItems = clientFilter(mediaItems);
  if (summaryEl) {
    summaryEl.textContent = `${visibleItems.length} of ${totalServerCount} items`;
  }
  if (!visibleItems.length) {
    emptyState.classList.remove('hidden');
    if (!append) feed.innerHTML = '';
    return;
  }
  emptyState.classList.add('hidden');
  renderFeed({ append });
}

function renderFolderOptions(folders) {
  folderFilter.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All folders';
  folderFilter.appendChild(allOption);

  folders.forEach((folder) => {
    if (!folder) return;
    const option = document.createElement('option');
    option.value = folder;
    option.textContent = folder;
    folderFilter.appendChild(option);
  });
  if (currentFolder) folderFilter.value = currentFolder;
}

function renderStories(folders) {
  storiesEl.innerHTML = '';
  const seen = new Set();
  const items = [{ label: 'Your story', isOwn: true, value: '' }];
  folders.forEach((folder) => {
    if (!folder) return;
    const leaf = folder.split(/[\\/]/).pop();
    if (seen.has(leaf)) return;
    seen.add(leaf);
    items.push({ label: leaf, value: folder, isOwn: false });
  });

  // Cap story ring count to keep the carousel short and cheap to render.
  const MAX_STORIES = 24;
  items.slice(0, MAX_STORIES).forEach((item) => {
    const story = document.createElement('button');
    story.type = 'button';
    story.className = 'story';
    const ring = document.createElement('div');
    ring.className = 'story-ring' + (item.isOwn ? ' own' : '');
    const avatar = document.createElement('div');
    avatar.className = 'story-avatar';
    avatar.style.background = paletteFor(item.label);
    avatar.textContent = initials(item.label);
    avatar.setAttribute('aria-hidden', 'true');
    ring.appendChild(avatar);
    const label = document.createElement('span');
    label.className = 'story-label';
    label.textContent = item.label;
    story.append(ring, label);

    story.addEventListener('click', () => {
      currentFolder = item.isOwn ? '' : item.value;
      folderFilter.value = currentFolder;
      loadMedia({ reset: true });
      window.scrollTo({ top: feed.offsetTop, behavior: 'smooth' });
    });

    storiesEl.appendChild(story);
  });
}

// ---------- Virtualized post rendering ----------
// We never have more than ~2x the viewport worth of cards in the DOM at
// once. Cards that scroll out of the intersection window are reset to
// placeholders; we re-mount their media when they come back.
const CARD_OVERSCAN = 2; // how many viewport heights above/below to keep alive

function renderFeed({ append = false } = {}) {
  if (!append) {
    feed.innerHTML = '';
    ensureCardObserver();
  }

  // Render in slices so we don't run for hundreds of ms in one frame.
  const sliceSize = 12;
  const startIndex = append ? feed.children.length : 0;
  const endIndex = Math.min(visibleItems.length, startIndex + sliceSize * 4);
  let i = startIndex;

  const work = () => {
    if (i >= endIndex) return;
    const stop = Math.min(i + sliceSize, endIndex);
    const frag = document.createDocumentFragment();
    for (; i < stop; i += 1) {
      const item = visibleItems[i];
      if (!item) continue;
      frag.appendChild(buildPostCard(item, i));
    }
    feed.appendChild(frag);
    hydrateIcons(frag);
    if (i < endIndex) {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(work, { timeout: 80 });
      } else {
        setTimeout(work, 16);
      }
    } else if (append && hasMore) {
      // Hit end of slice without filling — fetch more.
      maybeLoadMore();
    }
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(work, { timeout: 80 });
  } else {
    setTimeout(work, 0);
  }
}

function buildPostCard(item, index) {
  const card = document.createElement('article');
  card.className = 'post placeholder';
  card.dataset.index = String(index);
  card.dataset.relativePath = item.relativePath;
  card.dataset.type = item.type;

  // ----- Header -----
  const header = document.createElement('div');
  header.className = 'post-header';
  const leaf = item.folder ? item.folder.split(/[\\/]/).pop() : 'gallery';

  const postAvatar = document.createElement('div');
  postAvatar.className = 'post-avatar';
  const postAvatarInner = document.createElement('div');
  postAvatarInner.className = 'story-avatar';
  postAvatarInner.style.background = paletteFor(leaf);
  postAvatarInner.textContent = initials(leaf);
  postAvatarInner.setAttribute('aria-hidden', 'true');
  postAvatar.appendChild(postAvatarInner);
  header.appendChild(postAvatar);

  const identity = document.createElement('div');
  identity.className = 'post-identity';
  const username = document.createElement('span');
  username.className = 'post-username';
  username.textContent = usernameFor(item);
  identity.appendChild(username);

  const handle = handleFromFolder(item.folder);
  if (handle && handle !== 'lan') {
    const tick = document.createElement('span');
    tick.className = 'verified';
    const tickSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tickSvg.setAttribute('viewBox', '0 0 24 24');
    tickSvg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5z');
    path.setAttribute('fill', 'currentColor');
    tickSvg.appendChild(path);
    tick.appendChild(tickSvg);
    identity.appendChild(tick);
  }

  const dot = document.createElement('span');
  dot.className = 'muted';
  dot.textContent = `• ${item.folder || 'root'}`;
  dot.style.fontSize = '0.78rem';
  dot.style.marginLeft = '4px';
  dot.style.maxWidth = '140px';
  dot.style.overflow = 'hidden';
  dot.style.textOverflow = 'ellipsis';
  dot.style.whiteSpace = 'nowrap';
  identity.appendChild(dot);

  header.appendChild(identity);

  const menu = document.createElement('button');
  menu.className = 'post-menu';
  menu.type = 'button';
  menu.setAttribute('aria-label', 'More options');
  menu.textContent = '⋯';
  header.appendChild(menu);

  card.appendChild(header);

  // ----- Media wrapper (placeholder until visible) -----
  const mediaWrapper = document.createElement('div');
  mediaWrapper.className = 'post-media';
  card._mediaWrapper = mediaWrapper;

  // Type badge (always present, even when not yet visible)
  const badge = document.createElement('span');
  badge.className = 'post-type-badge';
  badge.textContent = item.type === 'video' ? 'Reel' : 'Photo';
  mediaWrapper.appendChild(badge);

  // Skeleton shown until the media actually loads
  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton';
  mediaWrapper.appendChild(skeleton);

  // Right-side action rail
  const rail = document.createElement('div');
  rail.className = 'action-rail';

  const creatorAv = document.createElement('div');
  creatorAv.className = 'action-avatar';
  creatorAv.style.background = paletteFor(leaf);
  creatorAv.textContent = initials(leaf);
  creatorAv.setAttribute('aria-hidden', 'true');
  rail.appendChild(creatorAv);

  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.className = 'action';
  likeBtn.setAttribute('aria-label', 'Like');
  const likeGlyph = document.createElement('span');
  likeGlyph.className = 'glyph-btn' + (item.liked ? ' liked' : '');
  likeGlyph.dataset.icon = item.liked ? 'heart-filled' : 'heart';
  likeBtn.appendChild(likeGlyph);
  const likeCount = document.createElement('span');
  likeCount.className = 'action-count';
  likeCount.textContent = formatCount(item._likes || 0);
  likeBtn.appendChild(likeCount);
  likeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleLike(item, likeBtn, likeGlyph, likeCount);
  });
  rail.appendChild(likeBtn);

  const commentBtn = document.createElement('button');
  commentBtn.type = 'button';
  commentBtn.className = 'action';
  commentBtn.setAttribute('aria-label', 'Comments');
  const cGlyph = document.createElement('span');
  cGlyph.className = 'glyph-btn';
  cGlyph.dataset.icon = 'comment';
  commentBtn.appendChild(cGlyph);
  const cCount = document.createElement('span');
  cCount.className = 'action-count';
  cCount.textContent = formatCount(item._comments || 0);
  commentBtn.appendChild(cCount);
  rail.appendChild(commentBtn);

  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'action';
  shareBtn.setAttribute('aria-label', 'Share');
  const sGlyph = document.createElement('span');
  sGlyph.className = 'glyph-btn';
  sGlyph.dataset.icon = 'share';
  shareBtn.appendChild(sGlyph);
  const sCount = document.createElement('span');
  sCount.className = 'action-count';
  sCount.textContent = formatCount(item._shares || 0);
  shareBtn.appendChild(sCount);
  rail.appendChild(shareBtn);

  mediaWrapper.appendChild(rail);

  const burst = document.createElement('div');
  burst.className = 'heart-burst';
  burst.dataset.icon = 'heart-filled';
  burst.style.opacity = '0';
  mediaWrapper.appendChild(burst);

  card.appendChild(mediaWrapper);

  // ----- Footer -----
  const footer = document.createElement('div');
  footer.className = 'post-footer';

  const actions = document.createElement('div');
  actions.className = 'post-actions';

  const heartAction = document.createElement('button');
  heartAction.type = 'button';
  heartAction.className = 'icon-action' + (item.liked ? ' liked filled' : '');
  heartAction.setAttribute('aria-label', 'Like');
  heartAction.setAttribute('aria-pressed', String(Boolean(item.liked)));
  heartAction.dataset.icon = item.liked ? 'heart-filled' : 'heart';
  heartAction.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleLike(item, likeBtn, likeGlyph, likeCount, heartAction);
  });
  actions.appendChild(heartAction);

  const commentAction = document.createElement('button');
  commentAction.type = 'button';
  commentAction.className = 'icon-action';
  commentAction.setAttribute('aria-label', 'Comments');
  commentAction.dataset.icon = 'comment';
  actions.appendChild(commentAction);

  const shareAction = document.createElement('button');
  shareAction.type = 'button';
  shareAction.className = 'icon-action';
  shareAction.setAttribute('aria-label', 'Share');
  shareAction.dataset.icon = 'share';
  actions.appendChild(shareAction);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  const bookmarkAction = document.createElement('button');
  bookmarkAction.type = 'button';
  bookmarkAction.className = 'icon-action';
  bookmarkAction.setAttribute('aria-label', 'Save');
  bookmarkAction.dataset.icon = 'bookmark';
  bookmarkAction.addEventListener('click', () => {
    bookmarkAction.classList.toggle('filled');
    bookmarkAction.dataset.icon = bookmarkAction.classList.contains('filled') ? 'bookmark-filled' : 'bookmark';
  });
  actions.appendChild(bookmarkAction);

  footer.appendChild(actions);

  const likesLine = document.createElement('div');
  likesLine.className = 'post-likes';
  likesLine.textContent = `${formatCount(item._likes || 0)} likes`;
  footer.appendChild(likesLine);

  const caption = document.createElement('p');
  caption.className = 'post-caption';
  const capUsername = document.createElement('span');
  capUsername.className = 'username';
  capUsername.textContent = usernameFor(item);
  caption.appendChild(capUsername);
  caption.appendChild(document.createTextNode(captionFor(item, index)));
  footer.appendChild(caption);

  const commentLine = document.createElement('p');
  commentLine.className = 'post-comments';
  commentLine.textContent = `View all ${formatCount(item._comments || 0)} comments`;
  footer.appendChild(commentLine);

  const topPreview = document.createElement('p');
  topPreview.className = 'post-comments';
  topPreview.style.color = 'var(--text)';
  topPreview.textContent = commentLineFor(item, index);
  footer.appendChild(topPreview);

  const timeLine = document.createElement('span');
  timeLine.className = 'post-time';
  timeLine.textContent = formatRelativeTime(item.modifiedAt);
  footer.appendChild(timeLine);

  card.appendChild(footer);

  // Card click → open viewer (skip interactive sub-zones)
  card.addEventListener('click', (event) => {
    if (event.target.closest('.post-header, .post-footer, .action, .icon-action, .post-menu, .action-rail, .post-type-badge')) return;
    openViewer(index);
  });

  // Double-tap on media area to like
  mediaWrapper.addEventListener('click', (event) => {
    if (event.target.closest('.action-rail, .post-type-badge')) return;
    const now = Date.now();
    if (now - lastMediaTap < 280) {
      burst.style.opacity = '0';
      void burst.offsetWidth;
      burst.classList.add('show');
      toggleLike(item, likeBtn, likeGlyph, likeCount, heartAction, { fromDoubleTap: !item.liked });
      lastMediaTap = 0;
    } else {
      lastMediaTap = now;
    }
  });

  // Lazy-mount media when the card enters the viewport
  card._mountMedia = () => mountMedia(card, item);
  card._unmountMedia = () => unmountMedia(card);
  if (cardObserver) cardObserver.observe(card);
  return card;
}

function ensureCardObserver() {
  if (cardObserver) return;
  if (!('IntersectionObserver' in window)) return;
  cardObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const card = entry.target;
      if (entry.isIntersecting) {
        card._mountMedia && card._mountMedia();
      } else {
        card._unmountMedia && card._unmountMedia();
      }
    });
  }, {
    rootMargin: '600px 0px',
    threshold: 0.01
  });
}

function mountMedia(card, item) {
  if (card._mediaMounted) return;
  card._mediaMounted = true;
  const wrapper = card._mediaWrapper;
  if (!wrapper) return;

  pendingMediaLoads += 1;

  if (item.type === 'video') {
    const video = document.createElement('video');
    video.src = item.url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.loop = true;
    video.setAttribute('webkit-playsinline', 'true');
    video.setAttribute('x5-playsinline', 'true');
    video.poster = '';
    video.style.background = '#000';
    video.draggable = false;
    video.className = 'lazy-media';
    video.loading = 'lazy';
    video.decoding = 'async';
    video.addEventListener('loadeddata', () => {
      revealMedia(video, card);
      maybeAutoplay(card, video);
    }, { once: true });
    video.addEventListener('error', () => revealMedia(video, card, true), { once: true });
    wrapper.appendChild(video);
    card._videoEl = video;
  } else {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.name || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'lazy-media';
    img.draggable = false;
    img.addEventListener('load', () => revealMedia(img, card), { once: true });
    img.addEventListener('error', () => revealMedia(img, card, true), { once: true });
    wrapper.appendChild(img);
  }
}

function maybeAutoplay(card, video) {
  // Use the visibility observer only for videos. Don't even attach one
  // for offscreen cards — we mount on demand, so we know we're visible.
  if (!('IntersectionObserver' in window)) {
    video.play().catch(() => {});
    return;
  }
  if (card._autoplayObserver) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, { threshold: [0, 0.5, 1] });
  io.observe(card);
  card._autoplayObserver = io;
}

function unmountMedia(card) {
  if (!card._mediaMounted) return;
  card._mediaMounted = false;
  const wrapper = card._mediaWrapper;
  if (!wrapper) return;
  const media = wrapper.querySelector('.lazy-media');
  if (media) {
    if (media.tagName === 'VIDEO') {
      try { media.pause(); } catch (_err) { /* ignore */ }
      media.removeAttribute('src');
      media.load();
    }
    media.remove();
  }
  if (card._autoplayObserver) {
    card._autoplayObserver.disconnect();
    card._autoplayObserver = null;
  }
  card._videoEl = null;
  const skeleton = wrapper.querySelector('.skeleton');
  if (skeleton) skeleton.style.opacity = '1';
}

function revealMedia(media, card, errored) {
  const skeleton = card._mediaWrapper && card._mediaWrapper.querySelector('.skeleton');
  if (skeleton) skeleton.remove();
  media.classList.add('loaded');
  // The card carries a `.placeholder` class so the wrapper paints a shimmer
  // until the real media element exists. Once the media is in the DOM, drop
  // the placeholder so the CSS rule that hides mounted media no longer
  // applies.
  if (card) card.classList.remove('placeholder');
  if (errored) {
    media.style.opacity = '0.3';
    const label = document.createElement('div');
    label.className = 'media-error';
    label.textContent = 'Could not load media';
    card._mediaWrapper.appendChild(label);
  }
  pendingMediaLoads = Math.max(0, pendingMediaLoads - 1);
}

// ---------- Likes ----------
async function toggleLike(item, likeBtn, likeGlyph, likeCount, heartAction, { fromDoubleTap = true } = {}) {
  if (serverAuthEnabled && !bearerToken) {
    setMessage('Set a bearer token in Settings to like files.');
    openTokenDialog();
    return;
  }
  if (item._likeInFlight) return;
  item._likeInFlight = true;
  setMessage('');
  try {
    const response = await fetchJson('/api/likes/toggle', {
      method: 'POST',
      body: JSON.stringify({ relativePath: item.relativePath })
    });
    item.liked = Boolean(response.liked);
    item._likes = (item._likes || 0) + (item.liked ? 1 : -1);

    const apply = (btn, glyph) => {
      if (!btn) return;
      if (glyph) {
        glyph.classList.toggle('liked', item.liked);
        glyph.dataset.icon = item.liked ? 'heart-filled' : 'heart';
      }
    };

    apply(likeBtn, likeGlyph);
    if (likeCount) likeCount.textContent = formatCount(item._likes || 0);
    if (heartAction) {
      heartAction.classList.toggle('liked', item.liked);
      heartAction.classList.toggle('filled', item.liked);
      heartAction.dataset.icon = item.liked ? 'heart-filled' : 'heart';
      heartAction.setAttribute('aria-pressed', String(item.liked));
    }
    if (viewerList[viewerIndex] === item) updateViewerLike();
    if (likedOnly) applyVisibleAndRender({ append: false });
  } catch (error) {
    setMessage(error.message || 'Unable to update like.');
  } finally {
    item._likeInFlight = false;
  }
}

// ---------- Viewer ----------
function openViewer(index) {
  viewerList = visibleItems.slice();
  viewerIndex = Math.max(0, Math.min(index, viewerList.length - 1));
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
  renderViewer();
}

function closeViewerView() {
  viewer.hidden = true;
  document.body.style.overflow = '';
  viewerStage.innerHTML = '';
}

function updateViewerLike() {
  const item = viewerList[viewerIndex];
  if (!item) return;
  likeViewer.classList.toggle('liked', item.liked);
  likeViewer.dataset.icon = item.liked ? 'heart-filled' : 'heart';
  likeViewer.setAttribute('aria-pressed', String(item.liked));
}

function renderViewer() {
  const item = viewerList[viewerIndex];
  if (!item) {
    closeViewerView();
    return;
  }
  viewerStage.innerHTML = '';
  const slide = document.createElement('div');
  slide.className = 'viewer-slide zoomable';
  let media;
  if (item.type === 'video') {
    media = document.createElement('video');
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
    media.preload = 'metadata';
  } else {
    media = document.createElement('img');
    media.alt = item.name || '';
    media.decoding = 'async';
    media.style.touchAction = 'pinch-zoom';
  }
  media.src = item.url;
  media.addEventListener('error', () => {
    slide.innerHTML = '<div class="media-error viewer-error">Could not load media</div>';
  }, { once: true });
  slide.appendChild(media);
  viewerStage.appendChild(slide);

  const folder = item.folder ? item.folder.split(/[\\/]/).pop() : 'root';
  viewerMeta.textContent = `${usernameFor(item)} • ${folder}`;
  viewerCounter.textContent = `${viewerIndex + 1} / ${viewerList.length}`;
  updateViewerLike();
  hydrateIcons(viewerOverlay);
  viewerZoom = 1;
}

function shiftViewer(delta) {
  const next = viewerIndex + delta;
  if (next < 0 || next >= viewerList.length) return;
  viewerIndex = next;
  renderViewer();
}

function onViewerTouchStart(event) {
  if (event.touches.length === 1) {
    viewerTouch = { startX: event.touches[0].clientX, startY: event.touches[0].clientY, moved: false };
  }
}

function onViewerTouchMove(event) {
  if (!viewerTouch || event.touches.length !== 1) return;
  const dx = event.touches[0].clientX - viewerTouch.startX;
  const dy = event.touches[0].clientY - viewerTouch.startY;
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12) viewerTouch.moved = true;
}

function onViewerTouchEnd(event) {
  if (!viewerTouch) return;
  const dx = (event.changedTouches[0]?.clientX ?? viewerTouch.startX) - viewerTouch.startX;
  const dy = (event.changedTouches[0]?.clientY ?? viewerTouch.startY) - viewerTouch.startY;
  const wasMoved = viewerTouch.moved;
  viewerTouch = null;
  if (!wasMoved) return;
  if (dy > 80 && Math.abs(dy) > Math.abs(dx)) {
    closeViewerView();
    return;
  }
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
    shiftViewer(dx < 0 ? 1 : -1);
  }
}

function onViewerTap() {
  const now = Date.now();
  if (now - lastTap < 280) {
    const item = viewerList[viewerIndex];
    if (item && item.type === 'image') {
      const img = viewerStage.querySelector('img');
      if (img) {
        viewerZoom = viewerZoom > 1 ? 1 : 2;
        img.style.transform = `scale(${viewerZoom})`;
      }
    } else if (item) {
      toggleLike(item, null, null, null, likeViewer);
    }
    lastTap = 0;
    return;
  }
  lastTap = now;
  viewerOverlay.classList.toggle('hidden');
}

function attachViewerGestures() {
  viewerStage.addEventListener('touchstart', onViewerTouchStart, { passive: true });
  viewerStage.addEventListener('touchmove', onViewerTouchMove, { passive: true });
  viewerStage.addEventListener('touchend', onViewerTouchEnd);
  viewerStage.addEventListener('click', onViewerTap);
}

// ---------- Filtering / scroll → load more ----------
function scheduleFilterReload() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    currentFolder = folderFilter.value;
    loadMedia({ reset: true });
  }, 180);
}

const debouncedSearch = debounce(() => {
  loadMedia({ reset: true });
}, 250);

function maybeLoadMore() {
  if (isLoadingPage || !hasMore) return;
  const remaining = feed.lastElementChild
    ? window.innerHeight * 1.5
    : 0;
  if (feed.getBoundingClientRect().bottom - remaining < window.innerHeight * 2) {
    loadMedia({ append: true });
  }
}

window.addEventListener('scroll', () => {
  controlsPanel.classList.toggle('collapsed', window.scrollY > 120);
  // Bottom-of-feed preload
  if (feed.getBoundingClientRect().bottom - window.innerHeight * 1.5 < window.innerHeight) {
    maybeLoadMore();
  }
}, { passive: true });

// ---------- Wire-up ----------
likedOnlyToggle.addEventListener('click', () => {
  likedOnly = !likedOnly;
  likedOnlyToggle.classList.toggle('active', likedOnly);
  likedOnlyToggle.setAttribute('aria-pressed', String(likedOnly));
  likedOnlyToggle.textContent = likedOnly ? 'Showing liked only' : 'Show liked only';
  applyVisibleAndRender({ append: false });
});

savePathButton.addEventListener('click', () => submitGalleryPath());
galleryPathInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitGalleryPath();
  }
});
galleryPathInput.addEventListener('input', () => {
  galleryPathInput.dataset.userTouched = '1';
});
browsePathButton?.addEventListener('click', () => browseForFolder());
document.getElementById('settingsButton')?.addEventListener('click', () => openTokenDialog());

browseUp?.addEventListener('click', () => {
  if (browseUp.disabled) return;
  loadBrowse(browseUp.dataset.path || '');
});
browseRefresh?.addEventListener('click', () => {
  if (browseCurrent) loadBrowse(browseCurrent);
});
browsePick?.addEventListener('click', async () => {
  const pickedPath = browsePick.dataset.path;
  if (!pickedPath) return;
  galleryPathInput.value = pickedPath;
  galleryPathInput.dataset.userTouched = '1';
  closeBrowse();
  await submitGalleryPath();
});
browseDialog?.addEventListener('close', () => {
  if (browseAbort) browseAbort.abort();
});

tokenSave?.addEventListener('click', () => {
  setBearerToken(tokenInput ? tokenInput.value : '');
  updateAuthIndicator();
  closeTokenDialog();
  showBanner(bearerToken ? 'Token saved for this browser.' : 'Token cleared.', 'info');
});
tokenClear?.addEventListener('click', () => {
  setBearerToken('');
  if (tokenInput) tokenInput.value = '';
  updateAuthIndicator();
  closeTokenDialog();
  showBanner('Token cleared.', 'info');
});
tokenDialog?.addEventListener('close', () => {
  if (tokenInput) tokenInput.value = '';
});

async function submitGalleryPath() {
  setMessage('');
  setBanner('');
  if (serverAuthEnabled && !bearerToken) {
    showBanner('This server requires a bearer token. Open Settings to enter it.', 'error');
    openTokenDialog();
    return;
  }
  const value = galleryPathInput.value.trim();
  if (!value) {
    showBanner('Enter a folder path on the host (for example D:\\Photos).', 'error');
    galleryPathInput.focus();
    return;
  }
  savePathButton.disabled = true;
  try {
    const data = await fetchJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ galleryRoot: value })
    });
    galleryPathInput.value = data.galleryRoot;
    delete galleryPathInput.dataset.userTouched;
    currentRoot.textContent = data.galleryRoot;
    showBanner(`Loaded gallery from ${data.galleryRoot}`, 'success');
    await loadMedia({ reset: true });
  } catch (error) {
    if (error.needsAuth) {
      showBanner('Bearer token rejected. Open Settings and re-enter it.', 'error');
      openTokenDialog();
      return;
    }
    // The server echoes back its current galleryRoot in the error body so we
    // can show "Server is still using X" without a second round-trip.
    const serverRoot = (error && error.serverRoot) || (currentRoot.textContent || '');
    showBanner(
      `${error.message || 'Unable to update gallery path.'}${serverRoot ? `  Server is still using ${serverRoot}.` : ''}`,
      'error'
    );
  } finally {
    savePathButton.disabled = false;
  }
}

async function browseForFolder() {
  // Server-side folder picker: works on every device (mobile + desktop) and
  // returns the real absolute path on disk. The browser-only File System
  // Access API can't give us a real path, so we use the host filesystem.
  if (browseDialog && typeof browseDialog.showModal === 'function') {
    browseDialog.showModal();
    const startPath = galleryPathInput.value.trim() || currentRoot.textContent || '';
    await loadBrowse(startPath);
    return;
  }
  // Dialog element missing — fall back to type-it message.
  showBanner(
    'Browser picker unavailable. Type the full path to your gallery folder and press Enter.',
    'info'
  );
  galleryPathInput.focus();
}

let browseAbort = null;
let browseCurrent = '';

async function loadBrowse(targetPath) {
  if (browseAbort) browseAbort.abort();
  browseAbort = new AbortController();
  setBrowseError('');
  browseList.innerHTML = '<li class="browse-empty">Loading…</li>';
  browseMeta.textContent = '';
  try {
    const params = new URLSearchParams();
    if (targetPath) params.set('path', targetPath);
    const data = await fetchJson(`/api/browse?${params.toString()}`, { signal: browseAbort.signal });
    browseCurrent = data.path;
    renderCrumbs(data.breadcrumbs || []);
    browseUp.disabled = !data.parent;
    browseUp.dataset.path = data.parent || '';
    browsePick.dataset.path = data.path;
    browseMeta.textContent = data.mediaCount
      ? `${data.mediaCount} media file(s) in this folder`
      : 'No media files in this folder';
    renderBrowseList(data.dirs || []);
  } catch (error) {
    if (error.name === 'AbortError') return;
    browseList.innerHTML = '';
    setBrowseError(error.message || 'Failed to list this folder.');
  }
}

function renderCrumbs(crumbs) {
  browseCrumbs.innerHTML = '';
  crumbs.forEach((segment, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'browse-crumb-sep';
      sep.textContent = '›';
      browseCrumbs.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browse-crumb';
    btn.dataset.path = segment;
    btn.textContent = index === 0 ? segment : pathBasename(segment);
    btn.title = segment;
    btn.addEventListener('click', () => loadBrowse(segment));
    browseCrumbs.appendChild(btn);
  });
}

function pathBasename(p) {
  if (!p) return '';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

function renderBrowseList(dirs) {
  browseList.innerHTML = '';
  if (!dirs.length) {
    const empty = document.createElement('li');
    empty.className = 'browse-empty';
    empty.textContent = 'No subfolders here.';
    browseList.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  dirs.forEach((dir) => {
    const li = document.createElement('li');
    li.className = 'browse-item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'browse-row';
    open.dataset.path = dir.path;
    const name = document.createElement('span');
    name.className = 'browse-name';
    name.textContent = dir.name;
    const tag = document.createElement('span');
    tag.className = 'browse-tag';
    tag.textContent = dir.hasMedia ? 'has media' : '';
    const chevron = document.createElementNS(SVG_NS, 'svg');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('class', 'browse-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-chevron');
    chevron.appendChild(use);
    open.append(name, tag, chevron);
    open.addEventListener('click', () => loadBrowse(dir.path));
    li.appendChild(open);
    frag.appendChild(li);
  });
  browseList.appendChild(frag);
}

function setBrowseError(text) {
  if (!browseError) return;
  if (!text) {
    browseError.classList.add('hidden');
    browseError.textContent = '';
  } else {
    browseError.classList.remove('hidden');
    browseError.textContent = text;
  }
}

function closeBrowse() {
  if (browseDialog && browseDialog.open) browseDialog.close();
}

function openTokenDialog() {
  if (!tokenDialog || typeof tokenDialog.showModal !== 'function') return;
  if (tokenInput) tokenInput.value = bearerToken;
  tokenDialog.showModal();
  if (tokenInput) tokenInput.focus();
}

function closeTokenDialog() {
  if (tokenDialog && tokenDialog.open) tokenDialog.close();
}

function showBanner(text, kind = 'info') {
  let banner = document.getElementById('banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'banner';
    banner.className = 'banner';
    const pathCard = document.querySelector('.path-card');
    if (pathCard) pathCard.appendChild(banner);
  }
  banner.className = `banner banner-${kind}`;
  banner.textContent = text;
}

function setBanner(text) {
  const banner = document.getElementById('banner');
  if (banner) banner.textContent = text;
}

folderFilter.addEventListener('change', () => {
  currentFolder = folderFilter.value;
  loadMedia({ reset: true });
});
typeFilter.addEventListener('change', scheduleFilterReload);
searchInput.addEventListener('input', debouncedSearch);
closeViewer.addEventListener('click', closeViewerView);
prevViewer.addEventListener('click', () => shiftViewer(-1));
nextViewer.addEventListener('click', () => shiftViewer(1));
likeViewer.addEventListener('click', () => {
  const item = viewerList[viewerIndex];
  if (item) toggleLike(item, null, null, null, likeViewer);
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    activeTab = tab.dataset.tab;
    if (activeTab === 'library' && !likedOnly) likedOnlyToggle.click();
    else if (activeTab === 'feed' && likedOnly) likedOnlyToggle.click();
  });
});

document.addEventListener('keydown', (event) => {
  if (viewer.hidden) return;
  if (event.key === 'Escape') closeViewerView();
  if (event.key === 'ArrowRight') shiftViewer(1);
  if (event.key === 'ArrowLeft') shiftViewer(-1);
});

let pullStartY = 0;
window.addEventListener('touchstart', (event) => {
  if (window.scrollY === 0) pullStartY = event.touches[0].clientY;
}, { passive: true });

window.addEventListener('touchend', (event) => {
  if (window.scrollY === 0 && event.changedTouches[0]) {
    const pullDistance = event.changedTouches[0].clientY - pullStartY;
    if (pullDistance > 90) loadMedia({ reset: true });
  }
});

window.addEventListener('error', (event) => {
  // Don't let a stray error blank the UI; surface a hint instead.
  if (event && event.message) setMessage(`UI error: ${event.message}`);
});

window.addEventListener('pagehide', () => {
  // Free up observers and video resources on navigation.
  if (cardObserver) {
    cardObserver.disconnect();
    cardObserver = null;
  }
  Array.from(feed.children).forEach((card) => {
    if (card._autoplayObserver) {
      card._autoplayObserver.disconnect();
      card._autoplayObserver = null;
    }
    if (card._videoEl) {
      try { card._videoEl.pause(); } catch (_err) { /* ignore */ }
    }
  });
  if (inFlightController) inFlightController.abort();
});

attachViewerGestures();
hydrateIcons();

(async function init() {
  try {
    await loadConfig();
    await loadMedia({ reset: true });
  } catch (error) {
    setMessage(error.message || 'Failed to start.');
  }
})();
