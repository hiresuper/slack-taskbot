import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;
import cron from "node-cron";
import Airtable from "airtable";
import OpenAI from "openai";

/* =====================
   ENV VALIDATION
===================== */

const requiredEnv = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENAI_API_KEY",
  "AIRTABLE_TOKEN",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_TABLE_NAME"
];
for (const k of requiredEnv) {
  if (!process.env[k]) throw new Error(`Missing env var: ${k}`);
}

/* =====================
   CONFIG
===================== */

const REMINDER_INTERVAL_HOURS = 24; // default recurring cadence
const CRON_EVERY_MINUTES = 30;
const MAX_REMINDERS = 0; // 0 = unlimited

/* =====================
   CLIENTS
===================== */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const airtableBase = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN
}).base(process.env.AIRTABLE_BASE_ID);

const TASKS_TABLE = process.env.AIRTABLE_TABLE_NAME;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

/* =====================
   HELPERS
===================== */

function slackMessageLink(channelId, threadTs) {
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${threadTs}`;
}

function normalizeThreadTs(event) {
  return event.thread_ts || event.ts;
}

function parseCommand(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\bremind\b/.test(t)) return "remind";
  if (/\blist\b/.test(t)) return "list";
  if (/\breopen\b/.test(t)) return "reopen";
  if (/\bsummary\b|\bsummarize\b/.test(t)) return "summary";
  if (/\bupdate\b/.test(t)) return "update";
  if (/\btrack\b/.test(t)) return "track";
  if (/\bcomplete\b/.test(t)) return "complete";
  return null;
}

function parseRemindDurationHours(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // "remind in 6 hours", "remind in 90 minutes", "remind in 2 days"
  const m = t.match(/remind\s+in\s+(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = m[2];
  if (unit.startsWith("min")) return n / 60;
  if (unit.startsWith("hour") || unit.startsWith("hr")) return n;
  if (unit.startsWith("day")) return n * 24;

  return null;
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

async function airtableFindByThreadTs(threadTs) {
  const records = await airtableBase(TASKS_TABLE)
    .select({
      maxRecords: 1,
      filterByFormula: `{thread_ts} = "${threadTs}"`
    })
    .firstPage();
  return records?.[0] || null;
}

async function airtableCreate(fields) {
  const [rec] = await airtableBase(TASKS_TABLE).create([{ fields }]);
  return rec;
}

async function airtableUpdate(id, fields) {
  const [rec] = await airtableBase(TASKS_TABLE).update([{ id, fields }]);
  return rec;
}

async function fetchThreadMessages(channelId, threadTs) {
  const replies = await app.client.conversations.replies({
    channel: channelId,
    ts: threadTs
  });
  return (replies.messages || []).slice(-25).map(m => ({ text: m.text || "" }));
}

async function airtableListOpenTasks(limit = 20) {
  const records = await airtableBase(TASKS_TABLE)
    .select({
      maxRecords: limit,
      sort: [{ field: "created_at", direction: "desc" }],
      filterByFormula: `LOWER({status}) = "open"`
    })
    .firstPage();
  return records || [];
}

/* =====================
   ASSIGNEE LOGIC
===================== */

function extractAssigneeSlackId(threadMessages, requesterId) {
  const botId = process.env.SLACK_BOT_USER_ID || "";
  const ignore = new Set([requesterId, botId].filter(Boolean));
  const regex = /<@([A-Z0-9]+)>/g;
  const counts = new Map();

  for (const m of threadMessages) {
    let match;
    while ((match = regex.exec(m.text || ""))) {
      if (!ignore.has(match[1])) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

async function slackDisplayName(userId) {
  if (!userId) return "";
  const info = await app.client.users.info({ user: userId });
  const p = info?.user?.profile;
  return p?.display_name || p?.real_name || info?.user?.name || "";
}

/* =====================
   AI SUMMARY
===================== */

async function summarizeThreadToTask(threadMessages) {
  const text = threadMessages.map(m => `- ${m.text}`).join("\n");

  const prompt = `
Return JSON only:
{
  "summary": "...",
  "next_actions": "- ...\\n- ...",
  "task_title": "..."
}

Rules:
- summary: ≤3 sentences
- next_actions: STRING ONLY (no arrays)
- task_title: 3–5 words
- do not infer anything not explicitly stated

Thread:
${text}
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: { format: { type: "json_object" } }
  });

  const raw = resp.output_text;

  try {
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary?.trim() || "",
      next_actions: typeof parsed.next_actions === "string" ? parsed.next_actions.trim() : "",
      task_title: parsed.task_title?.trim() || ""
    };
  } catch {
    return {
      summary: text.slice(0, 400),
      next_actions: "- (unable to parse)",
      task_title: "Follow Up"
    };
  }
}

