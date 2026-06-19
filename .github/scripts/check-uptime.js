// .github/scripts/check-uptime.js
//
// Checks frontend + backend health, compares against the last known
// state (persisted via actions/cache between workflow runs), and sends
// a Telegram alert ONLY when something changes — down→up or up→down —
// plus a periodic reminder if something has been down for a while.
// Without this state-comparison, every 5-minute run during an outage
// would fire its own alert, burying the signal in repeats of the same
// message instead of one clear "X went down" / "X recovered" pair.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), '.monitor-state.json');
const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // re-alert every 30 min while still down

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const FRONTEND_URL       = process.env.FRONTEND_URL;
const BACKEND_HEALTH_URL = process.env.BACKEND_HEALTH_URL;
const BACKEND_DEEP_URL   = process.env.BACKEND_DEEP_URL;

const CHECK_TIMEOUT_MS = 10_000;

// ─── helpers ──────────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {}; // first run ever, or cache miss — start fresh
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchWithTimeout(url, timeoutMs = CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials missing — cannot send alert. Message was:\n', text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram send failed:', res.status, body);
    }
  } catch (err) {
    console.error('Telegram send threw:', err.message);
  }
}

// ─── individual checks ────────────────────────────────────────────
async function checkFrontend() {
  try {
    const res = await fetchWithTimeout(FRONTEND_URL);
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function checkBackendHealth() {
  if (!BACKEND_HEALTH_URL) return { ok: true, detail: 'skipped — BACKEND_HEALTH_URL not set' };
  try {
    const res = await fetchWithTimeout(BACKEND_HEALTH_URL);
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function checkBackendDeep() {
  if (!BACKEND_DEEP_URL) return { ok: true, detail: 'skipped — BACKEND_DEEP_URL not set', subChecks: {} };
  try {
    const res = await fetchWithTimeout(BACKEND_DEEP_URL);
    const body = await res.json().catch(() => null);

    if (!res.ok || !body) {
      return { ok: false, detail: `HTTP ${res.status}`, subChecks: body?.checks ?? {} };
    }

    const checks = body.checks ?? {};
    const failedChecks = Object.entries(checks)
      .filter(([, v]) => v && v.status === 'error')
      .map(([k]) => k);

    return {
      ok: failedChecks.length === 0,
      detail: failedChecks.length === 0 ? 'all sub-checks ok' : `failing: ${failedChecks.join(', ')}`,
      subChecks: checks,
    };
  } catch (err) {
    return { ok: false, detail: err.message, subChecks: {} };
  }
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  const now = Date.now();

  const results = {
    frontend:       await checkFrontend(),
    backendHealth:  await checkBackendHealth(),
    backendDeep:    await checkBackendDeep(),
  };

  const messages = [];

  for (const [name, result] of Object.entries(results)) {
    const prev = state[name];
    const wasDown = prev?.ok === false;
    const isDown  = !result.ok;

    if (isDown && !wasDown) {
      // transition: up -> down
      messages.push(
        `🔴 <b>${labelFor(name)} is DOWN</b>\n${result.detail}\n<i>${new Date(now).toISOString()}</i>`
      );
      state[name] = { ok: false, since: now, lastAlertedAt: now };
    } else if (!isDown && wasDown) {
      // transition: down -> up
      const downForMs = now - (prev?.since ?? now);
      messages.push(
        `✅ <b>${labelFor(name)} recovered</b>\nWas down for ${formatDuration(downForMs)}.\n<i>${new Date(now).toISOString()}</i>`
      );
      state[name] = { ok: true };
    } else if (isDown && wasDown) {
      // still down — only remind periodically, not every single run
      const lastAlertedAt = prev?.lastAlertedAt ?? prev?.since ?? now;
      if (now - lastAlertedAt >= REMINDER_INTERVAL_MS) {
        const downForMs = now - (prev?.since ?? now);
        messages.push(
          `🔴 <b>${labelFor(name)} still down</b>\nDown for ${formatDuration(downForMs)}. ${result.detail}`
        );
        state[name] = { ...prev, lastAlertedAt: now };
      }
      // else: still down, but we alerted recently — stay quiet
    } else {
      // still up, nothing to report
      state[name] = { ok: true };
    }

    // surface sub-check detail (DB / RPC) only when something's actually wrong
    if (name === 'backendDeep' && isDown && result.subChecks) {
      const failing = Object.entries(result.subChecks).filter(([, v]) => v?.status === 'error');
      for (const [subName, subResult] of failing) {
        messages.push(`   ↳ <b>${subName}</b>: ${subResult.error ?? 'unknown error'}`);
      }
    }
  }

  if (messages.length > 0) {
    await sendTelegramMessage(messages.join('\n\n'));
  } else {
    console.log('All checks passed, no state changes — no alert sent.');
  }

  saveState(state);

  // exit non-zero if anything is currently down, so the Actions run
  // visibly shows red in the GitHub UI too — extra visibility beyond
  // just Telegram, costs nothing
  const anyDown = Object.values(results).some(r => !r.ok);
  process.exit(anyDown ? 1 : 0);
}

function labelFor(name) {
  return {
    frontend:      'Frontend (ficon.space)',
    backendHealth: 'Backend API',
    backendDeep:   'Backend (DB / Alchemy RPC)',
  }[name] ?? name;
}

function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

main().catch(err => {
  console.error('Monitor script crashed:', err);
  process.exit(1);
});