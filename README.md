# Jishnu K: photo and video portfolio

A photo/video portfolio with a private admin uploader. It supports local development and persistent Cloudinary media storage for deployment.

## Run locally

You need [Node.js](https://nodejs.org) 18 or newer.

```powershell
cd media-portfolio
npm install
Copy-Item .env.example .env
```

Edit `.env` and set `ADMIN_PASSWORD`, `ADMIN_PATH`, and `CLOUDINARY_URL`. To create the Cloudinary URL, open your [Cloudinary Console](https://console.cloudinary.com/), find your API credentials, and use the `cloudinary://API_KEY:API_SECRET@CLOUD_NAME` format. Keep the API secret private.

Start the app:

```powershell
npm start
```

- Gallery: http://localhost:3000
- Admin: `http://localhost:3000/<your ADMIN_PATH>/`

Without `CLOUDINARY_URL`, local development uses the local `uploads/` and `data/media.json` files. That local mode is not persistent on Render's free filesystem.

## Deploy to Render with persistent media

1. Create a Cloudinary account at https://cloudinary.com/ and open the Console.
2. In Cloudinary, find the API environment variable (`CLOUDINARY_URL`). Do not publish or share its API secret.
3. In Render, open your service -> **Environment** and add these variables:
   - `ADMIN_PASSWORD`: a new, unique password of at least 8 characters.
   - `ADMIN_PATH`: a private path of at least 8 letters/numbers/hyphens/underscores.
   - `CLOUDINARY_URL`: the complete value copied from Cloudinary.
   - `MAX_UPLOAD_MB`: `100` (optional).
4. Choose **Save and deploy** and wait for the deployment to become Live.
5. Check logs for `Media storage: Cloudinary (persistent cloud storage).`
6. Test with one non-sensitive photo, close/reopen the website, and verify it remains in the gallery and in Cloudinary's Media Library.

The Cloudinary Free plan currently has account/usage limits and a 10 MB image / 100 MB video maximum. The app checks the image limit before upload and reports provider errors instead of silently pretending an upload succeeded. Review the current [Cloudinary plan limits](https://cloudinary.com/pricing/compare-plans) before uploading large collections.

## How it works

- `server.js`: Express server, password-protected admin API, validation, Cloudinary uploads/deletes and gallery listing.
- `public/`: public gallery and viewer.
- `admin/`: private-path upload and management page.
- `uploads/` and `data/`: local-development fallback only; Render's free filesystem may be reset.
- Cloudinary stores the original media and its title/caption metadata, so it survives Render restarts and deploys.

## Safety notes

- Keep `.env` out of Git. Never commit Cloudinary API credentials or a real admin password.
- The admin page's secret path is not a replacement for the admin password.
- Upload/delete operations require the admin password and repeated failed logins are rate-limited.
- Allowed types: JPG, PNG, WebP, GIF, AVIF, MP4, WebM and MOV.
- Do not upload anything important until Render logs confirm Cloudinary storage is enabled.
