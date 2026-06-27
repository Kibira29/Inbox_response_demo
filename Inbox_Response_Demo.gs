// ============================================================
// EMAIL RESPONSE TRACKER
// 
// YOU ONLY EVER RUN THESE THREE FUNCTIONS:
//
// 1. processTracker        — fills AI columns from Gmail replies
// 2. draftReplies          — creates Gmail drafts for rows marked
//                            "holding" or "full" in draft_mode
// 3. generateWeeklyDigest  — builds the ai_digest tab summary
//
// Everything below is internal plumbing. Ignore it.
//
// SETUP: see README.md
// ============================================================

// ============================================================
// CONFIG — UPDATE BEFORE FIRST RUN
// ============================================================

// Your Gemini API key — store as a Script Property, not in code.
// Apps Script → Project Settings → Script Properties → Add property
// Name: GEMINI_API_KEY  |  Value: your key from aistudio.google.com
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

// Your email address — used to identify your sent messages when 
// scanning for stale commitments in the weekly digest.
const YOUR_EMAIL = 'your.email@example.com';

// Gemini model — gemini-2.5-flash is free tier; gemini-2.5-pro is 
// stronger but slower and may require paid tier for high volume.
const GEMINI_MODEL = 'gemini-2.5-flash';

// Tab names — change only if you renamed the tabs in your sheet.
const CONFIG_SHEET = 'Config';
const TRACKER_SHEET = 'Tracker';
const DIGEST_SHEET = 'ai_digest';

// Pacing: Gemini free tier = 5 requests/minute. 13s sleep stays under.
// Lower this only if you have a paid tier.
const SLEEP_BETWEEN_CALLS_MS = 13000;

// Apps Script kills runs after 6 minutes. Stop early at 5:30 to 
// checkpoint cleanly. Re-run to continue from where it left off.
const MAX_RUNTIME_MS = 330000;

// ============================================================
// PROMPT TEMPLATES
// 
// Each campaign_type defines:
// - classification_options: AI must pick exactly one
// - sentiment_options: AI must pick exactly one
// - action_guidance: when to mark "YES" in the action_required column
// - instructions: high-level framing for the AI
//
// Add new campaign types by adding new template blocks.
// ============================================================
const PROMPT_TEMPLATES = {
  
  stakeholder_response: {
    classification_options: ['Supportive', 'Neutral', 'Has concerns', 'Opposed', 'Asked question', 'No indication'],
    sentiment_options: ['Very Positive', 'Positive', 'Neutral', 'Cautious', 'Negative'],
    action_guidance: 'YES if they asked a question or made a request not yet answered. Otherwise "No - Replied" or "No".',
    instructions: 'You are extracting a stakeholder response tracker entry from an email thread about an announcement or update.'
  },
  
  event_rsvp: {
    classification_options: ['Confirmed', 'Declined', 'Tentative', 'Asked question', 'No response'],
    sentiment_options: ['Enthusiastic', 'Positive', 'Neutral', 'Reluctant'],
    action_guidance: 'YES if they asked logistics questions, requested accommodation, or need confirmation.',
    instructions: 'You are tracking RSVPs and responses to an event invitation.'
  },
  
  sales_lead: {
    classification_options: ['Hot - meeting requested', 'Warm - engaged', 'Cool - polite decline', 'Cold - no response', 'Not a fit', 'Wrong contact'],
    sentiment_options: ['Very Positive', 'Positive', 'Neutral', 'Skeptical', 'Negative'],
    action_guidance: 'YES with specific next step if they showed interest or asked a question.',
    instructions: 'You are qualifying sales leads from a cold outreach campaign. Identify buying signals, objections, and decision-maker status.'
  },
  
  expense_receipts: {
    classification_options: ['Document received', 'Document promised', 'Document issue', 'Already sent (claims)', 'Partial - more owed', 'No response'],
    sentiment_options: ['Cooperative', 'Neutral', 'Defensive', 'Apologetic'],
    action_guidance: 'YES with specific follow-up if document not yet received OR they promised by a date that has passed. "No" if document confirmed attached.',
    instructions: 'You are tracking document collection. CRITICAL: check the ATTACHMENT_DETECTED_FROM_THIS_PERSON field in context. If YES, classification is likely "Document received". If they only PROMISE to send, classification is "Document promised" and action_required must include the promised date if mentioned.'
  }
};

