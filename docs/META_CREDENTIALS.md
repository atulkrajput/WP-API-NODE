# Getting Your Meta WhatsApp Cloud API Credentials

This app talks to the **WhatsApp Cloud API** (Meta Graph API). To send messages,
run the deliverability probe (`/validate`), and receive status webhooks, you must
provide five values in your environment (`.env.production` or the Hostinger panel):

| Env var                 | What it is                                   | Required for            |
| ----------------------- | -------------------------------------------- | ----------------------- |
| `PHONE_NUMBER_ID`       | Numeric ID of your WhatsApp sender number    | Sending any message     |
| `WHATSAPP_TOKEN`        | Access token (bearer)                        | Sending any message     |
| `WABA_ID`               | WhatsApp Business Account ID                 | Account-level calls     |
| `APP_SECRET`            | Meta App secret                              | Verifying webhooks      |
| `WEBHOOK_VERIFY_TOKEN`  | A string you invent                          | Webhook handshake       |

> **Important:** `PHONE_NUMBER_ID` is **not** the phone number (`+91...`). It is a
> long numeric ID Meta assigns to that number. Leaving it blank causes the exact
> error you saw: *"Object with ID 'messages' does not exist"* — because the request
> URL collapses to `.../v21.0//messages`.

---

## Prerequisites

1. A **Meta (Facebook) account**.
2. A **Meta Business Account** — https://business.facebook.com
3. A **Meta app** of type *Business* with the **WhatsApp** product added —
   https://developers.facebook.com/apps

---

## Step 1 — Create / open your Meta app

1. Go to https://developers.facebook.com/apps and open (or create) your app.
2. In the left sidebar, under **Products**, add **WhatsApp** if it isn't already.
3. Open **WhatsApp → API Setup** (sometimes labelled *Getting Started*).

---

## Step 2 — `PHONE_NUMBER_ID` and `WABA_ID`

On the **WhatsApp → API Setup** page:

- **Phone number ID** is shown directly under the "From" phone number. It is a
  long number like `123456789012345`. Copy it into `PHONE_NUMBER_ID`.
- **WhatsApp Business Account ID** is shown on the same page (often labelled
  *WhatsApp Business Account ID*). Copy it into `WABA_ID`.

> These are IDs, not secrets — but keep them with the rest of your config.

---

## Step 3 — `WHATSAPP_TOKEN` (access token)

You have two options:

### Option A — Temporary token (quick test only)
On **API Setup**, copy the **Temporary access token**.
- Pros: instant.
- Cons: **expires in ~24 hours.** Sends will fail the next day. Do **not** use
  this for a deployed app.

### Option B — Permanent token (recommended for production)
Create a **System User** token so it does not expire:

1. Go to **Business Settings** → https://business.facebook.com/settings
2. **Users → System Users → Add** (create one, e.g. "wp-api-bot", role *Admin* or
   *Employee*).
3. Select the system user → **Add Assets** → assign your **App** and your
   **WhatsApp Account (WABA)** with full control.
4. Click **Generate new token**, choose your app, and select these permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the generated token into `WHATSAPP_TOKEN`. Store it now — Meta shows it
   only once.

---

## Step 4 — `APP_SECRET`

Used to verify the `X-Hub-Signature-256` header on incoming webhooks.

1. In your app dashboard: **App settings → Basic**.
2. Find **App secret**, click **Show**, copy the value into `APP_SECRET`.

---

## Step 5 — `WEBHOOK_VERIFY_TOKEN`

This is a value **you invent** — any hard-to-guess string. It must match in two
places:

1. Put your chosen string in `WEBHOOK_VERIFY_TOKEN`.
2. When you configure the webhook in Meta (**WhatsApp → Configuration → Edit**),
   enter:
   - **Callback URL:** `https://YOUR_DOMAIN/webhook`
   - **Verify token:** the same string.
   Then subscribe to the **messages** field.

Generate a random one if you like:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## Step 6 — Configure the Meta app URLs

The app exposes a public privacy policy page at `/privacy-policy`. After deploying
behind your HTTPS domain, enter this URL in **App settings → Basic → Privacy
Policy URL**:

```text
https://YOUR_DOMAIN/privacy-policy
```

The page is intentionally public and does not require an admin login. Review the
policy page and replace any deployment placeholders (operator name and contact
email) before submitting the URL to Meta.

The WhatsApp webhook uses a separate URL:

```text
https://YOUR_DOMAIN/webhook
```

## Step 7 — Put the values in your environment

Edit `.env.production` (already scaffolded) and fill in the blanks:

```dotenv
PHONE_NUMBER_ID='123456789012345'
WHATSAPP_TOKEN='EAAG...your-token...'
WABA_ID='987654321098765'
APP_SECRET='0123456789abcdef0123456789abcdef'
WEBHOOK_VERIFY_TOKEN='pick-any-secret-string'
```

On **Hostinger**, you can instead enter these in the Node.js app **Environment
variables** panel. Panel values override the file. Restart the app after changing
them.

---

## Step 7 — Before your first successful send

Even with correct credentials, Meta enforces a few rules:

- **Recipient allow-list:** while your app/number is in *development* mode, Meta
  only delivers to phone numbers you've added under **API Setup → recipient
  phone numbers**. Add the number you're testing (e.g. the one used on `/validate`)
  or the send will be rejected.
- **Approved templates:** the deliverability probe sends the `hello_world`
  (`en_US`) template, which is approved by default. Custom templates must be
  approved in **WhatsApp → Message Templates** before use.
- **Token expiry:** if you used the temporary token (Option A), expect failures
  after ~24h. Switch to a permanent System User token (Option B).

---

## Quick verification

After filling the values, confirm the app loads them (run with production env):

```powershell
$env:NODE_ENV="production"; node -e "const c=require('./src/config'); console.log({ phoneNumberId: c.meta.phoneNumberId || '(empty)', tokenSet: Boolean(c.meta.token), wabaSet: Boolean(c.meta.wabaId), appSecretSet: Boolean(c.meta.appSecret), verifyTokenSet: Boolean(c.meta.webhookVerifyToken) });"
```

You want `phoneNumberId` to be your real ID and every `*Set` flag to be `true`.
Then retry the deliverability check on `/validate`.

---

## Reference

- WhatsApp Cloud API — Get Started: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- System User tokens: https://developers.facebook.com/docs/whatsapp/business-management-api/get-started
- Webhooks setup: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
