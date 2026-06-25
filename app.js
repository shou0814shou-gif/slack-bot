const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SLACK_BOT_TOKEN) console.warn("SLACK_BOT_TOKEN is not set");
if (!SLACK_SIGNING_SECRET) console.warn("SLACK_SIGNING_SECRET is not set");
if (!DATABASE_URL) console.warn("DATABASE_URL is not set");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      thread_ts TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      teacher TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS assignment_cursors (
      subject TEXT PRIMARY KEY,
      next_index INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_teacher ON tasks (status, teacher);
    CREATE INDEX IF NOT EXISTS idx_tasks_channel_thread ON tasks (channel_id, thread_ts);
  `);

  // Ensure due_at column exists for tasks (migration for existing DBs)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`);

  console.log("Database initialized");
}

// Slack user ID mapping
const TEACHER_IDS = {
  "真間咲也子": "U0APQ35UAF6",
  "大森悠太": "U0AP53C4G79",
  "細山杏咲": "U0APFUYTAE6",
  "菅野瑠衣": "U0APGF2UPKM",
  "飯尾拓斗": "U0APH6WA41K",
  "中村創詩": "U0APHQR0S4A",
  "中村澪": "U0AP5FYKP1D",
  "三成ひなた": "U0APWQ10RPB",
  "難波昇大": "U0APX669K0E",
  "北村秀平": "U0AN7045G1L",
  "臼井海斗": "U0APFULA48J",
  "西塚遥香": "U0APKDPSZU5",
  "濱田綺音": "U0APFQ5T1QA",
  "宮内煌生": "U0APF269UHY",
  "森 聖羽": "U0APHR40G3Z",
  "中村莉望": "U0APVSN0Q2Z",
};

// Subject to teachers mapping
const subjectTeachers = {
  "英語": ["真間咲也子", "大森悠太", "細山杏咲", "中村莉望", "飯尾拓斗", "中村創詩"],
  "国語": ["中村創詩", "中村澪", "大森悠太", "細山杏咲", "中村莉望", "菅野瑠衣", "三成ひなた"],
  "数学": ["北村秀平", "難波昇大", "西塚遥香", "臼井海斗"],
  "物理": ["北村秀平", "難波昇大", "西塚遥香", "臼井海斗"],
  "化学": ["難波昇大", "西塚遥香", "臼井海斗"],
  "生物": ["濱田綺音"],
  "物理基礎": ["難波昇大", "西塚遥香", "臼井海斗", "北村秀平"],
  "化学基礎": ["難波昇大", "西塚遥香", "臼井海斗", "中村創詩"],
  "生物基礎": ["中村創詩", "濱田綺音"],
  "日本史": ["真間咲也子", "飯尾拓斗", "細山杏咲"],
  "世界史": ["大森悠太", "中村創詩", "中村澪"],
  "政治経済": ["宮内煌生"],
  "地理": ["森 聖羽"],
  "倫理": ["細山杏咲"],
  "情報": ["宮内煌生", "難波昇大"],
};

const subjects = Object.keys(subjectTeachers).sort((a, b) => b.length - a.length);

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));

app.get("/", (req, res) => {
  console.log("GET / received");
  res.send("Slack bot is running");
});

app.post("/slack/events", async (req, res) => {
  console.log("===== EVENT RECEIVED =====");
  console.log(JSON.stringify(req.body, null, 2));

  if (!verifySlackRequest(req)) {
    return res.status(401).send("invalid signature");
  }

  if (req.body.type === "url_verification") {
    return res.status(200).type("text/plain").send(req.body.challenge);
  }

  res.status(200).send("ok");

  try {
    await handleSlackEvent(req.body);
  } catch (error) {
    console.error("Failed to handle Slack event:", error);
  }
});

