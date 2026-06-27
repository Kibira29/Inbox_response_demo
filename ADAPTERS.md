# Adapter notes — porting to other LLM providers

This tool is built on Gemini. The two functions in `Inbox_Response_Demo.gs` that call the LLM are:

- `analyzeWithGemini()` — classification (returns structured JSON)
- `generateDraft()` — drafting (returns plain text)

Both use the helper `callGeminiWithRetry()` to handle rate limits.

To port to another provider, you'll need to change three things:

## 1. The API endpoint and auth

Gemini takes the key in the URL. Other providers use auth headers.

**Anthropic (Claude):**
```javascript
const url = 'https://api.anthropic.com/v1/messages';
// headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
```

**OpenAI:**
```javascript
const url = 'https://api.openai.com/v1/chat/completions';
// headers: { 'Authorization': 'Bearer ' + API_KEY }
```

## 2. The request shape

**Gemini** uses `contents → parts → text`.

**Claude** uses `messages → role + content`.

**OpenAI** uses `messages → role + content` (similar but not identical to Claude).

## 3. The response shape

**Gemini:** `data.candidates[0].content.parts[0].text`

**Claude:** `data.content[0].text`

**OpenAI:** `data.choices[0].message.content`

## A note on structured outputs

Gemini supports native JSON schema enforcement (`response_schema` in the request). This guarantees the model returns valid categories — no parsing errors, no invented sentiment labels.

Claude and OpenAI handle this differently:
- **Claude:** prompt instruction + post-hoc validation
- **OpenAI:** `response_format: { type: "json_schema", json_schema: {...} }`

If you swap providers, the classification function may need slightly stricter prompt wording to compensate.

## Scope of the swap

About 30 lines of code change per provider, concentrated in:
- `callGeminiWithRetry()` — endpoint/auth
- `analyzeWithGemini()` — request payload + response parsing
- `generateDraft()` — request payload + response parsing

Fork the repo, swap those three functions, and you're running on a different LLM.