/* =====================
   SLACK UTIL
===================== */

async function postInThread(channel, thread_ts, text) {
  await app.client.chat.postMessage({ channel, thread_ts, text });
}

function nextReminderISO(from = new Date()) {
  return new Date(from.getTime() + REMINDER_INTERVAL_HOURS * 3600_000).toISOString();
}

function makeTaskId() {
  return `TASK-${Date.now().toString(36).toUpperCase()}`;
}

/* =====================
   SLACK EVENTS
===================== */

app.event("app_mention", async ({ event }) => {
  try {
    if (event.bot_id) return;

    const channelId = event.channel;
    const threadTs = normalizeThreadTs(event);
    const cmd = parseCommand(event.text || "");

    if (!cmd) {
      await postInThread(
        channelId,
        threadTs,
        `Commands:\n• track\n• update\n• summary\n• complete\n• reopen\n• list\n• remind in X hours`
      );
      return;
    }

    if (cmd === "summary") {
      const rec = await airtableFindByThreadTs(threadTs);
      if (!rec) return postInThread(channelId, threadTs, "Nothing tracked yet.");
      await postInThread(
        channelId,
        threadTs,
        `🧾 *${rec.fields.task_title}*\n*Assignee:* ${rec.fields.assignee_display || "(unassigned)"}\n*Summary:* ${rec.fields.summary}\n*Next actions:*\n${rec.fields.next_actions}`
      );
      return;
    }

    if (cmd === "update") {
      const rec = await airtableFindByThreadTs(threadTs);
      if (!rec) return postInThread(channelId, threadTs, "Nothing tracked yet.");

      const msgs = await fetchThreadMessages(channelId, threadTs);
      const ai = await summarizeThreadToTask(msgs);

      const assigneeId =
        extractAssigneeSlackId(msgs, rec.fields.created_by_slack_id) ||
        rec.fields.assignee_slack_id ||
        "";

      const assignee_display = assigneeId
        ? await slackDisplayName(assigneeId)
        : rec.fields.assignee_display || "";

      await airtableUpdate(rec.id, {
        ...ai,
        assignee_slack_id: assigneeId,
        assignee_display,
        last_update_at: new Date().toISOString()
      });

      await postInThread(
        channelId,
        threadTs,
        `🔄 Updated *${ai.task_title}*.\nAssignee: ${assignee_display || "(unassigned)"}`
      );
      return;
    }

    if (cmd === "track") {
      if (await airtableFindByThreadTs(threadTs)) {
        return postInThread(channelId, threadTs, "Already tracked.");
      }

      const msgs = await fetchThreadMessages(channelId, threadTs);
      const ai = await summarizeThreadToTask(msgs);
      const assigneeId = extractAssigneeSlackId(msgs, event.user);
      const assignee_display = assigneeId ? await slackDisplayName(assigneeId) : "";

      await airtableCreate({
        task_id: makeTaskId(),
        status: "open",
        channel_id: channelId,
        thread_ts: threadTs,
        source_link: slackMessageLink(channelId, threadTs),
        created_by_slack_id: event.user,
        created_at: new Date().toISOString(),
        next_reminder_at: nextReminderISO(),
        reminder_count: 0,
        one_off_reminder_at: "", // TEXT field recommended
        ...ai,
        assignee_slack_id: assigneeId,
        assignee_display,
        last_update_at: new Date().toISOString()
      });

      await postInThread(channelId, threadTs, `✅ Tracking *${ai.task_title}*.`);
      return;
    }

    if (cmd === "list") {
      const open = await airtableListOpenTasks(10);

      if (!open.length) {
        await postInThread(channelId, threadTs, "✅ No open tasks right now.");
        return;
      }

      const lines = open.map((r, i) => {
        const title = r.fields.task_title || r.fields.task_id || "Untitled";
        const who = r.fields.assignee_display ? ` — ${r.fields.assignee_display}` : "";
        const link = r.fields.source_link ? ` (${r.fields.source_link})` : "";
        return `${i + 1}) *${title}*${who}${link}`;
      });

      await postInThread(
        channelId,
        threadTs,
        `📋 *Open tasks (${open.length})*\n${lines.join("\n")}\n\nTip: reply in a task thread with *@tasks summary* to get context.`
      );
      return;
    }

    if (cmd === "remind") {
      const rec = await airtableFindByThreadTs(threadTs);
      if (!rec) return postInThread(channelId, threadTs, "No tracked task yet. Use *@tasks track* first.");

      const hours = parseRemindDurationHours(event.text || "");
      if (!hours) {
        await postInThread(channelId, threadTs, "Usage: *@tasks remind in 6 hours* (also supports minutes/days)");
        return;
      }

      const whenISO = new Date(Date.now() + hours * 3600_000).toISOString();

      await airtableUpdate(rec.id, {
        one_off_reminder_at: whenISO,
        last_update_at: new Date().toISOString()
      });

      await postInThread(channelId, threadTs, `⏰ Got it — I’ll send an extra reminder in ${hours} hour(s).`);
      return;
    }

    if (cmd === "reopen") {
      const rec = await airtableFindByThreadTs(threadTs);
      if (!rec) return;

      const now = new Date();
      await airtableUpdate(rec.id, {
        status: "open",
        next_reminder_at: nextReminderISO(now),
        last_update_at: now.toISOString()
      });

      await postInThread(channelId, threadTs, `♻️ Reopened *${rec.fields.task_title}*.`);
      return;
    }

    if (cmd === "complete") {
      const rec = await airtableFindByThreadTs(threadTs);
      if (!rec) return;

      await airtableUpdate(rec.id, {
        status: "closed",
        one_off_reminder_at: "",
        last_update_at: new Date().toISOString()
      });

      await postInThread(channelId, threadTs, `✅ Closed *${rec.fields.task_title}*.`);
      return;
    }
  } catch (err) {
    console.error("app_mention error:", err);
  }
});