// ============================================================
// 1. CLASSIFY REPLIES
// ============================================================
function processTracker() {
  const startTime = new Date().getTime();
  const config = loadConfig();
  if (!config) return;
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TRACKER_SHEET);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const cols = mapColumns(headers);
  
  if (cols.email === -1) { Logger.log('ERROR: No "Email" column.'); return; }
  
  const template = PROMPT_TEMPLATES[config.campaign_type];
  if (!template) { Logger.log(`ERROR: Unknown campaign_type "${config.campaign_type}".`); return; }
  
  const data = sheet.getDataRange().getValues();
  const threads = GmailApp.search(`label:${config.gmail_label}`, 0, 300);
  Logger.log(`Found ${threads.length} threads under ${config.gmail_label}`);
  
  const emailToThreads = indexThreadsByContact(threads, data, cols.email);
  
  let processed = 0, skipped = 0, timedOut = false;
  
  for (let i = 1; i < data.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      Logger.log(`Approaching 6-min limit. Stopping at row ${i + 1}. Re-run to continue.`);
      timedOut = true;
      break;
    }
    
    const contactEmail = (data[i][cols.email] || '').toString().toLowerCase().trim();
    if (!contactEmail) continue;
    
    const alreadyDone = cols.ai_last_updated !== -1 && data[i][cols.ai_last_updated];
    if (alreadyDone) { skipped++; continue; }
    
    const matched = emailToThreads[contactEmail] || [];
    if (matched.length === 0) { Logger.log(`No threads: ${contactEmail}`); continue; }
    
    const hasAttachment = detectAttachmentFromContact(matched, contactEmail);
    const threadContent = extractThreadContent(matched);
    const contextRow = buildContextRow(headers, data[i], cols);
    if (config.campaign_type === 'expense_receipts') {
      contextRow['ATTACHMENT_DETECTED_FROM_THIS_PERSON'] = hasAttachment ? 'YES' : 'NO';
    }
    
    const analysis = analyzeWithGemini(threadContent, contextRow, template, config.context);
    if (!analysis) continue;
    
    writeAnalysis(sheet, i + 1, cols, analysis);
    processed++;
    Utilities.sleep(SLEEP_BETWEEN_CALLS_MS);
  }
  
  Logger.log(`Done. Processed: ${processed}, Skipped (already done): ${skipped}${timedOut ? ' — TIMED OUT, re-run to continue' : ''}`);
}

