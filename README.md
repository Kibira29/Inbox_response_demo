# Email Response Tracker

An adaptable email campaign tracker that classifies replies, drafts responses, and generates weekly digests — built with Google Sheets, Apps Script, and Gemini.

Designed for people running recurring email campaigns at scale: stakeholder updates, document collection, RSVPs, sales outreach, expense chasing. Anywhere the pattern is *send to many → wait → respond at scale*.

## The problem

If you run email campaigns to 20+ people, you've felt this:

- Replies arrive scattered across days
- You manually classify what each person said
- You chase non-responders one by one
- You draft individual replies that all say roughly the same thing
- The tracker spreadsheet that summarises it all eats hours per round

This tool compresses that into three buttons.

## What it does

1. **Classifies replies** — reads each thread, fills in sentiment, intent, summary, and action needed
2. **Drafts responses** — generates either a quick holding reply or a substantive draft, places it in Gmail Drafts for your review (never sends)
3. **Generates a weekly digest** — surfaces new replies, action items, your overdue commitments, and who hasn't responded yet

## Why Gemini

Built on Gemini for two reasons:

- **Free tier removes the biggest adoption barrier.** You can try this without setting up billing.
- **Native JSON schema support** constrains AI outputs to valid categories — no invented sentiment labels, no parsing brittleness.

Porting to Claude or OpenAI is straightforward — see `ADAPTERS.md`.

## Setup (10 minutes)

All settings live in the Google Sheet's Config tab. You only touch the script to paste it in — no code editing required.

### 1. Build the sheet

Create a Google Sheet with two tabs: `Config` and `Tracker`. A third tab (`ai_digest`) is created automatically on first digest run. See `SHEET_STRUCTURE.md` for exact column layout and Config values.

### 2. Get a Gemini API key

Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**. Free tier is sufficient for campaigns under 50 contacts.

### 3. Install the script

In your sheet: **Extensions → Apps Script** → delete the boilerplate → paste the contents of `Inbox_Response_Demo.gs` → save.

### 4. Add the API key

**Project Settings (gear icon) → Script Properties → Add property**:
- Name: `GEMINI_API_KEY`
- Value: your key

### 5. Fill in the Config tab

Five rows in your `Config` tab (key in column A, value in column B):

| Key | Value |
|---|---|
| `campaign_name` | Free text, e.g. `q2-stakeholders` |
| `campaign_type` | One of: `stakeholder_response`, `event_rsvp`, `sales_lead`, `expense_receipts` |
| `gmail_label` | The Gmail label applied to the threads you want tracked |
| `context` | Background for the AI — what this campaign is about, key dates, terminology |
| `your_email` | Your email address (used to detect your sent messages when finding stale commitments) |

### 6. Set up Gmail

Create a Gmail label matching the `gmail_label` value in your Config tab (e.g., `tracker/q2-stakeholders`). Apply it to the threads you want tracked.

### 7. Run

In Apps Script, select `processTracker` from the function dropdown → **Run**. Authorise Gmail and Sheets access on first run.

## Usage

Three functions, that's it:

| Function | What it does | When to run |
|---|---|---|
| `processTracker` | Reads replies, fills AI columns | Whenever new replies come in |
| `draftReplies` | Creates Gmail drafts for rows where you've set `draft_mode` to `holding` or `full` | After reviewing classifications |
| `generateWeeklyDigest` | Builds the `ai_digest` tab summary | Weekly, or on demand |

## Campaign types supported

| Type | Use case |
|---|---|
| `stakeholder_response` | Announcements, investor updates, internal comms |
| `event_rsvp` | Event invitations, meeting confirmations |
| `sales_lead` | Cold outreach response classification |
| `expense_receipts` | Document collection (receipts, signatures, attachments) |

Add new campaign types by adding a block to `PROMPT_TEMPLATES` at the top of `Inbox_Response_Demo.gs`.

## Design notes

- **Drafts never auto-send.** Every reply lands in Gmail Drafts for human review. The AI does the first pass, you do the judgment pass.
- **Language matching.** Drafts are written in the language of the thread (auto-detected).
- **Column convention.** Columns starting with `ai_` are written by the script. Everything else is yours — the script ignores manual columns when classifying but passes them to the AI as context.
- **Failure-tolerant.** Rate limits, timeouts, API errors all caught and logged with specific reasons in the sheet, not silent failures.
- **Resume support.** If the script hits the Apps Script 6-minute timeout, re-running picks up where it left off.
- **All config in the sheet.** No need to edit `Inbox_Response_Demo.gs` to switch campaigns — change the Config tab, run again.

## Limits

- **Free tier rate limit:** 5 Gemini calls/minute. ~50 contacts per run before throttling kicks in.
- **Apps Script timeout:** 6 minutes per run. Resume logic handles this.
- **Drafts need editing.** Holding drafts are near-perfect. Substantive drafts get you to ~70% — treat them as a starting block.
- **No context outside email.** The AI only sees the thread. It doesn't know history, relationships, or what you've committed to elsewhere.

## What's in this repo

- `Inbox_Response_Demo.gs` — the Apps Script
- `README.md` — this file
- `SHEET_STRUCTURE.md` — column conventions and Config tab format
- `ADAPTERS.md` — notes on porting to Claude or OpenAI

## License

MIT
