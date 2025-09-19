// index.js
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Puppeteer
const puppeteer = require('puppeteer');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteerExtra = require('pupeteer-extra');
puppeteerExtra.use(StealthPlugin());

// Simple JSON queue (low-dependency)
const DB_FILE = path.join(__dirname, 'queue.json');
function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { messages: [], pairings: {} };
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
if (!fs.existsSync(DB_FILE)) writeDb({ messages: [], pairings: {} });

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API: queue a message ---
/**
 * POST /api/send
 * body: { toThreadId: "<FB_THREAD_ID or numeric ID>", text: "Message text", senderName?: "optional" }
 */
app.post('/api/send', (req, res) => {
  const { toThreadId, text, senderName } = req.body;
  if (!toThreadId || !text) return res.status(400).json({ error: 'toThreadId and text required' });

  const db = readDb();
  const item = {
    id: uuidv4(),
    toThreadId,
    text,
    senderName: senderName || null,
    createdAt: new Date().toISOString(),
    status: 'queued', // queued | sent | failed
    lastError: null
  };
  db.messages.push(item);
  writeDb(db);
  logger.info({ msg: 'Queued message', id: item.id, to: toThreadId });
  return res.json({ ok: true, id: item.id });
});

// GET queue status
app.get('/api/queue', (req, res) => {
  const db = readDb();
  res.json({ messages: db.messages });
});

// Pairing code simple endpoint
app.post('/api/pair', (req, res) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const db = readDb();
  db.pairings[code] = { createdAt: new Date().toISOString() };
  writeDb(db);
  res.json({ code });
});

// Admin simple endpoints (you can protect this later)
app.post('/api/clear-queue', (req, res) => {
  const db = readDb();
  db.messages = [];
  writeDb(db);
  res.json({ ok: true });
});

// --- Puppeteer worker: pulls queued messages and sends ---
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '15000', 10);
let browser = null;
let page = null;
let workerRunning = false;

// Utility to load cookies from env var (COOKIES_BASE64) if provided
async function loadCookiesFromEnv(page) {
  const cb = process.env.COOKIES_BASE64;
  if (!cb) return false;
  try {
    const json = Buffer.from(cb, 'base64').toString('utf8');
    const cookies = JSON.parse(json); // expect array of puppeteer cookies
    await page.setCookie(...cookies);
    logger.info('Loaded cookies from COOKIES_BASE64');
    return true;
  } catch (e) {
    logger.error({ err: e }, 'Failed to load cookies from COOKIES_BASE64');
    return false;
  }
}

async function ensureBrowser() {
  if (browser) return;
  browser = await puppeteerExtra.launch({
    headless: process.env.HEADLESS !== 'false', // set HEADLESS=false for debugging in Render with TTY (or local)
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  page = await browser.newPage();
  // set user agent to reduce detection (stealth plugin helps)
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
  // load cookies (if provided)
  const loaded = await loadCookiesFromEnv(page);
  // go to messenger to initialize session or show login
  await page.goto('https://www.messenger.com/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => logger.warn('goto messenger failed', e));
  // If cookies not provided, user must login manually via a headful browser or paste cookies.
  return;
}

async function sendMessageToThread(toThreadId, text) {
  // toThreadId can be numeric id or "username" that works in /t/
  const threadUrl = `https://www.messenger.com/t/${toThreadId}`;
  logger.info({ threadUrl }, 'Sending message');
  await page.goto(threadUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for composer (contenteditable) to appear
  // The selector may vary; common is [contenteditable="true"] inside div role="textbox"
  await page.waitForTimeout(1500);
  // try a few selectors
  const selectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label="Message"]',
    'div.notranslate[contenteditable="true"]'
  ];
  let composer = null;
  for (const s of selectors) {
    try {
      composer = await page.$(s);
      if (composer) break;
    } catch (e) {}
  }
  if (!composer) {
    throw new Error('Composer not found on thread page');
  }

  // Focus and type the message, then press Enter
  await composer.focus();
  // Use page.keyboard to type newlines properly
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Enter');
  // Give the UI time to send
  await page.waitForTimeout(1200);
  logger.info('Message typed & Entered');
  return true;
}

async function processQueueOnce() {
  try {
    const db = readDb();
    const queued = db.messages.filter(m => m.status === 'queued');
    if (!queued.length) return;
    await ensureBrowser();
    // If page shows login screen (no user), we cannot continue
    // Check if logged in: look for an element only visible when logged in (like a chat list)
    const isLoggedIn = await page.evaluate(() => {
      const el = document.querySelector('div[role="navigation"]') || document.querySelector('nav') || document.querySelector('#app_root');
      return !!el;
    }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('Not logged in to Messenger in Puppeteer. Will retry later. Provide COOKIES_BASE64 or login manually in headful mode.');
      return;
    }

    for (const msg of queued) {
      try {
        await sendMessageToThread(msg.toThreadId, msg.text);
        // update status
        const db2 = readDb();
        const target = db2.messages.find(m => m.id === msg.id);
        if (target) {
          target.status = 'sent';
          target.sentAt = new Date().toISOString();
          writeDb(db2);
        }
      } catch (err) {
        logger.error({ err: err.message || err, id: msg.id }, 'Failed to send message');
        const db2 = readDb();
        const target = db2.messages.find(m => m.id === msg.id);
        if (target) {
          target.status = 'failed';
          target.lastError = (err && err.message) ? err.message : String(err);
          target.attemptedAt = new Date().toISOString();
          writeDb(db2);
        }
      }
    }
  } catch (e) {
    logger.error({ err: e }, 'processQueueOnce error');
  }
}

async function startWorker() {
  if (workerRunning) return;
  workerRunning = true;
  logger.info('Worker started, checking queue every %d ms', CHECK_INTERVAL_MS);
  // first immediate run
  await processQueueOnce();
  // set interval
  setInterval(() => {
    processQueueOnce().catch(err => logger.error({ err }, 'processQueueOnce crash'));
  }, CHECK_INTERVAL_MS);
}

// Start the worker automatically if env START_WORKER=true (default)
if (process.env.START_WORKER !== 'false') {
  startWorker().catch(e => logger.error(e));
}

// Start express
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info('Public UI available at /');
});
