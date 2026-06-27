# Sheet structure

The script expects two tabs in your Google Sheet, named exactly: `Config` and `Tracker`. A third tab (`ai_digest`) is created automatically on first digest run.

## Tab 1: `Config`

Two columns. Key in A, value in B. Five rows.

| A (Key) | B (Value) | Notes |
|---|---|---|
| `campaign_name` | e.g. `q2-stakeholders` | Free text. Used in digest header. |
| `campaign_type` | One of: `stakeholder_response`, `event_rsvp`, `sales_lead`, `expense_receipts` | Must match a key in `PROMPT_TEMPLATES`. |
| `gmail_label` | e.g. `tracker/q2-stakeholders` | The Gmail label applied to relevant threads. |
| `context` | Free text | Background for the AI. Be specific — what the campaign is, key dates, terminology. |
| `your_email` | e.g. `you@example.com` | Used to identify your sent messages when scanning for overdue commitments in the weekly digest. |

## Tab 2: `Tracker`

Two kinds of columns: manual (you write) and AI-generated (script writes).

### Required manual columns

| Column | Purpose |
|---|---|
| `Name` | First column. Used in drafts as the recipient's name. |
| `Email` | Must be exactly `Email`. The script finds threads by matching this. |

### Optional manual columns

Add whatever you want — Company, Role, Deal Size, Dietary, Shares, etc. The script ignores these for classification but passes them to the AI as context. Useful for richer summaries.

### Required AI columns (script writes these)

All headers must start with `ai_`:

| Column | What goes in it |
|---|---|
| `ai_response_date` | Date of their most recent reply (DD-MMM-YYYY) |
| `ai_classification` | One of the campaign type's classification options |
| `ai_sentiment` | One of the campaign type's sentiment options |
| `ai_summary` | Chronological narrative of what they said |
| `ai_action_required` | "YES" + action, or "No" |
| `ai_status` | Short status line |
| `ai_last_updated` | Timestamp of when the script processed this row |
| `ai_draft_status` | Result of last `draftReplies` run (or error) |

### One non-prefixed control column

| Column | Values |
|---|---|
| `draft_mode` | You type `holding`, `full`, or leave blank. Controls what `draftReplies` does for that row. |

`draft_mode` is the only manual control column that the script reads. Everything else manual is just context.

### Column ordering

Position doesn't matter. The script finds columns by header name, not position. Reorder freely.

### Example layout
Name | Email | Company | Role | draft_mode | ai_response_date | ai_classification | ai_sentiment | ai_summary | ai_action_required | ai_status | ai_last_updated | ai_draft_status

Manual columns first, control column, then AI columns — but any order works.

## Tab 3: `ai_digest`

Created automatically by `generateWeeklyDigest`. Don't edit it manually — the tab is cleared and rewritten each time the digest runs.

Contents:
- Summary stats (counts of new replies, action items, overdue commitments, no-response)
- New replies this week (last 7 days)
- Action required from you
- Your overdue commitments (extracted from your sent messages)
- No response yet

## Naming convention rationale

The `ai_` prefix is a visual contract:
- **No prefix** → manual input, you write, script reads as context
- **`ai_` prefix** → script writes, you read or edit afterward
- **`draft_mode`** is the deliberate exception: a manual control input the script reads

If you add new columns later, follow this convention to keep the sheet readable.
