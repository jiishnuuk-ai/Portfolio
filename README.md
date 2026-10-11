# Jishnu K: photo and video portfolio

A gallery website with a small Node.js backend for uploading photos and videos.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd media-portfolio
npm install
cp .env.example .env      # on Windows: copy .env.example .env
```

Open `.env` and change two things:

- `ADMIN_PASSWORD`: your own password (8+ characters).
- `ADMIN_PATH`: a secret word for your admin page address (8+ letters, numbers, `-` or `_`), for example `my-private-door-4821`. Don't use the example value, and don't share it.

Then:

```bash
npm start
```

- Gallery: http://localhost:3000
- Admin (upload and delete): `http://localhost:3000/<your ADMIN_PATH>/`. The server prints this address when it starts. Nothing on the public site links to it.

On your phone (same Wi-Fi), open `http://<your-computer-ip>:3000`.

## How it works

| Part | What it does |
| --- | --- |
| `server.js` | Express server. Serves the site, stores uploads, protects upload and delete with your password. |
| `public/index.html`, `style.css`, `app.js` | The public gallery: film-strip hero, photo/video grid, full-screen viewer. |
| `admin/admin.html`, `admin.css`, `admin.js` | Admin page, kept outside `public/` and served only at your secret address: log in, drag and drop files, add titles and captions, delete posts. |
| `uploads/` | Your photos and videos (created automatically). |
| `data/media.json` | The list of posts (created automatically). |

Back up `uploads/` and `data/` to keep your posts safe.

## Safety built in

- The admin page has no public link and lives at a secret address you choose. Hiding the address only keeps people away; the password is the real lock.
- Uploading and deleting need the admin password. Wrong guesses are limited (10 tries, then a 15 minute wait).
- Only JPG, PNG, WebP, GIF, AVIF, MP4, WebM and MOV are accepted. The server checks the real file contents, not just the name.
- Files are saved under random names, and titles and captions are shown as plain text.
- Use HTTPS when you put it online, because the password is sent with each upload.

## Putting it online

The server saves files on its own disk, so pick a host that keeps files between restarts: a VPS, or Render or Railway with a persistent disk or volume. Static-only hosts such as Netlify, Vercel or GitHub Pages cannot run the upload backend.

Set `ADMIN_PASSWORD` in the host's environment settings instead of using a `.env` file. If your host puts the server behind a proxy, the login limit sees the proxy's address, so keep that in mind.

## Changing things

- Colours and fonts: the variables at the top of `public/style.css`.
- Name, email, phone and Instagram: `public/index.html`.
- Upload size limit: `MAX_UPLOAD_MB` in `.env`.