function verifySlackRequest(req) {
  if (!SLACK_SIGNING_SECRET) return true;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(base)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function handleSlackEvent(body) {
  if (body.type !== "event_callback" || !body.event) return;

  const isFirstProcess = await markEventProcessed(body.event_id);
  if (!isFirstProcess) {
    console.log(`Skipping duplicate event: ${body.event_id}`);
    return;
  }

  const event = body.event;
  if (event.type !== "message") return;
  if (event.bot_id || event.subtype === "bot_message") return;

  const text = normalizeText(event.text || "");
  if (!text && !(event.files && event.files.length)) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;

  // Completion detection: either when a PDF file is posted in the thread OR when "完了" text is sent
  if (event.thread_ts) {
    // Check for PDF file
    if (event.files && event.files.some(f => {
      const mime = (f.mimetype || "").toLowerCase();
      const filetype = (f.filetype || "").toLowerCase();
      return mime === "application/pdf" || filetype === "pdf";
    })) {
      await completeTask(channel, event.thread_ts);
      return;
    }

    // Check for "完了" text
    if (text.includes("完了")) {
      await completeTask(channel, event.thread_ts);
      return;
    }

    // If in thread but not completion trigger, ignore
    return;
  }

  const matchedSubjects = findSubjects(text);
  if (matchedSubjects.length === 0) return;

  if (matchedSubjects.length > 1) {
    await postMessage({
      channel,
      thread_ts: threadTs,
      text: `科目名が複数見つかりました: ${matchedSubjects.join("、")}\n1つの投稿に1科目だけ[...]`
    });
    return;
  }

  await assignTask(channel, threadTs, matchedSubjects[0]);
}

async function markEventProcessed(eventId) {
  if (!eventId) return true;

  const result = await pool.query(
    "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [eventId],
  );
  return result.rowCount === 1;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function findSubjects(text) {
  return subjects.filter((subject) => text.includes(subject));
}

async function assignTask(channel, threadTs, subject) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT subject, teacher, status FROM tasks WHERE thread_ts = $1 FOR UPDATE",
      [threadTs],
    );

    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      console.log(`Task already exists for thread ${threadTs}`);
      return;
    }

    const teachers = subjectTeachers[subject];
    const active = await client.query(
      "SELECT teacher FROM tasks WHERE status = 'active'",
    );
    const activeTeachers = new Set(active.rows.map((row) => row.teacher));
    const cursorResult = await client.query(
      `INSERT INTO assignment_cursors (subject, next_index)
       VALUES ($1, 0)
       ON CONFLICT (subject) DO UPDATE SET subject = EXCLUDED.subject
       RETURNING next_index`,
      [subject],
    );
    const startIndex = cursorResult.rows[0].next_index % teachers.length;
    const assignment = findNextAvailableTeacher(teachers, activeTeachers, startIndex);

    let teacherToAssign;
    let assignedIndex = null;

    if (assignment) {
      teacherToAssign = assignment.teacher;
      assignedIndex = assignment.index;
    } else {
      // All teachers are active. Assign to the teacher who was assigned first (oldest assigned_at)
      const oldestRes = await client.query(
        `SELECT teacher, MIN(assigned_at) AS first_assigned
         FROM tasks
         WHERE status = 'active' AND teacher = ANY($1)
         GROUP BY teacher
         ORDER BY MIN(assigned_at) ASC
         LIMIT 1`,
        [teachers],
      );

      if (oldestRes.rowCount > 0) {
        teacherToAssign = oldestRes.rows[0].teacher;
        // assignedIndex remains null; we'll still advance the cursor below
      } else {
        // Fallback: shouldn't happen, but if no active tasks found, post message
        await client.query("COMMIT");
        await postMessage({
          channel,
          thread_ts: threadTs,
          text: `科目: ${subject}\n現在、担当可能な先生が見つかりません。`,
        });
        return;
      }
    }

    // Compute due date: if assigned at 22:00 or later => +8 days, else +7 days
    const now = new Date();
    const hour = now.getHours();
    const daysToAdd = hour >= 22 ? 8 : 7;
    const dueDate = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

    // Insert task with due_at
    await client.query(
      `INSERT INTO tasks (thread_ts, channel_id, subject, teacher, status, assigned_at, due_at)
       VALUES ($1, $2, $3, $4, 'active', NOW(), $5)`,
      [threadTs, channel, subject, teacherToAssign, dueDate],
    );

    // Advance cursor if we had an assignment index
    const nextIndex = (assignedIndex !== null) ? (assignedIndex + 1) % teachers.length : (startIndex + 1) % teachers.length;

    await client.query(
      `UPDATE assignment_cursors
       SET next_index = $2, updated_at = NOW()
       WHERE subject = $1`,
      [subject, nextIndex],
    );

    await client.query("COMMIT");

    // Post assignment message in thread only, with @mention-style Slack ID if available and due date
    const dueDateStr = dueDate.toISOString().split('T')[0];
    const mention = TEACHER_IDS[teacherToAssign] ? `<@${TEACHER_IDS[teacherToAssign]}>` : `@${teacherToAssign}`;
    await postMessage({
      channel,
      thread_ts: threadTs,
      text: `科目: ${subject}\n担当: ${mention}\n期限: ${dueDateStr}`,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function findNextAvailableTeacher(teachers, activeTeachers, startIndex) {
  for (let offset = 0; offset < teachers.length; offset += 1) {
    const index = (startIndex + offset) % teachers.length;
    const teacher = teachers[index];
    if (!activeTeachers.has(teacher)) {
      return { teacher, index };
    }
  }

  return null;
}

async function completeTask(channel, threadTs) {
  const result = await pool.query(
    `UPDATE tasks
     SET status = 'completed', completed_at = NOW()
     WHERE channel_id = $1 AND thread_ts = $2 AND status = 'active'
     RETURNING subject, teacher`,
    [channel, threadTs],
  );

  if (result.rowCount === 0) {
    console.log(`No active task found for thread ${threadTs}`);
    return;
  }

  const { subject, teacher } = result.rows[0];
  const mention = TEACHER_IDS[teacher] ? `<@${TEACHER_IDS[teacher]}>` : `@${teacher}`;

  await postMessage({
    channel,
    thread_ts: threadTs,
    text: `${subject}の分析シートを完了として記録しました。\n担当: ${mention}`,
  });
}

async function postMessage(payload) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error}`);
  }

  return data;
}

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });