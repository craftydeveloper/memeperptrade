# GitHub Deployment Notes

## Local Run (single command)

```bash
npm start
```

This starts `backend/server.js` on `http://localhost:8787` and also serves frontend files from the project root.

Open:
- `http://localhost:8787/index.html`
- `http://localhost:8787/testnet.html`

## Important: GitHub Pages Limitation

GitHub Pages hosts static files only. It cannot run `backend/server.js`.

Testnet wallet connect requires backend APIs at `/api/testnet/*`, so for GitHub Pages you must host the backend separately (for example: Render, Railway, Fly.io, VPS).

## Point Frontend to Hosted Backend

Use either method:

1. In setup page, set **Testnet Backend Origin** to your backend URL.
2. Or open testnet with query override:

```text
https://<your-pages-domain>/testnet.html?apiOrigin=https://<your-backend-domain>
```

The value is saved to localStorage key `mp_testnet_api_origin`.

## Render Deployment (Backend + Frontend Together)

This repo now includes [render.yaml](render.yaml), so Render will run it as a Node web service:

- Build command: `npm ci`
- Start command: `npm run start:backend`
- Health check: `/api/testnet/health`

After deploy, open your Render URL root (`/`). It now lands on `testnet.html` by default.

Important for "always on":

- Use a non-sleeping Render plan (for example Starter or higher).
- Sleeping/free instances can pause when idle, which is a Render platform behavior and cannot be overridden in app code.