// ============================================================
// 2. DRAFT REPLIES
// ============================================================
function draftReplies() {
  const startTime = new Date().getTime();
  const config = loadConfig();
  if (!config) return;
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TRACKER_SHEET);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const cols = mapColumns(headers);
  const draftModeCol = findCol(headers, 'draft_mode');
  const draftStatusCol = findCol(headers, 'ai_draft_status');
  
  if (draftModeCol === -1) { Logger.log('ERROR: No "draft_mode" column.'); return; }
  
  const data = sheet.getDataRange().getValues();
  const threads = GmailApp.search(`label:${config.gmail_label}`, 0, 300);
  const emailToThreads = indexThreadsByContact(threads, data, cols.email);
  
  let drafted = 0, skipped = 0, failed = 0, timedOut = false;
  
  for (let i = 1; i < data.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      Logger.log(`Approaching 6-min limit. Stopping at row ${i + 1}. Re-run to continue.`);
      timedOut = true;
      break;
    }
    
    const mode = (data[i][draftModeCol] || '').toString().toLowerCase().trim();
    if (mode !== 'holding' && mode !== 'full') { skipped++; continue; }
    
    const existingStatus = draftStatusCol !== -1 ? (data[i][draftStatusCol] || '').toString() : '';
    if (existingStatus.startsWith('drafted')) {
      skipped++;
      continue;
    }
    
    const contactEmail = (data[i][cols.email] || '').toString().toLowerCase().trim();
    if (!contactEmail) continue;
    
    const matched = emailToThreads[contactEmail] || [];
    if (matched.length === 0) {
      writeStatus(sheet, i + 1, draftStatusCol, 'error: no thread found');
      failed++;
      continue;
    }
    
    matched.sort((a, b) => b.getLastMessageDate() - a.getLastMessageDate());
    const thread = matched[0];
    
    const contactName = data[i][0];
    const aiSummary = cols.ai_summary !== -1 ? data[i][cols.ai_summary] : '';
    const aiAction = cols.ai_action_required !== -1 ? data[i][cols.ai_action_required] : '';
    
    const result = generateDraft(
      mode, contactName, aiSummary, aiAction,
      extractThreadContent([thread]), config.context, config.campaign_type
    );
    
    if (result.error) {
      writeStatus(sheet, i + 1, draftStatusCol, `error: ${result.error.slice(0, 100)}`);
      failed++;
      Utilities.sleep(SLEEP_BETWEEN_CALLS_MS);
      continue;
    }
    
    try {
      thread.createDraftReply(result.text);
      writeStatus(sheet, i + 1, draftStatusCol, `drafted (${mode}) at ${formatTimestamp(new Date())}`);
      drafted++;
    } catch (e) {
      writeStatus(sheet, i + 1, draftStatusCol, `error: Gmail rejected draft: ${e.toString().slice(0, 80)}`);
      failed++;
    }
    
    Utilities.sleep(SLEEP_BETWEEN_CALLS_MS);
  }
  
  Logger.log(`Drafted: ${drafted}, Failed: ${failed}, Skipped: ${skipped}${timedOut ? ' — TIMED OUT, re-run to continue' : ''}`);
}

