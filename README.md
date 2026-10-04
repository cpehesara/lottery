# Lottery Results Printer – automatic version

The web app finds the result image for the date you pick, loads it and builds the A4 sheet
(three copies). New images are collected automatically by a free scheduled job on GitHub.

```
site/      the web app (host this on Netlify or Vercel)
results/   fetched images + index.json (filled automatically)
fetcher/   the script that reads the Facebook page (runs on GitHub Actions)
.github/   the schedule
```

## One-time setup (about 15 minutes, any browser)

1. **GitHub.** Create a free account and a new **public** repository. Upload everything in this
   folder (Add file > Upload files; keep the folder structure, including the hidden `.github` folder).
2. **Run the first fetch.** Repository > Actions > "Fetch lottery results" > Run workflow.
   Wait for the green tick (about 3–5 minutes). A new `results/index.json` appears.
   If the run fails with "no dated results images were found", do *Facebook login* below, then run again.
3. **Host the app.**
   - Netlify: Add new site > Import from Git > pick the repository. Publish directory `site`
     (already set in `netlify.toml`).
   - Vercel: Add New > Project > import the repository. Framework "Other", leave build settings as they are
     (`vercel.json` sets the output folder to `site`).
4. **Point the app at your results.** In GitHub open `site/config.js`, press the pencil icon and set
   `resultsBase` to `https://raw.githubusercontent.com/YOUR-NAME/YOUR-REPO/main/results/`
   (and, optionally, `actionsUrl` to `https://github.com/YOUR-NAME/YOUR-REPO/actions/workflows/fetch.yml`).
   Commit. The host redeploys in a minute.
5. Open the site on your phone. Choose Install / Add to Home Screen.

From now on: open the app, pick a date (or just open it for today) and the result appears.
The job runs every 3 hours. For an older date, use *Run workflow* and type the date(s)
(e.g. `2026-09-20`); it works from the GitHub mobile site too.

## Facebook login (only if the fetch fails)

Facebook often hides older posts from visitors who are not logged in, and may block cloud servers.
If the first run reports no images:

1. On a computer: `pip install -r fetcher/requirements.txt`, `python -m playwright install chromium`,
   then `python fetcher/save_login.py`. Log in in the window that opens, press Enter in the terminal.
2. Open `fetcher/state.json`, copy everything.
3. GitHub > Settings > Secrets and variables > Actions > New repository secret:
   name `FB_STORAGE_STATE`, value = the copied text. Never upload `state.json` itself.
4. Run the workflow again.

Use a spare Facebook account if possible. Automated access may go against Facebook's terms, and Facebook
can log the account out or ask for verification at any time; the app's "Add an image yourself" option
always still works.

## Manual options in the app

"Add an image yourself" lets you choose an image from the phone, paste one, or load a direct link.
That is the fallback for any date the job could not fetch.

## Changing the schedule or how far back it looks

- Schedule: `cron` line in `.github/workflows/fetch.yml`.
- Days looked at by the scheduled run: `--days 3` in the same file.
