# Lottery Results – iPhone web app + nightly robot (all free)

**What you get**
- `site/` – the web app (opens like an app on iPhone, hosted free on Vercel).
- `robot/` – runs on GitHub Actions every 15 min from ~9:30 pm to ~2:15 am (Sri Lanka time). It looks for tonight's image, reads the date printed on it, builds the large-print A4 landscape PDF (same code as your PC app), saves it, and sends it to WhatsApp (and optionally Telegram). After it succeeds, the later checks stop by themselves.

A real App Store app needs a paid Apple developer account and a Mac, so this is a web app you add to the Home Screen.

## 1. GitHub (robot + storage)
1. Create a free account at github.com. New repository -> name `lottery`, **Public** (unlimited free Actions minutes; the PDFs are public lottery results anyway, your secrets stay hidden).
2. Unzip `lottery-cloud.zip` on your PC. In the new repo choose **Add file -> Upload files** and drag in **everything inside the folder** (including the hidden `.github` folder). Commit.
3. Open `site/index.html` on GitHub -> pencil icon -> change `YOUR-GITHUB-USER/YOUR-REPO` to e.g. `pehesara/lottery` -> Commit.
4. **Actions** tab -> enable workflows if asked.
5. **Settings -> Actions -> General -> Workflow permissions -> Read and write** -> Save.

## 2. Vercel (the web app)
1. vercel.com -> sign up with GitHub (free Hobby plan; personal, non-commercial use).
2. **Add New -> Project** -> import `lottery` -> Framework Preset **Other**, leave build settings empty -> Deploy.
3. Copy your address, e.g. `https://lottery-xxxx.vercel.app`.
Every time the robot saves a new PDF, Vercel redeploys automatically. (Avoid Netlify's free plan here: it allows only about 20 deploys a month, so a daily update would pause your account.)

## 3. Test the robot once (do this before relying on it)
GitHub -> **Actions -> daily-lottery -> Run workflow**, type a recent date such as `2026-10-03`, run, and open the run's log.
- Lines like `image date read: 2026-10-03` then `Saved ...` = success. After ~1 min the date shows in your web app.
- No `image date read` lines = Facebook showed a login wall to GitHub's servers. Fix: step 4 below.

## 4. If Facebook blocks the robot (likely at some point)
On your PC, log in to Facebook in Edge, install a cookie-export extension (e.g. "Cookie-Editor"), export cookies for facebook.com as JSON, and save them as a repository secret named `FB_COOKIES` (Settings -> Secrets and variables -> Actions -> New repository secret). Notes: this uses your account session on a cloud server; Facebook may log it out or ask for a security check, and automated access is against Facebook's terms. Use a spare account if you can. Nothing can guarantee this part works forever.

## 5. WhatsApp sending (Meta WhatsApp Cloud API, free test number)
1. developers.facebook.com -> log in -> **Create app** -> type **Business** -> add the **WhatsApp** product.
2. **WhatsApp -> API Setup**: Meta gives a free test number. Under *To* add your contact's WhatsApp number and confirm the code sent to it (max 5 numbers). Copy the **Phone number ID**.
3. **WhatsApp Manager -> Message templates -> Create**: category **Utility**, name `daily_lottery_results`, language English, **Header = Document** (upload any sample PDF), body: `Lottery results for {{1}} are attached.` -> Submit and wait for approval.
4. Token: temporary tokens last 24 h, so make a permanent one: business.facebook.com -> Settings -> Users -> **System users** -> Add (Admin) -> Add assets (your app + WhatsApp account) -> **Generate token** -> pick `whatsapp_business_messaging` and `whatsapp_business_management`, no expiry.
5. Add repository secrets: `WA_TOKEN` (that token), `WA_PHONE_ID`, `WA_TO` (contact number with country code, digits only, e.g. `94771234567`), `WA_TEMPLATE` (`daily_lottery_results`).
Not tested by me: Meta changes this often. If the template is rejected, the robot tries a plain document message, which only works if that contact messaged the test number in the last 24 h.
**Easy backup:** Telegram. Create a bot with @BotFather, send it a message, then add secrets `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` (find the id via @userinfobot). It delivers the PDF with no approvals.

## 6. iPhone shortcut
1. Safari -> open your Vercel address -> **Share -> Add to Home Screen** -> name it "Lottery" -> Add. It opens full-screen like an app.
2. (Optional) Shortcuts app -> **+** -> *Open URLs* -> paste the address -> tap the name at top -> **Add to Home Screen**.
Use it: pick a date (defaults to the latest) -> check the preview -> **Print / Share PDF** -> choose **Print** (AirPrint printer), WhatsApp, or Save to Files.

## 7. Good to know
- Older/missing dates: in the app tap the "Ask the robot" link, **Run workflow**, enter the date, reload after ~5 minutes.
- GitHub's timer can run late by 15-30 min and is paused if the repo is idle for 60 days; the robot's daily saves count as activity. If results are published after ~2:15 am, use Run workflow once.
- The app keeps the latest 45 days.