// ============================================================
// 3. WEEKLY DIGEST
// ============================================================
function generateWeeklyDigest() {
  const config = loadConfig();
  if (!config) return;
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tracker = ss.getSheetByName(TRACKER_SHEET);
  let digest = ss.getSheetByName(DIGEST_SHEET);
  if (!digest) digest = ss.insertSheet(DIGEST_SHEET);
  digest.clear();
  
  const headers = tracker.getRange(1, 1, 1, tracker.getLastColumn()).getValues()[0];
  const cols = mapColumns(headers);
  const data = tracker.getDataRange().getValues();
  
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const newReplies = [];
  const actionItems = [];
  const noResponse = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const name = row[0];
    const email = (row[cols.email] || '').toString();
    if (!email) continue;
    
    const respDateStr = cols.ai_response_date !== -1 ? row[cols.ai_response_date] : '';
    const classification = cols.ai_classification !== -1 ? row[cols.ai_classification] : '';
    const action = cols.ai_action_required !== -1 ? row[cols.ai_action_required] : '';
    const status = cols.ai_status !== -1 ? row[cols.ai_status] : '';
    
    if (!respDateStr) {
      noResponse.push({ name, email });
      continue;
    }
    
    const respDate = parseFlexibleDate(respDateStr);
    if (respDate && respDate >= weekAgo) {
      newReplies.push({ name, classification, status });
    }
    
    if (action && action.toString().toUpperCase().startsWith('YES')) {
      actionItems.push({ name, action, status });
    }
  }
  
  const stalePromises = detectStalePromises(config);
  
  let row = 1;
  
  digest.getRange(row, 1).setValue(`Weekly Digest — ${formatDate(today)} — Campaign: ${config.campaign_name}`);
  digest.getRange(row, 1).setFontWeight('bold').setFontSize(14);
  row += 2;
  
  digest.getRange(row, 1).setValue('SUMMARY').setFontWeight('bold').setBackground('#1F4E78').setFontColor('#FFFFFF');
  row++;
  digest.getRange(row, 1, 4, 2).setValues([
    ['New replies this week', newReplies.length],
    ['Action items open', actionItems.length],
    ['Your overdue commitments', stalePromises.length],
    ['No response yet', noResponse.length]
  ]);
  row += 5;
  
  digest.getRange(row, 1).setValue('NEW REPLIES THIS WEEK').setFontWeight('bold').setBackground('#1F4E78').setFontColor('#FFFFFF');
  row++;
  if (newReplies.length === 0) {
    digest.getRange(row, 1).setValue('(none)').setFontStyle('italic');
    row++;
  } else {
    digest.getRange(row, 1, 1, 3).setValues([['Name', 'Classification', 'Status']]).setFontWeight('bold');
    row++;
    newReplies.forEach(r => {
      digest.getRange(row, 1, 1, 3).setValues([[r.name, r.classification, r.status]]);
      row++;
    });
  }
  row++;
  
  digest.getRange(row, 1).setValue('ACTION REQUIRED FROM YOU').setFontWeight('bold').setBackground('#C00000').setFontColor('#FFFFFF');
  row++;
  if (actionItems.length === 0) {
    digest.getRange(row, 1).setValue('(none open)').setFontStyle('italic');
    row++;
  } else {
    digest.getRange(row, 1, 1, 3).setValues([['Name', 'Action', 'Status']]).setFontWeight('bold');
    row++;
    actionItems.forEach(a => {
      digest.getRange(row, 1, 1, 3).setValues([[a.name, a.action, a.status]]);
      row++;
    });
  }
  row++;
  
  digest.getRange(row, 1).setValue('YOUR OVERDUE COMMITMENTS').setFontWeight('bold').setBackground('#C00000').setFontColor('#FFFFFF');
  row++;
  if (stalePromises.length === 0) {
    digest.getRange(row, 1).setValue('(none)').setFontStyle('italic');
    row++;
  } else {
    digest.getRange(row, 1, 1, 5).setValues([['Recipient', 'Commitment', 'Deadline', 'Days since sent', 'They replied?']]).setFontWeight('bold');
    row++;
    stalePromises.forEach(p => {
      digest.getRange(row, 1, 1, 5).setValues([[p.recipient, p.commitment, p.deadline, p.days_since, p.they_replied_after]]);
      row++;
    });
  }
  row++;
  
  digest.getRange(row, 1).setValue('NO RESPONSE YET').setFontWeight('bold').setBackground('#666666').setFontColor('#FFFFFF');
  row++;
  if (noResponse.length === 0) {
    digest.getRange(row, 1).setValue('(everyone has replied)').setFontStyle('italic');
    row++;
  } else {
    digest.getRange(row, 1, 1, 2).setValues([['Name', 'Email']]).setFontWeight('bold');
    row++;
    noResponse.forEach(n => {
      digest.getRange(row, 1, 1, 2).setValues([[n.name, n.email]]);
      row++;
    });
  }
  
  digest.setColumnWidth(1, 200);
  digest.setColumnWidth(2, 300);
  digest.setColumnWidth(3, 200);
  digest.setColumnWidth(4, 120);
  digest.setColumnWidth(5, 120);
  
  Logger.log('Digest done.');
}

// ============================================================
// INTERNAL: STALE PROMISES (used by generateWeeklyDigest)
// ============================================================
function detectStalePromises(config) {
  const query = `label:${config.gmail_label} from:${YOUR_EMAIL}`;
  const threads = GmailApp.search(query, 0, 100);
  Logger.log(`Scanning ${threads.length} threads for your commitments`);
  
  const stalePromises = [];
  const today = new Date();
  
  threads.forEach(thread => {
    const messages = thread.getMessages();
    const yourMessages = messages.filter(m => m.getFrom().toLowerCase().includes(YOUR_EMAIL.toLowerCase()));
    if (yourMessages.length === 0) return;
    
    const lastYourMsg = yourMessages[yourMessages.length - 1];
    const sentDate = lastYourMsg.getDate();
    const daysSince = Math.floor((today - sentDate) / (1000 * 60 * 60 * 24));
    
    if (daysSince < 2) return;
    
    const lastMessageDate = thread.getLastMessageDate();
    const replyAfterYou = lastMessageDate > sentDate;
    
    const commitments = extractCommitments(lastYourMsg.getPlainBody().slice(0, 2000), sentDate);
    if (!commitments || commitments.length === 0) return;
    
    commitments.forEach(c => {
      const isStale = c.deadline_date 
        ? (new Date(c.deadline_date) < today)
        : (daysSince > 5);
      
      if (isStale) {
        stalePromises.push({
          recipient: thread.getMessages()[0].getFrom(),
          sent_date: formatDate(sentDate),
          days_since: daysSince,
          commitment: c.commitment,
          deadline: c.deadline_date || 'none stated',
          they_replied_after: replyAfterYou ? 'YES' : 'NO'
        });
      }
    });
    
    Utilities.sleep(SLEEP_BETWEEN_CALLS_MS);
  });
  
  return stalePromises;
}

