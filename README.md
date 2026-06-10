# LANgram

A small, self-hosted, mobile-first image and video gallery for your home
network. Point it at a folder, open the URL on your phone, and stream your
photos and short videos straight from disk — no cloud, no upload, no
account, no tracking.

It is a single Node.js process plus a static front-end. There is no
database, no build step, and no dependency beyond `express`.

## Features

- Choose a gallery root folder from any device on the LAN.
- Recursive scan of subfolders with a folder, type, and filename filter.
- Full-size image and video viewer with swipe / arrow-key navigation,
  pinch-to-zoom, and HTTP range streaming for large videos.
- Server-side pagination so 50,000-photo folders don't blow up a phone.
- Persistent "Likes" list stored in `data/likes.json` (gitignored).
- Modern, accessible UI: ARIA roles, keyboard navigation, reduced-motion
  support, dark / light color-scheme aware.
- Mobile-first virtualization: only the cards in the viewport mount real
  `<img>` / `<video>` elements, so a long feed stays smooth.

## Security model

LANgram is meant to run on a private network, but the security model is
written down so a curious friend on your Wi-Fi can't read the rest of your
disk by accident.

| Concern | Mitigation |
| --- | --- |
| Read access to files outside the gallery root | Every media path is resolved with `path.resolve` and then `path.relative` is checked against the gallery root. The walk refuses to follow symbolic links. The `walkMedia` recursion is bounded by `LANGRAM_MAX_DEPTH` (default 12) and `LANGRAM_MAX_FILES` (default 50,000). |
| Read access to the host filesystem via `/api/browse` | The folder picker is now restricted to **inside the current gallery root**. The previous version let anyone list any directory on the host. |
| Unauthenticated folder changes | `POST /api/config` (changing the gallery root) requires a bearer token via the `LANGRAM_TOKEN` environment variable. The token is compared with `crypto.timingSafeEqual`. |
| Unauthenticated writes | `POST /api/likes/toggle` requires the same bearer token. |
| Read-only API for honest devices | `GET /api/config`, `GET /api/media`, `GET /api/likes`, and `GET /media/*` are open so phones on the LAN can browse without a login. |
| Cross-site scripting | Every dynamic string (folder names, filenames, captions, counts) is rendered with `textContent`. There is no `innerHTML` write anywhere in the front-end. |
| MIME sniffing of error responses | `/media/*` errors set `Content-Type: text/plain; charset=utf-8`. The 404 handler is also `text/plain`. |
| Click-jacking / frame embedding | `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`. |
| MIME type sniffing of responses | `X-Content-Type-Options: nosniff` on every response. |
| Referrer leakage | `Referrer-Policy: no-referrer` on every response. |
| Privilege-creep via geolocation / camera / mic | `Permissions-Policy` denies them all. |
| Server DoS via body floods | JSON body limit is 32 KB. |
| Walk DoS via huge trees | `LANGRAM_MAX_DEPTH` and `LANGRAM_MAX_FILES` cap the recursion. |

If `LANGRAM_TOKEN` is not set, all mutating endpoints (including the folder
picker) will refuse every request with HTTP 503. Set it to a long random
string to enable them.

## Quick start

Requires Node 18+ and a folder of media files on the host.

```bash
npm install
LANGRAM_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" npm start
```

Then open the URL the server prints, e.g. `http://192.168.1.42:3012`, on
any device on the same LAN. The gallery root defaults to the current
working directory; click the gear icon and paste the bearer token to
change the folder.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3012` | TCP port the server listens on. |
| `GALLERY_PATH` | `process.cwd()` | Initial gallery root. Overridden by `data/settings.json` once the user picks a folder. |
| `LANGRAM_TOKEN` | _(unset)_ | Bearer token required for `POST /api/config`, `POST /api/likes/toggle`, and `GET /api/browse`. When unset, those endpoints return 503. |
| `LANGRAM_MAX_DEPTH` | `12` | Recursion limit for the gallery walk. |
| `LANGRAM_MAX_FILES` | `50000` | Hard cap on the number of files in the index. |

## Supported media formats

Images: `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `svg`, `avif`  
Videos: `mp4`, `webm`, `mov`, `m4v`, `avi`, `mkv`

## Development

```bash
npm install
node --check server.js
node --check public/app.js
LANGRAM_TOKEN=dev npm start
```

The project is small enough that the whole server fits in one file
(`server.js`) and the whole front-end in `public/`.

## License

MIT — see [LICENSE](LICENSE).