/* =====================
   REMINDERS
===================== */

cron.schedule(`*/${CRON_EVERY_MINUTES} * * * *`, async () => {
  try {
    const now = new Date();

    const records = await airtableBase(TASKS_TABLE)
      .select({ filterByFormula: `LOWER({status})="open"` })
      .all();

    for (const rec of records) {
      if (MAX_REMINDERS && Number(rec.fields.reminder_count || 0) >= MAX_REMINDERS) continue;

      const normalDue = rec.fields.next_reminder_at ? new Date(rec.fields.next_reminder_at) : null;
      const oneOffDue = rec.fields.one_off_reminder_at ? new Date(rec.fields.one_off_reminder_at) : null;

      const normalOk = isValidDate(normalDue);
      const oneOffOk = isValidDate(oneOffDue);

      const nextDue =
        normalOk && oneOffOk ? (normalDue < oneOffDue ? normalDue : oneOffDue)
        : oneOffOk ? oneOffDue
        : normalOk ? normalDue
        : null;

      if (!nextDue || nextDue > now) continue;

      await postInThread(
        rec.fields.channel_id,
        rec.fields.thread_ts,
        `⏰ Reminder: *${rec.fields.task_title || rec.fields.task_id}* is still open. Close with *@tasks complete* when done.`
      );

      const firedOneOff = !!(oneOffOk && oneOffDue <= now);

      await airtableUpdate(rec.id, {
        reminder_count: Number(rec.fields.reminder_count || 0) + 1,
        next_reminder_at: nextReminderISO(now),
        one_off_reminder_at: firedOneOff ? "" : (rec.fields.one_off_reminder_at || ""),
        last_update_at: now.toISOString()
      });
    }
  } catch (err) {
    console.error("Reminder cron error:", err);
  }
});

/* =====================
   START
===================== */

(async () => {
  await app.start();
  console.log("⚡️ tasks bot running");
})();