function extractCommitments(messageBody, sentDate) {
  const prompt = `Scan this email I sent for commitments I made (phrases like "I'll send", "by Friday", "next week").

Email body:
${messageBody}

Sent date: ${formatDate(sentDate)}

Return JSON array. Each item: { commitment: "short summary", deadline_date: "YYYY-MM-DD or null" }. If no commitments, return [].`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            commitment: { type: "string" },
            deadline_date: { type: "string", nullable: true }
          },
          required: ["commitment"]
        }
      },
      temperature: 0.1
    }
  };
  
  const result = callGeminiWithRetry(url, payload);
  if (!result.success) {
    Logger.log('Commitment extract error: ' + result.error);
    return [];
  }
  
  try {
    const data = JSON.parse(result.body);
    if (!data.candidates || !data.candidates[0]) return [];
    return JSON.parse(data.candidates[0].content.parts[0].text);
  } catch (e) {
    Logger.log('Commitment parse error: ' + e);
    return [];
  }
}

// ============================================================
// INTERNAL: API CALL WRAPPER WITH RETRY ON 429 / 503 / 500
// 30s → 60s → 120s exponential backoff, max 3 retries.
// ============================================================
function callGeminiWithRetry(url, payload, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    
    const code = response.getResponseCode();
    const text = response.getContentText();
    
    if (code === 200) {
      return { success: true, code: code, body: text };
    }
    
    if (code === 429 || code === 503 || code === 500) {
      lastError = `HTTP ${code}: ${text.slice(0, 200)}`;
      if (attempt < maxRetries) {
        const waitMs = 30000 * Math.pow(2, attempt);
        Logger.log(`Attempt ${attempt + 1} failed (${code}). Waiting ${waitMs / 1000}s before retry...`);
        Utilities.sleep(waitMs);
        continue;
      }
    }
    
    return { success: false, code: code, body: text, error: `HTTP ${code}: ${text.slice(0, 200)}` };
  }
  
  return { success: false, code: 429, body: '', error: `Exhausted ${maxRetries} retries. Last: ${lastError}` };
}

// ============================================================
// INTERNAL: GEMINI CALLS
// ============================================================
function analyzeWithGemini(threadContent, contextRow, template, campaignContext) {
  const contextStr = Object.keys(contextRow).length 
    ? `Known context about this contact:\n${JSON.stringify(contextRow, null, 2)}\n\n` 
    : '';
  
  const prompt = `${template.instructions}

Campaign context: ${campaignContext || '(none provided)'}

${contextStr}Thread content:
${threadContent}

Extract a tracker entry following this schema:
- response_date: DD-MMM-YYYY format, date of their MOST RECENT message
- classification: one of [${template.classification_options.join(', ')}]
- sentiment: one of [${template.sentiment_options.join(', ')}]
- summary: Chronological narrative. Use date prefixes (e.g. 'MAR 19:') for multiple messages. Capture specifics. 2-4 sentences. Be specific to THIS contact.
- action_required: ${template.action_guidance}
- status: Short status line.

Rules:
- classification and sentiment MUST be exactly one of the listed options.
- summary must reference specifics. Do not invent details.
- Use the LATEST message date for response_date.
- The summary itself should be written in English regardless of thread language (for tracker consistency).`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: {
        type: "object",
        properties: {
          response_date: { type: "string" },
          classification: { type: "string", enum: template.classification_options },
          sentiment: { type: "string", enum: template.sentiment_options },
          summary: { type: "string" },
          action_required: { type: "string" },
          status: { type: "string" }
        },
        required: ["response_date", "classification", "sentiment", "summary", "action_required", "status"]
      },
      temperature: 0.2
    }
  };
  
  const result = callGeminiWithRetry(url, payload);
  if (!result.success) {
    Logger.log(`Classification failed: ${result.error}`);
    return null;
  }
  
  try {
    const data = JSON.parse(result.body);
    if (!data.candidates || !data.candidates[0]) {
      Logger.log('No candidates: ' + result.body.slice(0, 500));
      return null;
    }
    return JSON.parse(data.candidates[0].content.parts[0].text);
  } catch (e) {
    Logger.log('Parse error: ' + e);
    return null;
  }
}

