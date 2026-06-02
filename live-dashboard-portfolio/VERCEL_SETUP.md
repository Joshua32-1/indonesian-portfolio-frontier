# Vercel setup — live-dashboard-portfolio

Deploy only the tracker (not the optimizer). Repo: `Joshua32-1/indonesian-portfolio-frontier`.

---

## Option A — GitHub import (recommended)

### 1. Sign in to Vercel

1. Open [https://vercel.com](https://vercel.com) and sign in (GitHub login is easiest).

### 2. Import the repo

1. Click **Add New…** → **Project**.
2. Find **indonesian-portfolio-frontier** → **Import**.

### 3. Monorepo root directory (required)

On the **Configure Project** screen:

| Setting | Value |
|---------|--------|
| **Root Directory** | Click **Edit** → select or type `live-dashboard-portfolio` |
| **Framework Preset** | Vite (auto-detected after root is set) |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm ci` |

Leave **Environment Variables** empty.

### 4. Deploy

1. Click **Deploy**.
2. Wait ~1–2 minutes. You get a URL like `https://indonesian-portfolio-frontier-xxx.vercel.app`.

### 5. Verify the live site

Open the URL. You should see:

- **IDX PORTFOLIO TRACKER** header
- Chart with IHSG + portfolio lines
- Weight table at the bottom

If you see “Failed to load data”, check the browser Network tab for `live-market-snapshot.json` and `portfolios.json` (both should return 200).

### 6. Auto-deploy on push

Default: every push to `main` that touches the project triggers a new deploy.

Price-only updates: GitHub Action `.github/workflows/refresh-dashboard.yml` commits an updated snapshot → Vercel rebuilds automatically.

Weight updates: commit `data/portfolios.json` yourself → Vercel rebuilds.

### 7. Enable GitHub Actions (for daily prices)

1. GitHub repo → **Settings** → **Actions** → **General**.
2. Allow actions and workflow read/write.
3. **Actions** tab → run **Refresh Dashboard Snapshot** once manually to test.

---

## Option B — Vercel CLI

```bash
cd live-dashboard-portfolio
npx vercel login          # browser login once
npx vercel link           # link to your Vercel team/account
npx vercel --prod         # production deploy
```

For a monorepo, when linking, set the project root to this folder (not the repo root).

---

## Custom domain (optional)

1. Vercel project → **Settings** → **Domains**.
2. Add your domain and follow DNS instructions.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Builds from repo root, 404 on site | Set **Root Directory** = `live-dashboard-portfolio` |
| `npm run build` fails | Run `npm ci && npm run build` locally in `live-dashboard-portfolio` |
| Chart empty / short history | Set earlier `inception` in `data/portfolios.json` |
| All portfolio lines identical | Replace placeholder equal weights with optimizer weights |
| No new prices | Check GitHub Action runs; or run `npm run sync-snapshot` and push |

---

## What not to deploy

Do **not** point Vercel at `portfolio-app/` or the repo root — that is the optimizer, not the public dashboard.
