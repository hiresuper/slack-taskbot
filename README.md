# slack-taskbot
Slack Task Bot is an internal experiment to organize asks and reminders in Slack into a quick, Airtable-backed Slack Bot.

This is a self-hosted and maintained Slack bot MVP that turns message threads into trackable tasks with reminders. This is not a hosted SaaS, multi-tenant Slack app, and with no support SLA guarantees. It is designed for small teams who are comfortable running their own instance and want to build on top of this MVP.

## What you’ll end up with

A Slack bot you can mention in a thread:

- `@tasks track` → creates a task row in Airtable from that thread
- `@tasks update` → refreshes summary/actions/title from latest thread messages
- `@tasks summary` → posts the stored summary/actions back into the thread
- `@tasks complete` → closes the task
- `@tasks reopen` → reopens it
- `@tasks list` → lists open tasks
- `@tasks remind` → set custom reminders in addition to the 24-hour one

---

## Step 0 — You’ll need accounts and prepare to securely store variables in each subsequent step

- Slack workspace admin:
    - `SLACK_APP_TOKEN` (looks like `xapp-...`)
    - `SLACK_BOT_TOKEN` (looks like `xoxb-...`)
    - `SLACK_BOT_USER_ID` (looks like `UOA…`)
- Airtable account
    - `AIRTABLE_BASE_ID` (looks like `app1A2B3c4567`)
    - `AIRTABLE_TABLE_NAME` (will be `Tasks`)
    - `AIRTABLE_TOKEN` (your Personal Access Token, starts with `pat`)
- Render.com account
    - Free to set up if this is your first project
- OpenAI API key
    - `OPENAI_API_KEY`

---

# 1) Create the Airtable base + table

### 1.1 Create a base

Create a new Airtable base called something like **“Slack Tasks Bot”**.

### 1.2 Create a table named `Tasks`

Create a table called **Tasks**. This is your `AIRTABLE_TABLE_NAME`

### 1.3 Add these exact fields

Create these columns (field names must match exactly):

- `task_title` (Single line text)
- `summary` (Long text)
- `next_actions` (Long text)
- `status` (Single select: include at least `open` and `closed`)
- `source_link` (URL)
- `assignee_display` (Single line text)
- `task_id` (Single line text)
- `channel_id` (Single line text)
- `thread_ts` (Single line text)
- `created_by_slack_id` (Single line text)
- `assignee_slack_id` (Single line text)
- `created_at` (Date/time)
- `last_update_at` (Date/time)
- `next_reminder_at` (Date/time)
- `reminder_count` (Number)
- `one_off_reminder_at` (Date/time)

### 1.4 Get Airtable IDs + token

You save two Airtable values securely:

1. **Personal Access Token (this is your** `AIRTABLE_TOKEN`)
- Airtable → Account → Developer hub → Personal access tokens
- Create token with:
    - **Scopes**: `data.records:read`, `data.records:write`
    - **Access**: limit to the specific base (”Tasks”)
1. **Base ID**
- Open the Airtable base
- The base ID is in the URL and starts with app######### (e.g. /app1A2B3c456789o/). Copy this as your `AIRTABLE_BASE_ID`.

---

# 2) Create the Slack App

### 2.1 Create app

- Go to Slack API → “Create New App” → “From scratch”
- App name: `Tasks` (or whatever you want)
- Pick the workspace

### 2.2 Enable Socket Mode

- “Socket Mode” → **Enable**
- Create an **App-Level Token**
    - Token name: `socket`
    - Scope: `connections:write`
- Save the token (`xapp-...`) → this becomes `SLACK_APP_TOKEN`

### 2.3 Add bot scopes

Go to **OAuth & Permissions** → Bot Token Scopes:

Required for core features:

- `app_mentions:read`
- `channels:history`
- `groups:history` *(if you want private channels)*
- `chat:write`

Required for assignee names (so Airtable shows names):

- `users:read`

### 2.4 Event subscriptions

Go to **Event Subscriptions**:

- Turn **On**
- Under “Subscribe to bot events”, add:
    - `app_mention`

### 2.5 Install the app

Go to **Install App**

- Click **Install to Workspace**
- Copy and save the **Bot User OAuth Token** (`xoxb-...`) → this becomes `SLACK_BOT_TOKEN`

### 2.6 Get the bot user ID

- Find the bot user in the member list / app profile
- Copy the member ID (looks like `U0A...`)
    
    That becomes: `SLACK_BOT_USER_ID`
    

---

# 3) Get an OpenAI API key

- Create an account on platform.openai.com
- Create a new API key
- That becomes: `OPENAI_API_KEY`

---

# 4) Deploy on Render (they don’t need to code)

### 4.1 The GitHub Repo

- LINK GOES HERE

### 4.2 Create a Render service

Render → New → **Web Service**

- Connect repo
- Runtime: Node
- Build command: `npm install`
- Start command: `node index.js`

### 4.3 Add environment variables in Render

Render → Service → Environment → add:

**Slack**

- `SLACK_BOT_TOKEN` = `xoxb-...`
- `SLACK_APP_TOKEN` = `xapp-...`
- `SLACK_BOT_USER_ID` = `U0A...`

**Airtable**

- `AIRTABLE_TOKEN` = `pat-...`
- `AIRTABLE_BASE_ID` = `app...`
- `AIRTABLE_TABLE_NAME` = `Tasks`

**OpenAI**

- `OPENAI_API_KEY` = `sk-...`

### 4.4 Deploy

Click Deploy and check logs. You should see:

- `⚡️ tasks bot running`

---

# 5) Use it in Slack

### 5.1 Invite the bot to a channel

In a public Slack channel:

- `/invite @Tasks`

### 5.2 Start tracking

In any thread:

- `@tasks track`

Other commands:

- `@tasks update`
- `@tasks summary`
- `@tasks complete`
- `@tasks reopen`
- `@tasks list`
- `@tasks remind me in X time`

---
