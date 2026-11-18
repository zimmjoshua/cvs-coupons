# Deployment review

Nothing in this file has been deployed. Do not apply the Render blueprint, create a Vercel project, accept hosting terms, push this source, or paste secrets into a host until you choose to.

## What stays running while the Mac is off

The mailbox poll has to be a process that stays up. Two hosts can do that. This repo prepares Render. It does not require Render.

Vercel Daemons are in public beta on all plans, including Hobby. A daemon is a Docker worker Vercel keeps running, including a worker that polls an external API. That is the Vercel-only way to run this Gmail loop. Vercel’s background-workers documentation is a separate product: it describes APIs and Services, not this continuous poller. Daemons are billed against each plan’s Active CPU and Provisioned Memory quotas. A waiting loop still consumes Provisioned Memory for every hour it runs. Preview deployments do not run daemons during the beta. Read the current quotas and prices at [Daemons](https://vercel.com/docs/daemons) before choosing a Vercel-only deploy. This review does not add a daemon, a Service, or a database migration.

The prepared option is below. Its free web plan sleeps after 15 minutes, and its free Postgres expires after 30 days, so the blueprint uses paid always-on plans.

| Service | Plan | Expected price | Why this blueprint uses it |
|---|---|---|---|
| Render web `cvs-coupons` | `0.5c-512mb` (Starter), 1 instance | $7/month | Stays awake and polls Gmail. |
| Render Postgres `cvs-coupons-db` | `0.1c-256mb`, 1 GB disk | $6/month + $0.30/month storage | Persistent database with backups. |
| Render workspace | Hobby | $0 | Paid compute is billed on top of Hobby. |
| Vercel static frontend | Hobby, if the personal terms fit | $0 | The UI is static. It does not poll Gmail. |

Confirm the prices before you accept them. Bandwidth and a larger disk are extra. `autoDeployTrigger` is off, so a later git push does not deploy by itself.

`render.yaml` does not contain secrets. `ACCESS_TOKEN`, `GMAIL_USER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` are prompted into the host’s secret environment. `CORS_ORIGIN` is the site origin, for example `https://cvs-coupons.vercel.app`.

## Repository

This project is an untracked directory inside a parent git repo at `Developer`. Do not commit or publish that parent. Create a new repository whose root is this `CVS` directory only. `.gitignore` already excludes `.env`, `backend/.env`, `backend/data/` (the Gmail token, Chrome profiles, and local Postgres), `dist/`, and logs. Do not add `frontend/dist`. The access token is typed into the browser and sent as an `Authorization` header. `frontend/vercel.json` rewrites `/api` to the API host and does not put the token in the URL or the rewrite. Change that host if the API is not on Render.

## Gmail label

The scanner uses scope `https://www.googleapis.com/auth/gmail.readonly` only. It resolves the label named `CVS` (or `GMAIL_LABEL`) to that label’s id and lists mail with `labelIds`. History uses the same id and follows both `messageAdded` and `labelAdded`, so mail that already existed and is labeled later is picked up. There is no `in:inbox` query. If the label is missing, the status says so and the check does not create the label or change any mail.

A Gmail filter `from:(cvs.com)` matches `cvs.com` and its subdomains, including `info@alerts.cvs.com`, `extracare@mystore.cvs.com`, and `extracare@mynotifications.cvs.com`. Skip the Inbox in that filter. A forward whose outer From is `zimmjoshua@gmail.com` does not match `from:(cvs.com)`. Label that thread by hand, or add a separate filter for that sender or subject. The app still reads whatever is in the CVS label. It inventories only $2 and $4 coupon offers and keeps the original recipient alias.

The first run with this parser re-reads the label once and updates existing rows in place. It does not delete coupons. After that, history continues from the mailbox’s current history id.

## Sign-in durability

The refresh token belongs in `GOOGLE_REFRESH_TOKEN`. The process also stores the current token in Postgres `meta.gmail_token` so a restart survives an ephemeral disk. Backups of that database therefore contain the Gmail refresh token. The Render blueprint allows only the private network to reach Postgres. The public API never returns the token.

This Google client is External and in Testing. A Testing refresh token expires after 7 days because the scope is Gmail, not only name and email. The timer reports that and does not open a Google prompt. In production, Scan also does not open a browser. Put a new refresh token in the secret after you sign in on your computer. An Internal OAuth client is the later organization setup, and it still needs one new sign-in. It is not active now.

## Polling, health, backups

One Postgres advisory lock covers the poll and a manual scan, including a second instance. Shutdown on SIGTERM stops the timer, waits for the current check, then closes the server and the pool.

`GET /api/health` checks Postgres and returns the last success, next poll, label, and error. A missing label or an expired Gmail login is degraded, not a crash. Do not put secrets in that response.

Paid Render Postgres includes point-in-time recovery and logical exports. Confirm the retention window in the dashboard. Keep the 1 GB disk unless the coupon images grow. Do not store dates of birth, one-time codes, or passwords. Coupon rows and the sync checkpoint are the data to restore.

## What the link can and cannot fill in

Open coupon uses the original `https://click.web.cvs.com/?qs=...` URL from the email. The only query name on the saved links is `qs`. The app does not add email, date of birth, a verification code, a password, or the app token. CVS does not document a parameter on this link that pre-fills the account email or a verification code, and this app does not invent one. The link opens CVS in normal Chrome. If that Chrome profile is already signed in as the right account, CVS shows the offer. If it asks, you paste the account email, choose Email, and click Send code yourself. Press Start waiting before that click. A message that arrived earlier is not shown. Your date of birth stays in Chrome.

## Sign-in codes

The code check is tied to one stored coupon. The browser cannot ask for an arbitrary address. The server remembers the coupon’s saved account email, a random session id, and the start time. It lists the CVS label by id, asks Gmail only for mail from `info@alerts.cvs.com` whose subject says verification code after the second the wait started, and pages through that window. It returns a code only when the recipient matches and the message time is at or after the wait started. There is no grace period for an earlier email. The same wait stays open for 10 minutes. A code found before that deadline stays available for 3 minutes, and the page then stops routine mailbox polls. A stalled mailbox read or browser request aborts and retries on that same wait. A temporary Gmail or network failure retries until that deadline. Gmail `Retry-After` is honored past 20 seconds when time remains in the wait. `rateLimitExceeded` and `userRateLimitExceeded` retry. A domain policy or sign-in failure does not. A missing label, a Gmail sign-in failure, cancel, and the deadline still end the check. Press Start waiting, then click Send code. The app does not click Send code or Resend for you. If Send code was already clicked, start the wait and click Send code again. CVS can take several minutes to deliver the email. That delay is outside this app.

A phone test on November 18, 2026 showed both sides of that. The first code for card 6145 was requested, shown in the app, and accepted by CVS. A later wait started around 4:19 PM saw nothing for more than a minute because the new messages were not in the CVS label until 4:22:12 PM and 4:22:22 PM. The mailbox check did not cause that delay. After one resend, a fresh code appeared in the app, was copied, and was accepted, and the original $4 off $10 offer opened. This app cannot make CVS deliver faster.

The code is not written to Postgres, the coupon list, health, logs, or the browser’s saved storage. The responses use `Cache-Control: no-store`. The open coupon clears the code on cancel, on leaving that coupon, on a terminal mailbox error, and when the wait or the short display time ends. Returning to the phone tab continues the same wait and does not accept a code from before it started. Polls and new checks are rate-limited. The owner and trusted people share this one inventory. There are no separate user accounts. The same `ACCESS_TOKEN` is the shared secret for that group. Anyone with it can open the inventory and a code while a check is on screen. Do not share it outside that group, and do not put this app up as a public multi-user service. A remote phone deploy is still a separate choice and is not started by this reliability change.

Barcode images are optional and do not decide Available, Expired, or Used. The app does not sign in to CVS, click redeem, run a cloud browser, or install an extension.