function generateDraft(mode, contactName, summary, actionRequired, threadContent, campaignContext, campaignType) {
  const modeInstructions = {
    holding: `Draft a SHORT holding reply (3-4 sentences max). Purpose: acknowledge receipt, signal you'll respond properly soon, give a rough timeline. Do NOT answer their question or commit to anything specific. Tone: warm, professional, brief.`,
    full: `Draft a substantive reply that addresses their specific question or request. Use the thread context. If you don't have information needed (specific numbers, dates, documents), use [BRACKETS] as placeholders. Tone: matches the existing thread. Length: matches the complexity of what they asked.`
  };
  
  const expenseAddendum = campaignType === 'expense_receipts' 
    ? '\nThis is a document collection follow-up. Be polite but clear about what is still needed. Reference the specific document or amount if mentioned.' 
    : '';
  
  const prompt = `You are drafting an email reply on behalf of the user. This is a DRAFT for review and editing before sending. It will not be sent automatically.

LANGUAGE RULE — CRITICAL:
Detect the language of the most recent message from the recipient in the thread below. Write your draft reply in THAT SAME LANGUAGE. If the recipient wrote in German, reply in German. If English, reply in English. If they switched languages mid-thread, match their MOST RECENT message. Match formality conventions of that language.

Campaign context: ${campaignContext}
Campaign type: ${campaignType}

Recipient: ${contactName}
What they said (summary): ${summary}
Action needed: ${actionRequired}

Recent thread:
${threadContent}

${modeInstructions[mode]}${expenseAddendum}

Critical rules:
- Do NOT invent facts. Use [BRACKETS] for unknown specifics.
- Do NOT commit to dates, amounts, or decisions not in the thread.
- Sign off appropriately for the language ("Best," for English, "Beste Grüße," for German, etc.).
- Plain text only, no markdown.
- Start with "[DRAFT — review before sending]\\n\\n" on its own line (always in English — this is a system marker the user deletes before sending).

Output ONLY the email body text, nothing else.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 }
  };
  
  const result = callGeminiWithRetry(url, payload);
  if (!result.success) {
    return { error: result.error.slice(0, 100) };
  }
  
  try {
    const data = JSON.parse(result.body);
    
    if (data.error) {
      return { error: `API: ${data.error.message || 'unknown'}`.slice(0, 100) };
    }
    
    if (!data.candidates || !data.candidates[0]) {
      return { error: 'No response from model (possibly safety-blocked)' };
    }
    
    const candidate = data.candidates[0];
    
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      return { error: `Model stopped: ${candidate.finishReason}` };
    }
    
    if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
      return { error: 'Malformed response structure' };
    }
    
    const text = candidate.content.parts[0].text;
    if (!text || text.trim().length === 0) {
      return { error: 'Empty response text' };
    }
    
    return { text: text };
  } catch (e) {
    return { error: `Parse: ${e.toString().slice(0, 100)}` };
  }
}

// ============================================================
// INTERNAL: HELPERS
// ============================================================
function loadConfig() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  if (!sheet) { Logger.log('ERROR: No Config sheet.'); return null; }
  const data = sheet.getDataRange().getValues();
  const config = {};
  data.forEach(([key, value]) => {
    if (key) config[key.toString().trim()] = (value || '').toString().trim();
  });
  return config;
}

function mapColumns(headers) {
  const cols = {
    email: -1, ai_response_date: -1, ai_classification: -1, ai_sentiment: -1,
    ai_summary: -1, ai_action_required: -1, ai_status: -1, ai_last_updated: -1,
    ai_draft_status: -1
  };
  headers.forEach((h, i) => {
    const key = h.toString().toLowerCase().trim();
    if (key === 'email') cols.email = i;
    else if (cols.hasOwnProperty(key)) cols[key] = i;
  });
  return cols;
}

function findCol(headers, name) {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].toString().toLowerCase().trim() === name.toLowerCase()) return i;
  }
  return -1;
}

function buildContextRow(headers, row, cols) {
  const context = {};
  headers.forEach((h, i) => {
    const key = h.toString().trim();
    const lowered = key.toLowerCase();
    if (lowered === 'email') return;
    if (lowered.startsWith('ai_')) return;
    if (lowered === 'draft_mode') return;
    if (row[i] !== '' && row[i] !== null) context[key] = row[i];
  });
  return context;
}

function indexThreadsByContact(threads, sheetData, emailCol) {
  const contactEmails = new Set();
  for (let i = 1; i < sheetData.length; i++) {
    const e = (sheetData[i][emailCol] || '').toString().toLowerCase().trim();
    if (e) contactEmails.add(e);
  }
  const index = {};
  threads.forEach(thread => {
    const matched = new Set();
    thread.getMessages().forEach(msg => {
      const haystack = (msg.getFrom() + ' ' + msg.getPlainBody().slice(0, 5000)).toLowerCase();
      contactEmails.forEach(e => { if (haystack.includes(e)) matched.add(e); });
    });
    matched.forEach(e => {
      if (!index[e]) index[e] = [];
      index[e].push(thread);
    });
  });
  return index;
}

function extractThreadContent(threads) {
  const parts = [];
  threads.forEach((t, idx) => {
    parts.push(`=== THREAD ${idx + 1}: ${t.getFirstMessageSubject()} ===`);
    t.getMessages().forEach(msg => {
      const attachments = msg.getAttachments();
      const attNote = attachments.length > 0 ? `\n[ATTACHMENTS: ${attachments.map(a => a.getName()).join(', ')}]` : '';
      parts.push(`---\nFrom: ${msg.getFrom()}\nDate: ${msg.getDate().toISOString().slice(0, 10)}${attNote}\n\n${msg.getPlainBody().slice(0, 3000)}`);
    });
  });
  return parts.join('\n\n');
}

function detectAttachmentFromContact(threads, contactEmail) {
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      if (msg.getFrom().toLowerCase().includes(contactEmail) && msg.getAttachments().length > 0) {
        return true;
      }
    }
  }
  return false;
}

function writeStatus(sheet, rowNum, col, msg) {
  if (col !== -1) sheet.getRange(rowNum, col + 1).setValue(msg);
}

function writeAnalysis(sheet, rowNum, cols, analysis) {
  const writes = [
    [cols.ai_response_date, analysis.response_date],
    [cols.ai_classification, analysis.classification],
    [cols.ai_sentiment, analysis.sentiment],
    [cols.ai_summary, analysis.summary],
    [cols.ai_action_required, analysis.action_required],
    [cols.ai_status, analysis.status],
    [cols.ai_last_updated, new Date()]
  ];
  writes.forEach(([col, val]) => {
    if (col !== -1) sheet.getRange(rowNum, col + 1).setValue(val);
  });
}

function formatDate(d) { return d.toISOString().slice(0, 10); }
function formatTimestamp(d) { return d.toISOString().slice(0, 16).replace('T', ' '); }

function parseFlexibleDate(str) {
  if (!str) return null;
  if (str instanceof Date) return str;
  const s = str.toString().trim();
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const month = months[m[2].toLowerCase()];
    if (month !== undefined) return new Date(parseInt(m[3]), month, parseInt(m[1]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}